#!/usr/bin/env python3
"""Sample data generator.

Produces synthetic test videos in `samples/`:

  normal_traffic.mp4  - three moving coloured shapes; helps calibrate a
                        "normal" baseline
  anomaly_clip.mp4    - same baseline plus deliberate anomalies: a runner
                        crossing very fast and a slow loiterer
  tiny_noise.mp4      - sparse speckle noise only (exercise robustness)

All clips use a dark background with high-saturation HSV shapes so the
configured colour ranges detect them cleanly. Usage:

    .venv/bin/python scripts/generate_samples.py [--out samples]
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import cv2
import numpy as np

DRAW_BGR = {
    "red":    (39, 39, 245),
    "green":  (76, 177, 124),
    "blue":   (196, 89, 30),
    "orange": (0, 120, 255),
}


def _bg(w, h):
    return np.full((h, w, 3), 28, np.uint8)


def _write(path: Path, frames: list[np.ndarray], fps: float) -> None:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc("m", "j", "p", "g"),
                             fps, (frames[0].shape[1], frames[0].shape[0]))
    for f in frames:
        writer.write(f)
    writer.release()
    print(f"wrote {path} ({len(frames)} frames @ {fps:.0f} fps)")


def normal_traffic(w=640, h=360, seconds=10.0, fps=30.0):
    n = int(seconds * fps)
    frames = []
    for i in range(n):
        t = i / fps
        f = _bg(w, h)
        # steady E-moving green circle
        cx = 40 + (w - 80) * (t / seconds)
        cv2.circle(f, (int(cx), 100), 22, DRAW_BGR["green"], -1)
        # steady W-moving blue square
        cv2.rectangle(f, (int(w - 40 - (w - 80) * (t / seconds)), 200),
                      (int(w - 40 - (w - 80) * (t / seconds)) + 40, 240),
                      DRAW_BGR["blue"], -1)
        frames.append(f)
    return frames


def anomaly_clip(w=640, h=360, seconds=14.0, fps=30.0):
    """Normal-traffic template + a fast runner and a slow loiterer."""
    base = normal_traffic(w, h, seconds, fps)
    runner_t0 = 5.0     # huh, runner appears at 5s for 1.2 s
    loiterer_t0 = 8.0
    out = []
    for i, f in enumerate(base):
        f = f.copy()
        t = i / fps
        if runner_t0 <= t < runner_t0 + 1.2:
            # very fast runner (high speed, brief) - orange diagonal
            prog = (t - runner_t0) / 1.2
            x = int(30 + (w - 60) * prog)
            y = int(60 + 120 * prog)
            cv2.rectangle(f, (x, y), (x + 28, y + 28), DRAW_BGR["orange"], -1)
        if loiterer_t0 <= t:
            # slow drifter that essentially hovers around (480, 300)
            jx = 480 + int(6 * math.sin(t * 1.5))
            jy = 300 + int(4 * math.cos(t * 1.3))
            cv2.circle(f, (jx, jy), 12, DRAW_BGR["red"], -1)
        out.append(f)
    return out


def tiny_noise(w=320, h=240, seconds=4.0, fps=10.0, seed=5):
    rng = np.random.default_rng(seed)
    frames = []
    for i in range(int(seconds * fps)):
        f = _bg(w, h)
        specks = rng.random((h, w)) > 0.999
        f[specks] = (180, 180, 180)
        frames.append(f)
    return frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="samples")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fps = 30.0
    _write(out / "normal_traffic.mp4", normal_traffic(fps=fps), fps)
    _write(out / "anomaly_clip.mp4", anomaly_clip(fps=fps), fps)
    _write(out / "tiny_noise.mp4", tiny_noise(fps=10.0), 10.0)


if __name__ == "__main__":
    main()
