"""Track Explorer - Phase 3 object investigation.

A searchable, filterable track table plus a per-track investigation panel:
real trajectory (screen-oriented, time-coloured, with heading ticks),
speed-over-time, movement summary, classification history and event evidence.
Every number comes from this session's observations; unavailable values are
shown as "no data" rather than zeros.
"""
from __future__ import annotations

import html
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import numpy as np
import pandas as pd
import streamlit as st

from src.analysis.features import _octant
from src.ui import charts
from src.ui.session import SessionResult
from src.ui.theme import (badge, empty_state, kpi, page_header, panel,
                          require_result_or_hint, section)

FILTERS = ("All", "Flagged only", "Clean only")


# ------------------------------------------------------------------ filtering
def _identity(row: pd.Series) -> str:
    return f"{int(row['track_id'])} {row['color']} {row['shape']} {row['worst_level']}"


def _filtered_tracks(res: SessionResult, query: str,
                     mode: str) -> pd.DataFrame:
    df = res.tracks
    if df.empty:
        return df
    if mode == "Flagged only":
        df = df[df["n_events"] > 0]
    elif mode == "Clean only":
        df = df[df["n_events"] == 0]
    if query:
        q = query.strip().lower()
        df = df[df.apply(lambda r: q in _identity(r).lower(), axis=1)]
    return df.sort_values("track_id").reset_index(drop=True)


def _track_table(df: pd.DataFrame) -> None:
    """The filterable track table - the session's real tracks and stats."""
    show = df[["track_id", "color", "shape", "first_frame", "last_frame",
               "duration_s", "n_obs", "mean_speed_px_s", "max_speed_px_s",
               "path_length_px", "straightness", "n_events", "worst_level"]]
    show = show.rename(columns={
        "track_id": "track", "first_frame": "first frame",
        "last_frame": "last frame", "duration_s": "duration s",
        "n_obs": "obs", "mean_speed_px_s": "mean px/s",
        "max_speed_px_s": "max px/s", "path_length_px": "path px",
        "straightness": "straight", "n_events": "events",
        "worst_level": "worst"})
    show["object"] = show.pop("color") + " " + show.pop("shape")
    com = show.pop("object")
    show.insert(1, "object", com)
    st.dataframe(show, hide_index=True, width="stretch",
                 height=min(max(46 + 34 * len(show), 132), 420),
        column_config={
            "track": st.column_config.NumberColumn("track"),
            "first frame": st.column_config.NumberColumn(format="%d"),
            "last frame": st.column_config.NumberColumn(format="%d"),
            "duration s": st.column_config.NumberColumn(format="%.1f"),
            "mean px/s": st.column_config.NumberColumn(format="%.0f"),
            "max px/s": st.column_config.NumberColumn(format="%.0f"),
            "path px": st.column_config.NumberColumn(format="%.0f"),
            "straight": st.column_config.NumberColumn(format="%.2f"),
        })


# ----------------------------------------------------------------- selection
def _movement_summary(row: pd.Series, obs: pd.DataFrame) -> str:
    """Plain-language movement summary built only from measured values."""
    net = float(np.hypot(row["end_x"] - row["start_x"],
                         row["end_y"] - row["start_y"]))
    peak = obs[obs["speed_px_s"] > 0]
    if not peak.empty:
        p = peak.loc[peak["speed_px_s"].idxmax()]
        peak_s = (f"peak {float(p['speed_px_s']):.0f} px/s at frame "
                  f"{int(p['frame'])} ({float(p['ts_s']):.2f}s)")
    else:
        peak_s = ("peak: no movement measured between observations "
                  "(genuine zero - the object never changed position)")
    dirs = obs["direction_deg"].dropna()
    if not dirs.empty:
        octants = dirs.map(lambda d: _octant(float(d)))
        name = octants.value_counts().index[0]
        share = float((octants == name).mean())
        dir_s = f"most common heading {name} ({share:.0%} of observations)"
    else:
        dir_s = "no heading recorded (object stationary)"
    counts = obs["level"].value_counts().to_dict()
    cls = " · ".join(
        f"{counts.get(lv, 0)} {lv}" for lv in ("Normal", "Suspicious", "Irregular"))
    return (
        f"start ({row['start_x']:.0f}, {row['start_y']:.0f}) → "
        f"end ({row['end_x']:.0f}, {row['end_y']:.0f}) · net displacement "
        f"{net:.0f} px · path {row['path_length_px']:.0f} px (straightness "
        f"{row['straightness']:.2f})<br>{peak_s} · {dir_s}<br>"
        f"classification: {html.escape(cls)} · colour/shape "
        f"{html.escape(str(row['color']))}/{html.escape(str(row['shape']))}")


