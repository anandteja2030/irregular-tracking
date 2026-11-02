"""Video Analysis Studio - source selection, real-progress processing and a
frame-by-frame evidence viewer.

Phase 2 layout: the annotated footage is the centrepiece. Bounding boxes,
track IDs, trajectory trails, timestamps and severity are drawn by the
pipeline itself (`src.ui.visualization`), so what you see is what the
detector/tracker actually produced. Every number in the panels is read from
the session result - this page never fabricates events, scores or metrics.
"""
from __future__ import annotations

import html
import json
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from datetime import datetime, timezone

import pandas as pd
import streamlit as st

from config.config import load_config
from src.ui.session import SessionResult, run_analysis, upload_path
from src.ui.theme import badge, empty_state, kpi, page_header, panel, section

# Preview playback pacing (seconds per frame) for the in-page frame player.
PLAY_INTERVAL_S = 0.35
UPLOAD_TYPES = ["mp4", "avi", "mov", "mkv"]

# Session-state keys that belong to one analysis run. They are dropped when a
# new run finishes so a previous run's frame/selection can never be mistaken
# for part of the current session.
_VIEWER_KEYS = ("studio_index", "studio_slider", "studio_obj", "studio_jump",
                "studio_track", "_studio_jump_applied", "_studio_track_applied",
                "studio_playing", "_studio_goto")


def _session_id() -> str:
    if "session_id" not in st.session_state:
        st.session_state["session_id"] = datetime.now(timezone.utc).strftime(
            "s_%Y%m%d_%H%M%S")
    return st.session_state["session_id"]


def _resolve(src_label: str, output_dir: Path) -> tuple[str, str]:
    if src_label.startswith("sample: "):
        return str(load_config().paths.samples
                   / src_label.split("sample: ", 1)[1]), "sample"
    return str(upload_path(output_dir,
                           src_label.split("upload: ", 1)[1])), "upload"


def validate_upload(name: str, data: bytes | None) -> str | None:
    """Friendly rejection reason for an uploaded file, or None if usable."""
    if not name:
        return "No file was received - choose a video again."
    ext = Path(name).suffix.lower().lstrip(".")
    if ext not in UPLOAD_TYPES:
        return (f"Unsupported format **.{ext}** - use one of: "
                f"{', '.join(UPLOAD_TYPES)} (anything OpenCV can decode).")
    if not data or len(data) == 0:
        return (f"**{name}** arrived empty (0 bytes) - the upload did not "
                "complete. Choose the file again.")
    return None


# ------------------------------------------------------------------ analysis
def _run(src_label: str, max_frames: int) -> None:
    if st.session_state.get("_run_active"):
        # Re-entrancy guard: a second Analyze trigger can never start a
        # duplicate pipeline run while one is already in flight.
        return
    cfg = load_config()
    src, kind = _resolve(src_label, Path(cfg.paths.output))
    status = st.empty()
    bar = st.progress(0.0, text="Starting analysis...")
    st.session_state["analysis_state"] = "running"
    st.session_state["_run_active"] = True
    t0 = time.monotonic()

    def cb(done: int, total: int) -> None:
        elapsed = time.monotonic() - t0
        if total:
            bar.progress(min(done / total, 1.0),
                         text=f"Processing frame {done} / {total} · "
                              f"{elapsed:.0f}s elapsed")
        else:
            status.markdown(f"**Processed {done} frames** · {elapsed:.0f}s "
                            "elapsed (source frame count unknown)")

    try:
        res: SessionResult = run_analysis(
            src, source_label=src_label, source_kind=kind,
            max_frames=max_frames, session=_session_id(), progress=cb)
    finally:
        st.session_state["_run_active"] = False
    bar.empty()
    status.empty()
    st.session_state["session_result"] = res
    st.session_state["session_error"] = res.error
    st.session_state["analysis_state"] = "error" if res.error else "done"
    st.session_state["analysis_ts"] = datetime.now(timezone.utc).strftime(
        "%H:%M:%S UTC")
    for stale in ("gt_labels", "eval_outcome", "pending_frame", *_VIEWER_KEYS):
        st.session_state.pop(stale, None)
    if res.error:
        # main() renders session_error on every pass; no flash needed here.
        st.rerun()
    else:
        st.session_state["studio_index"] = 0
        st.session_state["_studio_flash"] = (
            f"Analyzed {res.frames_processed} frames in {res.wall_s:.1f} s - "
            f"{len(res.tracks)} tracks, {len(res.events)} anomaly "
            "observations. Explore results in the other pages.")
        # rerun so the sidebar status card re-renders with the final state
        # instead of the "Processing\u2026" shown while the pipeline ran
        st.rerun()


