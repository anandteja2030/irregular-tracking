"""Phase 3 - track manager: Hungarian assignment + unique IDs + trajectories.

Per frame:
  1. Every live track predicts its next centroid via Kalman.
  2. A cost matrix (position distance blended with IoU) is built between
     predicted tracks and incoming detections.
  3. scipy's linear_sum_assignment (Hungarian algorithm) picks the minimum
     cost assignment; assignments above a distance gate are rejected.
  4. Unmatched detections start tentative tracks; unmatched tracks coast and
     are deleted after `max_age` frames without an update.

A track is reported by the pipeline only after `min_hits` consecutive updates
(debouncing), but its window starts at the first detection so trajectories
include it.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

from config.config import TrackingConfig, load_config
from src.tracking.kalman import KalmanBox
from src.video.detection import ObjectDetection


@dataclass
class Track:
    """Stateful object hypothesis with identity, motion and trajectory history."""
    id: int
    kf: KalmanBox
    color: str | None = None
    shape: str = "unknown"
    hits: int = 0                      # consecutive matched frames (debounce)
    misses: int = 0                    # consecutive unmatched (coasting) frames
    positions: deque = field(default_factory=lambda: deque(maxlen=400))  # (frame_idx, cx, cy)
    first_frame: int = 0
    last_frame: int = 0

    # ------------------------------------------------------------ info
    @property
    def centroid(self) -> tuple[float, float]:
        return self.kf.centroid

    @property
    def velocity(self) -> tuple[float, float]:
        return self.kf.velocity

    @property
    def box_wh(self) -> tuple[float, float]:
        return self.kf.box_wh

    @property
    def confirmed(self) -> bool:
        return self.hits >= load_config().tracking.min_hits

    def age_frames(self) -> int:
        return self.last_frame - self.first_frame + 1


@dataclass
class TrackedObject:
    """Snapshot of one Track handed downstream (features/viz) each frame."""
    frame_idx: int
    track_id: int
    centroid: tuple[float, float]
    velocity: tuple[float, float]
    box_wh: tuple[float, float]
    color: str | None
    shape: str
    trajectory: list[tuple[int, float, float]]
    confirmed: bool
    misses: int


class TrackManager:
    """Multi-object tracker with a position gate and Hungarian matching."""

    def __init__(self, config: TrackingConfig | None = None):
        self.cfg = config or load_config().tracking
        self._next_id = 0
        self.tracks: list[Track] = []
        self.dead_tracks: list[Track] = []     # archived for post-run analysis

    # ------------------------------------------------------------- helpers
    def _new_track(self, det: ObjectDetection, frame_idx: int) -> Track:
        x, y, w, h = det.bbox
        kf = KalmanBox(det.centroid[0], det.centroid[1], float(w), float(h),
                       process_noise=self.cfg.kalman_process_noise,
                       measurement_noise=self.cfg.kalman_measurement_noise)
        t = Track(id=self._next_id, kf=kf, color=det.color, shape=det.shape,
                  hits=1, misses=0, first_frame=frame_idx, last_frame=frame_idx)
        t.positions.append((frame_idx, *det.centroid))
        self._next_id += 1
        return t

    @staticmethod
    def _iou(x1, w1, y1, h1, x2, w2, y2, h2) -> float:
        """IoU of two axis-aligned boxes given centred (cx, w) representation."""
        ax1, ay1, ax2, ay2 = x1 - w1 / 2, y1 - h1 / 2, x1 + w1 / 2, y1 + h1 / 2
        bx1, by1, bx2, by2 = x2 - w2 / 2, y2 - h2 / 2, x2 + w2 / 2, y2 + h2 / 2
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
        inter = iw * ih
        union = w1 * h1 + w2 * h2 - inter
        return inter / max(union, 1e-6)

    def _cost_matrix(self, tracks: list[Track], dets: list[ObjectDetection]) -> np.ndarray:
        n, m = len(tracks), len(dets)
        if n == 0 or m == 0:
            return np.zeros((0, 0))
        C = np.zeros((n, m))
        for i, t in enumerate(tracks):
            px, py = t.centroid
            pw, ph = t.box_wh
            for j, d in enumerate(dets):
                dx, dy = d.centroid
                iou = self._iou(px, pw, py, ph, dx, d.bbox[2], dy, d.bbox[3])
                dist = float(np.hypot(px - dx, py - dy))
                C[i, j] = dist - 20.0 * iou     # reward overlap, punish distance
        return C

    # -------------------------------------------------------------- facade
    def update(self, detections: list[ObjectDetection], frame_idx: int) -> list[TrackedObject]:
        """Match detections to tracks; returns snapshots of *this frame's* tracks."""
        # 1) predict
        for t in self.tracks:
            t.kf.predict()

        # 2) assign
        C = self._cost_matrix(self.tracks, detections)
        matched_t: set[int] = set()
        matched_d: set[int] = set()
        if C.size:
            rows, cols = linear_sum_assignment(C)
            for r, c in zip(rows, cols):
                t, d = self.tracks[r], detections[c]
                dist = float(np.hypot(t.centroid[0] - d.centroid[0],
                                      t.centroid[1] - d.centroid[1]))
                if dist > self.cfg.position_gate_px:
                    continue
                matched_t.add(r)
                matched_d.add(c)
                t.kf.update(d.centroid[0], d.centroid[1], float(d.bbox[2]), float(d.bbox[3]))
                if d.color is not None:                  # stable colour of blob
                    t.color = d.color
                t.shape = d.shape
                t.hits += 1
                t.misses = 0
                t.last_frame = frame_idx
                t.positions.append((frame_idx, *d.centroid))

        # 3) new tentative tracks for unmatched detections
        for j, d in enumerate(detections):
            if j in matched_d:
                continue
            self.tracks.append(self._new_track(d, frame_idx))

        # 4) aging / culling
        matched_t_idx = {r for r in matched_t}
        for i, t in enumerate(self.tracks):
            if i not in matched_t_idx:
                t.misses += 1
        alive: list[Track] = []
        for t in self.tracks:
            if t.misses > self.cfg.max_age:
                self.dead_tracks.append(t)
            else:
                alive.append(t)
        self.tracks = alive

        # 5) snapshot
        out = [self._snapshot(t, frame_idx) for t in self.tracks]
        return out

    def _snapshot(self, t: Track, frame_idx: int) -> TrackedObject:
        return TrackedObject(
            frame_idx=frame_idx,
            track_id=t.id,
            centroid=t.centroid,
            velocity=t.velocity,
            box_wh=t.box_wh,
            color=t.color,
            shape=t.shape,
            trajectory=list(t.positions),
            confirmed=t.confirmed,
            misses=t.misses,
        )

    def is_id_taken(self, tid: int) -> bool:
        return any(t.id == tid for t in self.tracks) or \
               any(t.id == tid for t in self.dead_tracks)

    def all_time_tracks(self) -> list[Track]:
        return self.dead_tracks + self.tracks