def _event_investigation(obs: pd.DataFrame, tid: int) -> None:
    ev = obs[obs["level"] != "Normal"].sort_values(
        ["frame"], ascending=True).reset_index(drop=True)
    section("Event history & evidence", "every flagged observation of this "
                                          "track, in frame order")
    if ev.empty:
        st.success("No anomaly observations on this track - a clean "
                   "trajectory throughout.")
        return

    opts = [f"f{int(r.frame)} · {r.level} · fused {r.fused_score:.2f}"
            for r in ev.itertuples()]
    if st.session_state.get("track_event_pick") not in opts:
        st.session_state.pop("track_event_pick", None)
    picked = st.selectbox("Event on this track", opts, key="track_event_pick",
                          help="Select an event, then inspect its frame in "
                               "Video Studio")
    frame = int(picked.split(" ·", 1)[0][1:])
    crow = ev[ev["frame"] == frame].iloc[0]

    st.markdown(panel(
        f"<div style='display:flex;gap:.5rem;align-items:center;"
        f"flex-wrap:wrap;'>{badge(str(crow['level']))}"
        f"<span class='muted' style='font-size:.8rem;'>frame {frame} · "
        f"{float(crow['ts_s']):.2f}s · fused {float(crow['fused_score']):.2f} · "
        f"speed {float(crow['speed_px_s']):.0f} px/s</span></div>"
        f"<div style='margin-top:.4rem;font-size:.87rem;line-height:1.5;'>"
        f"<b>Why:</b> {html.escape(str(crow['why'] or 'no explanation recorded'))}</div>"),
        unsafe_allow_html=True)

    b1, b2, b3 = st.columns([1.3, 1.3, 1.0])
    with b1:
        if st.button(f"Inspect frame {frame} in Video Studio →",
                     width="stretch",
                     help="Opens the captured preview nearest to this event"):
            st.session_state["pending_frame"] = frame
            st.switch_page("pages/video_studio.py")
    with b2:
        if st.button(f"Open track {tid} in Anomaly Center →", width="stretch"):
            st.session_state["anomaly_track_filter"] = [tid]
            st.switch_page("pages/anomaly_center.py")
    with b3:
        st.download_button("Export this track (CSV)",
                           data=obs.drop(columns=["rules_json"]).to_csv(
                               index=False),
                           file_name=f"track_{tid}_observations.csv",
                           mime="text/csv", width="stretch")

    with st.expander(f"All {len(ev)} flagged observations of track {tid}",
                     expanded=False):
        st.dataframe(ev[["frame", "ts_s", "level", "fused_score",
                         "rule_score", "ml_score", "scene_score",
                         "speed_px_s", "direction_deg", "why"]],
                     hide_index=True, width="stretch")