def _source_controls() -> None:
    # Deferred analysis: one rerun first so the sidebar status flips to
    # "Processing\u2026" while the pipeline actually runs on the next script pass.
    pending = st.session_state.pop("_pending_analysis", None)
    if pending is not None:
        _run(pending[0], pending[1])
    elif st.session_state.get("analysis_state") == "running":
        # A run never finished (e.g. the server restarted mid-run). Never
        # leave a stale "Processing\u2026" indicator behind.
        st.session_state.pop("analysis_state", None)

    flash = st.session_state.pop("_studio_flash", None)
    if flash:
        st.success(flash)

    cfg = load_config()
    samples = sorted(Path(cfg.paths.samples).glob("*.mp4"))
    out_dir = Path(cfg.paths.output)

    options = [f"sample: {p.name}" for p in samples]
    uploaded = st.file_uploader(
        f"Upload video ({' / '.join(UPLOAD_TYPES)}, up to 64 MB)",
        type=UPLOAD_TYPES)
    if uploaded is not None:
        problem = validate_upload(uploaded.name, uploaded.getvalue())
        if problem:
            st.error(problem)
        else:
            upload_path(out_dir, uploaded.name).write_bytes(uploaded.getvalue())
            options.append(f"upload: {Path(uploaded.name).name}")

    if not options:
        empty_state("No video sources available",
                    "Generate the bundled samples with "
                    "`python scripts/generate_samples.py`, or upload a video "
                    "above. Supported formats: mp4, avi, mov, mkv.")
        return

    preset = st.session_state.pop("pending_source", None)
    if preset in options:
        st.session_state["studio_source"] = preset

    c1, c2, c3 = st.columns([1.5, 1.0, 1.0])
    with c1:
        src_label = st.selectbox(
            "Source", options, key="studio_source",
            help="Bundled samples are synthetic demonstration footage; "
                 "uploads are analysed by the identical pipeline.")
    with c2:
        max_frames = st.slider("Frame budget", 50, 1200, 450, step=50,
                               help="Process at most N frames (source fps "
                                    "preserved). Lower = faster first run.")
    with c3:
        st.markdown("<div style='height:1.55rem'></div>", unsafe_allow_html=True)
        analyze = st.button("Analyze", type="primary", width="stretch")

    auto = st.session_state.pop("auto_run", False)
    if analyze or auto:
        st.session_state["analysis_state"] = "running"
        st.session_state["_pending_analysis"] = (src_label, max_frames)
        st.rerun()


# ------------------------------------------------------------------- summary
def _summary(res: SessionResult) -> None:
    section("Run summary", "measured during this run")
    cols = st.columns(5)
    cols[0].markdown(kpi("Frames processed", f"{res.frames_processed}",
                         f"of {res.frames_available} available"),
                     unsafe_allow_html=True)
    cols[1].markdown(kpi("Source", f"{res.frame_width}×{res.frame_height}",
                         f"{res.fps:.1f} fps · {res.duration_s:.1f}s footage"),
                     unsafe_allow_html=True)
    cols[2].markdown(kpi("Processing", f"{res.wall_s:.1f}s",
                         f"{res.proc_fps:.1f} frames/s"), unsafe_allow_html=True)
    cols[3].markdown(kpi("Tracks", f"{len(res.tracks)}",
                         f"{len(res.obs)} observations"), unsafe_allow_html=True)
    lc = res.level_counts
    flagged = lc["Suspicious"] + lc["Irregular"]
    cols[4].markdown(kpi("Classification",
                         f"{lc['Normal']}/{lc['Suspicious']}/{lc['Irregular']}",
                         "normal / suspicious / irregular", accent=flagged > 0),
                     unsafe_allow_html=True)

    st.markdown(
        f'<span class="badge neutral">session {html.escape(res.session)}</span> '
        f'<span class="muted" style="font-size:.78rem;">analysed '
        f'{html.escape(res.started_ts)} \u00b7 source '
        f'{html.escape(res.source_label)}</span>',
        unsafe_allow_html=True)
    if res.is_synthetic:
        st.markdown(
            '<span class="badge neutral">synthetic sample footage</span> '
            '<span class="muted" style="font-size:.78rem;">- demonstration '
            'input, not real surveillance data</span>',
            unsafe_allow_html=True)

    # Stale-result guard: results belong to the source that produced them.
    selected = st.session_state.get("studio_source")
    if selected and selected != res.source_label:
        st.info(f"Showing results from **{res.source_label}** "
                f"(analysed {res.started_ts}). The selected source is now "
                f"**{selected}** - press *Analyze* to process it.")


