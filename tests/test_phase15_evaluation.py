"""Phase 15 tests for the ground-truth evaluation framework.

All tests use synthetic annotations and predictions. They exercise matching,
detection and anomaly metrics, tracking identity/continuity and the JSON /
Markdown output paths without touching the production database.
"""
from __future__ import annotations

import json

import pytest

from scripts.evaluate_predictions import main as evaluation_cli
from src.evaluation import (
    AnnotationError,
    bbox_iou,
    evaluate,
    parse_ground_truth,
    parse_predictions,
    render_report,
    write_report,
)


def _object(object_id, label, frames, category=None, trajectory=None):
    data = {
        "object_id": object_id,
        "label": label,
        "category": category,
        "frames": [
            {"frame_idx": frame, "bbox": bbox} for frame, bbox in frames
        ],
    }
    if trajectory is not None:
        data["trajectory"] = trajectory
    return data


def _prediction(track_id, bbox, level, category=None):
    data = {"track_id": track_id, "bbox": bbox, "level": level}
    if category is not None:
        data["category"] = category
    return data


def _ground_truth(video_id="v1", objects=None):
    return {"schema_version": 1, "videos": [{
        "video_id": video_id, "objects": objects or []
    }]}


def _predictions(video_id="v1", frames=None):
    return {"schema_version": 1, "videos": [{
        "video_id": video_id, "frames": frames or []
    }]}


def _perfect_data():
    gt = _ground_truth(objects=[
        _object("normal", "Normal", [
            (0, [100, 0, 10, 10]),
            (1, [101, 0, 10, 10]),
            (2, [102, 0, 10, 10]),
        ]),
        _object("anomaly", "Anomaly", [
            (0, [0, 0, 10, 10]),
            (1, [1, 0, 10, 10]),
            (2, [2, 0, 10, 10]),
        ], category="loitering"),
    ])
    frames = [
        {"frame_idx": frame, "objects": [
            _prediction(0, [100 + frame, 0, 10, 10], "Normal"),
            _prediction(1, [frame, 0, 10, 10], "Irregular",
                        category="loitering"),
        ]}
        for frame in range(3)
    ]
    return gt, _predictions(frames=frames)


def test_perfect_predictions_produce_perfect_metrics():
    gt, predictions = _perfect_data()

    result = evaluate(gt, predictions)
    overall = result["overall"]

    detection = overall["detection"]
    assert (detection["tp"], detection["fp"], detection["fn"]) == (6, 0, 0)
    assert detection["precision"] == 1.0
    assert detection["recall"] == 1.0
    assert detection["f1"] == 1.0
    assert detection["mean_matched_iou"] > 0.8
    assert overall["tracking"]["id_switches"] == 0
    assert overall["tracking"]["track_continuity"] == 1.0
    assert overall["tracking"]["fragmented_tracks"] == 0
    assert overall["tracking"]["mean_track_coverage"] == 1.0
    assert overall["anomaly"]["tp"] == 3
    assert overall["anomaly"]["tn"] == 3
    assert overall["anomaly"]["fp"] == 0
    assert overall["anomaly"]["fn"] == 0
    assert overall["anomaly"]["precision"] == 1.0
    assert overall["anomaly"]["recall"] == 1.0
    assert overall["anomaly"]["f1"] == 1.0
    assert overall["anomaly"]["false_positive_rate"] == 0.0
    assert overall["anomaly"]["confusion_matrix"] == {
        "true_normal": {"predicted_normal": 3, "predicted_positive": 0},
        "true_anomaly": {"predicted_normal": 0, "predicted_positive": 3},
    }
    assert overall["anomaly"]["category"]["accuracy"] == 1.0


def test_missed_detection_is_a_detection_false_negative_and_is_disclosed():
    gt, predictions = _perfect_data()
    predictions["videos"][0]["frames"][1]["objects"].pop(1)  # anomaly box

    result = evaluate(gt, predictions)
    overall = result["overall"]

    assert overall["detection"]["tp"] == 5
    assert overall["detection"]["fp"] == 0
    assert overall["detection"]["fn"] == 1
    assert overall["detection"]["recall"] == pytest.approx(5 / 6, abs=1e-4)
    assert overall["anomaly"]["matched_observations"] == 5
    assert overall["anomaly"]["unmatched_gt_observations"] == 1
    assert overall["anomaly"]["unmatched_gt_anomalies"] == 1
    # End-to-end anomaly recall includes the missed detector box.
    assert overall["anomaly"]["fn"] == 1
    assert overall["anomaly"]["recall"] == pytest.approx(2 / 3, abs=1e-4)
    assert overall["tracking"]["fragmented_tracks"] == 1
    assert overall["tracking"]["track_continuity"] == pytest.approx(
        5 / 6, abs=1e-4)


