"""Analysis service shared by the dashboard, the API and the CLI.

Runs the existing TrackingPipeline over a video source once, with real
progress reporting, and packages everything a consumer needs:

  * annotated + original preview frames (downscaled, strided) with frame ids
  * a flat per-observation DataFrame including structured evidence
    (triggered rules with severity/description, Isolation-Forest note,
    scene-relative note, zone dwell)
  * per-track summaries and trajectory point maps
  * scene calibration stats and processing telemetry

Nothing here is fabricated: every row comes from a real pipeline entry, and
`save_session_to_db` keeps each session's rows isolated from history.

This module is deliberately framework-neutral (no Streamlit import): it used
to live in `src/ui/session.py`, which now re-exports it for backward
compatibility.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import pandas as pd

from config.config import SAMPLES_DIR, load_config
from src.analysis.logger import ResultLogger
from src.pipeline import TrackingPipeline
from src.video.video_input import VideoSource

# Preview frames are every PREVIEW_STRIDE-th frame, downscaled to this width
# so a full session (annotated + original) stays comfortably in memory.
PREVIEW_MAX_W = 640
PREVIEW_STRIDE = 6
MAX_PREVIEW_FRAMES = 240
UPLOAD_MAX_AGE_S = 24 * 3600

# Flat per-observation schema shared by tables, CSV export and the DB row
# mapper. `rules_json` holds the structured rule evidence for one row.
OBS_COLS = ["frame", "ts_s", "track_id", "color", "shape", "level",
            "fused_score", "rule_score", "ml_score", "scene_score",
            "speed_px_s", "direction_deg", "cx", "cy", "zone",
            "zone_dwell_s", "rules_json", "ml_note", "scene_note", "why"]

TRACK_COLS = ["track_id", "color", "shape", "first_frame", "last_frame",
              "duration_s", "n_obs", "mean_speed_px_s", "max_speed_px_s",
              "path_length_px", "straightness", "start_x", "start_y",
              "end_x", "end_y", "directions", "n_events", "worst_level"]


class AnalysisCancelled(Exception):
    """A caller-supplied `should_stop` hook requested cancellation mid-run.

    Raised by `run_analysis` only when the optional hook is provided; the CLI
    and every Streamlit call leave it unset, so their behaviour is unchanged.
    """

    def __init__(self, session: str):
        super().__init__(f"analysis cancelled for session {session}")
        self.session = session


@dataclass
class PreviewFrame:
    frame_idx: int
    ts_s: float
    annotated: np.ndarray
    original: np.ndarray


@dataclass
class SessionResult:
    """Everything one analysis run produced (all values are measured)."""
    session: str
    source_label: str                 # display name, e.g. "sample: x.mp4"
    source_path: str
    source_kind: str                  # "sample" | "upload" | "file"
    is_synthetic: bool
    started_ts: str
    ended_ts: str
    wall_s: float
    fps: float
    frame_width: int
    frame_height: int
    frames_available: int | None      # container metadata (None if unknown)
    frames_processed: int
    max_frames: int | None
    previews: list[PreviewFrame] = field(default_factory=list)
    obs: pd.DataFrame = field(default_factory=lambda: pd.DataFrame(columns=OBS_COLS))
    tracks: pd.DataFrame = field(default_factory=lambda: pd.DataFrame(columns=TRACK_COLS))
    track_points: dict = field(default_factory=dict)   # track_id -> [(f, x, y)]
    scene: object = None                            # SceneStats
    summaries: list = field(default_factory=list)    # pipeline track summaries
    error: str | None = None

    @property
    def events(self) -> pd.DataFrame:
        """Non-Normal observations (the anomaly event list)."""
        if self.obs.empty:
            return self.obs
        return self.obs[self.obs["level"] != "Normal"].reset_index(drop=True)

    @property
    def level_counts(self) -> dict:
        if self.obs.empty:
            return {"Normal": 0, "Suspicious": 0, "Irregular": 0}
        counts = self.obs["level"].value_counts().to_dict()
        return {k: int(counts.get(k, 0)) for k in ("Normal", "Suspicious", "Irregular")}

    @property
    def duration_s(self) -> float:
        return self.frames_processed / max(self.fps, 1e-6)

    @property
    def proc_fps(self) -> float:
        return self.frames_processed / max(self.wall_s, 1e-6)


# --------------------------------------------------------------------- files
def upload_path(output_dir: Path, name: str) -> Path:
    """Sanitized destination for an uploaded video (browser-controlled name)."""
    safe = Path(name).name
    safe = "".join(c for c in safe if c.isalnum() or c in "._-")
    return output_dir / (f"upload_{safe}" if safe else "upload_video.mp4")


def cleanup_stale_uploads(output_dir: Path) -> int:
    removed, now = 0, time.time()
    try:
        candidates = list(output_dir.glob("upload_*"))
    except OSError:
        return 0
    for p in candidates:
        try:
            if now - p.stat().st_mtime > UPLOAD_MAX_AGE_S:
                p.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def is_synthetic_source(path: Path | str) -> bool:
    """Bundled sample videos are synthetic - disclosed wherever shown."""
    try:
        return Path(path).resolve().parent == Path(SAMPLES_DIR).resolve()
    except OSError:
        return False


def friendly_open_error(src_name: str, exc: Exception) -> str:
    return (f"Could not open **{src_name}** - {exc}. Supported formats: "
            "mp4 / avi / mov / mkv (anything OpenCV can decode). Pick another "
            "file or regenerate the samples with "
            "`python scripts/generate_samples.py`.")


# ------------------------------------------------------------------- analysis
def _thumb(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    if w <= PREVIEW_MAX_W:
        return bgr
    return cv2.resize(bgr, (PREVIEW_MAX_W, max(1, round(h * PREVIEW_MAX_W / w))),
                      interpolation=cv2.INTER_AREA)


def run_analysis(src: str, source_label: str, source_kind: str,
                 max_frames: int | None, session: str,
                 progress: Callable[[int, int], None] | None = None,
                 stage: Callable[[str], None] | None = None,
                 should_stop: Callable[[], bool] | None = None) -> SessionResult:
    """Process a video through the tracking pipeline.

    `progress(done, total)` is invoked every few frames with real counts;
    total is 0 when the container does not report a frame count.
    Optional hooks (all default None, so existing callers are unaffected):
      * `stage(name)` reports the real phase: opening / processing / summarising.
      * `should_stop()` is polled once per frame; returning True raises
        `AnalysisCancelled` so a background job can stop cooperatively.
    Returns a SessionResult whose `error` is a friendly message on failure.
    """
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    t0 = time.monotonic()
    cfg = load_config()
    synthetic = is_synthetic_source(src)
    if stage is not None:
        stage("opening")
    try:
        with VideoSource(src=src) as vs:
            fps = float(vs.fps)
            total = vs.frame_count() or 0
            if max_frames:
                total = min(total, max_frames) if total else max_frames
            pipeline = TrackingPipeline(session=session)
            rows: list[dict] = []
            previews: list[PreviewFrame] = []
            processed = 0
            width = height = 0
            if stage is not None:
                stage("processing")
            for vf in vs:
                if should_stop is not None and should_stop():
                    raise AnalysisCancelled(session)
                res = pipeline.process_frame(vf.bgr, vf.index, vf.fps)
                if not width:
                    height, width = vf.bgr.shape[:2]
                if (processed % PREVIEW_STRIDE == 0
                        and len(previews) < MAX_PREVIEW_FRAMES):
                    previews.append(PreviewFrame(
                        frame_idx=vf.index,
                        ts_s=round(vf.index / max(fps, 1e-6), 2),
                        annotated=_thumb(res.annotated_bgr),
                        original=_thumb(vf.bgr)))
                for e in res.entries:
                    rows.append({
                        "frame": e["frame_idx"],
                        "ts_s": round(e["frame_idx"] / max(fps, 1e-6), 2),
                        "track_id": e["track_id"],
                        "color": e.get("color"),
                        "shape": e.get("shape"),
                        "level": e["level"],
                        "fused_score": e["fused_score"],
                        "rule_score": e["rule_score"],
                        "ml_score": e["ml_score"],
                        "scene_score": e["scene_score"],
                        "speed_px_s": e["speed_px_s"],
                        "direction_deg": e["direction_deg"],
                        "cx": round(e["centroid"][0], 1),
                        "cy": round(e["centroid"][1], 1),
                        "zone": e.get("in_zone"),
                        "zone_dwell_s": e.get("zone_dwell_s", 0.0),
                        "rules_json": json.dumps(e.get("rules", [])),
                        "ml_note": e.get("ml_note", ""),
                        "scene_note": e.get("scene_note", ""),
                        "why": e.get("why", ""),
                    })
                processed += 1
                if progress and (processed % 10 == 0 or processed == 1):
                    progress(processed, total)
                if max_frames and processed >= max_frames:
                    break
            if stage is not None:
                stage("summarising")
            summaries = pipeline.summarize_tracks(fps)
            scene = pipeline.calibrator.stats()
            n_available = vs.frame_count() or processed

        obs = pd.DataFrame(rows, columns=OBS_COLS)
        tracks, track_points = _track_tables(obs, summaries, fps)
        if progress:
            progress(processed, total or processed)
        return SessionResult(
            session=session, source_label=source_label, source_path=str(src),
            source_kind=source_kind, is_synthetic=synthetic,
            started_ts=started,
            ended_ts=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            wall_s=round(time.monotonic() - t0, 2), fps=fps,
            frame_width=width, frame_height=height,
            frames_available=n_available, frames_processed=processed,
            max_frames=max_frames, previews=previews, obs=obs, tracks=tracks,
            track_points=track_points, scene=scene, summaries=summaries)
    except (OSError, TypeError, ValueError, cv2.error) as exc:
        return SessionResult(
            session=session, source_label=source_label, source_path=str(src),
            source_kind=source_kind, is_synthetic=synthetic,
            started_ts=started,
            ended_ts=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            wall_s=round(time.monotonic() - t0, 2),
            fps=load_config().features.fps_default,
            frame_width=0, frame_height=0, frames_available=None,
            frames_processed=0, max_frames=max_frames,
            error=friendly_open_error(Path(str(src)).name, exc))


def _track_tables(obs: pd.DataFrame, summaries: list, fps: float
                  ) -> tuple[pd.DataFrame, dict]:
    """Per-track table + trajectory maps, all derived from real observations."""
    points: dict[int, list] = {}
    if not obs.empty:
        for tid, grp in obs.groupby("track_id"):
            points[int(tid)] = [(int(r.frame), float(r.cx), float(r.cy))
                                for r in grp.itertuples()]
    stats_by_id = {s["track_id"]: s for s in summaries}
    rows = []
    for tid, grp in (obs.groupby("track_id") if not obs.empty else []):
        s = stats_by_id.get(int(tid))
        st = s["stats"] if s else None
        levels = grp["level"].value_counts().to_dict()
        worst = ("Irregular" if levels.get("Irregular")
                 else "Suspicious" if levels.get("Suspicious") else "Normal")
        rows.append({
            "track_id": int(tid),
            "color": grp["color"].iloc[-1],
            "shape": grp["shape"].iloc[-1],
            "first_frame": int(grp["frame"].min()),
            "last_frame": int(grp["frame"].max()),
            "duration_s": round((grp["frame"].max() - grp["frame"].min())
                                / max(fps, 1e-6), 2),
            "n_obs": int(len(grp)),
            "mean_speed_px_s": round(float(st.mean_speed_px_s), 1) if st else 0.0,
            "max_speed_px_s": round(float(st.max_speed_px_s), 1) if st else 0.0,
            "path_length_px": round(float(st.path_length_px), 1) if st else 0.0,
            "straightness": round(float(st.straightness), 3) if st else 0.0,
            "start_x": round(float(grp["cx"].iloc[0]), 1),
            "start_y": round(float(grp["cy"].iloc[0]), 1),
            "end_x": round(float(grp["cx"].iloc[-1]), 1),
            "end_y": round(float(grp["cy"].iloc[-1]), 1),
            "directions": ",".join(st.direction_hist.keys()) if st else "",
            "n_events": int((grp["level"] != "Normal").sum()),
            "worst_level": worst,
        })
    tracks = pd.DataFrame(rows, columns=TRACK_COLS)
    return tracks, points


# ------------------------------------------------------------------ database
def save_session_to_db(result: SessionResult) -> dict:
    """Persist a run under its own session id (replaces that session only)."""
    cfg = load_config()
    log = ResultLogger(cfg.paths.db, session=result.session)
    try:
        log.clear_session_events(result.session)
        log.clear_session_summaries(result.session)
        for rec in result.obs.to_dict("records"):
            log.log_event(int(rec["frame"]), _db_event_row(rec))
        for s in result.summaries:
            log.log_track_summary(s["stats"], s["color"], s["shape"],
                                  s["first_frame"], s["last_frame"])
        log.log_run({
            "session": result.session, "source": result.source_label,
            "kind": result.source_kind, "synthetic": result.is_synthetic,
            "frames": result.frames_processed, "width": result.frame_width,
            "height": result.frame_height, "fps": result.fps,
            "wall_s": result.wall_s, "max_frames": result.max_frames,
            "started_ts": result.started_ts, "ended_ts": result.ended_ts,
        })
        return {"events": len(result.obs), "summaries": len(result.summaries)}
    finally:
        log.close()


def _db_event_row(rec: dict) -> dict:
    """Map an OBS_COLS record onto the track_events entry contract."""
    out = dict(rec)
    out["frame_idx"] = rec["frame"]
    return out


def load_history(db_path: Path | str) -> list[dict]:
    log = ResultLogger(db_path, session="__history__")
    try:
        sessions = log.list_sessions()
        for s in sessions:
            run = log.get_run(s["session"]) or {}
            s["source"] = run.get("source")
            s["kind"] = run.get("kind")
            s["synthetic"] = bool(run.get("synthetic"))
            s["wall_s"] = run.get("wall_s")
            s["frames"] = run.get("frames")
        return sessions
    finally:
        log.close()


def load_session_data(db_path: Path | str, session: str
                      ) -> tuple[pd.DataFrame, pd.DataFrame, dict | None]:
    """Historical events + summaries + run info for one stored session."""
    log = ResultLogger(db_path, session=session)
    try:
        ecols, erows = log.session_events(session)
        ccols, crows = log.session_summaries(session)
        run = log.get_run(session)
        return (pd.DataFrame(erows, columns=ecols),
                pd.DataFrame(crows, columns=ccols), run)
    finally:
        log.close()


def delete_session(db_path: Path | str, session: str) -> dict:
    log = ResultLogger(db_path, session=session)
    try:
        return log.close_session(session)
    finally:
        log.close()