# --------------------------------------------------------------- navigation
def _nearest_preview(res: SessionResult, frame_idx: int) -> int:
    return min(range(len(res.previews)),
               key=lambda i: abs(res.previews[i].frame_idx - int(frame_idx)))


def _request_frame(preview_idx: int) -> None:
    """Ask the viewer to move frames.

    The scrub slider owns ``studio_index`` (its widget key), so a frame change
    requested by a button, a jump or the player cannot be written directly
    after that widget rendered - Streamlit would reject the assignment. The
    request is parked in a plain key and applied at the top of the next pass,
    before any widget is instantiated. This is what keeps prev/next, event
    jumps and playback consistent with the slider instead of reverting them.
    """
    st.session_state["_studio_goto"] = int(preview_idx)
    st.rerun()


def _objects_on_frame(res: SessionResult, frame_idx: int) -> list[int]:
    fo = res.obs[res.obs["frame"] == frame_idx]
    if fo.empty:
        return []
    return sorted(int(t) for t in fo["track_id"].unique())


def _apply_jump(res: SessionResult, frame_idx: int,
                track_id: int | None = None) -> None:
    """Move the viewer to the frame that carries this evidence."""
    idx = _nearest_preview(res, frame_idx)
    if track_id is not None and not res.obs.empty:
        # prefer a captured preview where this track was actually observed
        seen = set(int(f) for f in
                   res.obs.loc[res.obs["track_id"] == track_id, "frame"])
        cand = [i for i, pv in enumerate(res.previews) if pv.frame_idx in seen]
        if cand:
            idx = min(cand, key=lambda i: abs(res.previews[i].frame_idx
                                              - int(frame_idx)))
    st.session_state["_studio_goto"] = idx
    here = _objects_on_frame(res, res.previews[idx].frame_idx)
    if track_id is not None and track_id in here:
        st.session_state["studio_obj"] = track_id
    elif st.session_state.get("studio_obj") not in here:
        st.session_state.pop("studio_obj", None)


def _ensure_valid(key: str, options) -> None:
    """Drop a widget value that belongs to a previous frame/selection."""
    if st.session_state.get(key) not in options:
        st.session_state.pop(key, None)


def _anomaly_jump(res: SessionResult) -> None:
    ev = res.events
    if ev.empty:
        st.caption("No anomaly events in this session - nothing to jump to.")
        return
    opts = [f"f{int(r.frame)} · track {int(r.track_id)} · {r.level} · "
            f"{float(r.fused_score):.2f}" for r in ev.itertuples()]
    _ensure_valid("studio_jump", opts)
    picked = st.selectbox("Jump to anomaly", opts, key="studio_jump",
                          help="Opens the captured frame nearest to that event")
    applied = st.session_state.get("_studio_jump_applied")
    if applied is None:
        st.session_state["_studio_jump_applied"] = picked   # first paint: adopt
    elif picked != applied:
        st.session_state["_studio_jump_applied"] = picked
        _apply_jump(res, int(picked.split(" ·", 1)[0][1:]),
                    int(picked.split("track ", 1)[1].split(" ·", 1)[0]))
        st.rerun()


def _track_jump(res: SessionResult) -> None:
    if res.tracks.empty:
        st.caption("No tracks in this session.")
        return
    tids = sorted(int(t) for t in res.tracks["track_id"].tolist())
    _ensure_valid("studio_track", tids)

    def _fmt(t: int) -> str:
        row = res.tracks[res.tracks["track_id"] == t].iloc[0]
        return f"#{t} · {row['color']} {row['shape']} · {row['worst_level']}"

    picked = st.selectbox("Inspect track", tids, key="studio_track",
                          format_func=_fmt,
                          help="Jumps to this track's most severe frame")
    applied = st.session_state.get("_studio_track_applied")
    if applied is None:
        st.session_state["_studio_track_applied"] = picked
    elif picked != applied:
        st.session_state["_studio_track_applied"] = picked
        rows = res.obs[res.obs["track_id"] == picked]
        if not rows.empty:
            _apply_jump(res, int(rows.loc[rows["fused_score"].idxmax(),
                                          "frame"]), picked)
            st.rerun()


