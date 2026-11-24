"""Phase 5 - rule-based anomaly detection.

The RuleEngine fires interpretable, expert-style rules against per-frame
movement snapshots (plus optional trajectory stats and the calibrated scene
baseline). Each rule emits a `RuleSignal` with a bounded severity (0..1) and a
plain-English description that later feeds the explanation generator.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from config.config import RuleConfig, load_config
from src.analysis.calibration import SceneStats, _angle_gap
from src.analysis.features import MovementSnapshot, TrajectoryStats, _octant


@dataclass
class RuleSignal:
    rule: str
    severity: float          # 0..1
    description: str


class RuleEngine:
    """Applies calibrated/absolute thresholds to one observation at a time."""

    def __init__(self, config: RuleConfig | None = None):
        self.cfg = config or load_config().anomaly.rule
        self.zone_cfg = load_config().zone

    # ------------------------------------------------------------ facade
    def evaluate(self, snap: MovementSnapshot, stats: SceneStats | None,
                 traj: TrajectoryStats | None = None,
                 zone: tuple[str, float] | None = None) -> list[RuleSignal]:
        out: list[RuleSignal] = []
        out += self.rule_excessive_speed(snap, stats)
        out += self.rule_against_flow(snap, stats)
        out += self.rule_erratic_heading(snap)
        out += self.rule_sudden_accel(snap, stats)
        if traj is not None:
            out += self.rule_loitering(snap, traj)
        if zone is not None:
            out += self.rule_zone_violation(zone)
        return out

    # ------------------------------------------------------------ rules
    def rule_excessive_speed(self, snap: MovementSnapshot,
                             stats: SceneStats | None) -> list[RuleSignal]:
        v = snap.speed_px_s
        if v <= 0 or stats is None:
            return []
        if stats.n_samples < 20:          # not calibrated: too little evidence
            return []
        if stats.speed_p90 <= 0:
            return []
        # Compare against the scene's fast envelope. A z-score would punish
        # objects that are simply closer to the camera (perspective makes a
        # near car read 5x faster than a far one in a perfectly normal scene).
        ratio = v / stats.speed_p90
        if ratio < 1.6:
            return []
        sev = min(1.0, 0.5 + 0.5 * (ratio - 1.6) / 1.4)
        return [RuleSignal(
            rule="excessive_speed",
            severity=round(sev, 3),
            description=(f"speed {v:.0f} px/s is {ratio:.1f}x the scene's "
                         f"fast envelope (p90 {stats.speed_p90:.0f} px/s)"),
        )]

    def rule_against_flow(self, snap: MovementSnapshot,
                          stats: SceneStats | None) -> list[RuleSignal]:
        if stats is None or snap.direction_deg is None:
            return []
        if not stats.ready or not stats.dominant_angles:
            return []
        if stats.flow_share < 0.30:
            return []     # multiple flows / diffuse scene: heading means little
        deviation = min(_angle_gap(snap.direction_deg, angle)
                        for angle in stats.dominant_angles)
        tolerance = self.cfg.flow_tolerance_deg
        if deviation <= tolerance:
            return []
        oct_ = _octant(snap.direction_deg)
        share = stats.direction_hist.get(oct_, 0.0)
        if share >= 0.25:
            return []     # this heading is common in its own right
        severity = 0.35 + 0.65 * min(1.0, (deviation - tolerance) /
                                     max(180.0 - tolerance, 1.0))
        return [RuleSignal(
            rule="direction_against_flow",
            severity=round(severity, 3),
            description=(f"heading is {deviation:.0f} deg off the scene's "
                         f"dominant flow ({', '.join(stats.dominant_directions)})"),
        )]

    def rule_erratic_heading(self, snap: MovementSnapshot) -> list[RuleSignal]:
        hc = snap.heading_change_deg
        if hc is None:
            return []
        thresh = self.cfg.direction_dev_deg
        if hc < thresh:
            return []
        sev = min(1.0, (hc - thresh) / (90.0 - thresh) + 0.3)
        return [RuleSignal(
            rule="erratic_heading",
            severity=round(sev, 3),
            description=f"heading changed by {hc:.0f} deg between consecutive steps",
        )]

    def rule_sudden_accel(self, snap: MovementSnapshot,
                          stats: SceneStats | None) -> list[RuleSignal]:
        a = snap.acceleration_px_s2
        # Detector boxes wobble by a few pixels, which at 30 fps reads as a
        # large instantaneous acceleration. 1200 px/s^2 is well above that
        # jitter while a real brake/swerve still crosses it.
        if abs(a) < 1200.0:
            return []
        sev = min(1.0, abs(a) / 4000.0 + 0.25)
        verb = "accelerating" if a > 0 else "decelerating"
        return [RuleSignal(
            rule="sudden_acceleration",
            severity=round(sev, 3),
            description=f"{verb} abruptly ({a:+.0f} px/s^2)",
        )]

    def rule_zone_violation(self, zone: tuple[str, float]) -> list[RuleSignal]:
        """Fires when an object dwells inside a restricted zone long enough.

        `zone` is (zone_name, dwell_seconds_so_far). The threshold comes from
        the (enabled) zone configuration, so the rule is silent unless zones
        are actually configured.
        """
        name, dwell = zone
        threshold = self.zone_cfg.dwell_seconds
        if not self.zone_cfg.enabled or dwell < threshold:
            return []
        sev = min(1.0, 0.5 + 0.5 * (dwell - threshold) / max(threshold * 2.0, 1e-6))
        return [RuleSignal(
            rule="zone_violation",
            severity=round(sev, 3),
            description=(f"dwelled {dwell:.1f} s inside restricted zone "
                         f"'{name}' (threshold {threshold:.1f} s)"),
        )]

    def rule_loitering(self, snap: MovementSnapshot, traj: TrajectoryStats) -> list[RuleSignal]:
        if traj.dwell_seconds < self.cfg.loiter_seconds:
            return []
        # Perspective-safe definition: an object that has stayed within a
        # couple of its own body lengths for the whole dwell is stationary in
        # the scene, however many pixels a distant object seems to move.
        size = math.hypot(*snap.bbox_wh) or 1.0
        if traj.net_displacement_px > self.cfg.loiter_stationary_factor * size:
            return []
        if traj.mean_speed_px_s >= 25.0:
            # In a moving-camera scene a followed car stays put on screen at
            # 100+ px/s; only a genuinely stopped object stays under this.
            return []
        sev = min(1.0, traj.dwell_seconds / (self.cfg.loiter_seconds * 6) * 0.8 + 0.2)
        return [RuleSignal(
            rule="loitering",
            severity=round(sev, 3),
            description=(f"only moved {traj.net_displacement_px:.0f} px in "
                         f"{traj.dwell_seconds:.1f} s (loitering/dwelling)"),
        )]
