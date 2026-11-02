"""Altair chart builders shared by the pages - every chart is fed real
session DataFrames; nothing is sampled, jittered or synthesised here.
"""
from __future__ import annotations

import altair as alt
import numpy as np
import pandas as pd

from src.analysis.features import _octant

ACCENT = "#8b5cf6"      # electric violet
CYAN = "#22d3ee"
OK = "#34d399"
WARN = "#fbbf24"
BAD = "#f87171"
MUTED = "#9aa3b8"
LEVEL_COLOR = {"Normal": OK, "Suspicious": WARN, "Irregular": BAD}


def dark(chart: alt.Chart) -> alt.Chart:
    return (chart
            .configure_axis(labelColor=MUTED, titleColor=MUTED,
                            gridColor="rgba(255,255,255,.06)",
                            domainColor="rgba(255,255,255,.12)",
                            tickColor="rgba(255,255,255,.12)")
            .configure_view(strokeOpacity=0)
            .configure_legend(labelColor=MUTED, titleColor=MUTED,
                              symbolStrokeWidth=0)
            .configure_range(category=[OK, WARN, BAD, ACCENT]))


def level_distribution(counts: dict) -> alt.Chart:
    df = pd.DataFrame({"level": list(counts.keys()),
                       "observations": list(counts.values())})
    return dark(
        alt.Chart(df).mark_bar(cornerRadiusTopLeft=6, cornerRadiusTopRight=6,
                               size=26).encode(
            x=alt.X("observations:Q", title=None),
            y=alt.Y("level:N", title=None,
                    sort=["Normal", "Suspicious", "Irregular"]),
            color=alt.Color("level:N", scale=alt.Scale(
                domain=["Normal", "Suspicious", "Irregular"],
                range=[OK, WARN, BAD]), legend=None),
            tooltip=["level", "observations"],
        ).properties(height=140))


def score_timeline(events: pd.DataFrame, suspicious: float,
                   irregular: float) -> alt.Chart:
    if events.empty:
        return None
    base = alt.Chart(events).encode(
        x=alt.X("frame:Q", title="frame"),
        y=alt.Y("fused_score:Q", title="fused anomaly score",
                scale=alt.Scale(domain=[0, 1])),
        color=alt.Color("level:N",
                        scale=alt.Scale(domain=["Suspicious", "Irregular"],
                                        range=[WARN, BAD]),
                        legend=alt.Legend(orient="top-left", symbolType="circle")),
        tooltip=["frame", "ts_s", "track_id", "level", "fused_score", "why"],
    )
    th = alt.Chart(pd.DataFrame({
        "y": [suspicious, irregular],
        "label": [f"Suspicious {suspicious}", f"Irregular {irregular}"]})).mark_rule(
        strokeDash=[4, 4], color=MUTED).encode(y="y:Q")
    lbl = alt.Chart(pd.DataFrame({
        "y": [suspicious, irregular],
        "label": [f"Suspicious {suspicious}", f"Irregular {irregular}"]})).mark_text(
        align="left", dx=4, dy=-4, color=MUTED, fontSize=10).encode(
        y="y:Q", text="label")
    return dark(base.mark_circle(size=70).encode(opacity=alt.value(0.9))
                + th + lbl).properties(height=300)


def speed_series(track_obs: pd.DataFrame, mean_speed: float) -> alt.Chart:
    line = alt.Chart(track_obs).mark_line(color=ACCENT, strokeWidth=2).encode(
        x=alt.X("ts_s:Q", title="time (s)"),
        y=alt.Y("speed_px_s:Q", title="speed (px/s)"),
        tooltip=["frame", "ts_s", "speed_px_s", "direction_deg", "level"])
    ref = alt.Chart(pd.DataFrame({"y": [mean_speed],
                                  "lab": [f"mean {mean_speed:.0f}"]})).mark_rule(
        color=WARN, strokeDash=[5, 4]).encode(y="y:Q")
    lab = alt.Chart(pd.DataFrame({"y": [mean_speed],
                                  "lab": [f"mean {mean_speed:.0f}"]})).mark_text(
        align="right", dx=-4, dy=-4, color=WARN, fontSize=10).encode(
        y="y:Q", text="lab")
    return dark((line + ref + lab).interactive()).properties(height=260)


