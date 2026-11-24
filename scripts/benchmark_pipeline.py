#!/usr/bin/env python3
"""Run the existing pipeline and score its output against Phase 15 ground truth.

Usage:
    .venv/bin/python -m scripts.benchmark_pipeline \
        --source samples/anomaly_clip.mp4 \
        --ground-truth annotations.json \
        --video-id anomaly_clip \
        --predictions benchmark_predictions.json \
        --output-json benchmark_evaluation.json \
        --output-report benchmark_report.md \
        --manifest benchmark_manifest.json

This runs the normal analysis service with its existing ``on_frame`` hook,
converts every returned ``FrameResult`` through the Phase 15 adapter, evaluates
the result and writes a reproducibility manifest. It does not persist a
session to SQLite and does not change the detector or API.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from config.config import PROJECT_ROOT, load_config
from src.core.analysis_service import SessionResult, run_analysis
from src.evaluation import (
    AnnotationError,
    DEFAULT_IOU_THRESHOLD,
    evaluate,
    frames_to_predictions,
    load_ground_truth,
    render_report,
    write_predictions,
)
from src.pipeline import FrameResult

MANIFEST_VERSION = 1
_PREDICTION_ENTRY_FIELDS = ("track_id", "centroid", "bbox_wh", "level")


def _json_safe(value: Any) -> Any:
    """Convert config values/paths to a JSON-safe representation."""
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


def file_sha256(path: Path | str) -> str | None:
    """Hash a source or annotation file without loading it all into memory."""
    try:
        digest = hashlib.sha256()
        with Path(path).open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except (OSError, UnicodeError):
        return None


def _git(root: Path, *args: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True, text=True, check=False, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def git_metadata(root: Path = PROJECT_ROOT) -> dict:
    """Record the repository commit, branch and dirty state when available."""
    commit = _git(root, "rev-parse", "HEAD")
    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    status = _git(root, "status", "--porcelain")
    return {
        "available": commit is not None,
        "root": str(root),
        "commit": commit,
        "branch": branch,
        "dirty": None if status is None else bool(status),
    }


def _write_json(document: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    return path


def build_manifest(
        *, source: Path, ground_truth: Path, video_id: str,
        evaluation: dict, session: SessionResult, frames_collected: int,
        predictions: Path, evaluation_json: Path, report: Path,
        git: dict | None = None, generated_utc: str | None = None) -> dict:
    """Build the reproducibility record for one benchmark run."""
    config_path = PROJECT_ROOT / "config" / "config.py"
    config_values = _json_safe(dataclasses.asdict(load_config()))
    return {
        "schema_version": MANIFEST_VERSION,
        "generated_utc": (generated_utc
                          or datetime.now(timezone.utc).isoformat(
                              timespec="seconds")),
        "video_id": video_id,
        "source": {
            "path": str(source.resolve()),
            "label": source.name,
            "kind": "file",
            "sha256": file_sha256(source),
            "synthetic": session.is_synthetic,
            "fps": session.fps,
            "frames_available": session.frames_available,
            "frames_processed": session.frames_processed,
            "frames_collected": frames_collected,
            "frame_width": session.frame_width,
            "frame_height": session.frame_height,
            "max_frames": session.max_frames,
            "wall_s": session.wall_s,
        },
        "ground_truth": {
            "path": str(ground_truth.resolve()),
            "sha256": file_sha256(ground_truth),
        },
        "outputs": {
            "predictions": str(predictions),
            "evaluation_json": str(evaluation_json),
            "report": str(report),
        },
        "evaluation": {
            "schema_version": evaluation["schema_version"],
            "iou_threshold": evaluation["matching"]["iou_threshold"],
            "matching_strategy": evaluation["matching"]["strategy"],
            "positive_levels": evaluation["matching"]["positive_levels"],
        },
        "config": {
            "path": str(config_path.resolve()),
            "sha256": file_sha256(config_path),
            "values": config_values,
        },
        "runtime": {
            "python": platform.python_version(),
        },
        "git": git if git is not None else git_metadata(),
    }


def compact_frame_result(result: FrameResult) -> FrameResult:
    """Drop visualization/trajectory payloads not needed for predictions.

    ``FrameResult.entries`` also carries the per-frame trajectory snapshot and
    explanation objects. Retaining those for every frame makes a long video
    grow quadratically in memory even though the adapter only reads four
    fields. The projection is exact: it copies those four values unchanged.
    """
    entries = [
        {key: entry[key] for key in _PREDICTION_ENTRY_FIELDS if key in entry}
        for entry in result.entries
    ]
    return dataclasses.replace(
        result, annotated_bgr=np.empty((0, 0, 3), dtype=np.uint8),
        entries=entries)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path,
                        help="video source to run through the existing pipeline")
    parser.add_argument("--ground-truth", required=True, type=Path,
                        help="Phase 15 ground-truth annotation JSON")
    parser.add_argument("--video-id", default=None,
                        help="ground-truth video id (default: source stem)")
    parser.add_argument("--iou-threshold", type=float,
                        default=DEFAULT_IOU_THRESHOLD,
                        help="minimum IoU for a detection match (default 0.5)")
    parser.add_argument("--max-frames", type=int, default=None,
                        help="process at most this many frames")
    parser.add_argument("--predictions", type=Path,
                        default=Path("benchmark_predictions.json"),
                        help="where to write the adapted prediction JSON")
    parser.add_argument("--output-json", type=Path,
                        default=Path("benchmark_evaluation.json"),
                        help="where to write the evaluation result JSON")
    parser.add_argument("--output-report", type=Path,
                        default=Path("benchmark_report.md"),
                        help="where to write the Markdown evaluation report")
    parser.add_argument("--manifest", type=Path,
                        default=Path("benchmark_manifest.json"),
                        help="where to write the reproducibility manifest")
    args = parser.parse_args(argv)
    if args.max_frames is not None and args.max_frames <= 0:
        parser.error("--max-frames must be greater than zero")
    return args


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    source: Path = args.source
    ground_truth: Path = args.ground_truth
    video_id = args.video_id or source.stem

    if not source.is_file():
        print(f"error: source is not a readable file: {source}",
              file=sys.stderr)
        return 2
    if not ground_truth.is_file():
        print(f"error: ground truth is not a readable file: {ground_truth}",
              file=sys.stderr)
        return 2
    if (not math.isfinite(args.iou_threshold)
            or not 0 <= args.iou_threshold <= 1):
        print("error: --iou-threshold must be between 0 and 1",
              file=sys.stderr)
        return 2

    try:
        parsed_ground_truth = load_ground_truth(ground_truth)
    except AnnotationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    gt_video_ids = {video.video_id for video in parsed_ground_truth}
    if video_id not in gt_video_ids:
        print(
            f"error: video id {video_id!r} is not in ground truth "
            f"(available: {', '.join(sorted(gt_video_ids))})",
            file=sys.stderr)
        return 2

    # Capture the repository state before benchmark outputs are written so
    # generated files do not make the manifest look dirty by themselves.
    git = git_metadata()
    frames: list[FrameResult] = []

    def collect(result: FrameResult, _fps: float) -> None:
        # Keep only the fields the prediction adapter consumes, and release
        # the annotated pixels, so long benchmarks stay linear in frames.
        frames.append(compact_frame_result(result))

    try:
        session = run_analysis(
            str(source), source.name, "file", args.max_frames,
            session=f"benchmark:{video_id}", on_frame=collect)
    except (OSError, TypeError, ValueError) as exc:
        print(f"error: could not run pipeline: {exc}", file=sys.stderr)
        return 2

    if session.error:
        print(f"error: {session.error}", file=sys.stderr)
        return 2
    if not frames:
        print("error: pipeline produced no frames", file=sys.stderr)
        return 2

    try:
        predictions_doc = frames_to_predictions(video_id, frames)
        # Evaluate before writing any output. A rejected prediction document
        # must not leave a stale predictions file behind for the next run.
        evaluation = evaluate(
            parsed_ground_truth, predictions_doc,
            iou_threshold=args.iou_threshold)
        write_predictions(predictions_doc, args.predictions)
    except (AnnotationError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: could not write predictions: {exc}", file=sys.stderr)
        return 1

    try:
        _write_json(evaluation, args.output_json)
        args.output_report.parent.mkdir(parents=True, exist_ok=True)
        args.output_report.write_text(
            render_report(evaluation), encoding="utf-8")
        manifest = build_manifest(
            source=source, ground_truth=ground_truth, video_id=video_id,
            evaluation=evaluation, session=session,
            frames_collected=len(frames), predictions=args.predictions,
            evaluation_json=args.output_json, report=args.output_report,
            git=git)
        _write_json(manifest, args.manifest)
    except OSError as exc:
        print(f"error: could not write benchmark outputs: {exc}",
              file=sys.stderr)
        return 1

    overall = evaluation["overall"]
    print(f"benchmarked {video_id}: {session.frames_processed} frame(s)")
    print(f"detection precision={overall['detection']['precision']} "
          f"recall={overall['detection']['recall']} "
          f"f1={overall['detection']['f1']}")
    print(f"anomaly precision={overall['anomaly']['precision']} "
          f"recall={overall['anomaly']['recall']} "
          f"f1={overall['anomaly']['f1']}")
    print(f"wrote {args.predictions}, {args.output_json}, "
          f"{args.output_report} and {args.manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
