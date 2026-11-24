"""Phase 4 - scene self-calibration.

Rather than requiring the user to hand-tune "what speed is fast", the
calibrator watches movements for a warmup window and learns the scene's
baseline:

  * speed distribution  (p10 / median / p90)   -> normal speed envelope
  * direction histogram (8 octants)            -> dominant flow directions
  * per-object motion frequency

`is_ready()` becomes True once either the minimum number of distinct tracks or
the configured observation seconds have been met. Downstream components use
`stats()` to compare an object's behaviour against what the scene normally
sees (scene-relative anomaly reasoning).

Units: all speeds px/s, angles degrees (0 = +x / right, CCW).
"""
from __future__ import annotations

import math
from collections import Counter, deque
from dataclasses import dataclass, field

import numpy as np

from config.config import CalibrationConfig, load_config
from src.analysis.features import MovementSnapshot, _octant

# Heading (degrees, image convention) at the centre of each octant label.
OCTANT_ANGLES = {"E": 0.0, "NE": 45.0, "N": 90.0, "NW": 135.0,
                 "W": 180.0, "SW": 225.0, "S": 270.0, "SE": 315.0}


def _angle_gap(a: float, b: float) -> float:
    """Shortest absolute difference between two bearings, in degrees."""
    return abs((a - b + 540.0) % 360.0 - 180.0)


@dataclass
class SceneStats:
    """Learned baseline of 'normal' scene movement."""
    ready: bool
    n_samples: int
    n_tracks: int
    observed_seconds: float
    speed_p10: float
    speed_p50: float
    speed_p90: float
    speed_mean: float
    speed_std: float
    direction_hist: dict                 # octant -> fraction (0..1)
    dominant_directions: list[str]       # top octant labels (>= 20% share)
    moving_fraction: float               # share of observations with speed > 0
    dominant_angles: list[float] = field(default_factory=list)  # octant centres
    flow_share: float = 0.0              # share of motion in dominant octants


class ScenarioCalibrator:
    """Collects MovementSnapshot evidence and fits a baseline distribution."""

    def __init__(self, config: CalibrationConfig | None = None):
        self.cfg = config or load_config().calibration
        self._speeds: deque = deque(maxlen=6000)
        self._track_ids: set = set()
        self._observed_seconds = 0.0
        self._direction_counts: Counter = Counter()
        self._movement_frames = 0
        self._total_frames = 0

    # ------------------------------------------------------------ ingest
    def update(self, snapshots: list[MovementSnapshot], frame_idx: int, fps: float) -> None:
        for s in snapshots:
            self._track_ids.add(s.track_id)
            if s.speed_px_s > 0:
                self._speeds.append(s.speed_px_s)
                self._movement_frames += 1
            self._total_frames += 1
            if s.direction_deg is not None:
                self._direction_counts[_octant(s.direction_deg)] += 1
        self._observed_seconds += (1.0 if fps <= 0 else 1.0 / fps) * len(snapshots)

    # ------------------------------------------------------------ queries
    def is_ready(self) -> bool:
        has_enough_evidence = (
            len(self._track_ids) >= self.cfg.warmup_tracks
            and self._observed_seconds >= self.cfg.tracks_seconds
            and self.observation_count() >= self.cfg.min_samples
        )
        return bool(has_enough_evidence)

    def observation_count(self) -> int:
        return len(self._speeds)

    def stats(self) -> SceneStats:
        speeds = np.array(self._speeds, dtype=float) if len(self._speeds) else np.zeros(2)
        total_dir = sum(self._direction_counts.values()) or 1
        hist = {
            oct_: round(cnt / total_dir, 4)
            for oct_, cnt in sorted(self._direction_counts.items())
        }
        dominant = [oct_ for oct_, share in sorted(hist.items(), key=lambda kv: -kv[1])
                    if share >= 0.20][:2]          # at most the two strongest
        dominant_angles = [OCTANT_ANGLES[oct_] for oct_ in dominant]
        flow_share = round(sum(hist.get(oct_, 0.0) for oct_ in dominant), 4)
        return SceneStats(
            ready=self.is_ready(),
            n_samples=self.observation_count(),
            n_tracks=len(self._track_ids),
            observed_seconds=round(self._observed_seconds, 2),
            speed_p10=float(np.percentile(speeds, 10)),
            speed_p50=float(np.percentile(speeds, 50)),
            speed_p90=float(np.percentile(speeds, 90)),
            speed_mean=float(np.mean(speeds)) if len(speeds) else 0.0,
            speed_std=float(np.std(speeds)) if len(speeds) else 0.0,
            direction_hist=hist,
            dominant_directions=dominant,
            moving_fraction=round(self._movement_frames / max(self._total_frames, 1), 4),
            dominant_angles=dominant_angles,
            flow_share=flow_share,
        )

    # --------------------------------------------- scene-relative scoring
    def scene_relative(self, snapshot: MovementSnapshot, stats: SceneStats
                       ) -> tuple[float, str]:
        """Compare an object's current motion with the scene baseline.

        Returns (score, why) where score in [0, 1] rises as the object's
        behaviour deviates from what the scene normally shows.
        """
        if not stats.ready or stats.n_samples < 5:
            return 0.0, "insufficient calibration"
        notes: list[str] = []
        score = 0.0

        if snapshot.speed_px_s > 0 and stats.speed_p90 > 0:
            ratio = snapshot.speed_px_s / stats.speed_p90
            if ratio > 1.5:
                score += 0.4
                notes.append(f"{ratio:.1f}x the usual fast speed")
            elif ratio > 1.2:
                score += 0.2
                notes.append("slightly faster than usual for this scene")
            elif stats.speed_p50 > 0 and snapshot.speed_px_s < stats.speed_p50 / 4 and snapshot.speed_px_s > 1:
                score += 0.2
                notes.append("much slower than the scene's norm")

        if snapshot.direction_deg is not None and stats.dominant_angles:
            # A flow covers a range of headings: a car on a bridge drifts 20-40
            # degrees off the lane axis without leaving the flow. Compare the
            # angle to the dominant headings with a tolerance instead of
            # demanding the exact octant.
            deviation = min(_angle_gap(snapshot.direction_deg, angle)
                            for angle in stats.dominant_angles)
            tolerance = load_config().anomaly.rule.flow_tolerance_deg
            if stats.flow_share >= 0.30 and deviation > tolerance:
                score += 0.3
                notes.append(f"heading {deviation:.0f} deg off the dominant "
                             f"scene flow ({stats.dominant_directions})")
            elif deviation > tolerance + 45:
                score += 0.15
                notes.append("heading rarely seen in this scene")

        return min(score, 1.0), "; ".join(notes) if notes else "movement matches scene baseline"
