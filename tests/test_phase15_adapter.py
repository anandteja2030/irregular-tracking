"""Phase 15 tests for converting real pipeline frame results to predictions."""
from __future__ import annotations

import json

import numpy as np
import pytest

from src.evaluation import (
    evaluate,
    frames_to_predictions,
    parse_predictions,
    write_predictions,
)
from src.evaluation.adapter import frame_to_prediction_frame
from src.pipeline import FrameResult


def _entry(frame_idx, track_id, centroid, bbox_wh, level):
    """The entry shape produced by TrackingPipeline._observe_and_classify."""
    return {
        "frame_idx": frame_idx,
        "track_id": track_id,
        "centroid": centroid,
        "bbox_wh": bbox_wh,
        "level": level,
    }


def _frame(frame_idx, entries):
    return FrameResult(
        frame_idx=frame_idx,
        annotated_bgr=np.zeros((1, 1, 3), dtype=np.uint8),
        entries=entries,
        n_detections=len(entries),
        calibrated=False,
    )


def test_pipeline_frame_results_convert_to_valid_predictions(tmp_path):
    frames = [
        _frame(0, [_entry(0, 7, (100.0, 50.0), (20.0, 10.0), "Normal")]),
        _frame(1, [_entry(1, 7, (105.0, 50.0), (20.0, 10.0), "Suspicious")]),
    ]

    document = frames_to_predictions("clip-a", frames)

    assert document["schema_version"] == 1
    assert document["videos"][0]["video_id"] == "clip-a"
    assert document["videos"][0]["frames"][0]["objects"][0] == {
        "track_id": 7,
        "bbox": [90.0, 45.0, 20.0, 10.0],
        "level": "Normal",
    }
    parsed = parse_predictions(document)
    assert parsed["clip-a"].frames[0][0].bbox.xyxy == (90, 45, 110, 55)
    assert parsed["clip-a"].frames[1][0].level == "Suspicious"

    output = write_predictions(document, tmp_path / "nested" / "predictions.json")
    assert output.is_file()
    assert json.loads(output.read_text(encoding="utf-8")) == document


def test_adapter_output_can_be_benchmarked():
    frame = _frame(0, [
        _entry(0, 7, (100.0, 50.0), (20.0, 10.0), "Normal"),
    ])
    predictions = frames_to_predictions("clip-a", [frame])
    ground_truth = {
        "schema_version": 1,
        "videos": [{
            "video_id": "clip-a",
            "objects": [{
                "object_id": "subject",
                "label": "Normal",
                "frames": [{"frame_idx": 0, "bbox": [90, 45, 20, 10]}],
            }],
        }],
    }

    result = evaluate(ground_truth, predictions)["overall"]
    assert result["detection"]["tp"] == 1
    assert result["detection"]["fp"] == 0
    assert result["detection"]["fn"] == 0


def test_adapter_rejects_malformed_pipeline_entries():
    with pytest.raises(ValueError, match="centroid"):
        frame_to_prediction_frame(_frame(0, [{
            "track_id": 7, "bbox_wh": (20.0, 10.0), "level": "Normal",
        }]))
    with pytest.raises(ValueError, match="width and height must be positive"):
        frame_to_prediction_frame(_frame(0, [
            _entry(0, 7, (100.0, 50.0), (0.0, 10.0), "Normal"),
        ]))
    with pytest.raises(ValueError, match="track_id"):
        frame_to_prediction_frame(_frame(0, [
            _entry(0, "7", (100.0, 50.0), (20.0, 10.0), "Normal"),
        ]))