# -------------------------------------------------------------------- stage
def _stage(res: SessionResult, idx: int) -> int:
    """Annotated footage as the centrepiece + playback/scrub/jump controls."""
    n = len(res.previews)
    pv = res.previews[idx]

    mode = st.radio("View", ["Annotated", "Original", "Both"], horizontal=True,
                    index=0, key="studio_mode",
                    help="Annotated = pipeline overlays · Original = the raw "
                         "decoded frame without any drawing")

    if mode in ("Annotated", "Both"):
        st.markdown(
            '<span class="chip">ANNOTATED</span> '
            '<span class="muted" style="font-size:.78rem;">pipeline overlays - '
            'bounding boxes, track IDs, trajectory trails, severity</span>',
            unsafe_allow_html=True)
        st.image(pv.annotated[:, :, ::-1], channels="RGB", width="stretch",
                 caption=f"Annotated · frame {pv.frame_idx} · t {pv.ts_s:.2f}s")
    if mode in ("Original", "Both"):
        st.markdown(
            '<span class="badge neutral">ORIGINAL</span> '
            '<span class="muted" style="font-size:.78rem;">raw decoded frame - '
            'nothing drawn on it</span>',
            unsafe_allow_html=True)
        st.image(pv.original[:, :, ::-1], channels="RGB", width="stretch",
                 caption=f"Original · frame {pv.frame_idx} · t {pv.ts_s:.2f}s")

    # --- playback / scrubbing: every change re-runs so the frame above and
    #     the panels below always describe the same frame.
    c1, c2, c3, c4, c5 = st.columns([0.45, 0.8, 3.0, 0.45, 1.3])
    with c1:
        if st.button("‹", disabled=idx <= 0, width="stretch",
                     help="Previous preview frame"):
            _request_frame(idx - 1)
    with c2:
        playing = bool(st.session_state.get("studio_playing"))
        if st.button("■ Stop" if playing else "▶ Play", width="stretch",
                     help="Play the captured frames as a stoppable slideshow"):
            st.session_state["studio_playing"] = not playing
            st.rerun()
    with c3:
        if n > 1:
            # the slider IS the viewer index: one source of truth, so the
            # thumb, the frame above and the panels below can never disagree
            idx = st.slider("Preview frame", 0, n - 1, idx,
                            key="studio_index",
                            help="Scrub the captured preview frames "
                                 "(every 6th source frame)")
        else:
            st.caption("Single captured preview frame")
    with c4:
        if st.button("›", disabled=idx >= n - 1, width="stretch",
                     help="Next preview frame"):
            _request_frame(idx + 1)
    with c5:
        cur = res.previews[idx]
        st.caption(f"t {cur.ts_s:.2f}s · preview {idx + 1}/{n}")

    j1, j2 = st.columns([1.35, 1.0])
    with j1:
        _anomaly_jump(res)
    with j2:
        _track_jump(res)
    return max(0, min(idx, n - 1))


