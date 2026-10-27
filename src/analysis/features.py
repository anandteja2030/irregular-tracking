"""Phase 4 - movement feature extraction.

Turns raw tracking output into interpretable kinematic features:

Per observation  (TrackFeatureExtractor.observe):
    speed_px_s          displacement/second between the two most recent
                        trajectory positions
    direction_deg       bearing of that displacement (0 = +x / right,
                        CCW, range [0, 360))
    acceleration_px_s2  (speed_now - speed_prev) / dt
    heading_change_deg  absolute turn angle vs previous displacement

Per track      (TrajectoryFeatures.from_trajectory):
    straightness / path length / displacement, mean & max speed, dwell time,
    direction histogram, spatial extent, entry/exit points.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np

from config.config import FeatureConfig, load_config
from src.tracking.track_manager import TrackedObject


@dataclass
class MovementSnapshot:
    """Kinematic state of one tracked object at one frame."""
    frame_idx: int
    track_id: int
    centroid: tuple[float, float]
    speed_px_s: float
    direction_deg: float | None       # None when the object hasn't moved yet
    acceleration_px_s2: float
    heading_change_deg: float | None
    bbox_wh: tuple[float, float]


class TrackFeatureExtractor:
    """Per-maintained-track rolling kinematic calculator.

    Instantiate once per runtime; feed the per-frame `TrackedObject`s in.
    Speeds are in px/s using the *video's* fps so numbers are meaningful
    across recordings.
    """

    def __init__(self, config: FeatureConfig | None = None):
        self.cfg = config or load_config().features
        self._prev_speed: dict[int, float] = {}
        self._last_positions: dict[int, deque] = {}
        self._last_delta: dict[int, tuple[float, float, int]] = {}  # (dx, dy, frame)
        self._window_hist: dict[int, deque] = {}  # (frame, cx, cy) for accel windows

    # ------------------------------------------------------------ steps
    ACCEL_WINDOW = 5      # frames per acceleration window (see _acceleration)

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _bearing(dx: float, dy: float) -> float:
        """Direction in CV/image convention: 0 deg = +x (right), CCW in degrees."""
        ang = math.degrees(math.atan2(-dy, dx))     # neg y-img = up/right positive
        return (ang + 360.0) % 360.0

    def _acceleration(self, track_id: int, cx: float, cy: float,
                      frame_idx: int, fps: float) -> float | None:
        """Two-window acceleration (px/s^2), or None when history is short.

        Compares the mean speed of the most recent ACCEL_WINDOW frames with
        the ACCEL_WINDOW frames before it. Both windows span several frames,
        so integer-pixel quantisation noise largely cancels. This keeps
        `sudden_acceleration` quiet on smooth motion while abrupt real speed
        changes (entering/leaving, runner bursts) still fire.
        """
        W = self.ACCEL_WINDOW
        hist = self._window_hist.setdefault(
            track_id, deque(maxlen=2 * W + 1))
        hist.append((frame_idx, cx, cy))
        if len(hist) < 2 * W + 1:
            return None
        pts = list(hist)
        recent, prev = pts[-(W + 1):], pts[-(2 * W + 1):-W]
        f_now, f_mid, f_old = pts[-1][0], pts[-W - 1][0], pts[-(2 * W + 1)][0]
        dt_recent = max((f_now - f_mid) / max(fps, 1e-6), 1e-6)
        dt_prev = max((f_mid - f_old) / max(fps, 1e-6), 1e-6)
        if dt_recent <= 1e-6 or dt_prev <= 1e-6:
            return None
        v_recent = math.hypot(recent[-1][1] - recent[0][1],
                              recent[-1][2] - recent[0][2]) / dt_recent
        v_prev = math.hypot(prev[-1][1] - prev[0][1],
                            prev[-1][2] - prev[0][2]) / dt_prev
        dt = (dt_recent + dt_prev) / 2.0
        return (v_recent - v_prev) / dt

    # ------------------------------------------------------------ facade
    def observe(self, obj: TrackedObject, fps: float) -> MovementSnapshot:
        """Compute kinematic features for this tracked object this frame."""
        cx, cy = obj.centroid
        hist = obj.trajectory
        track_id = obj.track_id

        # dt since the trajectory's previous distinct position
        speed, dir_deg, ddx, ddy, dt = 0.0, None, 0.0, 0.0, 1e-6
        if len(hist) >= 2:
            f1, x1, y1 = hist[-2]
            f2, x2, y2 = hist[-1]
            dt = max((f2 - f1) / max(fps, 1e-6), 1e-6)
            ddx, ddy = x2 - x1, y2 - y1
            dist = math.hypot(ddx, ddy)
            speed = dist / dt
            if dist > 1e-4:
                dir_deg = self._bearing(ddx, ddy)
                self._last_delta[track_id] = (ddx, ddy, f2)
            elif track_id in self._last_delta:
                ddx, ddy, _ = self._last_delta[track_id]     # reuse last real delta

        prev = self._prev_speed.get(track_id)
        accel = 0.0 if prev is None else (speed - prev) / dt
        self._prev_speed[track_id] = speed
        # Replace per-frame acceleration with a two-window estimate when the
        # track has enough history: frame-to-frame differencing of integer
        # centroid pixels amplifies quantisation noise by 1/dt (~30x), which
        # otherwise fires the sudden-acceleration rule on smooth motion.
        accel_windowed = self._acceleration(track_id, cx, cy, obj.frame_idx, fps)
        if accel_windowed is not None:
            accel = accel_windowed

        heading_change = None
        if dir_deg is not None and obj.track_id in self._last_delta:
            pdx, pdy, _ = self._last_delta[obj.track_id]
            if math.hypot(pdx, pdy) > 1e-4:
                heading_change = abs((dir_deg - self._bearing(pdx, pdy) + 540) % 360 - 180)

        # keep tiny buffers so memory stays bounded across long runs
        buf = self._last_positions.setdefault(track_id, deque(maxlen=8))
        buf.append((cx, cy))

        return MovementSnapshot(
            frame_idx=obj.frame_idx,
            track_id=track_id,
            centroid=(cx, cy),
            speed_px_s=speed,
            direction_deg=dir_deg,
            acceleration_px_s2=accel,
            heading_change_deg=heading_change,
            bbox_wh=obj.box_wh,
        )


@dataclass
class TrajectoryStats:
    """Aggregated, human-readable trajectory summary for one track."""
    track_id: int
    n_points: int
    n_seconds: float
    mean_speed_px_s: float
    max_speed_px_s: float
    path_length_px: float
    net_displacement_px: float
    straightness: float               # net / length  (1.0 = straight line)
    direction_hist: dict               # octant label -> count
    dwell_seconds: float
    start: tuple[float, float]
    end: tuple[float, float]
    bbox_extent: tuple[float, float]   # (dx, dy) covered


def _octant(deg: float) -> str:
    names = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"]
    return names[int(((deg % 360) + 22.5) // 45) % 8]


class TrajectoryFeatures:
    """Aggregates a whole track's trajectory positions into interpretable stats."""

    @staticmethod
    def from_track(trajectory: list[tuple[int, float, float]], fps: float,
                   track_id: int = 0) -> TrajectoryStats | None:
        cfg = load_config().features
        if len(trajectory) < cfg.traj_min_positions:
            return None
        frames = np.array([p[0] for p in trajectory], float)
        pts = np.array([(p[1], p[2]) for p in trajectory], float)
        steps = np.diff(pts, axis=0)
        seg = np.linalg.norm(steps, axis=1)
        length = float(seg.sum())
        disp = float(np.linalg.norm(pts[-1] - pts[0]))
        dt_frame = max(1.0 / max(fps, 1e-6), 1e-6)
        speeds = seg / dt_frame
        direction_counts: dict[str, int] = {}
        for dx, dy in steps:
            if dx == 0 and dy == 0:
                continue
            label = _octant(math.degrees(math.atan2(-dy, dx)))
            direction_counts[label] = direction_counts.get(label, 0) + 1
        return TrajectoryStats(
            track_id=track_id,
            n_points=len(trajectory),
            n_seconds=float(frames[-1] - frames[0]) / max(fps, 1e-6),
            mean_speed_px_s=float(speeds.mean()) if len(speeds) else 0.0,
            max_speed_px_s=float(speeds.max()) if len(speeds) else 0.0,
            path_length_px=length,
            net_displacement_px=disp,
            straightness=disp / max(length, 1e-6),
            direction_hist=direction_counts,
            dwell_seconds=float(frames[-1] - frames[0]) / max(fps, 1e-6),
            start=(float(pts[0][0]), float(pts[0][1])),
            end=(float(pts[-1][0]), float(pts[-1][1])),
            bbox_extent=(float(pts[:, 0].max() - pts[:, 0].min()),
                         float(pts[:, 1].max() - pts[:, 1].min())),
        )
