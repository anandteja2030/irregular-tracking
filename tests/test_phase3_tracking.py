"""Phase 3 unit tests: Kalman motion, Hungarian assignment, track lifecycle."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, ROOT)

from src.tracking.kalman import KalmanBox
from src.tracking.track_manager import TrackManager, TrackedObject
from src.video.detection import ObjectDetection


def _det(frame_idx, cx, cy, color="red", shape="circle", w=40, h=40, area=None):
    return ObjectDetection(
        frame_idx=frame_idx, bbox=(int(cx - w / 2), int(cy - h / 2), w, h),
        centroid=(float(cx), float(cy)), area=(area if area is not None else w * h * 0.7),
        color=color, shape=shape, aspect=w / h,
        contour=np.zeros((1, 1, 2), np.int32))


# ------------------------------------------------------------------ Kalman
def test_kalman_tracks_constant_velocity():
    kf = KalmanBox(0.0, 0.0, 20, 20, process_noise=0.01, measurement_noise=1e-6)
    for step in range(1, 30):
        kf.predict()
        kfx = step * 3.0       # 3 px/frame along x
        kf.update(kfx, 0.0, 20, 20)
    kf.predict()
    x, y = kf.centroid
    assert abs(x - 90.0) < 1.0, f"predicted x={x}, expected ~90"
    assert abs(y) < 0.5


def test_kalman_velocity_estimate_converges():
    kf = KalmanBox(0.0, 0.0, 20, 20, process_noise=0.05, measurement_noise=1e-8)
    for step in range(1, 60):
        kf.predict()
        kf.update(step * 2.0, step, 20, 20)
    vx, vy = kf.velocity
    assert abs(vx - 2.0) < 0.05 and abs(vy - 1.0) < 0.05


def test_kalman_smooths_noisy_measurements():
    rng = np.random.default_rng(42)
    kf = KalmanBox(0.0, 0.0, 20, 20, process_noise=0.05, measurement_noise=25.0)
    err = []
    for step in range(1, 120):
        kf.predict()
        noisy = step * 1.0 + rng.normal(0, 3.0)
        kf.update(noisy, 0.0, 20, 20)
        err.append(abs(kf.centroid[0] - step))
    lo, hi = err[-60:], err[-6:]
    assert max(lo) > np.mean(np.abs(hi))       # converges below earlier errors
    assert np.mean(np.abs(hi)) < 5.0


# ------------------------------------------------------------------ TrackManager
def test_single_object_keep_identical_id_over_frames():
    tm = TrackManager()
    ids = []
    pos = 100.0
    for f in range(10):
        dets = [_det(f, pos, 240.0)]
        tracks = tm.update(dets, f)
        ids.append(tracks[0].track_id) if tracks else ids.append(None)
        pos += 4.0
    seen = {i for i in ids if i is not None}
    assert len(seen) == 1, f"IDs seen: {seen}"


def test_new_object_gets_new_unique_id():
    tm = TrackManager()
    d1 = tm.update([_det(0, 100, 100)], 0)
    id1 = d1[0].track_id
    d2 = tm.update([_det(1, 500, 500)], 1)      # far away -> new identity
    # Snapshots include the still-coasting old track; pick the one near (500,500).
    near500 = min(d2, key=lambda t: math.hypot(t.centroid[0] - 500, t.centroid[1] - 500))
    assert math.hypot(near500.centroid[0] - 500, near500.centroid[1] - 500) < 5
    id2 = near500.track_id
    assert id2 != id1
    assert not tm.is_id_taken(-1)


def test_unmatched_detection_becomes_tentative_then_confirmed():
    tm = TrackManager()
    from config.config import TrackingConfig
    tm.cfg = TrackingConfig(min_hits=3, max_age=5)
    tracks = tm.update([_det(0, 100, 100)], 0)
    assert not tracks[0].confirmed
    for f in (1, 2):
        tracks = tm.update([_det(f, 104, 100)], f)
    assert tracks[0].confirmed


def test_track_survives_missing_detections_up_to_max_age():
    from config.config import TrackingConfig
    tm = TrackManager(TrackingConfig(min_hits=2, max_age=4))
    dets = [tm.update([_det(0, 100, 100)], 0)]
    for f in range(1, 4):
        dets = [tm.update([_det(f, 104, 100)], f)]
    alive = tm.tracks[0]
    # Detections vanish: track must coast and stay alive up to max_age frames.
    for f in range(4, 9):
        dets = [tm.update([], f)]
        if f < 8:
            assert alive in tm.tracks, f"track died too early at f={f}"
    assert alive in tm.dead_tracks or not tm.tracks, "track should be culled after max_age"


def test_position_gate_rejects_far_jump():
    from config.config import TrackingConfig
    tm = TrackManager(TrackingConfig(min_hits=1, max_age=10, position_gate_px=50))
    tm.update([_det(0, 100, 100)], 0)
    id1 = tm.tracks[0].id
    dets = tm.update([_det(1, 400, 100)], 1)       # 300 px jump
    near400 = [tr for tr in dets if math.hypot(tr.centroid[0] - 400, tr.centroid[1] - 100) < 5]
    assert near400 and near400[0].track_id != id1, \
        "far-away detection must not be merged into existing track"


def test_two_objects_each_get_own_distinct_id():
    tm = TrackManager()
    ids_per_object = [set(), set()]
    for f in range(8):
        dets = [_det(f, 100 + 4 * f, 100.0), _det(f, 400 + 4 * f, 100.0)]
        tracks = [tr for tr in tm.update(dets, f) if tr.confirmed or f == 0]
        if f >= 1:
            for i, obj in enumerate(sorted(tracks, key=lambda t: t.centroid[0])):
                ids_per_object[i].add(obj.track_id)
    left = list(ids_per_object[0])[0]
    right = list(ids_per_object[1])[0]
    assert left != right and ids_per_object[0] == {left} and ids_per_object[1] == {right}


def test_hungarian_applied_via_many_simultaneous_detections():
    """5 tracks moving right; detections offset slightly; all should match 1:1."""
    tm = TrackManager()
    ys = [80, 160, 240, 320, 400]
    xs = {y: 100.0 for y in ys}
    id_map = {}
    for f in range(10):
        dets = [_det(f, xs[y] + 4, y) for y in ys]
        for tr in tm.update(dets, f):
            id_map.setdefault(round(tr.centroid[1]), set()).add(tr.track_id)
            xs[round(tr.centroid[1])] = tr.centroid[0] + 4
    for y in ys:
        assert len(id_map[y]) == 1, f"y={y} has ids {id_map[y]}"


def test_trajectory_history_grows_and_records_positions():
    tm = TrackManager()
    for f in range(6):
        tm.update([_det(f, 100 + 5 * f, 100.0)], f)
    tr = tm.tracks[0]
    assert len(tr.positions) == 6
    assert tr.positions[0][0] == 0 and tr.positions[-1][0] == 5
    xs = [p[1] for p in tr.positions]
    assert xs[0] < xs[-1]


def test_snapshot_fields_populated():
    tm = TrackManager()
    snap = tm.update([_det(0, 100, 100, "green", "square")], 0)[0]
    assert isinstance(snap, TrackedObject)
    assert snap.color == "green" and snap.shape == "square"
    assert snap.track_id >= 0
    assert snap.centroid[0] == 100.0 and snap.centroid[1] == 100.0