# --------------------------------------------------------------------- rail
def _evidence_html(row) -> str:
    """HTML for one observation: recorded explanation + the evidence streams
    that actually produced it (rule engine vs Isolation Forest vs scene)."""
    rules = json.loads(row["rules_json"] or "[]")
    d = row["direction_deg"]
    dir_s = f"{d:.0f}\u00b0" if pd.notna(d) else "n/a"
    why = row["why"]
    why_s = str(why) if pd.notna(why) and str(why).strip() else ""
    ml = float(row["ml_score"]) if pd.notna(row["ml_score"]) else 0.0
    scene = float(row["scene_score"]) if pd.notna(row["scene_score"]) else 0.0

    parts = [
        "<div style='display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;'>",
        badge(str(row["level"])),
        f"<b>track #{int(row['track_id'])}</b>",
        f"<span class='muted' style='font-size:.78rem;'>frame "
        f"{int(row['frame'])} · {float(row['ts_s']):.2f}s · fused "
        f"{float(row['fused_score']):.2f}</span></div>",
        f"<div style='margin:.5rem 0 .35rem;font-size:.87rem;line-height:1.5;'>"
        f"<b>Why:</b> {html.escape(why_s or 'no explanation recorded')}</div>",
        f"<div class='muted' style='font-size:.78rem;'>measured: "
        f"{float(row['speed_px_s']):.0f} px/s · {dir_s} · "
        f"{html.escape(str(row['shape']))} ({html.escape(str(row['color']))})"
        f"</div>",
    ]
    if rules:
        parts.append("<div style='margin-top:.5rem;'>")
        for r in rules:
            parts.append(
                f"<div style='margin:.22rem 0;'>"
                f"<span class='chip'>{html.escape(str(r.get('rule', 'rule')))}"
                f" · {int(float(r.get('severity', 0)) * 100)}%</span> "
                f"<span class='muted' style='font-size:.78rem;'>"
                f"{html.escape(str(r.get('description', '')))}</span></div>")
        parts.append("</div>")
    if ml > 0:
        parts.append(
            f"<div style='margin-top:.4rem;'><span class='chip ml'>"
            f"Isolation Forest</span> <span class='muted' "
            f"style='font-size:.8rem;'>{html.escape(str(row['ml_note'] or ''))}"
            f"</span></div>")
    if scene > 0 or (row["scene_note"] and str(row["scene_note"]).strip()):
        parts.append(
            f"<div style='margin-top:.3rem;'><span class='chip scene'>"
            f"scene-relative</span> <span class='muted' "
            f"style='font-size:.8rem;'>"
            f"{html.escape(str(row['scene_note'] or ''))}</span></div>")
    if row["zone"] and str(row["zone"]) not in ("", "nan", "None"):
        parts.append(
            f"<div style='margin-top:.3rem;'><span class='chip'>zone</span> "
            f"inside <b>{html.escape(str(row['zone']))}</b>, dwell "
            f"{float(row['zone_dwell_s'] or 0):.1f}s</div>")
    if not rules and ml == 0 and scene == 0 and not (
            row["zone"] and str(row["zone"]) not in ("", "nan", "None")):
        parts.append(
            "<div class='muted' style='font-size:.78rem;margin-top:.4rem;'>"
            "No rule fired and no model flag here - the fusion classified "
            "this observation Normal.</div>")
    return "".join(parts)


def _rail(res: SessionResult, idx: int) -> None:
    pv = res.previews[idx]
    frame_obs = res.obs[res.obs["frame"] == pv.frame_idx]

    g1, g2 = st.columns(2)
    g1.markdown(kpi("Frame", f"{pv.frame_idx}", f"t = {pv.ts_s:.2f} s"),
                unsafe_allow_html=True)
    g2.markdown(kpi("Tracks here", f"{len(frame_obs)}",
                    "observations on this frame"), unsafe_allow_html=True)
    g3, g4 = st.columns(2)
    levels = (frame_obs["level"].value_counts().to_dict()
              if not frame_obs.empty else {})
    g3.markdown(kpi("Levels",
                    f"{levels.get('Normal', 0)}/{levels.get('Suspicious', 0)}"
                    f"/{levels.get('Irregular', 0)}",
                    "normal / suspicious / irregular"), unsafe_allow_html=True)
    fastest = float(frame_obs["speed_px_s"].max()) if not frame_obs.empty else 0.0
    g4.markdown(kpi("Fastest here", f"{fastest:.0f}", "px/s"),
                unsafe_allow_html=True)

    st.markdown("<h3>Object evidence</h3>", unsafe_allow_html=True)
    valid = _objects_on_frame(res, pv.frame_idx)
    if not valid:
        st.caption("No tracked objects were observed on this frame - step "
                   "through other previews, or jump to an anomaly or track "
                   "above.")
        return
    _ensure_valid("studio_obj", valid)
    sel = st.selectbox("Object on this frame", valid, key="studio_obj",
                       format_func=lambda t: f"#{t}")
    row = frame_obs[frame_obs["track_id"] == sel].iloc[0]
    st.markdown(panel(_evidence_html(row)), unsafe_allow_html=True)

    b1, b2 = st.columns(2)
    with b1:
        if st.button(f"Track #{sel} in explorer →", width="stretch"):
            st.session_state["track_select"] = sel
            st.session_state["track_query"] = ""
            st.switch_page("pages/tracks.py")
    with b2:
        if st.button("Anomaly Center →", width="stretch"):
            st.session_state["anomaly_track_filter"] = [sel]
            st.switch_page("pages/anomaly_center.py")
    st.caption("Rule chips come from the interpretable rule engine, the "
               "Isolation Forest chip from the ML model, and scene-relative "
               "from the learned baseline - weighted separately in fusion.")


