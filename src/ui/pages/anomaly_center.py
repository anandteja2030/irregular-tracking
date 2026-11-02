"""Anomaly Center - filterable event table, timeline, and a per-event
investigation view: evidence frame, triggered rules, Isolation-Forest and
scene-relative notes, score breakdown and a plain-English explanation.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import streamlit as st

from config.config import load_config
from src.ui import charts
from src.ui.session import SessionResult
from src.ui.theme import (badge, empty_state, kpi, page_header, panel,
                          require_result_or_hint, section)


def _apply_filters(res: SessionResult) -> "pd.DataFrame":  # noqa: F821
    import pandas as pd  # local import keeps module import order simple
    ev = res.events.copy()
    if ev.empty:
        return ev
    levels = st.session_state.get("ac_levels") or ["Suspicious", "Irregular"]
    ev = ev[ev["level"].isin(levels)]
    tracks = st.session_state.get("ac_tracks") or []
    if tracks:
        ev = ev[ev["track_id"].isin(tracks)]
    min_score = st.session_state.get("ac_min", 0.0)
    if min_score:
        ev = ev[ev["fused_score"] >= min_score]
    source = st.session_state.get("ac_source", "Any evidence stream")
    if source == "Rule-based":
        ev = ev[ev["rule_score"] > 0]
    elif source == "Isolation Forest":
        ev = ev[ev["ml_score"] >= 0.35]
    elif source == "Scene-relative":
        ev = ev[ev["scene_score"] >= 0.3]
    q = (st.session_state.get("ac_search") or "").strip().lower()
    if q:
        ev = ev[ev["why"].str.lower().str.contains(q, na=False)]
    return ev.sort_values("frame").reset_index(drop=True)


def main() -> None:
    page_header("Anomaly Center",
                "Search, filter and investigate every flagged observation - "
                "with its actual frame evidence and score breakdown.")
    if not require_result_or_hint("Anomaly Center"):
        return
    res: SessionResult = st.session_state["session_result"]
    cfg = load_config()
    all_events = res.events

    if all_events.empty:
        empty_state("No anomaly observations in this session",
                    "The pipeline classified every observation as Normal. "
                    "That is a valid outcome - try the anomaly sample clip "
                    "for a demonstration of flagged events.")
        return

    # ---------------- filters
    f1, f2, f3, f4 = st.columns([1.1, 1.2, 1.1, 1.6])
    with f1:
        st.multiselect("Severity", ["Suspicious", "Irregular"],
                       default=st.session_state.get("ac_levels",
                                                    ["Suspicious", "Irregular"]),
                       key="ac_levels")
    with f2:
        track_ids = sorted(int(t) for t in all_events["track_id"].unique())
        preset = st.session_state.pop("anomaly_track_filter",
                                      st.session_state.get("ac_tracks"))
        if preset:
            st.session_state["ac_tracks"] = [t for t in preset if t in track_ids]
        st.multiselect("Tracks", track_ids,
                       default=st.session_state.get("ac_tracks", []),
                       key="ac_tracks")
    with f3:
        st.slider("Min fused score", 0.0, 1.0,
                  st.session_state.get("ac_min", 0.0), 0.05, key="ac_min")
    with f4:
        st.selectbox("Evidence stream",
                     ["Any evidence stream", "Rule-based", "Isolation Forest",
                      "Scene-relative"],
                     key="ac_source",
                     help="Rule-based = a rule fired · Isolation Forest = "
                          "ML score >= 0.35 · Scene-relative = scene score >= 0.3")

    search = st.text_input("Search explanations", key="ac_search",
                           placeholder="speed, direction, loitering, zone…")
    ev = _apply_filters(res)

    total = len(all_events)
    c1, c2, c3, c4 = st.columns(4)
    c1.markdown(kpi("Matching events", f"{len(ev)}", f"of {total} total"),
                unsafe_allow_html=True)
    c2.markdown(kpi("Tracks involved",
                    f"{ev['track_id'].nunique() if not ev.empty else 0}",
                    "in current filter"), unsafe_allow_html=True)
    c3.markdown(kpi("Top fused score",
                    f"{ev['fused_score'].max():.2f}" if not ev.empty else "—",
                    "in current filter"), unsafe_allow_html=True)
    rules_fired = sum(len(json.loads(r or "[]")) for r in
                      (ev["rules_json"] if not ev.empty else []))
    c4.markdown(kpi("Rule fires", str(rules_fired),
                    "in matching observations"), unsafe_allow_html=True)

    if ev.empty:
        empty_state("No events match the current filters",
                    "Loosen the severity, score or evidence-stream filters to "
                    "see other flagged observations.")
        return

    # ---------------- timeline + selection
    left, right = st.columns([1.5, 1.0])
    with left:
        section("Timeline", "fused score per event - thresholds dashed")
        chart = charts.score_timeline(
            ev, cfg.anomaly.threshold_suspicious, cfg.anomaly.threshold_irregular)
        if chart is not None:
            st.altair_chart(chart, width="stretch")
    with right:
        section("Event table")
        st.dataframe(
            ev[["frame", "ts_s", "track_id", "level", "fused_score",
                "rule_score", "ml_score", "scene_score", "why"]],
            hide_index=True, width="stretch", height=320)

    section("Investigate an event")
    options = [f"f{int(r.frame)} · track {int(r.track_id)} · {r.level} · "
               f"{r.fused_score:.2f}" for r in ev.itertuples()]
    default_idx = st.session_state.pop("ac_event_default", 0)
    picked = st.selectbox("Selected event", options,
                          index=min(default_idx, len(options) - 1),
                          key="ac_selected")
    idx = options.index(picked)
    row = ev.iloc[idx]
    w = load_config().anomaly.weights

    # ---------------- evidence view
    pv_idx = min(range(len(res.previews)),
                 key=lambda i: abs(res.previews[i].frame_idx - int(row["frame"])))
    pv = res.previews[pv_idx]
    v1, v2 = st.columns([1.4, 1.0])
    with v1:
        mode = st.radio("Evidence frame", ["Annotated", "Original"],
                        horizontal=True, key="ac_mode")
        img = pv.annotated if mode == "Annotated" else pv.original
        st.image(img[:, :, ::-1], channels="RGB",
                 caption=f"{mode} · frame {pv.frame_idx} (nearest preview to "
                         f"event frame {int(row['frame'])}) · t {pv.ts_s:.2f}s")
    with v2:
        st.markdown(
            f"<div class='panel'>"
            f"<div style='display:flex;gap:.6rem;align-items:center;"
            f"flex-wrap:wrap;'>{badge(row['level'])}"
            f"<b>track {int(row['track_id'])}</b>"
            f"<span class='muted' style='font-size:.8rem;'>"
            f"frame {int(row['frame'])} · {row['ts_s']:.2f}s · "
            f"fused {row['fused_score']:.2f}</span></div>"
            f"<div style='margin:.6rem 0 .3rem;font-size:.9rem;line-height:1.55;'>"
            f"<b>Why:</b> {row['why']}</div>"
            f"<div class='muted' style='font-size:.82rem;'>"
            f"speed {row['speed_px_s']:.0f} px/s · direction "
            f"{('%.0f°' % row['direction_deg']) if row['direction_deg'] == row['direction_deg'] and row['direction_deg'] is not None else 'n/a'}"
            f" · shape {row['shape']} ({row['color']})</div></div>",
            unsafe_allow_html=True)

        section("Score breakdown", "weighted contribution to the fused score")
        st.altair_chart(charts.score_breakdown(
            round(row["rule_score"] * w["rule"], 3),
            round(row["ml_score"] * w["ml"], 3),
            round(row["scene_score"] * w["scene"], 3)),
            width="stretch")

    # ---------------- evidence streams
    st.markdown(panel(
        "<h3>Evidence streams</h3>"
        f"<div style='display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:.5rem;'>"
        + "".join(
            f"<span class='chip'>{r['rule']} · {int(r['severity']*100)}% "
            f"— {r['description']}</span>"
            for r in json.loads(row["rules_json"] or "[]"))
        + "</div>"
        + (f"<div><span class='chip ml'>Isolation Forest</span> "
           f"{row['ml_note']}</div>"
           if row["ml_score"] > 0 else "")
        + (f"<div style='margin-top:.3rem;'><span class='chip scene'>"
           f"scene-relative</span> {row['scene_note']}</div>"
           if row["scene_score"] > 0 or row["scene_note"] else "")
        + ("<div style='margin-top:.3rem;'><span class='chip'>zone</span> "
           f"inside <b>{row['zone']}</b>, dwell "
           f"{row['zone_dwell_s']:.1f}s</div>" if row["zone"] else "")
        + "</div>"),
        unsafe_allow_html=True)
    st.caption("Rule-based findings come from the interpretable rule engine; "
               "the Isolation Forest is a data-driven model score; the "
               "scene-relative stream compares against the learned baseline. "
               "They are weighted separately in the fusion.")

    a1, a2, a3 = st.columns(3)
    with a1:
        if st.button("Inspect in Video Studio →", width="stretch"):
            st.session_state["pending_frame"] = int(row["frame"])
            st.switch_page("pages/video_studio.py")
    with a2:
        if st.button(f"Open track {int(row['track_id'])} in Track Explorer →",
                     width="stretch"):
            st.session_state["track_select"] = int(row["track_id"])
            st.session_state["track_query"] = ""
            st.switch_page("pages/tracks.py")
    with a3:
        st.download_button("Export filtered events (CSV)",
                           data=ev.drop(columns=["rules_json"]).to_csv(index=False),
                           file_name="anomaly_events_filtered.csv",
                           mime="text/csv", width="stretch")


if __name__ == "__main__":
    main()
