"""Phase 5 - anomaly signal fusion, classification and explanations.

Fuses three independent evidence streams into one bounded score:

  * signal_score : aggregate severity of fired rule signals (expert rules)
  * ml_score     : Isolation Forest anomaly score (data-driven)
  * scene_score  : deviation of the object's motion from the calibrated
                   dominant flow (scene-relative comparison)

The fused score maps onto three qualitative levels:
    Normal < threshold_suspicious <= Suspicious < threshold_irregular <= Irregular

The explanation generator turns the fused signals into a short, human-readable
sentence list, ordered by contribution, suitable for logs and the UI.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from config.config import load_config
from src.anomaly.isolation import IsolationAnomalyDetector
from src.anomaly.rules import RuleEngine, RuleSignal

LEVEL_NORMAL = "Normal"
LEVEL_SUSPICIOUS = "Suspicious"
LEVEL_IRREGULAR = "Irregular"


@dataclass
class AnomalyVerdict:
    """Everything downstream consumers (viz, logs, dashboard) need."""
    level: str                     # Normal / Suspicious / Irregular
    fused_score: float             # 0..1
    signal_score: float            # rule aggregate
    ml_score: float
    scene_score: float
    signals: list[RuleSignal]
    explanation: list[str] = field(default_factory=list)
    why: str = ""                  # one-line summary for quick reading

    def to_dict(self) -> dict:
        return {
            "level": self.level, "fused_score": round(self.fused_score, 3),
            "signal_score": round(self.signal_score, 3),
            "ml_score": round(self.ml_score, 3),
            "scene_score": round(self.scene_score, 3),
            "why": self.why,
            "rules": [s.rule for s in self.signals],
        }


class AnomalyFusion:
    """Aggregates rule/ML/scene signals for the current frame's observation."""

    def __init__(self, rule_engine: RuleEngine | None = None,
                 detector: IsolationAnomalyDetector | None = None):
        self.rule_engine = rule_engine or RuleEngine()
        self.detector = detector or IsolationAnomalyDetector()

    def fuse(self, signal: list[RuleSignal] | None,
             ml_score: float | None, scene_score: float | None) -> AnomalyVerdict:
        rule_block = (sorted(signal, key=lambda s: -s.severity)
                      if signal else [])
        # Rule evidence: each signal contributes up to its severity, but an
        # object beset by several moderately-severe signals caps near 0.9.
        rule_score = sum(s.severity * (0.7 ** i) for i, s in enumerate(rule_block))
        rule_score = round(min(rule_score, 1.0), 3)

        w = load_config().anomaly.weights
        fused = (rule_score * w["rule"]
                 + (ml_score or 0.0) * w["ml"]
                 + (scene_score or 0.0) * w["scene"])

        cfg = load_config().anomaly
        if fused >= cfg.threshold_irregular:
            level = LEVEL_IRREGULAR
        elif fused >= cfg.threshold_suspicious:
            level = LEVEL_SUSPICIOUS
        else:
            level = LEVEL_NORMAL
        return AnomalyVerdict(
            level=level,
            fused_score=round(float(fused), 3),
            signal_score=rule_score,
            ml_score=round(ml_score or 0.0, 3),
            scene_score=round(scene_score or 0.0, 3),
            signals=rule_block,
        )


def explain(verdict: AnomalyVerdict, extra_signal_texts: list[str] | None = None
            ) -> AnomalyVerdict:
    """Attach human-readable explanation lines to a verdict (returns it too)."""
    lines: list[str] = []
    if verdict.level == LEVEL_NORMAL:
        lines.append("No unusual movement detected.")
    else:
        topic_bits: list[str] = []
        # Signals, in order of severity, get short phrases.
        for s in verdict.signals[:3]:
            since_vs = "%.0f%% severity" % (s.severity * 100)
            topic_bits.append(f"fired rule [{s.rule}] ({since_vs}): {s.description}")
        if verdict.ml_score > 0.4:
            topic_bits.append(
                f"Isolation Forest flags this motion as out-of-distribution "
                f"(score {verdict.ml_score:.2f})")
        if verdict.scene_score > 0.3:
            topic_bits.append(
                f"movement deviates from the scene's typical patterns "
                f"(score {verdict.scene_score:.2f})")
        lines += topic_bits
    lines += list(extra_signal_texts or [])
    verdict.explanation = lines
    verdict.why = verdict.explanation[0] if verdict.explanation \
        else f"{verdict.level} (fused={verdict.fused_score:.2f})"
    return verdict