def trajectory(points: pd.DataFrame) -> alt.Chart:
    """Observed centroid path of one track (real positions, frame order).

    The y axis is reversed so the path matches the video frame's screen
    orientation (cy grows downwards in an image). Dots are coloured by time
    progression and heading ticks show the measured direction of motion at a
    strided sample of observations - all values come from the session data.
    """
    path = alt.Chart(points).mark_line(color=ACCENT, strokeWidth=1.4,
                                       opacity=.75).encode(
        x=alt.X("cx:Q", title="x (px)"),
        y=alt.Y("cy:Q", title="y (px, screen down)",
                scale=alt.Scale(reverse=True)),
        order="frame:Q")
    dots = alt.Chart(points).mark_circle(size=40, opacity=.9).encode(
        x="cx:Q", y=alt.Y("cy:Q", scale=alt.Scale(reverse=True)),
        order="frame:Q",
        color=alt.Color("ts_s:Q", scale=alt.Scale(scheme="viridis"),
                        legend=alt.Legend(title="time (s)", orient="top-left",
                                          symbolType="circle")),
        tooltip=["frame", "ts_s", "cx", "cy", "speed_px_s", "level"])
    layers = [path, dots]
    dirs = points[points["direction_deg"].notna()]
    if len(dirs) >= 2:
        stride = max(1, len(dirs) // 10)
        arrows = dirs.iloc[::stride].copy()
        k = 26.0
        arrows["x2"] = arrows["cx"] + k * np.cos(
            np.radians(arrows["direction_deg"]))
        arrows["y2"] = arrows["cy"] - k * np.sin(
            np.radians(arrows["direction_deg"]))
        layers.append(alt.Chart(arrows).mark_rule(
            color=ACCENT, opacity=.55, strokeWidth=1.5).encode(
            x="cx:Q", y=alt.Y("cy:Q", scale=alt.Scale(reverse=True)),
            x2=alt.X2("x2:Q"), y2=alt.Y2("y2:Q"),
            tooltip=["frame", "ts_s", "speed_px_s",
                     alt.Tooltip("direction_deg:Q", title="heading (deg, 0=E)")]))
    ends = alt.Chart(pd.concat([
        points.iloc[[0]].assign(tag="start"),
        points.iloc[[-1]].assign(tag="end")])).mark_point(
        shape="triangle-up", size=160, filled=True).encode(
        x="cx:Q", y=alt.Y("cy:Q", scale=alt.Scale(reverse=True)),
        color=alt.Color("tag:N", scale=alt.Scale(domain=["start", "end"],
                                                 range=[OK, BAD]),
                        legend=None),
        shape="tag:N", tooltip=["tag", "frame", "ts_s", "cx", "cy"])
    layers.append(ends)
    return dark(alt.layer(*layers).interactive()).properties(height=330)


def level_timeline(track_obs: pd.DataFrame) -> alt.Chart:
    """Classification history of one track: what the fusion called each
    observation, over the track's own timeline (real levels, no aggregation)."""
    df = track_obs[["frame", "ts_s", "level", "fused_score", "why"]].copy()
    return dark(
        alt.Chart(df).mark_circle(size=55, opacity=.85).encode(
            x=alt.X("ts_s:Q", title="time (s)"),
            y=alt.Y("level:N", title=None,
                    sort=["Normal", "Suspicious", "Irregular"]),
            color=alt.Color("level:N", scale=alt.Scale(
                domain=["Normal", "Suspicious", "Irregular"],
                range=[OK, WARN, BAD]), legend=None),
            tooltip=["frame", "ts_s", "level", "fused_score", "why"],
        ).properties(height=150))


def direction_bars(obs: pd.DataFrame, dominant: list[str]) -> alt.Chart:
    dirs = obs["direction_deg"].dropna()
    if dirs.empty:
        return None
    octs = dirs.map(lambda d: _octant(float(d)))
    df = (octs.value_counts().rename_axis("direction").reset_index(name="count"))
    df["share"] = df["count"] / df["count"].sum()
    df["dominant"] = df["direction"].isin(dominant or [])
    return dark(
        alt.Chart(df).mark_bar(cornerRadiusTopLeft=5, cornerRadiusTopRight=5,
                               size=30).encode(
            x=alt.X("direction:N", title=None,
                    sort=["E", "NE", "N", "NW", "W", "SW", "S", "SE"]),
            y=alt.Y("share:Q", title="share of observations",
                    axis=alt.Axis(format=".0%")),
            color=alt.Color("dominant:N",
                            scale=alt.Scale(domain=[True, False],
                                            range=[ACCENT, "rgba(255,255,255,.14)"]),
                            legend=None),
            tooltip=["direction", "count",
                     alt.Tooltip("share:Q", format=".1%")],
        ).properties(height=220))


def speed_distribution(obs: pd.DataFrame, p10: float, p50: float,
                       p90: float) -> alt.Chart:
    speeds = obs.loc[obs["speed_px_s"] > 0, "speed_px_s"]
    if speeds.empty:
        return None
    hist = alt.Chart(pd.DataFrame({"speed": speeds})).mark_bar(
        color=ACCENT, opacity=.85, cornerRadiusTopLeft=4,
        cornerRadiusTopRight=4).encode(
        x=alt.X("speed:Q", bin=alt.Bin(maxbins=28), title="speed (px/s)"),
        y=alt.Y("count():Q", title=None),
        tooltip=["count()"])
    rules = alt.Chart(pd.DataFrame({
        "v": [p10, p50, p90],
        "lab": [f"p10 {p10:.0f}", f"median {p50:.0f}", f"p90 {p90:.0f}"]})).mark_rule(
        color=WARN, strokeDash=[5, 4]).encode(x="v:Q")
    labels = alt.Chart(pd.DataFrame({
        "v": [p10, p50, p90],
        "lab": [f"p10 {p10:.0f}", f"median {p50:.0f}", f"p90 {p90:.0f}"]})).mark_text(
        align="left", dx=3, dy=-6, color=WARN, fontSize=10).encode(
        x="v:Q", text="lab")
    return dark(hist + rules + labels).properties(height=240)


def score_breakdown(rule_w: float, ml_w: float, scene_w: float) -> alt.Chart:
    df = pd.DataFrame({
        "stream": ["Rules", "Isolation Forest", "Scene-relative"],
        "contribution": [rule_w, ml_w, scene_w]})
    return dark(
        alt.Chart(df).mark_bar(cornerRadiusEnd=5, size=22).encode(
            x=alt.X("contribution:Q", title="weighted contribution to fused score"),
            y=alt.Y("stream:N", title=None),
            color=alt.Color("stream:N",
                            scale=alt.Scale(domain=["Rules",
                                                    "Isolation Forest",
                                                    "Scene-relative"],
                                            range=["#8b5cf6", "#22d3ee",
                                                   "#60a5fa"]),
                            legend=None),
            tooltip=["stream", "contribution"],
        ).properties(height=150))
