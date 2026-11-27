"""Evaluation metrics computed only from real measurements + real labels.

Design rules (scientific honesty):
  * ``classification_metrics`` returns ``None`` when evaluation is not
    valid - i.e. when no labels exist, or when the labels cover a single
    class (precision/recall/FPR would be undefined or meaningless).
  * Nothing is fabricated: every number derives from the passed vectors.
  * Tracking identity quality (ID switches vs. ground truth) needs labelled
    trajectories; none are collected here, so it is explicitly not reported.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ClassificationMetrics:
    tp: int
    fp: int
    fn: int
    tn: int
    precision: float
    recall: float
    f1: float
    fpr: float
    accuracy: float
    n_labeled: int

    def as_dict(self) -> dict:
        return {
            "tp": self.tp, "fp": self.fp, "fn": self.fn, "tn": self.tn,
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "fpr": round(self.fpr, 4),
            "accuracy": round(self.accuracy, 4),
            "n_labeled": self.n_labeled,
        }


@dataclass
class EvaluationOutcome:
    """Either metrics or an honest reason why they cannot be computed."""
    metrics: ClassificationMetrics | None
    reason: str = ""
    n_labeled: int = 0
    n_predicted_positive: int = 0
    extras: dict = field(default_factory=dict)

    @property
    def computable(self) -> bool:
        return self.metrics is not None


def predicted_positive(level: str) -> bool:
    """Detector's decision rule: Suspicious or Irregular counts as positive."""
    return level in ("Suspicious", "Irregular")


def classification_metrics(y_true: list[str],
                           y_pred_level: list[str]) -> ClassificationMetrics | None:
    """Binary metrics over labelled observations.

    Returns None when evaluation is undefined: empty input, mismatched
    lengths, missing predictions for some labels, or only one true class.
    """
    if not y_true or len(y_true) != len(y_pred_level):
        return None
    tp = fp = fn = tn = 0
    for t, p in zip(y_true, y_pred_level):
        t_pos = t == "Anomaly"
        p_pos = predicted_positive(p)
        if t_pos and p_pos:
            tp += 1
        elif not t_pos and p_pos:
            fp += 1
        elif t_pos and not p_pos:
            fn += 1
        else:
            tn += 1
    if (tp + fn) == 0 or (tn + fp) == 0:
        return None                    # single-class labels: not valid
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) \
        if (precision + recall) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    accuracy = (tp + tn) / (tp + fp + fn + tn)
    return ClassificationMetrics(
        tp=tp, fp=fp, fn=fn, tn=tn, precision=precision, recall=recall,
        f1=f1, fpr=fpr, accuracy=accuracy, n_labeled=len(y_true))


def roc_analysis(y_true: list[str],
                 scores: list[float | None]) -> dict:
    """Rank-based ROC curve and AUC from the fused score stream.

    The fused score is already a continuous 0-1 anomaly score, so ranking the
    labelled observations by it gives a genuine ROC curve - no probability is
    invented and no missing score is filled in. Observations without a stored
    fused score are excluded and reported as such.
    """
    pairs = [(float(score), 1 if label == "Anomaly" else 0)
             for label, score in zip(y_true, scores)
             if score is not None]
    positives = sum(1 for _, label in pairs if label == 1)
    negatives = len(pairs) - positives
    excluded = len(y_true) - len(pairs)
    if positives == 0 or negatives == 0:
        return {
            "available": False,
            "auc": None,
            "points": [],
            "positives": positives,
            "negatives": negatives,
            "excluded": excluded,
            "reason": ("ROC needs both a labelled anomaly and a labelled "
                       "normal observation with a stored fused score."),
        }

    # Descending score order, grouping ties so a tie adds one ROC step.
    ordered = sorted(pairs, key=lambda item: -item[0])
    curve: list[tuple[float, float]] = [(0.0, 0.0)]
    tp = fp = 0
    index = 0
    while index < len(ordered):
        score = ordered[index][0]
        while index < len(ordered) and ordered[index][0] == score:
            if ordered[index][1] == 1:
                tp += 1
            else:
                fp += 1
            index += 1
        curve.append((fp / negatives, tp / positives))

    # Trapezoidal area over the raw curve.
    auc = 0.0
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        auc += (x1 - x0) * (y0 + y1) / 2.0

    stride = max(1, len(curve) // 60)
    sampled = curve[::stride]
    if sampled[-1] != curve[-1]:
        sampled.append(curve[-1])
    return {
        "available": True,
        "auc": round(auc, 4),
        "points": [{"fpr": round(x, 4), "tpr": round(y, 4)}
                   for x, y in sampled],
        "positives": positives,
        "negatives": negatives,
        "excluded": excluded,
        "reason": None,
    }


def evaluate(obs_rows: list[dict], labels: list[dict]) -> EvaluationOutcome:
    """Join observation predictions with ground-truth labels and score them.

    Only observations that carry a label are scored; unlabelled observations
    are reported separately so partial labelling stays honest.
    """
    if not labels:
        return EvaluationOutcome(metrics=None,
                                 reason="No ground-truth labels yet - store "
                                        "Normal and Anomaly labels for this "
                                        "session to enable evaluation.")
    label_map = {(int(r["frame_idx"]), int(r["track_id"])): r["label"]
                 for r in labels}
    y_true: list[str] = []
    y_pred: list[str] = []
    unlabeled = 0
    for row in obs_rows:
        key = (int(row["frame"]), int(row["track_id"]))
        if key in label_map:
            y_true.append(label_map[key])
            y_pred.append(row["level"])
        else:
            unlabeled += 1
    if not y_true:
        return EvaluationOutcome(metrics=None,
                                 reason="Labels exist but none match this "
                                        "session's observations.",
                                 n_labeled=0)
    m = classification_metrics(y_true, y_pred)
    n_pred_pos = sum(1 for p in y_pred if predicted_positive(p))
    if m is None:
        return EvaluationOutcome(
            metrics=None,
            reason=(f"{len(y_true)} labelled observations all belong to one "
                    "class - precision/recall/F1 would be undefined. Label "
                    "both a normal and an anomalous track."),
            n_labeled=len(y_true),
            n_predicted_positive=n_pred_pos)
    return EvaluationOutcome(metrics=m, n_labeled=len(y_true),
                             n_predicted_positive=n_pred_pos,
                             extras={"unlabeled_observations": unlabeled})
