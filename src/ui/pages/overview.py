"""Overview - the executive dashboard.

Top: project title, subtitle and a live system-status strip (every chip reads
real state: pipeline phase, calibration, the SQLite file, bundled samples).
Then a KPI row (Normal / Suspicious / Irregular / Active tracks), recent
alerts, the activity timeline and the sample gallery.

Before a run the screen is complete and honest - placeholder dashes, never
invented numbers. After a run every value comes from the session.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import streamlit as st

from config.config import load_config
from src.ui import charts
from src.ui.session import is_synthetic_source
from src.ui.theme import (badge, empty_state, inject_css, kpi, page_header,
                          panel, section, status_chip)

SAMPLE_DESC = {
    "normal_traffic.mp4": ("Baseline scene", "300 frames - two steady objects, "
                            "used to demonstrate self-calibration and a clean "
                            "0-irregular run."),
    "anomaly_clip.mp4": ("Anomaly demo", "420 frames - adds a fast runner and a "
                         "slow loiterer; expect Suspicious/Irregular verdicts "
                         "with written explanations."),
    "tiny_noise.mp4": ("Robustness", "40 frames - sensor speckle only; the "
                       "detector should find nothing and not crash."),
}


def _load_sample(name: str) -> None:
    st.session_state["pending_source"] = f"sample: {name}"
    st.session_state["auto_run"] = True
    st.switch_page("pages/video_studio.py")


# ------------------------------------------------------------- status strip
def _system_status() -> None:
    """Live system status: five chips, each backed by real state."""
    cfg = load_config()
    res = st.session_state.get("session_result")
    err = st.session_state.get("session_error")
    state = st.session_state.get("analysis_state", "")
    has_run = res is not None and not getattr(res, "error", None)

    if state == "running":
        pipeline = ("warn", "Pipeline", "processing", True)
    elif err:
        pipeline = ("bad", "Pipeline", "last run failed", False)
    elif has_run:
        pipeline = ("ok", "Pipeline", "ready", False)
    else:
        pipeline = ("idle", "Pipeline", "idle", False)

    scene = getattr(res, "scene", None) if has_run else None
    if scene is not None and scene.ready:
        calib = ("ok", "Calibration", f"ready · {scene.n_samples} samples", False)
    elif scene is not None:
        calib = ("warn", "Calibration", f"warming · {scene.n_samples}", True)
    else:
        calib = ("idle", "Calibration", "no baseline", False)

    db = Path(cfg.paths.db)
    if db.exists():
        kb = db.stat().st_size / 1024
        storage = ("ok", "Storage", f"sqlite · {kb:.0f} KB", False)
    else:
        storage = ("idle", "Storage", "not initialised", False)

    n_samples = len(list(Path(cfg.paths.samples).glob("*.mp4")))
    samples = ("ok" if n_samples else "warn", "Samples",
               f"{n_samples} bundled" if n_samples else "none found", False)

    last = ("ok", "Last run", "none yet" if not has_run
            else f"{res.frames_processed} frames · {res.proc_fps:.1f} fps", False)

    chips = "".join(status_chip(*c) for c in
                    (pipeline, calib, storage, samples, last))
    st.markdown(f'<div class="status-strip">{chips}</div>',
                unsafe_allow_html=True)


def _project_header() -> None:
    st.markdown(
        '<h1>NEURAL COMMAND</h1>'
        '<p class="muted" style="margin:.05rem 0 .7rem;font-size:.9rem;">'
        'Intelligent Surveillance &amp; Anomaly Intelligence - intelligent '
        'irregular object tracking with HSV/contour detection, Kalman '
        'tracking, self-calibrating baselines and explainable Normal / '
        'Suspicious / Irregular verdicts.</p>',
        unsafe_allow_html=True)
    _system_status()


# ----------------------------------------------------------- sample gallery
def _sample_gallery(compact: bool = False) -> None:
    cfg = load_config()
    if not compact:
        section("Bundled samples", "synthetic demonstration footage - clearly "
                                   "disclosed, never presented as real data")
    else:
        section("Run another sample", "synthetic demonstration footage")
    samples = sorted(Path(cfg.paths.samples).glob("*.mp4"))
    if not samples:
        empty_state("No sample videos found",
                    "Generate them with `python scripts/generate_samples.py` "
                    "or upload your own video in Video Studio.")
        return
    cols = st.columns(min(3, len(samples)))
    for i, p in enumerate(samples):
        title, desc = SAMPLE_DESC.get(p.name, (p.name, "Bundled sample video."))
        with cols[i % len(cols)]:
            st.markdown(
                panel(
                    "<div style='display:flex;justify-content:space-between;"
                    "align-items:center;gap:.5rem;'>"
                    f"<b style='font-size:.92rem'>{title}</b>"
                    "<span class='badge neutral'>synthetic</span></div>"
                    "<div style='font-family:monospace;font-size:.76rem;"
                    f"color:#8A94A8;margin:.2rem 0 .4rem;'>{p.name}</div>"
                    "<div class='muted' style='font-size:.84rem;"
                    f"line-height:1.55;'>{desc}</div>"),
                unsafe_allow_html=True)
            if st.button("Analyze →", key=f"load_{p.name}",
                         width="stretch"):
                _load_sample(p.name)


# ------------------------------------------------------------- empty state
def _empty_screen() -> None:
    cfg = load_config()
    # placeholder KPI row: dashes, never fabricated zeros
    c = st.columns(4)
    for i, (lab, sub) in enumerate([
            ("Normal", "awaiting analysis"), ("Suspicious", "awaiting analysis"),
            ("Irregular", "awaiting analysis"),
            ("Active tracks", "no session yet")]):
        c[i].markdown(kpi(lab, "—", sub), unsafe_allow_html=True)

    st.markdown(
        panel(
            "<div style='text-align:center;padding:1.1rem .6rem;'>"
            "<div style='font-size:1.5rem;opacity:.8;'>&#9670;</div>"
            "<div style='font-weight:660;margin:.45rem 0 .25rem;'>"
            "No analysis has been run yet</div>"
            "<div class='muted' style='font-size:.87rem;max-width:560px;"
            "margin:0 auto;line-height:1.55;'>Open <b style='color:#E5E7EB'>"
            "Video Studio</b> to analyze a bundled sample or upload your own "
            "video, or start one of the samples below. Every card, chart and "
            "metric on this page is populated from the real session data of "
            "your latest run.</div></div>"),
        unsafe_allow_html=True)
    if st.button("Open Video Studio", type="primary", width="stretch"):
        st.switch_page("pages/video_studio.py")

    section("Project capabilities")
    st.markdown(panel(
        "<div style='display:flex;flex-wrap:wrap;gap:.6rem;'>"
        + "".join(
            f"<span class='chip'>{t}</span>" for t in [
                "HSV + contour detection",
                "Kalman filter + Hungarian assignment",
                "stable track IDs & trajectories",
                "speed / direction / acceleration features",
                "scene self-calibration",
                "rule engine + Isolation Forest fusion",
                "Normal / Suspicious / Irregular + explanations",
                "SQLite & CSV persistence",
                "restricted-zone dwell rules"]) + "</div>"),
        unsafe_allow_html=True)

    _sample_gallery()

    section("Pipeline stages")
    st.markdown(panel(
        "<div class='muted' style='font-size:.86rem;line-height:1.9;'>"
        "<b style='color:#E5E7EB'>1 · See & track</b> - video input, "
        "preprocessing, HSV/contour detection → Kalman prediction, Hungarian "
        "matching, unique IDs, trajectory history<br>"
        "<b style='color:#E5E7EB'>2 · Learn & analyze</b> - kinematic "
        "features, self-calibrating scene baseline, per-object and "
        "scene-relative behaviour<br>"
        "<b style='color:#E5E7EB'>3 · Detect, explain & show</b> - "
        "interpretable rules + Isolation Forest, weighted fusion, severity "
        "levels, OpenCV overlays, dashboard & reports</div>"),
        unsafe_allow_html=True)


# ----------------------------------------------------------- session screen
def _session_screen() -> None:
    res = st.session_state["session_result"]
    cfg = load_config()
    counts = res.level_counts
    events = res.events

    if res.is_synthetic:
        st.markdown('<span class="badge neutral">synthetic sample footage</span>'
                    ' <span class="muted" style="font-size:.8rem;">this '
                    "session analyzes generated demonstration video, not "
                    "real-world surveillance data</span>",
                    unsafe_allow_html=True)

    # KPI row: Normal / Suspicious / Irregular / Active tracks
    c = st.columns(4)
    c[0].markdown(kpi("Normal", str(counts["Normal"]),
                      "observations classified normal", accent=False),
                  unsafe_allow_html=True)
    c[1].markdown(kpi("Suspicious", str(counts["Suspicious"]),
                      "flagged by fusion ≥ 0.35",
                      accent=counts["Suspicious"] > 0), unsafe_allow_html=True)
    c[2].markdown(kpi("Irregular", str(counts["Irregular"]),
                      "highest severity ≥ 0.65",
                      accent=counts["Irregular"] > 0), unsafe_allow_html=True)
    c[3].markdown(kpi("Active tracks", str(len(res.tracks)),
                      f"{len(res.obs)} observations"),
                  unsafe_allow_html=True)

    left, right = st.columns([1.08, 1.0])

    # ---- recent alerts
    with left:
        section("Recent alerts", "highest fused scores first - each links "
                                 "to its evidence in the Anomaly Center")
        if events.empty:
            empty_state("No alerts in this session",
                        "Every observation in this run was classified "
                        "Normal. A clean result is still a result - inspect "
                        "the tracks and the scene baseline in the other "
                        "pages.")
        else:
            top = events.sort_values("fused_score", ascending=False).head(6)
            html = ""
            for _, r in top.iterrows():
                html += (
                    '<div class="panel" style="padding:.62rem .85rem;'
                    'margin-bottom:.5rem;">'
                    '<div style="display:flex;gap:.7rem;align-items:center;'
                    'flex-wrap:wrap;">'
                    f"{badge(r['level'])}"
                    f'<b style="font-size:.87rem;">track '
                    f'{int(r["track_id"])}</b>'
                    '<span class="muted" style="font-size:.77rem;">'
                    f'frame {int(r["frame"])} · t {r["ts_s"]:.2f}s</span>'
                    '<span class="chip" style="margin-left:auto;">fused '
                    f'{r["fused_score"]:.2f}</span></div>'
                    '<div class="muted" style="font-size:.83rem;'
                    f'margin-top:.32rem;">{r["why"]}</div></div>')
            st.markdown(html, unsafe_allow_html=True)
            if st.button("Open Anomaly Center →", width="stretch"):
                st.switch_page("pages/anomaly_center.py")

    # ---- recent activity timeline
    with right:
        section("Recent activity", "fused anomaly score per observation "
                                   "over the run")
        if events.empty:
            empty_state("Timeline empty",
                        "No non-Normal observations to plot for this run.")
        else:
            chart = charts.score_timeline(
                events, cfg.anomaly.threshold_suspicious,
                cfg.anomaly.threshold_irregular)
            if chart is not None:
                st.altair_chart(chart, width="stretch")

        section("Activity log", "latest flagged observations")
        if not events.empty:
            recent = events.sort_values("frame", ascending=False).head(6)
            rows = "".join(
                '<div class="st-row" style="gap:.5rem;padding:.28rem 0;'
                'border-bottom:1px solid #172033;">'
                f'<span class="dot {"bad" if r["level"] == "Irregular" else "warn"}"></span>'
                f'<span class="muted" style="font-size:.76rem;min-width:76px;">'
                f'f{int(r["frame"])} · {r["ts_s"]:.1f}s</span>'
                f'<span style="font-size:.79rem;">track '
                f'{int(r["track_id"])} - {r["level"]}</span></div>'
                for _, r in recent.iterrows())
            st.markdown(f'<div class="panel" style="padding:.55rem .8rem;">'
                        f"{rows}</div>", unsafe_allow_html=True)

    # ---- session detail + classification mix
    section("Session summary")
    sc = st.columns(3)
    with sc[0]:
        st.markdown(panel(
            "<div class='lab muted' style='font-size:.7rem;letter-spacing:"
            ".1em;text-transform:uppercase;'>Source</div>"
            f"<div style='font-weight:640;font-size:.9rem;margin-top:.15rem;'>"
            f"{res.source_label}</div>"
            f"<div class='muted' style='font-size:.8rem;'>{res.source_kind} · "
            f"{res.frame_width}×{res.frame_height} @ {res.fps:.1f} fps</div>"),
            unsafe_allow_html=True)
    with sc[1]:
        st.markdown(panel(
            "<div class='lab muted' style='font-size:.7rem;letter-spacing:"
            ".1em;text-transform:uppercase;'>Processing</div>"
            f"<div style='font-weight:640;font-size:.9rem;margin-top:.15rem;'>"
            f"{res.frames_processed} frames in {res.wall_s:.1f} s</div>"
            f"<div class='muted' style='font-size:.8rem;'>{res.proc_fps:.1f} "
            f"fps · window {res.max_frames or 'full'}</div>"),
            unsafe_allow_html=True)
    with sc[2]:
        scene = res.scene
        st.markdown(panel(
            "<div class='lab muted' style='font-size:.7rem;letter-spacing:"
            ".1em;text-transform:uppercase;'>Calibration</div>"
            f"<div style='font-weight:640;font-size:.9rem;margin-top:.15rem;'>"
            f"{'ready' if scene and scene.ready else 'warming up'}</div>"
            f"<div class='muted' style='font-size:.8rem;'>"
            f"{scene.n_samples if scene else 0} movement samples</div>"),
            unsafe_allow_html=True)

    _sample_gallery(compact=True)


def main() -> None:
    _project_header()
    res = st.session_state.get("session_result")
    err = st.session_state.get("session_error")
    if err and (res is None or res.error):
        st.error(err)
    if res is None or res.error:
        _empty_screen()
    else:
        _session_screen()


if __name__ == "__main__":
    main()
