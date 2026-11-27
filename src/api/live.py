"""Live camera tracking sessions.

The browser captures frames from ``getUserMedia`` and posts each one here. A
live session owns its own ``TrackingPipeline`` instance, so a webcam frame goes
through exactly the same detector -> tracker -> calibrator -> rules/Isolation
Forest/scene fusion path as a file or CLI run. Nothing is simulated: every
number in a frame response is read off the real pipeline output for that frame.

On ``stop`` the accumulated observations, track summaries, scene calibration
and retained annotated previews are assembled into an ordinary
`SessionResult` and persisted, so a live capture becomes a normal session that
every existing dashboard surface (overview, tracks, anomalies, scene,
evaluation, media, report) can read.

State is process-local, like the job registry: an API restart drops live
sessions, and a stopped capture survives because it is written to SQLite.
"""
from __future__ import annotations

import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Literal

import cv2
import numpy as np

from src.api.session_store import store as artifact_store
from src.core.analysis_service import (
    MAX_PREVIEW_FRAMES,
    PREVIEW_STRIDE,
    PreviewFrame,
    build_result_from_observations,
    observation_row,
    preview_thumb,
    save_session_to_db,
)
from src.pipeline import TrackingPipeline
from src.video.object_detector import get_object_detector

MAX_LIVE_SESSIONS = 4
MAX_LIVE_FRAMES = 18_000          # ~25 min at the default 12 fps
MAX_IDLE_S = 180.0                # an abandoned stream frees its slot
MAX_FRAME_BYTES = 4 * 1024 * 1024
DEFAULT_FPS = 12.0
MIN_FPS, MAX_FPS = 1.0, 60.0
FPS_SMOOTHING = 0.8
# Weight of the newest measured frame in the per-object stability average.
STABILITY_WEIGHT = 0.35
STABILITY_WINDOW = 10
Engine = Literal["objects", "motion", "auto"]

LIVE = "live"
STOPPING = "stopping"
STOPPED = "stopped"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _session_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"live_{stamp}_{secrets.token_hex(3)}"


class LiveError(Exception):
    """Base class for live-session problems the routes translate to HTTP."""


class LiveNotFound(LiveError):
    def __init__(self, live_id: str):
        super().__init__(f"unknown live session {live_id!r}")
        self.live_id = live_id


class LiveStateError(LiveError):
    def __init__(self, state: str, message: str):
        super().__init__(message)
        self.state = state


class LiveLimitError(LiveError):
    pass


class LiveFrameError(LiveError):
    pass


class LivePersistError(LiveError):
    pass


def decode_frame(data: bytes) -> np.ndarray:
    """Decode one JPEG/PNG frame; reject anything OpenCV cannot read."""
    if not data:
        raise LiveFrameError("The frame body is empty.")
    if len(data) > MAX_FRAME_BYTES:
        raise LiveFrameError(
            f"A frame may be at most {MAX_FRAME_BYTES // (1024 * 1024)} MiB.")
    try:
        buffer = np.frombuffer(data, dtype=np.uint8)
        bgr = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    except (cv2.error, ValueError) as exc:
        raise LiveFrameError(f"The frame could not be decoded: {exc}") from exc
    if bgr is None or bgr.size == 0:
        raise LiveFrameError("The frame could not be decoded as an image.")
    return bgr


