"""Phase 5 unit tests: rules, Isolation Forest, fusion, explanations."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, ROOT)

from src.anomaly.rules import RuleEngine, RuleSignal
from src.anomaly.isolation import IsolationAnomalyDetector
from src.anomaly.fusion import AnomalyFusion, explain, LEVEL_NORMAL, LEVEL_SUSPICIOUS, LEVEL_IRREGULAR
from src.analysis.calibration import SceneStats
from src.analysis.features import MovementSnapshot, TrajectoryStats


def _snap(speed=50.0, direction=0.0, heading=None, accel=0.0, track_id=1):
    return MovementSnapshot(
        frame_idx=0, track_id=track_id, centroid=(0, 0),
        speed_px_s=speed, direction_deg=direction,
        acceleration_px_s2=accel, heading_change_deg=heading, bbox_wh=(10, 10))


def _stats(mean=50.0, std=8.0, n=200, dirs=None, ready=True, dom=("E",)):
    return SceneStats(
        ready=ready, n_samples=n, n_tracks=3, observed_seconds=30.0,
        speed_p10=mean - 1.3 * std, speed_p50=mean, speed_p90=mean + 1.3 * std,
        speed_mean=mean, speed_std=std,
        direction_hist=dirs or {"E": 1.0},
        dominant_directions=list(dom), moving_fraction=0.9)


# ------------------------------------------------------------------ rules
def test_excessive_speed_fires_when_calibrated():
    sig = RuleEngine().rule_excessive_speed(_snap(speed=100.0), _stats(mean=50, std=8))
    assert sig and sig[0].rule == "excessive_speed" and sig[0].severity > 0.5


def test_excessive_speed_quiet_when_not_calibrated():
    stats = _stats()
    stats.n_samples = 5
    sig = RuleEngine().rule_excessive_speed(_snap(speed=200.0), stats)
    assert not sig


def test_against_flow_fires_only_when_calibrated_and_offset():
    re = RuleEngine()
    stats = _stats()
    assert re.rule_against_flow(_snap(direction=270.0), stats)     # S vs dominant E
    stats2 = _stats()
    stats2.ready = False
    assert not re.rule_against_flow(_snap(direction=270.0), stats2)
    assert not re.rule_against_flow(_snap(direction=10.0), stats)  # E is dominant


def test_erratic_heading_threshold():
    re = RuleEngine()
    assert not re.rule_erratic_heading(_snap(heading=15.0))
    sig = re.rule_erratic_heading(_snap(heading=120.0))
    assert sig and sig[0].rule == "erratic_heading" and sig[0].severity >= 0.3


def test_sudden_acceleration():
    re = RuleEngine()
    assert not re.rule_sudden_accel(_snap(accel=100.0), None)
    sig = re.rule_sudden_accel(_snap(accel=1500.0), None)
    assert sig and sig[0].rule == "sudden_acceleration" and sig[0].severity >= 0.25


def test_loitering_with_trajectory_stats():
    re = RuleEngine()
    traj = TrajectoryStats(track_id=1, n_points=30, n_seconds=5.0,
                           mean_speed_px_s=20.0, max_speed_px_s=30.0,
                           path_length_px=40.0, net_displacement_px=15.0,
                           straightness=0.4, direction_hist={},
                           dwell_seconds=6.0, start=(0, 0), end=(15, 0),
                           bbox_extent=(15, 0))
    sig = re.rule_loitering(_snap(speed=20.0), traj)
    assert sig and sig[0].rule == "loitering"
    # a brisk straight path is NOT loitering
    traj2 = TrajectoryStats(track_id=1, n_points=30, n_seconds=5.0,
                            mean_speed_px_s=500.0, max_speed_px_s=520.0,
                            path_length_px=2400.0, net_displacement_px=2400.0,
                            straightness=1.0, direction_hist={},
                            dwell_seconds=4.0, start=(0, 0), end=(2400, 0),
                            bbox_extent=(2400, 0))
    assert not re.rule_loitering(_snap(speed=500.0), traj2)


def test_evaluate_aggregates_and_sorts():
    re = RuleEngine()
    out = re.evaluate(_snap(speed=120.0, direction=270.0, heading=100.0, accel=900.0),
                      _stats(mean=50, std=8))
    assert len(out) >= 3
    severities = [s.severity for s in out]
    assert all(0 <= s <= 1 for s in severities)


# ------------------------------------------------------------------ IsolationForest
def _detector_with_normal_speeds(*, n=400, seed=3):
    det = IsolationAnomalyDetector()
    rng = np.random.default_rng(seed)
    for i in range(n):
        snap = _snap(speed=float(rng.normal(60, 6)), heading=float(rng.uniform(0, 20)),
                     accel=float(rng.normal(0, 50)), track_id=(i // 50) + 1)
        det.observe(snap)
    return det


def test_isolation_detector_scores_normal_movement_low():
    det = _detector_with_normal_speeds()
    score, why = det.score(_snap(speed=62.0, heading=10.0, accel=30.0))
    assert score < 0.35, why


def test_isolation_detector_scores_extreme_movement_high():
    det = _detector_with_normal_speeds()
    score, why = det.score(_snap(speed=400.0, heading=170.0, accel=2500.0))
    assert score > 0.5, why


def test_isolation_detector_needs_warmup():
    det = IsolationAnomalyDetector()
    score, why = det.score(_snap(speed=999.0))
    assert score == 0.0 and "collecting" in why


def test_per_track_window_flags_sudden_behavior_shift():
    det = IsolationAnomalyDetector()
    # Track 5 moves straight and slow for ages, then lunges sideways fast.
    for i in range(120):
        det.observe(_snap(speed=40.0, heading=2.0, accel=5.0, track_id=5))
    score, why = det.score(_snap(speed=350.0, heading=160.0, accel=900.0, track_id=5))
    assert score > 0.4, why


# ------------------------------------------------------------------ fusion
def test_fusion_levels_and_thresholds():
    fus = AnomalyFusion()
    v0 = fus.fuse([], 0.0, 0.0)
    assert v0.level == LEVEL_NORMAL
    v1 = fus.fuse([RuleSignal("excessive_speed", 0.7, "x")], 0.55, 0.5)
    assert v1.level in (LEVEL_SUSPICIOUS, LEVEL_IRREGULAR) and v1.fused_score > 0.3
    v2 = fus.fuse([RuleSignal("excessive_speed", 1.0, "x"),
                   RuleSignal("erratic_heading", 0.95, "x"),
                   RuleSignal("loitering", 0.9, "x")], 0.9, 0.8)
    assert v2.level == LEVEL_IRREGULAR and v2.fused_score >= 0.65


def test_explain_produces_human_readable_lines():
    fus = AnomalyFusion()
    v = fus.fuse([RuleSignal("excessive_speed", 0.8,
                             "speed 180 px/s is 4.0 standard deviations above the calibrated mean")],
                 ml_score=0.7, scene_score=0.4)
    v = explain(v)
    assert v.why, "why-line must be filled"
    assert any("excessive_speed" in l for l in v.explanation)
    assert any("Isolation Forest" in l for l in v.explanation)
    assert v.to_dict()["level"] == v.level


def test_to_dict_contract():
    fus = AnomalyFusion()
    d = fus.fuse([], 0.1, 0.1).to_dict()
    assert set(d) == {"level", "fused_score", "signal_score", "ml_score",
                      "scene_score", "why", "rules"}
    assert d["rules"] == []
