"""Multi-page dashboard shell: navigation, global sidebar status, theme.

Run with:
    .venv/bin/streamlit run src/ui/dashboard.py

Pages (each a file under src/ui/pages/):
    Overview | Video Studio | Track Explorer | Anomaly Center |
    Scene Intelligence | Evaluation & Reports | Settings

The shell owns the session lifecycle: Video Studio writes
``st.session_state["session_result"]`` (a src.ui.session.SessionResult) and
``st.session_state["analysis_state"]`` (running/done/error), and every other
page reads them. Webcam capture stays CLI-only
(``python -m scripts.run_pipeline 0``) because a deployed server has no
camera; invalid sources surface friendly errors, never tracebacks.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import streamlit as st

from config.config import load_config
from src.ui.session import cleanup_stale_uploads
from src.ui.theme import (brand_html, inject_css, status_card, status_row)

st.set_page_config(page_title=load_config().dashboard.page_title,
                   page_icon="🛡️", layout="wide",
                   initial_sidebar_state="expanded")

inject_css()

st.sidebar.markdown(brand_html(), unsafe_allow_html=True)
cleanup_stale_uploads(load_config().paths.output)

_pages = [
    st.Page("pages/overview.py", title="Overview",
            icon=":material/dashboard:", default=True),
    st.Page("pages/video_studio.py", title="Video Studio",
            icon=":material/movie:"),
    st.Page("pages/tracks.py", title="Track Explorer",
            icon=":material/travel_explore:"),
    st.Page("pages/anomaly_center.py", title="Anomaly Center",
            icon=":material/warning:"),
    st.Page("pages/scene.py", title="Scene Intelligence",
            icon=":material/place:"),
    st.Page("pages/evaluation.py", title="Evaluation & Reports",
            icon=":material/assessment:"),
    st.Page("pages/settings.py", title="Settings",
            icon=":material/settings:"),
]
_nav = st.navigation(_pages, position="sidebar")


# ---- global status card (sidebar): session / processing / calibration
def _sidebar_status() -> str:
    """Rows for the status card; every value comes from real session state."""
    res = st.session_state.get("session_result")
    err = st.session_state.get("session_error")
    state = st.session_state.get("analysis_state", "")
    ts = st.session_state.get("analysis_ts", "")

    if state == "running":
        sys_row = status_row("warn", "System", "Processing\u2026", live=True)
    elif err:
        sys_row = status_row("bad", "System", "Last run failed")
    elif res is not None and not getattr(res, "error", None):
        sys_row = status_row("ok", "System", "Ready")
    else:
        sys_row = status_row("idle", "System", "Idle\u00b7no session")

    has_run = res is not None and not getattr(res, "error", None)
    sample = (res.source_label if has_run else "\u2014")
    sample_row = status_row("ok" if has_run else "idle", "Sample", sample)

    if has_run:
        proc = (f"{res.frames_processed} frames \u00b7 {res.proc_fps:.1f} fps "
                f"\u00b7 {res.wall_s:.1f}s")
    elif ts:
        proc = f"last run {ts}"
    else:
        proc = "\u2014 awaiting first run"
    proc_row = status_row("ok" if has_run else "idle", "Process", proc)

    scene = getattr(res, "scene", None) if has_run else None
    if scene is not None and scene.ready:
        cal = status_row("ok", "Calib", f"ready \u00b7 {scene.n_samples} samples")
    elif scene is not None:
        cal = status_row("warn", "Calib",
                         f"warming \u00b7 {scene.n_samples} samples", live=True)
    else:
        cal = status_row("idle", "Calib", "\u2014 no baseline")

    sid = status_row("idle", "Session",
                     res.session if has_run else "\u2014")
    return sys_row + sample_row + proc_row + cal + sid


with st.sidebar:
    st.markdown(status_card(_sidebar_status()), unsafe_allow_html=True)
    if st.session_state.get("session_error"):
        st.error(st.session_state["session_error"])
    st.markdown(
        '<div class="muted" style="font-size:.7rem;line-height:1.6;">'
        'SQLite <code>data/app_data.db</code><br>'
        'CLI <code>python -m scripts.run_pipeline &lt;video&gt;</code>'
        "</div>", unsafe_allow_html=True)

_nav.run()
