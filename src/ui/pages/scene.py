"""Scene Intelligence - the learned baseline: calibration status, speed
distribution, directional flow, per-track deviation from the scene norm,
restricted-zone configuration and dwell evidence, plus honest limitations.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import streamlit as st

from config.config import load_config
from src.analysis.features import _octant
from src.ui import charts
from src.ui.session import SessionResult
from src.ui.theme import (empty_state, kpi, page_header, panel,
                          require_result_or_hint, section)

_ZONE_DEFAULT = {"name": "restricted-1", "x1": 0.05, "y1": 0.05,
                 "x2": 0.35, "y2": 0.35}


def _calibration_panel(res: SessionResult) -> None:
    scene = res.scene
    if scene is None:
        st.warning("Scene statistics unavailable for this run.")
        return
    cols = st.columns(4)
    cols[0].markdown(kpi("Status", "ready" if scene.ready else "warming up",
                         f"{scene.n_samples} movement samples"),
                     unsafe_allow_html=True)
    cols[1].markdown(kpi("Speed median", f"{scene.speed_p50:.0f}",
                         f"p10 {scene.speed_p10:.0f} · p90 {scene.speed_p90:.0f}"),
                     unsafe_allow_html=True)
    cols[2].markdown(kpi("Observed", f"{scene.observed_seconds:.1f}s",
                         f"from {scene.n_tracks} distinct tracks"),
                     unsafe_allow_html=True)
    cols[3].markdown(kpi("Moving fraction", f"{scene.moving_fraction:.0%}",
                         "observations with speed > 0"), unsafe_allow_html=True)

    st.markdown(panel(
        "<h3>How this baseline was learned</h3>"
        f"<div class='muted' style='font-size:.86rem;line-height:1.75;'>"
        f"The calibrator watches every observation and collects the speed "
        f"distribution (p10/p50/p90, mean {scene.speed_mean:.0f} ± "
        f"{scene.speed_std:.0f} px/s) plus an 8-octant direction histogram. "
        f"Calibration is marked <b>ready</b> only after "
        f"{load_config().calibration.warmup_tracks} distinct tracks, "
        f"{load_config().calibration.tracks_seconds:.0f}s of observation and "
        f"{load_config().calibration.min_samples} movement samples. Rules and "
        f"scene-relative scoring stay quiet until then, so early frames are "
        f"never judged against an empty baseline. Dominant flow: "
        f"<b>{', '.join(scene.dominant_directions) or 'n/a'}</b>.</div>"),
        unsafe_allow_html=True)


def _distribution_section(res: SessionResult) -> None:
    scene = res.scene
    if res.obs.empty:
        empty_state("No observations", "Run a video in Video Studio first.")
        return
    left, right = st.columns(2)
    with left:
        section("Speed distribution", "all observations vs learned percentiles")
        if scene is not None:
            ch = charts.speed_distribution(res.obs, scene.speed_p10,
                                           scene.speed_p50, scene.speed_p90)
            if ch is not None:
                st.altair_chart(ch, width="stretch")
            else:
                st.caption("No moving observations to histogram.")
    with right:
        section("Directional flow", "share by octant; bright = dominant")
        ch = charts.direction_bars(res.obs, scene.dominant_directions if scene else [])
        if ch is not None:
            st.altair_chart(ch, width="stretch")
        else:
            st.caption("No directional observations yet.")


def _baseline_comparison(res: SessionResult) -> None:
    scene = res.scene
    section("Scene-relative comparison", "per-track deviation from the baseline")
    if scene is None or res.tracks.empty:
        st.caption("Calibration data unavailable.")
        return
    rows = []
    for _, t in res.tracks.iterrows():
        obs = res.obs[res.obs["track_id"] == t["track_id"]]
        dirs = obs["direction_deg"].dropna()
        share_dom = None
        if scene.dominant_directions and not dirs.empty:
            octs = dirs.map(lambda d: _octant(float(d)))
            share_dom = float(octs.isin(scene.dominant_directions).mean())
        ratio = (t["mean_speed_px_s"] / scene.speed_p90
                 if scene.speed_p90 > 0 else 0.0)
        if ratio > 1.5:
            verdict = "much faster than scene norm"
        elif ratio > 1.2:
            verdict = "slightly faster than scene norm"
        elif t["mean_speed_px_s"] < scene.speed_p50 / 4 and t["mean_speed_px_s"] > 1:
            verdict = "much slower than scene norm"
        elif share_dom is not None and share_dom < 0.35:
            verdict = "mostly outside the dominant flow"
        else:
            verdict = "consistent with scene norm"
        rows.append({
            "track": int(t["track_id"]),
            "mean speed": round(t["mean_speed_px_s"]),
            "vs p90": round(ratio, 2),
            "in dominant flow": (f"{share_dom:.0%}" if share_dom is not None
                                 else "n/a"),
            "assessment": verdict,
        })
    st.dataframe(rows, hide_index=True, width="stretch")
    st.caption("Assessment mirrors the scene-relative scoring logic: speed "
               "ratio against the learned p90 and direction share against the "
               "dominant flow octants.")


def _zone_editor() -> None:
    cfg = load_config()
    section("Restricted zones", "region rules - applied to the next analysis run")
    st.caption("Zones use relative coordinates (0-1) so they scale with any "
               "resolution. An object dwelling inside a zone beyond the "
               "threshold fires the 'zone_violation' rule.")
    if "zones_enabled" not in st.session_state:
        st.session_state["zones_enabled"] = cfg.zone.enabled
        st.session_state["zones"] = [dict(z) for z in cfg.zone.zones]
        st.session_state["zone_dwell"] = cfg.zone.dwell_seconds

    enabled = st.checkbox("Enable zone rules", key="zones_enabled")
    dwell = st.slider("Dwell threshold (s)", 0.5, 10.0,
                      st.session_state["zone_dwell"], 0.5, key="zone_dwell_ui")
    st.session_state["zone_dwell"] = dwell

    zones: list = st.session_state["zones"]
    for i, z in enumerate(zones):
        r1c, r2c, r3c, r4c, r5c, r6c, r7c = st.columns([1.4, .85, .85, .85, .85, .9, .5])
        with r1c:
            st.text_input("Name", value=z["name"], key=f"zn_{i}_name")
        with r2c:
            st.number_input("x1", 0.0, 1.0, float(z["x1"]), 0.05, key=f"zn_{i}_x1")
        with r3c:
            st.number_input("y1", 0.0, 1.0, float(z["y1"]), 0.05, key=f"zn_{i}_y1")
        with r4c:
            st.number_input("x2", 0.0, 1.0, float(z["x2"]), 0.05, key=f"zn_{i}_x2")
        with r5c:
            st.number_input("y2", 0.0, 1.0, float(z["y2"]), 0.05, key=f"zn_{i}_y2")
        with r6c:
            st.markdown("<div style='height:1.9rem'></div>", unsafe_allow_html=True)
            if enabled:
                st.caption(f"area {abs(float(z['x2'])-float(z['x1']))*100:.0f}×"
                           f"{abs(float(z['y2'])-float(z['y1']))*100:.0f}%")
        with r7c:
            st.markdown("<div style='height:1.9rem'></div>", unsafe_allow_html=True)
            if st.button("✕", key=f"zn_rm_{i}"):
                zones.pop(i)
                st.rerun()

    b1, b2, b3 = st.columns([1, 1, 2])
    with b1:
        if st.button("+ Add zone"):
            zones.append(dict(_ZONE_DEFAULT,
                              name=f"restricted-{len(zones)+1}"))
            st.rerun()
    with b2:
        if st.button("Apply to next run", type="primary"):
            cfg.zone.enabled = bool(st.session_state["zones_enabled"])
            cfg.zone.dwell_seconds = float(st.session_state["zone_dwell_ui"])
            cfg.zone.zones = [
                {"name": st.session_state[f"zn_{i}_name"] or f"zone-{i+1}",
                 "x1": float(st.session_state[f"zn_{i}_x1"]),
                 "y1": float(st.session_state[f"zn_{i}_y1"]),
                 "x2": float(st.session_state[f"zn_{i}_x2"]),
                 "y2": float(st.session_state[f"zn_{i}_y2"])}
                for i in range(len(zones))]
            zones.clear()
            zones.extend(cfg.zone.zones)
            st.success(f"{'Enabled' if cfg.zone.enabled else 'Disabled'}: "
                       f"{len(cfg.zone.zones)} zone(s), dwell threshold "
                       f"{cfg.zone.dwell_seconds}s. Re-run a video in Video "
                       "Studio to apply them to detections.")
    with b3:
        st.caption("Zones affect the next run only - frames already analyzed "
                   "were drawn without them.")


def _zone_evidence(res: SessionResult) -> None:
    in_zone = res.obs[res.obs["zone"].notna()] if not res.obs.empty else res.obs
    if in_zone.empty:
        return
    section("Zone dwell evidence", "from this session")
    grouped = (in_zone.groupby(["track_id", "zone"])
               .agg(frames=("frame", "count"),
                    max_dwell=("zone_dwell_s", "max"),
                    events=("level", lambda s: int((s != "Normal").sum())))
               .reset_index())
    st.dataframe(grouped.rename(columns={"track_id": "track",
                                         "max_dwell": "max dwell (s)"}),
                 hide_index=True, width="stretch")


def main() -> None:
    page_header("Scene Intelligence",
                "What the system learned about this scene - and how observed "
                "movement deviates from it.")
    if not require_result_or_hint("Scene Intelligence"):
        return
    res: SessionResult = st.session_state["session_result"]
    _calibration_panel(res)
    _distribution_section(res)
    _baseline_comparison(res)
    _zone_editor()
    _zone_evidence(res)

    with st.expander("Model & calibration limitations"):
        st.markdown(
            "- Percentiles and z-scores come from **this clip only**; a short "
            "or static clip yields a narrow baseline that flags normal variation.\n"
            "- Direction flow assumes the dominant octants describe normal "
            "movement; scenes with mixed bidirectional traffic weaken this rule.\n"
            "- Before calibration completes, rule and scene streams are "
            "muted - only the Isolation Forest contributes.\n"
            "- Zone dwell relies on source timestamps and relative frame "
            "coordinates; there is no object persistence across occlusions.\n"
            "- All units are pixels and seconds (no camera calibration).")


if __name__ == "__main__":
    main()