"""Settings - view and edit the live analysis configuration.

Every control here writes into the `SETTINGS` singleton, which the pipeline,
rule engine and fusion read when the next analysis run starts - so changes are
real, not cosmetic. Validation rejects incoherent values, and Reset restores
the shipped defaults. The environment panel reports actual installed versions
and paths.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import platform

import streamlit as st

from config.config import (AnomalyConfig, CalibrationConfig, ZoneConfig,
                           load_config)
from src.ui.theme import kpi, page_header, panel, section, status_chip

APPLIED_NOTE = ("Changes apply to the **next** analysis run - the current "
                "session's results are never recomputed.")


def _environment_panel() -> None:
    import cv2
    import numpy
    import sklearn

    cfg = load_config()
    db = Path(cfg.paths.db)
    samples = sorted(Path(cfg.paths.samples).glob("*.mp4"))

    c = st.columns(4)
    c[0].markdown(kpi("Python", sys.version.split()[0],
                      platform.system()), unsafe_allow_html=True)
    c[1].markdown(kpi("OpenCV", cv2.__version__, "headless"),
                  unsafe_allow_html=True)
    c[2].markdown(kpi("NumPy / SciPy", numpy.__version__,
                      f"sk-learn {sklearn.__version__}"), unsafe_allow_html=True)
    c[3].markdown(kpi("Streamlit", st.__version__, "dashboard runtime"),
                  unsafe_allow_html=True)

    st.markdown(panel(
        "<div class='muted' style='font-size:.83rem;line-height:1.9;'>"
        f"<b style='color:#E5E7EB'>Project root</b> <code>{_ROOT}</code><br>"
        f"<b style='color:#E5E7EB'>Samples</b> <code>{cfg.paths.samples}</code>"
        f" - {len(samples)} video(s): "
        + (", ".join(p.name for p in samples) or "none")
        + "<br>"
        f"<b style='color:#E5E7EB'>Output</b> <code>{cfg.paths.output}</code>"
        f" (annotated frames, CSV, uploads)<br>"
        f"<b style='color:#E5E7EB'>Database</b> <code>{cfg.paths.db}</code>"
        f" - {db.stat().st_size / 1024:.1f} KB on disk</div>"),
        unsafe_allow_html=True)


def _analysis_section() -> dict:
    """Editable analysis parameters; returns the staged (unapplied) values."""
    cfg = load_config()
    staged: dict = {}

    section("Classification thresholds", "where Normal ends and Suspicious / "
                                         "Irregular begin")
    c1, c2 = st.columns(2)
    with c1:
        staged["thr_suspicious"] = st.number_input(
            "Suspicious threshold (fused score ≥)", 0.05, 0.95,
            float(cfg.anomaly.threshold_suspicious), step=0.05,
            help="Observations at or above this fused score are flagged.")
    with c2:
        staged["thr_irregular"] = st.number_input(
            "Irregular threshold (fused score ≥)", 0.10, 1.00,
            float(cfg.anomaly.threshold_irregular), step=0.05,
            help="Observations at or above this fused score are Irregular.")

    section("Fusion weights", "how rule evidence, Isolation Forest and "
                              "scene deviation combine")
    w = cfg.anomaly.weights
    wc1, wc2, wc3, wc4 = st.columns([1, 1, 1, 1.2])
    with wc1:
        staged["w_rule"] = st.number_input("Rule weight", 0.0, 1.0,
                                           float(w["rule"]), step=0.05)
    with wc2:
        staged["w_ml"] = st.number_input("Isolation Forest weight", 0.0, 1.0,
                                         float(w["ml"]), step=0.05)
    with wc3:
        staged["w_scene"] = st.number_input("Scene weight", 0.0, 1.0,
                                            float(w["scene"]), step=0.05)
    total = staged["w_rule"] + staged["w_ml"] + staged["w_scene"]
    tone = "ok" if abs(total - 1.0) < 1e-6 else "warn"
    with wc4:
        st.markdown(f'<div style="padding-top:1.55rem;">'
                    f'{status_chip(tone, "Sum", f"{total:.2f}"
                                   + ("" if tone == "ok" else " · normalized on apply"))}'
                    f"</div>", unsafe_allow_html=True)

    section("Rule parameters", "expert rules fed by the calibrated baseline")
    rc1, rc2, rc3 = st.columns(3)
    with rc1:
        staged["loiter"] = st.number_input(
            "Loitering dwell (s)", 0.5, 60.0,
            float(cfg.anomaly.rule.loiter_seconds), step=0.5,
            help="Stationary for this long (with low straightness) fires the "
                 "loitering rule.")
    with rc2:
        staged["dir_dev"] = st.number_input(
            "Heading-change trigger (°)", 5.0, 180.0,
            float(cfg.anomaly.rule.direction_dev_deg), step=5.0,
            help="Consecutive heading changes at or above this fire the "
                 "erratic-heading rule.")
    with rc3:
        staged["max_z"] = st.number_input(
            "Speed z-score cap", 1.0, 10.0,
            float(cfg.anomaly.rule.max_z), step=0.5,
            help="Severity of the excessive-speed rule saturates at this many "
                 "standard deviations.")

    section("Calibration warm-up", "when the scene baseline is considered ready")
    cc1, cc2, cc3 = st.columns(3)
    with cc1:
        staged["warmup_tracks"] = st.number_input(
            "Distinct tracks", 1, 20, int(cfg.calibration.warmup_tracks), step=1)
    with cc2:
        staged["tracks_seconds"] = st.number_input(
            "Observation seconds", 1.0, 120.0,
            float(cfg.calibration.tracks_seconds), step=1.0)
    with cc3:
        staged["min_samples"] = st.number_input(
            "Movement samples", 5, 1000,
            int(cfg.calibration.min_samples), step=5)

    section("Restricted zones", "region rules applied to the next run")
    zc1, zc2 = st.columns([1, 1])
    with zc1:
        staged["zone_enabled"] = st.checkbox(
            "Enable restricted-zone rules", value=bool(cfg.zone.enabled),
            help="Zone geometry is edited on the Scene Intelligence page. "
                 "Objects dwelling inside a zone past the dwell time fire "
                 "the zone_violation rule.")
    with zc2:    staged["zone_dwell"] = st.number_input(
        "Dwell threshold (s)", 0.5, 120.0,
        float(cfg.zone.dwell_seconds), step=0.5)

    return staged


def _apply(staged: dict) -> bool:
    """Validate and write staged values into the live singleton."""
    if staged["thr_suspicious"] >= staged["thr_irregular"]:
        st.error("The Suspicious threshold must be lower than the Irregular "
                 "threshold.")
        return False
    total = staged["w_rule"] + staged["w_ml"] + staged["w_scene"]
    if total <= 0:
        st.error("At least one fusion weight must be greater than zero.")
        return False
    if staged["min_samples"] < 5 or staged["warmup_tracks"] < 1:
        st.error("Calibration needs at least 1 track and 5 movement samples.")
        return False

    cfg = load_config()
    cfg.anomaly.threshold_suspicious = float(staged["thr_suspicious"])
    cfg.anomaly.threshold_irregular = float(staged["thr_irregular"])
    cfg.anomaly.weights = {
        "rule": round(staged["w_rule"] / total, 4),
        "ml": round(staged["w_ml"] / total, 4),
        "scene": round(staged["w_scene"] / total, 4),
    }
    cfg.anomaly.rule.loiter_seconds = float(staged["loiter"])
    cfg.anomaly.rule.direction_dev_deg = float(staged["dir_dev"])
    cfg.anomaly.rule.max_z = float(staged["max_z"])
    cfg.calibration.warmup_tracks = int(staged["warmup_tracks"])
    cfg.calibration.tracks_seconds = float(staged["tracks_seconds"])
    cfg.calibration.min_samples = int(staged["min_samples"])
    cfg.zone.enabled = bool(staged["zone_enabled"])
    cfg.zone.dwell_seconds = float(staged["zone_dwell"])
    return True


def _reset() -> None:
    """Restore the shipped defaults (fresh dataclass instances)."""
    cfg = load_config()
    cfg.anomaly = AnomalyConfig()
    cfg.calibration = CalibrationConfig()
    cfg.zone = ZoneConfig()


def main() -> None:
    page_header("Settings",
                "Live analysis configuration, runtime environment and storage "
                "- everything here is real and takes effect on the next run.")
    cfg = load_config()

    st.markdown(status_chip("ok", "Config", "live singleton - shared by CLI "
                                            "and dashboard"),
                unsafe_allow_html=True)

    left, right = st.columns([1.25, 1.0])

    with left:
        staged = _analysis_section()

        st.markdown("")
        b1, b2, b3 = st.columns([1, 1, 1.4])
        with b1:
            if st.button("Apply changes", type="primary", width="stretch"):
                if _apply(staged):
                    st.session_state["_settings_flash"] = (
                        "Applied - the next analysis run uses these values.")
                    st.rerun()
        with b2:
            if st.button("Reset to defaults", width="stretch"):
                _reset()
                st.session_state["_settings_flash"] = (
                    "Defaults restored for the next run.")
                st.rerun()
        with b3:
            flash = st.session_state.pop("_settings_flash", None)
            if flash:
                st.success(flash)
            else:
                st.caption(APPLIED_NOTE)

    with right:
        section("Current configuration", "values in force right now")
        a = cfg.anomaly
        st.markdown(panel(
            "<div class='muted' style='font-size:.82rem;line-height:1.85;'>"
            f"<b style='color:#E5E7EB'>Thresholds</b> suspicious "
            f"≥ {a.threshold_suspicious:.2f} · irregular ≥ "
            f"{a.threshold_irregular:.2f}<br>"
            f"<b style='color:#E5E7EB'>Weights</b> rule "
            f"{a.weights['rule']:.2f} / forest {a.weights['ml']:.2f} / scene "
            f"{a.weights['scene']:.2f}<br>"
            f"<b style='color:#E5E7EB'>Rules</b> loiter "
            f"{a.rule.loiter_seconds:.1f}s · heading "
            f"{a.rule.direction_dev_deg:.0f}° · z-cap "
            f"{a.rule.max_z:.1f}<br>"
            f"<b style='color:#E5E7EB'>Calibration</b> "
            f"{cfg.calibration.warmup_tracks} tracks / "
            f"{cfg.calibration.tracks_seconds:.0f}s / "
            f"{cfg.calibration.min_samples} samples<br>"
            f"<b style='color:#E5E7EB'>Zones</b> "
            f"{'enabled' if cfg.zone.enabled else 'disabled'} · dwell "
            f"{cfg.zone.dwell_seconds:.1f}s · "
            f"{len(cfg.zone.zones)} defined<br>"
            f"<b style='color:#E5E7EB'>Detection</b> min area "
            f"{cfg.color.min_area:.0f} px² · "
            f"{len(cfg.color.ranges)} HSV ranges<br>"
            f"<b style='color:#E5E7EB'>Tracking</b> min hits "
            f"{cfg.tracking.min_hits} · max age {cfg.tracking.max_age} · "
            f"IoU gate {cfg.tracking.iou_gate:.2f}</div>"),
            unsafe_allow_html=True)

        section("Runtime & storage")
        _environment_panel()


if __name__ == "__main__":
    main()
