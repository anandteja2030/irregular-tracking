"""Phase 15 ground-truth evaluation framework.

Public entry points:
  * ``evaluate`` / ``evaluate_files`` produce a JSON-serializable result.
  * ``render_report`` / ``write_report`` produce Markdown.
  * ``frames_to_predictions`` / ``write_predictions`` adapt pipeline output.
  * ``load_ground_truth`` / ``load_predictions`` validate JSON annotations.

The existing API per-observation evaluation in ``src.analysis.metrics`` is
intentionally unchanged.
"""
from .adapter import (
    frame_to_prediction_frame,
    frames_to_predictions,
    write_predictions,
)
from .annotations import (
    DEFAULT_IOU_THRESHOLD,
    POSITIVE_LEVELS,
    PREDICTION_LEVELS,
    SCHEMA_VERSION,
    AnnotationError,
    BoundingBox,
    GroundTruthObject,
    GroundTruthVideo,
    Prediction,
    PredictionVideo,
    TrajectoryPoint,
    bbox_iou,
    load_ground_truth,
    load_predictions,
    parse_ground_truth,
    parse_predictions,
)
from .evaluation import (
    MATCHING_STRATEGY,
    MOSTLY_TRACKED_COVERAGE,
    evaluate,
    evaluate_files,
)
from .report import render_report, write_report

__all__ = [
    "AnnotationError",
    "BoundingBox",
    "DEFAULT_IOU_THRESHOLD",
    "GroundTruthObject",
    "GroundTruthVideo",
    "MATCHING_STRATEGY",
    "MOSTLY_TRACKED_COVERAGE",
    "POSITIVE_LEVELS",
    "PREDICTION_LEVELS",
    "Prediction",
    "PredictionVideo",
    "SCHEMA_VERSION",
    "TrajectoryPoint",
    "bbox_iou",
    "evaluate",
    "evaluate_files",
    "frame_to_prediction_frame",
    "frames_to_predictions",
    "load_ground_truth",
    "load_predictions",
    "parse_ground_truth",
    "parse_predictions",
    "render_report",
    "write_predictions",
    "write_report",
]