def _frame_table(res: SessionResult, idx: int) -> None:
    pv = res.previews[idx]
    frame_obs = res.obs[res.obs["frame"] == pv.frame_idx]
    section("Frame observations", "every tracked object recorded on this frame")
    if frame_obs.empty:
        st.caption("The detector reported no objects on this frame - step "
                   "through other previews or jump to an anomaly above.")
        return
    rows = frame_obs[["track_id", "level", "fused_score", "speed_px_s",
                      "direction_deg", "why"]]
    rows = rows.rename(columns={"track_id": "track", "fused_score": "fused",
                                "speed_px_s": "speed_px/s",
                                "direction_deg": "dir\u00b0"})
    st.dataframe(rows, hide_index=True, width="stretch")


def _play_tick(res: SessionResult, idx: int) -> None:
    """Advance the frame player; runs after every widget so Stop always wins."""
    if not st.session_state.get("studio_playing"):
        return
    if idx >= len(res.previews) - 1:
        st.session_state["studio_playing"] = False
        st.caption("Preview playback finished.")
        return
    st.session_state["_studio_goto"] = idx + 1
    time.sleep(PLAY_INTERVAL_S)
    st.rerun()


def _workspace(res: SessionResult) -> None:
    if not res.previews:
        st.warning("No preview frames were captured for this run.")
        return
    # deferred frame changes (buttons, jumps, player) - applied before any
    # widget is instantiated so the slider's own state picks them up
    goto = st.session_state.pop("_studio_goto", None)
    if goto is not None:
        st.session_state["studio_index"] = int(goto)
    # pending jump from other pages (event or track inspection)
    pending = st.session_state.pop("pending_frame", None)
    if pending is not None:
        st.session_state.pop("studio_obj", None)
        st.session_state["studio_index"] = _nearest_preview(res, int(pending))

    n = len(res.previews)
    idx = max(0, min(int(st.session_state.get("studio_index", 0)), n - 1))
    st.session_state["studio_index"] = idx

    body, rail = st.columns([2.35, 1.0], gap="large")
    with body:
        idx = _stage(res, idx)
    with rail:
        _rail(res, idx)
    _frame_table(res, idx)
    _play_tick(res, idx)


def main() -> None:
    page_header("Video Studio",
                "Pick a source, run the pipeline with real progress, then "
                "inspect annotated evidence frame by frame.")
    _source_controls()

    res = st.session_state.get("session_result")
    err = st.session_state.get("session_error")
    if err:
        st.error(err)
    if res is None or res.error:
        if not err:
            section("Before you start")
            c1, c2 = st.columns(2)
            with c1:
                st.markdown(panel(
                    "<h3>Input validation</h3>"
                    "<ul class='muted' style='margin:0;padding-left:1.1rem;"
                    "font-size:.86rem;line-height:1.7;'>"
                    "<li>Formats: mp4, avi, mov, mkv (anything OpenCV decodes)"
                    "</li>"
                    "<li>Upload limit 64 MB; empty, unsupported or corrupt "
                    "files are rejected with a friendly error</li>"
                    "<li>Bundled samples are <b>synthetic</b> and labelled as "
                    "such everywhere they appear</li>"
                    "<li>Frame budget caps memory: previews are strided and "
                    "downscaled</li></ul>"), unsafe_allow_html=True)
            with c2:
                st.markdown(panel(
                    "<h3>What a run does</h3>"
                    "<ol class='muted' style='margin:0;padding-left:1.1rem;"
                    "font-size:.86rem;line-height:1.7;'>"
                    "<li>HSV + contour detection per frame</li>"
                    "<li>Kalman prediction, Hungarian assignment, stable IDs"
                    "</li>"
                    "<li>Speed / direction / acceleration features</li>"
                    "<li>Scene self-calibration from observed motion</li>"
                    "<li>Rules + Isolation Forest + scene-relative fusion</li>"
                    "<li>SQLite/CSV persistence (per-session, isolated)</li>"
                    "</ol>"), unsafe_allow_html=True)
        return

    _summary(res)
    section("Video workspace",
            "annotated footage is the source of truth - boxes, IDs, trails "
            "and severity are drawn by the pipeline itself")
    _workspace(res)
    st.caption(f"Session {res.session} · source {res.source_label} · started "
               f"{res.started_ts} · ended {res.ended_ts} · previews every "
               f"6th frame, max 640 px wide")


if __name__ == "__main__":
    main()
