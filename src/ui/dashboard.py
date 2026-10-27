"""Phase 7 - Streamlit dashboard.

Run with:
    .venv/bin/streamlit run src/ui/dashboard.py       (see README for exact path)

Layout:
  sidebar  - source picker (bundled samples / uploaded file), run button
  main     - annotated frame previews, level counts, scene-calibration panel,
             per-events table, track summaries, recent anomalies, CSV exports

The dashboard replays a video through the same TrackingPipeline used by the
CLI so numbers match. A webcam tab also runs the same code path (see
`process_camera`), but a webcam needs a browser/local host, so it degrades
gracefully with a notice when unavailable.
"""
from __future__ import annotations

import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# Allow launching from any working directory (streamlit run / containers):
# make the project root importable so `config`, `src`, ... resolve.
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import pandas as pd
import streamlit as st

from config.config import load_config
from src.analysis.logger import ResultLogger
from src.pipeline import TrackingPipeline
from src.video.video_input import VideoSource

st.set_page_config(page_title="Intelligent Irregular Object Tracking",
                   page_icon="👁️", layout="wide")


def _session_id() -> str:
    return datetime.now(timezone.utc).strftime("s_%H%M%S")


@st.cache_data(show_spinner=False)
def read_video_to_frames(src: str, max_frames: int | None = None):
    """Process the whole video once, returning annotated frames + stats.

    Caching keeps every Streamlit rerun instant while tuning.
    """
    with VideoSource(src=src) as vs:
        pipeline = TrackingPipeline(session=_session_id())
        frames, entries = [], []
        total = vs.frame_count() or max_frames or 1
        processed = 0
        for vf in vs:
            res = pipeline.process_frame(vf.bgr, vf.index, vf.fps)
            if processed % 6 == 0:             # ~6 fps preview cadence
                frames.append(res.annotated_bgr)
            entries.extend(dict(e, frame=e["frame_idx"]) for e in res.entries)
            processed += 1
            if max_frames and processed >= max_frames:
                break
        summaries = pipeline.summarize_tracks(vs.fps)
        return frames, pd.DataFrame(entries), summaries, pipeline


def summarize_frames(entries_df: pd.DataFrame) -> Counter:
    if entries_df.empty:
        return Counter()
    return Counter(entries_df["level"].tolist())


def track_summaries_frame(summaries: list[dict]) -> pd.DataFrame:
    rows = []
    for s in summaries:
        stats = s["stats"]
        rows.append({
            "track": s["track_id"], "color": s["color"], "shape": s["shape"],
            "seconds": round(stats.n_seconds, 2),
            "mean_speed_px_s": round(stats.mean_speed_px_s, 1),
            "max_speed_px_s": round(stats.max_speed_px_s, 1),
            "path_length_px": round(stats.path_length_px, 1),
            "straightness": round(stats.straightness, 3),
        })
    return pd.DataFrame(rows)


def main() -> None:
    cfg = load_config()
    st.title("Intelligent Irregular Object Tracking & Scene-Aware Anomaly Detection")
    st.caption("Colour/contour detection, Kalman+Hungarian tracking, "
               "self-calibration, rule + Isolation-Forest fusion")

    samples = sorted(Path(cfg.paths.samples).glob("*.mp4"))
    with st.sidebar:
        st.header("Input")
        options = [f"sample: {p.name}" for p in samples]
        upload_placeholder = st.empty()
        uploaded = upload_placeholder.file_uploader(
            "or upload a video (mp4/avi)", type=["mp4", "avi", "mov", "mkv"])
        if uploaded is not None:
            tmp = Path(cfg.paths.output) / f"upload_{uploaded.name}"
            tmp.write_bytes(uploaded.getvalue())
            options.append(f"upload: {uploaded.name}")
        src_label = st.selectbox("choose", options, index=0 if options else None)
        max_frames = st.slider("process up to N frames", 50, 1200, 450, step=50)
        run = st.button("Run pipeline", type="primary")

    if not run or src_label is None:
        if not samples and uploaded is None:
            st.info("No sample videos found. Generate them with "
                    "`python scripts/generate_samples.py` or upload a file.")
        else:
            st.info("Pick a source and press **Run pipeline**.")
        return

    src = (Path(cfg.paths.samples) / src_label.split("sample: ", 1)[1]
           if src_label.startswith("sample:") else
           Path(cfg.paths.output) / f"upload_{src_label.split('upload: ', 1)[1]}")

    with st.spinner("Replaying video through the tracking pipeline..."):
        frames, df, summaries, pipeline = read_video_to_frames(str(src),
                                                              int(max_frames))

    # ---- top: annotated preview
    st.subheader("Annotated frames (preview every ~6th frame)")
    if frames:
        idx = st.slider("frame preview", 0, len(frames) - 1, 0)
        st.image(frames[idx][:, :, ::-1], channels="RGB")
    else:
        st.warning("no frames processed - check the source file")

    # ---- counts
    c1, c2, c3, c4 = st.columns(4)
    counts = summarize_frames(df)
    c1.metric("Normal", counts.get("Normal", 0))
    c2.metric("Suspicious", counts.get("Suspicious", 0))
    c3.metric("Irregular", counts.get("Irregular", 0))
    c4.metric("Distinct tracks", len(summaries))
    st.caption(f"calibrated: {pipeline.calibrator.is_ready()} "
               f"({pipeline.calibrator.stats().n_samples} movement samples)")

    # ---- events
    st.subheader("Detected anomalies & explanations")
    if df.empty:
        st.write("No tracked objects found.")
    else:
        show = df[df["level"] != "Normal"]
        if show.empty:
            st.success("No anomalies detected in the processed range.")
        else:
            st.dataframe(show[["frame", "track_id", "level", "fused_score",
                               "speed_px_s", "direction_deg", "why"]])

    # ---- summaries
    st.subheader("Trajectory summaries")
    ts_df = track_summaries_frame(summaries)
    st.dataframe(ts_df)

    # ---- persistence + export
    st.subheader("Export")
    csv_path = Path(cfg.paths.output) / "dashboard_events.csv"
    kept = df.to_csv(index=False)
    st.download_button("Downloads: per-observation CSV (this session)",
                       data=kept, file_name="dashboard_events.csv",
                       mime="text/csv")
    traj_csv_path = Path(cfg.paths.output) / "dashboard_track_summaries.csv"
    st.download_button("Download: trajectory summaries CSV",
                       data=ts_df.to_csv(index=False),
                       file_name="dashboard_track_summaries.csv",
                       mime="text/csv")
    if st.button("Append summaries to session database"):
        log = ResultLogger(cfg.paths.db, session=_session_id())
        try:
            for s in summaries:
                stats = s["stats"]
                log.log_track_summary(stats, s["color"], s["shape"],
                                      s["first_frame"], s["last_frame"])
            st.success(f"Summary rows appended to {cfg.paths.db}")
        finally:
            log.close()


if __name__ == "__main__":
    main()