def test_false_detection_is_a_detection_false_positive():
    gt, predictions = _perfect_data()
    predictions["videos"][0]["frames"][0]["objects"].append(
        _prediction(99, [500, 500, 10, 10], "Suspicious"))

    result = evaluate(gt, predictions)
    overall = result["overall"]

    assert overall["detection"]["tp"] == 6
    assert overall["detection"]["fp"] == 1
    assert overall["detection"]["fn"] == 0
    assert overall["detection"]["precision"] == pytest.approx(6 / 7, abs=1e-4)
    assert overall["anomaly"]["fp"] == 1
    assert overall["anomaly"]["false_positive_rate"] == 0.25
    assert overall["anomaly"]["precision"] == 0.75
    assert overall["anomaly"]["unmatched_positive_predictions"] == 1
    assert overall["anomaly"]["predicted_positive"] == 4
    assert overall["counts"]["unmatched_predictions"] == 1


def test_identity_switch_and_fragmentation_are_measured():
    gt = _ground_truth(objects=[
        _object("target", "Normal", [
            (0, [0, 0, 10, 10]),
            (1, [0, 0, 10, 10]),
            (2, [0, 0, 10, 10]),
        ]),
    ])
    switched = _predictions(frames=[
        {"frame_idx": 0, "objects": [
            _prediction(10, [0, 0, 10, 10], "Normal")]},
        {"frame_idx": 1, "objects": [
            _prediction(11, [0, 0, 10, 10], "Normal")]},
        {"frame_idx": 2, "objects": [
            _prediction(11, [0, 0, 10, 10], "Normal")]},
    ])
    result = evaluate(gt, switched)["overall"]["tracking"]
    assert result["id_switches"] == 1
    assert result["fragmented_tracks"] == 0
    assert result["track_continuity"] == 1.0

    fragmented = _predictions(frames=[
        {"frame_idx": 0, "objects": [
            _prediction(10, [0, 0, 10, 10], "Normal")]},
        {"frame_idx": 2, "objects": [
            _prediction(10, [0, 0, 10, 10], "Normal")]},
    ])
    result = evaluate(gt, fragmented)["overall"]["tracking"]
    assert result["id_switches"] == 0       # a gap is not a switch
    assert result["fragmented_tracks"] == 1
    assert result["track_continuity"] == pytest.approx(2 / 3, abs=1e-4)


def test_anomaly_classification_errors_and_category_confusion():
    gt = _ground_truth(objects=[
        _object("normal", "Normal", [(0, [100, 0, 10, 10]),
                                     (1, [100, 0, 10, 10])]),
        _object("anomaly", "Anomaly", [(0, [0, 0, 10, 10]),
                                       (1, [0, 0, 10, 10])],
                category="loitering"),
    ])
    predictions = _predictions(frames=[
        {"frame_idx": 0, "objects": [
            _prediction(0, [100, 0, 10, 10], "Suspicious",
                        category="running"),
            _prediction(1, [0, 0, 10, 10], "Normal",
                        category="loitering"),
        ]},
        {"frame_idx": 1, "objects": [
            _prediction(0, [100, 0, 10, 10], "Normal"),
            _prediction(1, [0, 0, 10, 10], "Irregular",
                        category="running"),
        ]},
    ])

    anomaly = evaluate(gt, predictions)["overall"]["anomaly"]
    assert (anomaly["tp"], anomaly["fp"], anomaly["fn"], anomaly["tn"]) == (
        1, 1, 1, 1)
    assert anomaly["precision"] == 0.5
    assert anomaly["recall"] == 0.5
    assert anomaly["f1"] == 0.5
    assert anomaly["false_positive_rate"] == 0.5
    assert anomaly["confusion_matrix"] == {
        "true_normal": {"predicted_normal": 1, "predicted_positive": 1},
        "true_anomaly": {"predicted_normal": 1, "predicted_positive": 1},
    }
    # A missed anomaly is an anomaly FN, not a category-classification credit.
    assert anomaly["category"]["evaluated"] == 1
    assert anomaly["category"]["correct"] == 0
    assert anomaly["category"]["accuracy"] == 0.0
    assert anomaly["category"]["confusion"] == {
        "loitering": {"running": 1},
    }


