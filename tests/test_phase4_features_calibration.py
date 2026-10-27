"""Phase 4 unit tests: movement features + scene self-calibration."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, ROOT)

from src.analysis.features import TrackFeatureExtractor, TrajectoryFeatures, MovementSnapshot, _octant
from src.analysis.calibration import ScenarioCalibrator, SceneStats


def _tracked(track_id, frame_idx, cx, cy, fps=30.0, confirmed=True):
    """Build a TrackedObject whose trajectory walks cx,cy arriving at frame_idx."""
    hist = []
    for f in range(max(frame_idx - 3, 0), frame_idx + 1):
        hist.append((f, cx - 4.0 * (frame_idx - f), cy))
    return _TrackedStub(frame_idx=frame_idx, track_id=track_id, centroid=(cx, cy),
                        velocity=(4.0, 0.0), box_wh=(30., 30.), color="red",
                        shape="circle", trajectory=hist, confirmed=confirmed, misses=0)


class _TrackedStub:
    """Minimal duck-typed stand-in for TrackedObject."""
    def __init__(self, **kw):
        self.__dict__.update(kw)


# ------------------------------------------------------------------ features
def test_octant_labels():
    assert _octant(0) == "E"
    assert _octant(45) == "NE"
    assert _octant(90) == "N"
    assert _octant(180) == "W"
    assert _octant(270) == "S"
    assert _octant(350) == "E" or _octant(350) == "SE"   # wraparound near E


def test_calculator_computes_speed_for_constant_velocity():
    ex = TrackFeatureExtractor()
    # 4 px/frame @30 fps = 120 px/s
    snap = ex.observe(_tracked(0, 10, 140.0, 100.0), fps=30.0)
    assert abs(snap.speed_px_s - 120.0) < 3.0
    assert snap.direction_deg is not None
    assert abs((snap.direction_deg - 0.0) % 360) < 3.0


def test_directional_change_southeast():
    ex = TrackFeatureExtractor()

    class _T:
        def __init__(self, f, cx, cy, hist):
            self.frame_idx = f
            self.track_id = 1
            self.centroid = (cx, cy)
            self.velocity = (0, 0)
            self.box_wh = (10, 10)
            self.color = None
            self.shape = "unknown"
            self.trajectory = hist
            self.confirmed = True
            self.misses = 0

    t1 = _T(0, 100, 100, [(0, 100.0, 100.0)])
    ex.observe(t1, 30.0)
    t2 = _T(1, 120, 130, [(0, 100.0, 100.0), (1, 120.0, 130.0)])
    snap = ex.observe(t2, 30.0)
    assert _octant(snap.direction_deg) == "SE"   # image coords: dy>0 is down/south
    assert snap.speed_px_s > 0


def test_acceleration_positive_when_speeding_up():
    """Steps grow 4,6,8,... px/frame -> every observation after the first has
    positive acceleration in this synthetic run."""
    ex = TrackFeatureExtractor()

    class _T:
        def __init__(self, f, hist):
            self.frame_idx = f
            self.track_id = 2
            self.centroid = hist[-1][1:]
            self.velocity = (0, 0)
            self.box_wh = (10, 10)
            self.color = None
            self.shape = "unknown"
            self.trajectory = hist
            self.confirmed = True
            self.misses = 0

    x = 100.0
    step = 4.0
    hist = [(0, x, 100.0)]
    snaps = [ex.observe(_T(0, hist), 30.0)]      # first frame: no accel yet
    for f in range(1, 10):
        x += step
        hist.append((f, x, 100.0))
        snaps.append(ex.observe(_T(f, hist), 30.0))
        step += 2.0
    assert all(s.acceleration_px_s2 > 0 for s in snaps[1:]), \
        [round(s.acceleration_px_s2, 2) for s in snaps]
    assert snaps[-1].speed_px_s > snaps[1].speed_px_s


def test_trajectory_straightness_and_aggregates():
    traj = [(f, 100.0 + 10.0 * f, 50.0) for f in range(20)]
    stats = TrajectoryFeatures.from_track(traj, fps=30.0, track_id=7)
    assert stats is not None
    assert abs(stats.straightness - 1.0) < 0.01
    assert abs(stats.mean_speed_px_s - 300.0) < 1.0   # 10 px/frame @ 30 fps
    assert stats.net_displacement_px == stats.path_length_px
    assert stats.direction_hist == {"E": 19}
    assert stats.track_id == 7
    assert stats.bbox_extent == (190.0, 0.0)


def test_trajectory_rejects_too_few_points():
    assert TrajectoryFeatures.from_track([(0, 0, 0), (1, 1, 1)], 30.0) is None


def test_l_shape_path_decreases_straightness():
    pts = [(f, 100.0 + 10.0 * f, 100.0) for f in range(10)]
    pts += [(10 + f, 190.0, 100.0 + 10.0 * f) for f in range(1, 10)]
    stats = TrajectoryFeatures.from_track(pts, 30.0)
    assert stats.straightness < 0.8
    assert stats.direction_hist["E"] == 9 and stats.direction_hist["S"] == 9


# ---------------------------------------------------------------- calibration
def _snap(track_id, speed, direction_deg, frame_idx=0):
    return MovementSnapshot(
        frame_idx=frame_idx, track_id=track_id, centroid=(0, 0),
        speed_px_s=speed, direction_deg=direction_deg,
        acceleration_px_s2=0.0, heading_change_deg=None, bbox_wh=(10, 10))


def test_calibrator_not_ready_with_no_data():
    cal = ScenarioCalibrator()
    assert not cal.is_ready()
    s = cal.stats()
    assert not s.ready and s.n_samples == 0


def test_calibrator_becomes_ready_and_reports_percentiles():
    cal = ScenarioCalibrator()
    rng = np.random.default_rng(7)
    speeds = np.clip(rng.normal(60.0, 10.0, 400), 1, None)   # ~p90 ~73
    f = 0
    for sp in speeds:
        cal.update([_snap(track_id=(f // 40) % 4 + 1, speed=float(sp),
                          direction_deg=0.0, frame_idx=f)], f, 1.0)   # 1 fps
        f += 1
    assert cal.is_ready()
    s = cal.stats()
    assert abs(s.speed_p50 - np.percentile(speeds, 50)) < 2.0
    assert abs(s.speed_p90 - np.percentile(speeds, 90)) < 2.0
    assert s.n_tracks == 4
    assert s.dominant_directions == ["E"]


def test_scene_relative_flags_fast_against_flow():
    cal = ScenarioCalibrator()
    for i in range(500):
        cal.update([_snap(track_id=i % 5 + 1, speed=50.0,
                          direction_deg=0.0, frame_idx=i)], i, 1.0)
    stats = cal.stats()
    assert stats.ready
    # Object moving twice as fast in an odd direction => high score
    score, why = cal.scene_relative(_snap(9, 160.0, 180.0), stats)
    assert score >= 0.5, why
    assert "faster" in why or "flow" in why
    # Normal object => low score
    score2, why2 = cal.scene_relative(_snap(9, 55.0, 10.0), stats)
    assert score2 <= 0.2, why2
    # Insufficient calibration never scores
    cal2 = ScenarioCalibrator()
    cal2.update([_snap(1, 300.0, 0.0, 0)], 0, 1.0)
    sc, wh = cal2.scene_relative(_snap(1, 300.0, 0.0), cal2.stats())
    assert sc == 0.0 and "insufficient" in wh
