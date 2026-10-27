"""Phase 5 - rule-based anomaly detection.

The RuleEngine fires interpretable, expert-style rules against per-frame
movement snapshots (plus optional trajectory stats and the calibrated scene
baseline). Each rule emits a `RuleSignal` with a bounded severity (0..1) and a
plain-English description that later feeds the explanation generator.
"""
from __future__ import annotations

from dataclasses import dataclass

from config.config import RuleConfig, load_config
from src.analysis.calibration import SceneStats
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

    # ------------------------------------------------------------ facade
    def evaluate(self, snap: MovementSnapshot, stats: SceneStats | None,
                 traj: TrajectoryStats | None = None) -> list[RuleSignal]:
        out: list[RuleSignal] = []
        out += self.rule_excessive_speed(snap, stats)
        out += self.rule_against_flow(snap, stats)
        out += self.rule_erratic_heading(snap)
        out += self.rule_sudden_accel(snap, stats)
        if traj is not None:
            out += self.rule_loitering(snap, traj)
        return out

    # ------------------------------------------------------------ rules
    def rule_excessive_speed(self, snap: MovementSnapshot,
                             stats: SceneStats | None) -> list[RuleSignal]:
        v = snap.speed_px_s
        if v <= 0 or stats is None:
            return []
        if stats.n_samples < 20:          # not calibrated: too little evidence
            return []
        # z-score of speed against learned distribution
        z = (v - stats.speed_mean) / max(stats.speed_std, 1.0)
        sev = min(1.0, max(0.0, z / self.cfg.max_z))
        if sev < 0.25:
            return []
        return [RuleSignal(
            rule="excessive_speed",
            severity=round(sev, 3),
            description=(f"speed {v:.0f} px/s is {z:.1f} standard deviations "
                         f"above the calibrated mean ({stats.speed_mean:.0f} px/s)"),
        )]

    def rule_against_flow(self, snap: MovementSnapshot,
                          stats: SceneStats | None) -> list[RuleSignal]:
        if stats is None or not stats.dominant_directions or snap.direction_deg is None:
            return []
        if not stats.ready:
            return []
        oct_ = _octant(snap.direction_deg)
        if oct_ in stats.dominant_directions:
            return []
        share = stats.direction_hist.get(oct_, 0.0)
        if share >= 0.35:
            return []     # too diffuse a scene for flow direction to mean much
        return [RuleSignal(
            rule="direction_against_flow",
            severity=0.6 if share < 0.05 else 0.35,
            description=(f"moves {oct_}, which this scene rarely shows "
                         f"(dominant flow: {stats.dominant_directions})"),
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
        if abs(a) < 600.0:            # gentle thresholds tuned for px/s^2 scale
            return []
        sev = min(1.0, abs(a) / 2000.0 + 0.25)
        verb = "accelerating" if a > 0 else "decelerating"
        return [RuleSignal(
            rule="sudden_acceleration",
            severity=round(sev, 3),
            description=f"{verb} abruptly ({a:+.0f} px/s^2)",
        )]

    def rule_loitering(self, snap: MovementSnapshot, traj: TrajectoryStats) -> list[RuleSignal]:
        if traj.dwell_seconds < self.cfg.loiter_seconds:
            return []
        if traj.straightness > 0.9 and traj.net_displacement_px > 60:
            return []                 # moved a long way in a straight line: not loiter
        if traj.mean_speed_px_s >= 400.0:
            return []
        sev = min(1.0, traj.dwell_seconds / (self.cfg.loiter_seconds * 6) * 0.8 + 0.2)
        return [RuleSignal(
            rule="loitering",
            severity=round(sev, 3),
            description=(f"only moved {traj.net_displacement_px:.0f} px in "
                         f"{traj.dwell_seconds:.1f} s (loitering/dwelling)"),
        )]
