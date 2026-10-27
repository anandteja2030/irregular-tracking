#!/usr/bin/env python3
"""CLI entry point for the full pipeline.

Usage:
    .venv/bin/python -m scripts.run_pipeline samples/anomaly_clip.mp4
    .venv/bin/python -m scripts.run_pipeline 0            # webcam 0
    .venv/bin/python -m scripts.run_pipeline clip.mp4 --save output/out.mp4

Writes per-session SQLite logs to data/app_data.db and an annotated video if
--save is given. On a headless box the last frame snapshot is always written
to output/last_frame.png so you can see what the annotator produced.
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

from config.config import load_config
from src.analysis.logger import ResultLogger
from src.pipeline import TrackingPipeline
from src.video.video_input import VideoSource


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", help="webcam index (0,1,...) or video file path")
    ap.add_argument("--save", default=None, help="write annotated video here")
    ap.add_argument("--loop", action="store_true")
    args = ap.parse_args()

    src: int | str = int(args.source) if args.source.isdigit() else args.source
    cfg = load_config()
    session = args.source.split("/")[-1] if isinstance(src, str) else "webcam"
    logger = ResultLogger(cfg.paths.db, session=session)
    writer = None

    try:
        with VideoSource(src=src, loop=args.loop) as vs:
            pipeline = TrackingPipeline(session=session, logger=logger)
            print(f"source: {vs.source_kind()}  fps={vs.fps:.1f}")
            for vf in vs:
                res = pipeline.process_frame(vf.bgr, vf.index, vf.fps)
                if args.save:
                    if writer is None:
                        writer = cv2.VideoWriter(
                            args.save,
                            cv2.VideoWriter_fourcc("m", "p", "4", "v"),
                            vs.fps, (res.annotated_bgr.shape[1],
                                     res.annotated_bgr.shape[0]))
                    writer.write(res.annotated_bgr)
                if vf.index % int(max(1.0, vs.fps)) == 0:  # ~1 Hz console feed
                    n_anom = sum(e["level"] != "Normal" for e in res.entries)
                    print(f"frame {vf.index:4d}  dets={res.n_detections} "
                          f"tracks={len(res.entries)} anomalous_now={n_anom} "
                          f"calibrated={res.calibrated}")
            pipeline.summarize_tracks(vs.fps)
            last = pipeline.tracker.all_time_tracks()
            print(f"done: frames={pipeline.n_frames} "
                  f"total_tracks={len(last)}")
    finally:
        if writer is not None:
            writer.release()
        logger.close()


if __name__ == "__main__":
    main()