def test_multiple_videos_are_aggregated():
    gt, predictions = _perfect_data()
    second_gt = _ground_truth("v2", [
        _object("second", "Normal", [(0, [0, 0, 20, 20])]),
    ])
    second_pred = _predictions("v2", [
        {"frame_idx": 0, "objects": [
            _prediction(4, [0, 0, 20, 20], "Normal")]},
    ])
    gt["videos"].append(second_gt["videos"][0])
    predictions["videos"].append(second_pred["videos"][0])

    result = evaluate(gt, predictions)
    assert result["overall"]["videos"] == 2
    assert [video["video_id"] for video in result["videos"]] == ["v1", "v2"]
    assert result["overall"]["detection"]["tp"] == 7
    assert result["overall"]["detection"]["fp"] == 0
    assert result["overall"]["tracking"]["gt_tracks"] == 3


def test_iou_threshold_and_annotation_validation():
    gt = _ground_truth(objects=[
        _object("a", "Normal", [(0, [0, 0, 10, 10])])
    ])
    box = parse_ground_truth(gt)[0].objects[0].frames[0]
    assert bbox_iou(box, box) == 1.0
    predictions = _predictions(frames=[
        {"frame_idx": 0, "objects": [
            _prediction(0, [20, 0, 10, 10], "Normal")]},
    ])
    result = evaluate(gt, predictions, iou_threshold=0.5)["overall"]
    assert result["detection"]["tp"] == 0
    assert result["detection"]["fp"] == 1
    assert result["detection"]["fn"] == 1

    with pytest.raises(AnnotationError, match="iou_threshold"):
        evaluate(gt, predictions, iou_threshold=float("nan"))
    with pytest.raises(AnnotationError, match="greater than zero"):
        evaluate(_ground_truth(objects=[
            _object("a", "Normal", [(0, [0, 0, 0, 10])])
        ]), predictions)
    with pytest.raises(AnnotationError, match="unknown video"):
        evaluate(gt, _predictions("unknown", frames=[]))
    with pytest.raises(AnnotationError, match="duplicate object"):
        parse_ground_truth(_ground_truth(objects=[
            _object("a", "Normal", [(0, [0, 0, 10, 10])]),
            _object("a", "Anomaly", [(0, [0, 0, 10, 10])]),
        ]))


def test_trajectory_points_are_part_of_the_validated_format():
    document = _ground_truth(objects=[
        _object("a", "Anomaly", [(0, [0, 0, 10, 10])],
                category="loitering",
                trajectory=[{"frame_idx": 0, "x": 5, "y": 5},
                            {"frame_idx": 1, "x": 6, "y": 5}]),
    ])
    parsed = parse_ground_truth(document)
    assert [point.frame_idx for point in
            parsed[0].objects[0].trajectory] == [0, 1]
    assert parsed[0].objects[0].trajectory[1].x == 6.0

    bad = json.loads(json.dumps(document))
    bad["videos"][0]["objects"][0]["trajectory"][0]["x"] = "bad"
    with pytest.raises(AnnotationError, match="expected a finite number"):
        parse_ground_truth(bad)


def test_report_and_machine_readable_output(tmp_path):
    gt, predictions = _perfect_data()
    result = evaluate(gt, predictions)
    text = render_report(result)

    assert text.startswith("# Ground-Truth Evaluation Report")
    assert "## Matching criteria" in text
    assert "Detection precision" in text
    assert "Anomaly confusion matrix" in text
    assert "The baseline detector was not changed" in text
    assert json.loads(json.dumps(result))["schema_version"] == 1

    output = tmp_path / "nested" / "evaluation.md"
    assert write_report(result, output) == output
    assert output.is_file()
    assert "| Detection recall |" in output.read_text(encoding="utf-8")


def test_cli_writes_json_and_markdown(tmp_path):
    gt, predictions = _perfect_data()
    gt_path = tmp_path / "gt.json"
    pred_path = tmp_path / "predictions.json"
    json_path = tmp_path / "out" / "evaluation.json"
    report_path = tmp_path / "out" / "evaluation.md"
    gt_path.write_text(json.dumps(gt), encoding="utf-8")
    pred_path.write_text(json.dumps(predictions), encoding="utf-8")

    assert evaluation_cli([
        "--ground-truth", str(gt_path),
        "--predictions", str(pred_path),
        "--output-json", str(json_path),
        "--output-report", str(report_path),
    ]) == 0
    stored = json.loads(json_path.read_text(encoding="utf-8"))
    assert stored["overall"]["detection"]["precision"] == 1.0
    assert report_path.is_file()


def test_prediction_duplicate_track_in_frame_is_rejected():
    predictions = _predictions(frames=[
        {"frame_idx": 0, "objects": [
            _prediction(1, [0, 0, 10, 10], "Normal"),
            _prediction(1, [20, 0, 10, 10], "Normal"),
        ]},
    ])
    with pytest.raises(AnnotationError, match="duplicate track id"):
        parse_predictions(predictions)
