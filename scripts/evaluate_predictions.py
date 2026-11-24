#!/usr/bin/env python3
"""Evaluate detection/tracking/anomaly predictions against JSON ground truth.

Usage:
    .venv/bin/python -m scripts.evaluate_predictions \
        --ground-truth annotations.json \
        --predictions predictions.json \
        --output-json evaluation.json \
        --output-report evaluation.md

The evaluator uses the Phase 15 annotation format documented in
``src/evaluation/annotations.py``. It does not read or write the production
SQLite database; both inputs and outputs are explicit files.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from src.evaluation import AnnotationError, evaluate_files, render_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ground-truth", required=True, type=Path,
                        help="versioned ground-truth annotation JSON")
    parser.add_argument("--predictions", required=True, type=Path,
                        help="versioned prediction JSON")
    parser.add_argument("--iou-threshold", type=float, default=0.5,
                        help="minimum IoU for a detection match (default 0.5)")
    parser.add_argument("--output-json", type=Path,
                        default=Path("evaluation.json"),
                        help="machine-readable result path")
    parser.add_argument("--output-report", type=Path,
                        default=Path("evaluation.md"),
                        help="Markdown report path")
    args = parser.parse_args(argv)

    try:
        result = evaluate_files(args.ground_truth, args.predictions,
                                iou_threshold=args.iou_threshold)
    except AnnotationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    args.output_report.parent.mkdir(parents=True, exist_ok=True)
    args.output_report.write_text(render_report(result), encoding="utf-8")

    overall = result["overall"]
    print(f"evaluated {overall['videos']} video(s)")
    print(f"detection precision={overall['detection']['precision']} "
          f"recall={overall['detection']['recall']} "
          f"f1={overall['detection']['f1']}")
    print(f"tracking id_switches={overall['tracking']['id_switches']} "
          f"continuity={overall['tracking']['track_continuity']}")
    print(f"anomaly precision={overall['anomaly']['precision']} "
          f"recall={overall['anomaly']['recall']} "
          f"f1={overall['anomaly']['f1']}")
    print(f"wrote {args.output_json} and {args.output_report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