def _track_payload(entry: dict, stability: dict | None = None) -> dict:
    cx, cy = entry["centroid"]
    width, height = entry["bbox_wh"]
    fused = float(entry["fused_score"])
    smoothed = fused if stability is None else float(stability["ema"])
    level_share = (None if stability is None
                   else float(stability["share"]))
    return {
        # Measured fused score for this frame, and the recent average the
        # console shows beside it. The level is always the engine's measured
        # level; the average never rewrites a verdict.
        "fused_smoothed": round(smoothed, 3),
        "level_stability": (None if level_share is None
                            else round(level_share, 3)),
        "track_id": int(entry["track_id"]),
        "box": [round(cx - width / 2, 1), round(cy - height / 2, 1),
                round(width, 1), round(height, 1)],
        "centroid": [round(cx, 1), round(cy, 1)],
        "color": entry.get("color"),
        "shape": entry.get("shape"),
        # The class the object detector reported ("person", "car", ...), and
        # null for the colour/shape engine.
        "class_name": entry.get("class_name"),
        "level": entry["level"],
        "scores": {
            "fused": round(fused, 3),
            "rule": round(float(entry["rule_score"]), 3),
            "ml": round(float(entry["ml_score"]), 3),
            "scene": round(float(entry["scene_score"]), 3),
        },
        # Track maturity: the engine's own confirmation (consecutive matched
        # frames >= tracking.min_hits) and how many frames this identity has
        # actually been observed in. The browser uses these to separate steady
        # objects from one-frame candidates instead of guessing from geometry.
        "confirmed": bool(entry.get("confirmed", False)),
        "misses": int(entry.get("misses", 0)),
        "frames_seen": len(entry.get("trajectory", [])),
        "speed_px_s": entry.get("speed_px_s"),
        "direction_deg": entry.get("direction_deg"),
        "zone": entry.get("in_zone"),
        "why": entry.get("why", ""),
        "rules": [r.get("rule") for r in entry.get("rules", [])],
        "evidence": entry.get("rules", []),
        # Recent measured centroids so the browser can draw a real trail even
        # for a track that started before the first response was painted.
        "trail": [[round(float(x), 1), round(float(y), 1)]
                  for _frame, x, y in list(entry.get("trajectory", []))[-48:]],
    }