# ---------------------------------------------------------------------- main
def main() -> None:
    page_header("Track Explorer",
                "Search tracks, then investigate one: its measured movement, "
                "trajectory, classification history and event evidence - all "
                "from this session's observations.")
    if not require_result_or_hint("Track Explorer"):
        return
    res: SessionResult = st.session_state["session_result"]

    if res.tracks.empty:
        empty_state("No tracks were formed",
                    "The detector found no qualifying objects in the processed "
                    "range. Try another source, raise the frame budget, or "
                    "generate the sample videos.")
        return

    # ---------------- filters: search + severity + picker
    search_col, filter_col, pick_col = st.columns([1.3, 1.0, 1.2])
    with search_col:
        query = st.text_input("Search tracks", placeholder="id, colour, shape…",
                              key="track_query")
    with filter_col:
        mode = st.radio("Show", list(FILTERS), horizontal=True,
                        key="track_filter",
                        help="Flagged only = tracks with ≥1 anomaly "
                             "observation; Clean only = tracks with none.")
    with pick_col:
        pass  # picker is rendered inside the same row below via "Track"

    tracks_df = _filtered_tracks(res, query, mode)
    if tracks_df.empty:
        st.warning("No tracks match that search.")
        return

    # drop a stale selection that the current filter excluded
    if st.session_state.get("track_select") not in tracks_df["track_id"]:
        st.session_state.pop("track_select", None)
    ids = tracks_df["track_id"].tolist()

    def _fmt(t: int) -> str:
        r = tracks_df[tracks_df["track_id"] == t].iloc[0]
        return (f"#{int(t)} · {r['color']} {r['shape']} · "
                f"{int(r['n_obs'])} obs · {r['worst_level']}")

    with pick_col:
        sel = st.selectbox("Track", ids, format_func=_fmt, key="track_select")

    flagged = int((res.tracks["n_events"] > 0).sum())
    st.caption(f"{len(res.tracks)} tracks in this session · {flagged} with "
               f"flagged observations · showing {len(tracks_df)} after filters")

    # ---------------- track table (primary, filterable)
    section("Track table", "every track and its measured statistics")
    _track_table(tracks_df)

    # ---------------- selected-track investigation panel
    row = tracks_df[tracks_df["track_id"] == sel].iloc[0]
    obs = res.obs[res.obs["track_id"] == sel].copy()
    if obs.empty:                      # defensive: should not happen
        empty_state("No observations recorded for this track",
                    "The track summary references observations that are not "
                    "in this session's data.")
        return

    section(f"Track #{int(sel)} investigation",
            "trajectory, movement and evidence for the selected track")

    cols = st.columns(6)
    cols[0].markdown(kpi("Duration", f"{row['duration_s']:.1f}s",
                         f"frames {int(row['first_frame'])}-{int(row['last_frame'])}"),
                     unsafe_allow_html=True)
    cols[1].markdown(kpi("Observations", f"{int(row['n_obs'])}",
                         "frames with this track"), unsafe_allow_html=True)
    cols[2].markdown(kpi("Mean speed", f"{row['mean_speed_px_s']:.0f}",
                         "px/s"), unsafe_allow_html=True)
    cols[3].markdown(kpi("Max speed", f"{row['max_speed_px_s']:.0f}",
                         "px/s"), unsafe_allow_html=True)
    cols[4].markdown(kpi("Path length", f"{row['path_length_px']:.0f}",
                         f"straightness {row['straightness']:.2f}"),
                     unsafe_allow_html=True)
    cols[5].markdown(kpi("Events", f"{int(row['n_events'])}",
                         f"worst: {row['worst_level']}",
                         accent=row["n_events"] > 0), unsafe_allow_html=True)

    st.markdown(panel(_movement_summary(row, obs)), unsafe_allow_html=True)

    t_left, t_right = st.columns([1.25, 1.0])
    with t_left:
        section("Trajectory", "observed path - screen-oriented, dots coloured "
                              "by time, ticks show measured heading")
        if len(obs) >= 2:
            st.altair_chart(charts.trajectory(obs), width="stretch")
        else:
            st.caption("Not enough positions to plot a path.")
        section("Direction mix", "octant shares of this track's motion")
        dirs = obs["direction_deg"].dropna()
        if dirs.empty:
            st.caption("No direction changes recorded (object stationary).")
        else:
            st.altair_chart(charts.direction_bars(obs, dominant=[]),
                            width="stretch")
    with t_right:
        section("Speed over time", "measured px/s at each timestamp")
        if (obs["speed_px_s"] > 0).any():
            st.altair_chart(charts.speed_series(
                obs, float(row["mean_speed_px_s"])), width="stretch")
        else:
            st.caption("This track never moved between frames (stationary) - "
                       "speed stays a genuine zero.")
        section("Classification history", "what the fusion reported at each "
                                          "observation of this track")
        st.altair_chart(charts.level_timeline(obs), width="stretch")

    _event_investigation(obs, int(sel))

    with st.expander(f"All {len(obs)} observations of track {int(sel)}",
                     expanded=False):
        st.dataframe(obs[["frame", "ts_s", "level", "fused_score",
                          "rule_score", "ml_score", "scene_score",
                          "speed_px_s", "direction_deg", "why"]],
                     hide_index=True, width="stretch")


if __name__ == "__main__":
    main()
