#!/usr/bin/env python3
"""CLI entry point for the full pipeline.

Usage:
    .venv/bin/python -m scripts.run_pipeline samples/anomaly_clip.mp4
    .venv/bin/python -m scripts.run_pipeline 0            # webcam 0
    .venv/bin/python -m scripts.run_pipeline clip.mp4 --save output/out.mp4

Writes per-session SQLite logs to data/app_data.db and an annotated video if
--save is given. A run is persisted only after it finishes successfully, using
the same `save_session_to_db` path as the API and Streamlit.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow `python scripts/run_pipeline.py` from any working directory.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import cv2

from src.core.analysis_service import run_analysis, save_session_to_db


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="webcam index (0,1,...) or video file path")
    ap.add_argument("--save", default=None, help="write annotated video here")
    ap.add_argument("--loop", action="store_true")
    args = ap.parse_args()

    src: int | str = int(args.source) if args.source.isdigit() else args.source
    session = args.source.split("/")[-1] if isinstance(src, str) else "webcam"
    source_kind = "webcam" if isinstance(src, int) else "file"
    writer = None
    announced = False

    def on_frame(result, fps: float) -> None:
        """Keep the CLI's live console feed and optional annotated video."""
        nonlocal writer, announced
        if not announced:
            print(f"source: {source_kind}  fps={fps:.1f}")
            announced = True
        if args.save:
            if writer is None:
                height, width = result.annotated_bgr.shape[:2]
                writer = cv2.VideoWriter(
                    args.save,
                    cv2.VideoWriter_fourcc("m", "p", "4", "v"),
                    fps, (width, height))
            writer.write(result.annotated_bgr)
        if result.frame_idx % int(max(1.0, fps)) == 0:      # ~1 Hz console feed
            n_anom = sum(e["level"] != "Normal" for e in result.entries)
            print(f"frame {result.frame_idx:4d}  dets={result.n_detections} "
                  f"tracks={len(result.entries)} anomalous_now={n_anom} "
                  f"calibrated={result.calibrated}")

    try:
        result = run_analysis(
            src, str(args.source), source_kind, None, session,
            on_frame=on_frame, loop=args.loop)

        if result.error:
            print(f"error: cannot read source {args.source!r}: {result.error}",
                  file=sys.stderr)
            print("hint: pass an existing video file (mp4/avi/mov/mkv) "
                  "or a webcam index such as 0", file=sys.stderr)
            return 2

        try:
            save_session_to_db(result)
        except Exception as exc:                            # noqa: BLE001
            print(f"error: results could not be stored: {exc}",
                  file=sys.stderr)
            return 1

        print(f"done: frames={result.frames_processed} "
              f"total_tracks={len(result.track_points)}")
        return 0
    finally:
        if writer is not None:
            writer.release()


if __name__ == "__main__":
    sys.exit(main())