class LiveSession:
    """One in-progress webcam capture with its own pipeline and buffers."""

    def __init__(self, live_id: str, session_id: str, engine: Engine = "auto"):
        self.live_id = live_id
        self.session_id = session_id
        # Engine choice: `objects` runs the pretrained COCO detector (proper
        # class names, far fewer saturated-background false positives), while
        # `motion` keeps the colour + background-subtraction path for machines
        # without the model or when maximum frame rate matters.
        requested = engine if engine in ("objects", "motion", "auto") else "auto"
        detector_ready = False
        if requested in ("objects", "auto"):
            detector_ready = bool(get_object_detector().available)
        self.engine = "objects" if detector_ready else "motion"
        self.engine_requested = requested
        self.stability: dict[int, dict] = {}
        self.created_ts = _now_iso()
        self.started_ts: str | None = None
        self.ended_ts: str | None = None
        self.created_mono = time.monotonic()
        self.last_seen = self.created_mono
        self.state = LIVE
        self.lock = threading.RLock()
        # A webcam sees arbitrary, often unsaturated objects, so live sessions
        # add moving-foreground detection on top of the colour path. The rest
        # of the pipeline (tracker, calibration, fusion, explanations) is the
        # same engine a file run uses.
        self.pipeline = TrackingPipeline(
            session=session_id,
            motion_augment=not detector_ready,
            use_object_detector=detector_ready)
        self.rows: list[dict] = []
        self.previews: list[PreviewFrame] = []
        self.frame_idx = 0
        self.width = 0
        self.height = 0
        self.fps = DEFAULT_FPS
        self.levels = {"Normal": 0, "Suspicious": 0, "Irregular": 0}
        self._last_frame_mono: float | None = None

    # ------------------------------------------------------------- ingest
    def ingest(self, data: bytes) -> dict:
        bgr = decode_frame(data)
        with self.lock:
            if self.state != LIVE:
                raise LiveStateError(self.state,
                                     "This live session is no longer accepting frames.")
            if self.frame_idx >= MAX_LIVE_FRAMES:
                raise LiveLimitError(
                    f"A live capture is capped at {MAX_LIVE_FRAMES} frames; "
                    "stop and analyse this one, then start a new capture.")

            now = time.monotonic()
            if self._last_frame_mono is not None and self.frame_idx > 0:
                delta = now - self._last_frame_mono
                if delta > 0:
                    measured = min(MAX_FPS, max(MIN_FPS, 1.0 / delta))
                    self.fps = round(FPS_SMOOTHING * self.fps
                                     + (1.0 - FPS_SMOOTHING) * measured, 3)
            self._last_frame_mono = now
            if self.started_ts is None:
                self.started_ts = _now_iso()

            height, width = bgr.shape[:2]
            self.width, self.height = width, height
            started = time.perf_counter()
            result = self.pipeline.process_frame(bgr, self.frame_idx, self.fps)
            process_ms = round((time.perf_counter() - started) * 1000.0, 1)

            for entry in result.entries:
                self.rows.append(observation_row(entry, self.fps))
                level = entry["level"]
                self.levels[level] = self.levels.get(level, 0) + 1
                self._update_stability(entry)
            if (self.frame_idx % PREVIEW_STRIDE == 0
                    and len(self.previews) < MAX_PREVIEW_FRAMES):
                self.previews.append(PreviewFrame(
                    frame_idx=self.frame_idx,
                    ts_s=round(self.frame_idx / max(self.fps, 1e-6), 2),
                    annotated=preview_thumb(result.annotated_bgr),
                    original=preview_thumb(bgr)))

            # Only objects actually measured in this frame are drawn and
            # listed; a coasting prediction from the Kalman filter is not a
            # visible object and would read as a phantom box on the stage.
            tracks = [_track_payload(entry, self.stability.get(entry["track_id"]))
                      for entry in result.entries
                      if entry.get("misses", 0) == 0]
            confirmed = sum(1 for track in tracks if track["confirmed"])
            payload = {
                "live_id": self.live_id,
                "session_id": self.session_id,
                "frame_idx": self.frame_idx,
                "ts_s": round(self.frame_idx / max(self.fps, 1e-6), 2),
                "fps": self.fps,
                "width": width,
                "height": height,
                "calibrated": bool(result.calibrated),
                "calibration": self._calibration_payload(),
                "engine": self.engine,
                "engine_requested": self.engine_requested,
                "process_ms": process_ms,
                "detections": int(result.n_detections),
                "tracks": tracks,
                "counts": {
                    "objects_now": len(tracks),
                    "confirmed_now": confirmed,
                    "candidates_now": len(tracks) - confirmed,
                    "tracks_seen": len(self.pipeline.tracker.all_time_tracks()),
                    "observations": len(self.rows),
                    "frames": self.frame_idx + 1,
                    "levels": dict(self.levels),
                },
                "elapsed_s": round(now - self.created_mono, 2),
            }
            self.frame_idx += 1
            self.last_seen = time.monotonic()
            return payload

    # ---------------------------------------------------------- stability
    def _update_stability(self, entry: dict) -> None:
        """Track a recent running average and level share per identity.

        Webcam scores jitter frame to frame; the average makes the reading
        steadier to look at and `level_stability` says how consistently the
        measured level held. Neither value changes the recorded observation.
        """
        track_id = int(entry["track_id"])
        level = entry["level"]
        fused = float(entry["fused_score"])
        state = self.stability.get(track_id)
        if state is None:
            state = {"ema": fused, "levels": deque(maxlen=STABILITY_WINDOW)}
            self.stability[track_id] = state
        else:
            state["ema"] = (STABILITY_WEIGHT * fused
                            + (1.0 - STABILITY_WEIGHT) * state["ema"])
        state["levels"].append(level)
        counts = list(state["levels"])
        state["share"] = counts.count(level) / len(counts)

    def _calibration_payload(self) -> dict:
        stats = self.pipeline.calibrator.stats()
        cfg = self.pipeline.cfg.calibration
        progress = min(1.0, stats.n_samples / max(cfg.min_samples, 1))
        return {
            "ready": bool(stats.ready),
            "samples": stats.n_samples,
            "needed": int(cfg.min_samples),
            "tracks": stats.n_tracks,
            "progress": round(progress, 3),
            "median_speed": round(stats.speed_p50, 2),
        }

    # -------------------------------------------------------------- stop
    def stop(self) -> dict:
        with self.lock:
            if self.state == STOPPED:
                raise LiveStateError(self.state, "This live session is already stopped.")
            if self.frame_idx == 0:
                raise LiveStateError(
                    self.state,
                    "No frames were received, so there is nothing to analyse.")
            self.state = STOPPING
            wall_s = round(time.monotonic() - self.created_mono, 2)
            summaries = self.pipeline.summarize_tracks(self.fps)
            scene = self.pipeline.calibrator.stats()
            self.ended_ts = _now_iso()
            result = build_result_from_observations(
                session=self.session_id,
                source_label="live camera",
                source_kind="live",
                is_synthetic=False,
                started_ts=self.started_ts or self.created_ts,
                ended_ts=self.ended_ts,
                wall_s=wall_s,
                fps=self.fps,
                frame_width=self.width,
                frame_height=self.height,
                frames_processed=self.frame_idx,
                max_frames=None,
                previews=list(self.previews),
                rows=list(self.rows),
                summaries=summaries,
                scene=scene)
            try:
                save_session_to_db(result)
            except Exception as exc:                    # noqa: BLE001
                self.state = LIVE                    # allow a retry
                raise LivePersistError(
                    f"The live capture could not be stored: {exc}") from exc

            self.state = STOPPED
            # Rich artifacts are best effort; the SQLite rows are the record.
            try:
                artifact_store.record(result)
            except Exception:                           # noqa: BLE001
                pass
            return {
                "session_id": self.session_id,
                "live_id": self.live_id,
                "state": STOPPED,
                "frames_processed": self.frame_idx,
                "observations": len(result.obs),
                "tracks": len(result.tracks),
                "levels": result.level_counts,
                "fps": self.fps,
                "duration_s": round(self.frame_idx / max(self.fps, 1e-6), 2),
                "wall_s": wall_s,
                "previews": len(self.previews),
                "started_ts": result.started_ts,
                "ended_ts": result.ended_ts,
            }

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "live_id": self.live_id,
                "session_id": self.session_id,
                "state": self.state,
                "created_ts": self.created_ts,
                "frames": self.frame_idx,
                "fps": self.fps,
                "width": self.width,
                "height": self.height,
                "observations": len(self.rows),
                "tracks_seen": len(self.pipeline.tracker.all_time_tracks()),
                "levels": dict(self.levels),
                "elapsed_s": round(time.monotonic() - self.created_mono, 2),
                "engine": self.engine,
                "calibration": self._calibration_payload(),
                "limits": {"max_frames": MAX_LIVE_FRAMES,
                           "max_frame_bytes": MAX_FRAME_BYTES},
            }


