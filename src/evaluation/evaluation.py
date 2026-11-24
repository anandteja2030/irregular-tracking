"""Reproducible detection, tracking and anomaly evaluation for Phase 15.

The evaluator is deliberately independent of the API and SQLite path. It
accepts the versioned JSON annotations from :mod:`src.evaluation.annotations`
and returns a JSON-serializable result; callers decide where to write it.

Matching policy
---------------
* Detections are matched **per video and per frame**.
* A candidate pair must have IoU >= the configured threshold (default 0.5).
* Candidates are sorted by descending IoU, then by ground-truth object ID and
  predicted track ID for deterministic tie-breaking.
* Matching is one-to-one greedy: each GT object and prediction can participate
  in at most one pair in a frame. Extra predictions are false positives;
  unmatched GT objects are false negatives.

Tracking and anomaly policy
---------------------------
* A GT object inherits the predicted track ID of its per-frame detector match.
* An ID switch is counted only between consecutive visible GT frames
  (``frame_idx`` increases by one) that both matched different track IDs.
  A missing frame breaks that comparison rather than counting a re-entry as a
  switch.
* Track continuity is matched GT observations divided by all GT observations.
  A GT track is fragmented when an unmatched visible frame occurs between its
  first and last matched frame.
* Anomaly metrics are end-to-end: every GT object-frame is evaluated, an
  unmatched GT anomaly is a false negative, and an unmatched positive
  prediction is a false positive. Detection metrics remain separately
  reported so a detector miss can be distinguished from a classification
  error.
* Category metrics score only matched GT anomalies that were also predicted
  positive; a missed anomaly is already an anomaly false negative.
* A predicted level is positive when it is ``Suspicious``, ``Irregular`` or
  the binary alias ``Anomaly``.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .annotations import (
    DEFAULT_IOU_THRESHOLD,
    POSITIVE_LEVELS,
    SCHEMA_VERSION,
    AnnotationError,
    GroundTruthObject,
    GroundTruthVideo,
    Prediction,
    PredictionVideo,
    bbox_iou,
    load_ground_truth,
    load_predictions,
    parse_ground_truth,
    parse_predictions,
)

MATCHING_STRATEGY = "greedy_one_to_one_per_frame_descending_iou"
MOSTLY_TRACKED_COVERAGE = 0.8


@dataclass(frozen=True)
class Match:
    frame_idx: int
    gt_object: GroundTruthObject
    prediction: Prediction
    iou: float


def _round(value: float | None) -> float | None:
    return None if value is None else round(float(value), 4)


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _prf(tp: int, fp: int, fn: int) -> tuple[float | None, float | None,
                                             float | None]:
    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    if precision is None or recall is None:
        f1 = None
    elif precision + recall == 0:
        f1 = 0.0
    else:
        f1 = 2 * precision * recall / (precision + recall)
    return precision, recall, f1


def _match_frame(frame_idx: int, gt_objects: list[GroundTruthObject],
                 predictions: tuple[Prediction, ...],
                 iou_threshold: float) -> list[Match]:
    candidates: list[tuple[float, str, str, GroundTruthObject,
                           Prediction]] = []
    for gt_object in gt_objects:
        gt_box = gt_object.frames[frame_idx]
        for prediction in predictions:
            iou = bbox_iou(gt_box, prediction.bbox)
            if iou >= iou_threshold:
                candidates.append((iou, gt_object.object_id,
                                   prediction.track_id, gt_object, prediction))
    candidates.sort(key=lambda item: (-item[0], item[1], item[2]))

    used_objects: set[str] = set()
    used_tracks: set[str] = set()
    matches: list[Match] = []
    for iou, _object_id, track_id, gt_object, prediction in candidates:
        if gt_object.object_id in used_objects or track_id in used_tracks:
            continue
        used_objects.add(gt_object.object_id)
        used_tracks.add(track_id)
        matches.append(Match(frame_idx, gt_object, prediction, iou))
    return matches


def _detection_block(tp: int, fp: int, fn: int, iou_sum: float) -> dict:
    precision, recall, f1 = _prf(tp, fp, fn)
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": _round(precision),
        "recall": _round(recall),
        "f1": _round(f1),
        "mean_matched_iou": _round(iou_sum / tp if tp else None),
    }


def _category_block(confusion: dict[str, dict[str, int]],
                    evaluated: int, correct: int) -> dict:
    ordered = {
        gt_category: dict(sorted(predictions.items()))
        for gt_category, predictions in sorted(confusion.items())
    }
    return {
        "evaluated": evaluated,
        "correct": correct,
        "accuracy": _round(_ratio(correct, evaluated)),
        "confusion": ordered,
    }


def _anomaly_block(tp: int, fp: int, fn: int, tn: int,
                   category_confusion: dict[str, dict[str, int]],
                   category_evaluated: int, category_correct: int,
                   matched: int, gt_observations: int,
                   unmatched_gt_anomalies: int,
                   unmatched_positive_predictions: int,
                   predicted_positive: int) -> dict:
    precision, recall, f1 = _prf(tp, fp, fn)
    total = tp + fp + fn + tn
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": _round(precision),
        "recall": _round(recall),
        "f1": _round(f1),
        "false_positive_rate": _round(_ratio(fp, fp + tn)),
        "accuracy": _round(_ratio(tp + tn, total)),
        "matched_observations": matched,
        "gt_observations": gt_observations,
        "unmatched_gt_observations": gt_observations - matched,
        "unmatched_gt_anomalies": unmatched_gt_anomalies,
        "unmatched_positive_predictions": unmatched_positive_predictions,
        "predicted_positive": predicted_positive,
        "confusion_matrix": {
            "true_normal": {
                "predicted_normal": tn,
                "predicted_positive": fp,
            },
            "true_anomaly": {
                "predicted_normal": fn,
                "predicted_positive": tp,
            },
        },
        "category": _category_block(
            category_confusion, category_evaluated, category_correct),
    }


def _tracking_block(video: GroundTruthVideo,
                    matched_by_object: dict[str, dict[int, str]],
                    gt_observations: int) -> tuple[dict, float]:
    id_switches = 0
    fragmented = 0
    mostly_tracked = 0
    tracked_tracks = 0
    matched_observations = 0
    coverage_sum = 0.0
    for gt_object in video.objects:
        frame_indices = sorted(gt_object.frames)
        matches = matched_by_object.get(gt_object.object_id, {})
        matched_frames = [frame for frame in frame_indices if frame in matches]
        matched_observations += len(matched_frames)
        coverage = len(matched_frames) / len(frame_indices)
        coverage_sum += coverage
        if matched_frames:
            tracked_tracks += 1
        if coverage >= MOSTLY_TRACKED_COVERAGE:
            mostly_tracked += 1
        if len(matched_frames) > 1:
            first, last = matched_frames[0], matched_frames[-1]
            if any(frame not in matches
                   for frame in frame_indices if first < frame < last):
                fragmented += 1
        for previous, current in zip(frame_indices, frame_indices[1:]):
            # Frames must be truly consecutive; an occlusion gap is not
            # treated as an identity switch.
            if current != previous + 1:
                continue
            previous_track = matches.get(previous)
            current_track = matches.get(current)
            if (previous_track is not None and current_track is not None
                    and previous_track != current_track):
                id_switches += 1
    n_tracks = len(video.objects)
    return ({
        "gt_tracks": n_tracks,
        "tracked_gt_tracks": tracked_tracks,
        "mostly_tracked_tracks": mostly_tracked,
        "fragmented_tracks": fragmented,
        "id_switches": id_switches,
        "mean_track_coverage": _round(coverage_sum / n_tracks
                                      if n_tracks else None),
        "track_continuity": _round(_ratio(matched_observations,
                                          gt_observations)),
    }, coverage_sum)


def _evaluate_video(video: GroundTruthVideo, predictions: PredictionVideo,
                    iou_threshold: float) -> tuple[dict, float, float]:
    gt_by_frame: dict[int, list[GroundTruthObject]] = {}
    for gt_object in video.objects:
        for frame_idx in gt_object.frames:
            gt_by_frame.setdefault(frame_idx, []).append(gt_object)

    matched_by_object: dict[str, dict[int, str]] = {}
    match_by_key: dict[tuple[str, int], Match] = {}
    match_count = 0
    iou_sum = 0.0
    gt_observations = 0
    predicted_observations = 0
    for frame_idx in sorted(set(gt_by_frame) | set(predictions.frames)):
        gt_objects = gt_by_frame.get(frame_idx, [])
        frame_predictions = predictions.frames.get(frame_idx, ())
        gt_observations += len(gt_objects)
        predicted_observations += len(frame_predictions)
        for match in _match_frame(
                frame_idx, gt_objects, frame_predictions, iou_threshold):
            match_count += 1
            iou_sum += match.iou
            matched_by_object.setdefault(
                match.gt_object.object_id, {})[frame_idx] = \
                match.prediction.track_id
            match_by_key[(match.gt_object.object_id, frame_idx)] = match

    tp = match_count
    fp = predicted_observations - tp
    fn = gt_observations - tp

    predicted_positive = sum(
        1 for frame_predictions in predictions.frames.values()
        for prediction in frame_predictions
        if prediction.level in POSITIVE_LEVELS)
    matched_positive_predictions = 0
    anomaly_tp = anomaly_fp = anomaly_fn = anomaly_tn = 0
    unmatched_gt_anomalies = 0
    category_confusion: dict[str, dict[str, int]] = {}
    category_evaluated = category_correct = 0
    for gt_object in video.objects:
        for frame_idx in gt_object.frames:
            match = match_by_key.get((gt_object.object_id, frame_idx))
            if match is None:
                if gt_object.label == "Anomaly":
                    anomaly_fn += 1
                    unmatched_gt_anomalies += 1
                else:
                    anomaly_tn += 1
                continue
            prediction_positive = match.prediction.level in POSITIVE_LEVELS
            if prediction_positive:
                matched_positive_predictions += 1
            true_positive = gt_object.label == "Anomaly"
            if true_positive and prediction_positive:
                anomaly_tp += 1
            elif true_positive:
                anomaly_fn += 1
            elif prediction_positive:
                anomaly_fp += 1
            else:
                anomaly_tn += 1
            if (true_positive and prediction_positive
                    and gt_object.category is not None):
                predicted_category = (match.prediction.category
                                      or "<missing>")
                category_confusion.setdefault(
                    gt_object.category, {})
                category_confusion[gt_object.category][predicted_category] = \
                    category_confusion[gt_object.category].get(
                        predicted_category, 0) + 1
                category_evaluated += 1
                if match.prediction.category == gt_object.category:
                    category_correct += 1

    unmatched_positive_predictions = (
        predicted_positive - matched_positive_predictions)
    anomaly_fp += unmatched_positive_predictions

    tracking, coverage_sum = _tracking_block(
        video, matched_by_object, gt_observations)
    return ({
        "video_id": video.video_id,
        "counts": {
            "gt_observations": gt_observations,
            "predicted_observations": predicted_observations,
            "matched_observations": tp,
            "unmatched_gt_observations": fn,
            "unmatched_predictions": fp,
        },
        "detection": _detection_block(tp, fp, fn, iou_sum),
        "tracking": tracking,
        "anomaly": _anomaly_block(
            anomaly_tp, anomaly_fp, anomaly_fn, anomaly_tn,
            category_confusion, category_evaluated, category_correct,
            matched=tp, gt_observations=gt_observations,
            unmatched_gt_anomalies=unmatched_gt_anomalies,
            unmatched_positive_predictions=unmatched_positive_predictions,
            predicted_positive=predicted_positive),
    }, iou_sum, coverage_sum)


def _overall(video_results: list[dict], iou_sums: list[float],
             coverage_sums: list[float]) -> dict:
    tp = sum(video["detection"]["tp"] for video in video_results)
    fp = sum(video["detection"]["fp"] for video in video_results)
    fn = sum(video["detection"]["fn"] for video in video_results)
    iou_sum = sum(iou_sums)
    anomaly_tp = sum(video["anomaly"]["tp"] for video in video_results)
    anomaly_fp = sum(video["anomaly"]["fp"] for video in video_results)
    anomaly_fn = sum(video["anomaly"]["fn"] for video in video_results)
    anomaly_tn = sum(video["anomaly"]["tn"] for video in video_results)
    category_confusion: dict[str, dict[str, int]] = {}
    for video in video_results:
        for gt_category, predictions in video["anomaly"]["category"][
                "confusion"].items():
            target = category_confusion.setdefault(gt_category, {})
            for predicted_category, count in predictions.items():
                target[predicted_category] = target.get(
                    predicted_category, 0) + count
    unmatched_gt_anomalies = sum(
        video["anomaly"]["unmatched_gt_anomalies"]
        for video in video_results)
    unmatched_positive_predictions = sum(
        video["anomaly"]["unmatched_positive_predictions"]
        for video in video_results)
    gt_observations = sum(
        video["counts"]["gt_observations"] for video in video_results)
    matched_observations = sum(
        video["anomaly"]["matched_observations"]
        for video in video_results)
    gt_tracks = sum(video["tracking"]["gt_tracks"]
                    for video in video_results)
    coverage_sum = sum(coverage_sums)
    return {
        "videos": len(video_results),
        "counts": {
            "gt_observations": gt_observations,
            "predicted_observations": sum(
                result["counts"]["predicted_observations"]
                for result in video_results),
            "matched_observations": tp,
            "unmatched_gt_observations": fn,
            "unmatched_predictions": fp,
        },
        "detection": _detection_block(tp, fp, fn, iou_sum),
        "tracking": {
            "gt_tracks": gt_tracks,
            "tracked_gt_tracks": sum(
                result["tracking"]["tracked_gt_tracks"]
                for result in video_results),
            "mostly_tracked_tracks": sum(
                result["tracking"]["mostly_tracked_tracks"]
                for result in video_results),
            "fragmented_tracks": sum(
                result["tracking"]["fragmented_tracks"]
                for result in video_results),
            "id_switches": sum(result["tracking"]["id_switches"]
                               for result in video_results),
            "mean_track_coverage": _round(
                coverage_sum / gt_tracks if gt_tracks else None),
            "track_continuity": _round(_ratio(matched_observations,
                                              gt_observations)),
        },
        "anomaly": _anomaly_block(
            anomaly_tp, anomaly_fp, anomaly_fn, anomaly_tn,
            category_confusion,
            sum(video["anomaly"]["category"]["evaluated"]
                for video in video_results),
            sum(video["anomaly"]["category"]["correct"]
                for video in video_results),
            matched=matched_observations,
            gt_observations=gt_observations,
            unmatched_gt_anomalies=unmatched_gt_anomalies,
            unmatched_positive_predictions=unmatched_positive_predictions,
            predicted_positive=sum(video["anomaly"]["predicted_positive"]
                                   for video in video_results)),
    }


def _validate_iou_threshold(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AnnotationError("iou_threshold: expected a number in [0, 1]")
    threshold = float(value)
    if not math.isfinite(threshold) or threshold < 0 or threshold > 1:
        raise AnnotationError("iou_threshold: expected a number in [0, 1]")
    return threshold


def evaluate(ground_truth: Any, predictions: Any, *,
             iou_threshold: float = DEFAULT_IOU_THRESHOLD) -> dict:
    """Evaluate prediction data against ground truth across all videos.

    ``ground_truth`` and ``predictions`` may be raw parsed JSON documents or
    the normalized values returned by the annotation loaders.
    """
    threshold = _validate_iou_threshold(iou_threshold)
    if (isinstance(ground_truth, (tuple, list))
            and all(isinstance(video, GroundTruthVideo)
                    for video in ground_truth)):
        gt_videos = tuple(ground_truth)
    else:
        gt_videos = parse_ground_truth(ground_truth)
    if (isinstance(predictions, dict)
            and all(isinstance(video, PredictionVideo)
                    for video in predictions.values())):
        pred_videos = predictions
    else:
        pred_videos = parse_predictions(predictions)

    gt_ids = {video.video_id for video in gt_videos}
    unknown = sorted(set(pred_videos) - gt_ids)
    if unknown:
        raise AnnotationError(
            "predictions.videos contain unknown video id(s): "
            + ", ".join(repr(video_id) for video_id in unknown))

    video_results: list[dict] = []
    iou_sums: list[float] = []
    coverage_sums: list[float] = []
    for video in gt_videos:
        result, iou_sum, coverage_sum = _evaluate_video(
            video, pred_videos.get(video.video_id,
                                   PredictionVideo(video.video_id, {})),
            threshold)
        video_results.append(result)
        iou_sums.append(iou_sum)
        coverage_sums.append(coverage_sum)

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_utc": datetime.now(timezone.utc).isoformat(
            timespec="seconds"),
        "matching": {
            "iou_threshold": threshold,
            "bbox_order": "x, y, width, height",
            "strategy": MATCHING_STRATEGY,
            "identity_rule": (
                "predictions are associated per frame by IoU; an ID switch "
                "is counted between consecutive GT-visible frames that map "
                "to different track IDs"),
            "positive_levels": sorted(POSITIVE_LEVELS),
            "anomaly_scope": (
                "end-to-end over all GT object-frame observations; unmatched "
                "GT anomalies are false negatives and unmatched positive "
                "predictions are false positives"),
        },
        "videos": video_results,
        "overall": _overall(video_results, iou_sums, coverage_sums),
    }


def evaluate_files(ground_truth_path: Any, predictions_path: Any, *,
                   iou_threshold: float = DEFAULT_IOU_THRESHOLD) -> dict:
    """Load two JSON files and evaluate them."""
    return evaluate(load_ground_truth(ground_truth_path),
                    load_predictions(predictions_path),
                    iou_threshold=iou_threshold)
