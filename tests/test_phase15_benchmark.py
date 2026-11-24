"""Tests for the end-to-end Phase 15 benchmark runner."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from scripts import benchmark_pipeline as benchmark
from src.evaluation import parse_predictions
from src.pipeline import FrameResult

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "tiny_noise.mp4"


def _ground_truth(video_id: str) -> dict:
    return {
        "schema_version": 1,
        "videos": [{"video_id": video_id, "objects": []}],
    }


def test_benchmark_runner_runs_pipeline_and_writes_all_outputs(tmp_path):
    video_id = "tiny_noise"
    gt_path = tmp_path / "ground_truth.json"
    gt_path.write_text(json.dumps(_ground_truth(video_id)), encoding="utf-8")
    predictions = tmp_path / "out" / "predictions.json"
    evaluation = tmp_path / "out" / "evaluation.json"
    report = tmp_path / "out" / "report.md"
    manifest_path = tmp_path / "out" / "manifest.json"

    code = benchmark.main([
        "--source", str(SAMPLE),
        "--ground-truth", str(gt_path),
        "--video-id", video_id,
        "--max-frames", "1",
        "--predictions", str(predictions),
        "--output-json", str(evaluation),
        "--output-report", str(report),
        "--manifest", str(manifest_path),
    ])

    assert code == 0
    assert predictions.is_file()
    assert evaluation.is_file()
    assert report.is_file()
    assert manifest_path.is_file()

    parsed = parse_predictions(json.loads(predictions.read_text()))
    assert video_id in parsed
    result = json.loads(evaluation.read_text())
    assert result["schema_version"] == 1
    assert result["overall"]["videos"] == 1

    manifest = json.loads(manifest_path.read_text())
    assert manifest["schema_version"] == benchmark.MANIFEST_VERSION
    assert manifest["video_id"] == video_id
    assert manifest["source"]["sha256"] == benchmark.file_sha256(SAMPLE)
    assert manifest["source"]["frames_processed"] == 1
    assert manifest["ground_truth"]["sha256"] == benchmark.file_sha256(gt_path)
    assert manifest["evaluation"]["iou_threshold"] == 0.5
    assert manifest["evaluation"]["matching_strategy"]
    assert manifest["config"]["sha256"] == benchmark.file_sha256(
        ROOT / "config" / "config.py")
    assert "tracking" in manifest["config"]["values"]
    assert set(manifest["git"]) == {
        "available", "root", "commit", "branch", "dirty"}
    assert manifest["outputs"]["predictions"] == str(predictions)


def test_compact_frame_result_keeps_only_prediction_fields():
    original = FrameResult(
        frame_idx=7,
        annotated_bgr=np.full((4, 4, 3), 9, dtype=np.uint8),
        entries=[{
            "track_id": 3, "centroid": (10.0, 20.0),
            "bbox_wh": (8.0, 6.0), "level": "Suspicious",
            "trajectory": [(0, 1.0, 2.0)],
            "snapshot": object(), "rules": [{"rule": "x"}],
        }],
        n_detections=1,
        calibrated=True,
    )

    compact = benchmark.compact_frame_result(original)
    assert compact.frame_idx == 7
    assert compact.annotated_bgr.shape == (0, 0, 3)
    assert compact.entries == [{
        "track_id": 3, "centroid": (10.0, 20.0),
        "bbox_wh": (8.0, 6.0), "level": "Suspicious",
    }]
    assert original.entries[0]["track_id"] == 3


def test_benchmark_does_not_write_predictions_when_evaluation_rejects(
        tmp_path, monkeypatch, capsys):
    video_id = "tiny_noise"
    gt_path = tmp_path / "ground_truth.json"
    gt_path.write_text(json.dumps(_ground_truth(video_id)), encoding="utf-8")
    predictions = tmp_path / "out" / "predictions.json"

    def reject(*_args, **_kwargs):
        raise ValueError("rejected prediction document")

    monkeypatch.setattr(benchmark, "evaluate", reject)
    code = benchmark.main([
        "--source", str(SAMPLE),
        "--ground-truth", str(gt_path),
        "--video-id", video_id,
        "--max-frames", "1",
        "--predictions", str(predictions),
        "--output-json", str(tmp_path / "out" / "evaluation.json"),
        "--output-report", str(tmp_path / "out" / "report.md"),
        "--manifest", str(tmp_path / "out" / "manifest.json"),
    ])

    assert code == 2
    assert "rejected prediction document" in capsys.readouterr().err
    assert not predictions.exists()


def test_benchmark_runner_fails_before_pipeline_for_missing_ground_truth(
        tmp_path, capsys):
    prediction_path = tmp_path / "predictions.json"
    code = benchmark.main([
        "--source", str(SAMPLE),
        "--ground-truth", str(tmp_path / "missing.json"),
        "--predictions", str(prediction_path),
    ])

    assert code == 2
    assert "ground truth" in capsys.readouterr().err
    assert not prediction_path.exists()