class LiveSessionManager:
    """Thread-safe registry of in-progress webcam captures."""

    def __init__(self, max_sessions: int = MAX_LIVE_SESSIONS,
                 max_idle_s: float = MAX_IDLE_S):
        self.max_sessions = max(1, int(max_sessions))
        self.max_idle_s = max(1.0, float(max_idle_s))
        self._lock = threading.RLock()
        self._sessions: dict[str, LiveSession] = {}

    # ------------------------------------------------------------ lifecycle
    def create(self, engine: Engine = "auto") -> dict:
        with self._lock:
            self._prune_locked()
            if len(self._sessions) >= self.max_sessions:
                raise LiveLimitError(
                    f"At most {self.max_sessions} live captures can run at once. "
                    "Stop one in another tab, or wait for an idle capture to expire.")
            session = LiveSession("live_" + secrets.token_hex(8), _session_id(),
                                  engine=engine)
            self._sessions[session.live_id] = session
            return session.snapshot()

    def ingest(self, live_id: str, data: bytes) -> dict:
        return self._get(live_id).ingest(data)

    def stop(self, live_id: str) -> dict:
        session = self._get(live_id)
        summary = session.stop()
        with self._lock:
            self._sessions.pop(live_id, None)
        return summary

    def cancel(self, live_id: str) -> dict:
        with self._lock:
            session = self._sessions.pop(live_id, None)
        if session is None:
            raise LiveNotFound(live_id)
        with session.lock:
            session.state = "cancelled"
        return {"live_id": live_id, "state": "cancelled"}

    def snapshot(self, live_id: str) -> dict:
        return self._get(live_id).snapshot()

    def active(self) -> list[dict]:
        with self._lock:
            self._prune_locked()
            return [s.snapshot() for s in self._sessions.values()]

    def cancel_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            with session.lock:
                session.state = "cancelled"

    # -------------------------------------------------------------- helpers
    def _get(self, live_id: str) -> LiveSession:
        with self._lock:
            session = self._sessions.get(live_id)
        if session is None:
            raise LiveNotFound(live_id)
        return session

    def _prune_locked(self) -> None:
        """Drop abandoned captures so a closed tab cannot hold a slot."""
        now = time.monotonic()
        expired = [sid for sid, session in self._sessions.items()
                   if now - session.last_seen > self.max_idle_s]
        for sid in expired:
            session = self._sessions.pop(sid)
            with session.lock:
                session.state = "cancelled"


manager = LiveSessionManager()
