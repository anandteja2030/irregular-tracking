#!/usr/bin/env python3
"""Hard-to-detect sample generator.

The three clips from `scripts/generate_samples.py` are deliberately easy:
bright, saturated shapes on a dark background. These clips are the opposite:
each one makes one detection/analysis stage struggle, so the pipeline's
honest limits and borderline behaviour can be exercised by hand.

  hard_low_light.mp4        dim objects (V just above the mask floor) with
                            grain and periodic black-out flicker; the tracker
                            must coast through the dropped frames
  hard_crowded_crossing.mp4 same-colour objects passing through each other in
                            a crowded scene; stresses assignment / ID stability
  hard_subtle_speed.mp4     one object speeds up only 1.8x for ~1.4 s, with no
                            direction change; expected at most a soft flag
  hard_short_pause.mp4      an object pauses 2.4 s (below the 3 s loiter rule)
                            and then leaves; a hard negative for the loiter rule
  hard_grey_intruder.mp4    grey and dim intruders (S and V under the colour
                            mask floors) beside normal saturated traffic; the
                            known-miss case the docs admit to

Usage:

    .venv/bin/python scripts/generate_hard_samples.py [--out samples/hard]
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import cv2
import numpy as np

W, H, FPS = 640, 360, 30.0


def _bgr(h: int, s: int, v: int) -> tuple[int, int, int]:
    """HSV (OpenCV ranges) -> a BGR tuple for a solid shape."""
    px = np.uint8([[[h, s, v]]])
    b, g, r = cv2.cvtColor(px, cv2.COLOR_HSV2BGR)[0, 0]
    return int(b), int(g), int(r)


def _bg(seed: int) -> np.ndarray:
    """Dark background plus static clutter that never passes either mask.

    Clutter stays under V=60 and below S=60, so it adds visual noise for a
    human without becoming a candidate for the detector.
    """
    frame = np.full((H, W, 3), 18, np.uint8)
    rng = np.random.default_rng(seed)
    for _ in range(20):
        x, y = int(rng.integers(0, W)), int(rng.integers(0, H))
        w, h = int(rng.integers(12, 70)), int(rng.integers(6, 40))
        base = int(rng.integers(26, 44))
        cv2.rectangle(frame, (x, y), (x + w, y + h),
                      (base, base + 3, base + 1), -1)
    return frame


def _grain(frame: np.ndarray, rng: np.random.Generator, sigma: float) -> None:
    noise = rng.normal(0.0, sigma, frame.shape[:2]).astype(np.int16)
    frame[:] = np.clip(frame.astype(np.int16) + noise[:, :, None], 0, 255)


def _write(path: Path, frames: list[np.ndarray]) -> None:
    writer = cv2.VideoWriter(str(path),
                             cv2.VideoWriter_fourcc("m", "j", "p", "g"),
                             FPS, (W, H))
    for frame in frames:
        writer.write(frame)
    writer.release()
    print(f"wrote {path} ({len(frames)} frames @ {FPS:.0f} fps)")


def low_light(seconds: float = 12.0) -> list[np.ndarray]:
    """Dim, noisy, flickering shapes; contrast is near the mask floors."""
    rng = np.random.default_rng(11)
    green = _bgr(60, 210, 80)       # S/V just above the S>60,V>60 fallback
    blue = _bgr(115, 190, 75)
    red = _bgr(175, 200, 85)
    base = _bg(seed=1)
    frames = []
    for i in range(int(seconds * FPS)):
        t = i / FPS
        f = base.copy()
        cx = 40 + (W - 120) * (t / seconds)
        cv2.circle(f, (int(cx), 90), 20, green, -1)
        bx = W - 40 - (W - 120) * (t / seconds)
        cv2.rectangle(f, (int(bx), 200), (int(bx) + 38, 238), blue, -1)
        rx = 40 + ((W - 120) * (t / seconds) * 0.6) % (W - 100)
        cv2.circle(f, (int(rx), 300), 14, red, -1)
        _grain(f, rng, 3.5)
        # Two-frame black-out every 11 frames: below the V>60 floor.
        if i % 11 < 2:
            f = (f.astype(np.float32) * 0.42).astype(np.uint8)
        frames.append(f)
    return frames


def crowded_crossing(seconds: float = 14.0) -> list[np.ndarray]:
    """Same-colour circles pass through each other while traffic continues."""
    green = _bgr(60, 220, 210)
    blue = _bgr(115, 220, 220)
    orange = _bgr(20, 230, 240)
    red = _bgr(175, 220, 220)
    base = _bg(seed=2)
    frames = []
    for i in range(int(seconds * FPS)):
        t = i / FPS
        f = base.copy()
        # Two equal-size green circles, head-on along the same row.
        a = int((W - 100) * (t / seconds) + 50)
        b = int((W - 100) * (1 - t / seconds) + 50)
        cv2.circle(f, (a, 105), 22, green, -1)
        cv2.circle(f, (b, 105), 22, green, -1)
        # Crossing diagonal (red) through the vertical traffic lane.
        cv2.circle(f, (int(60 + 520 * (t / seconds)),
                       int(60 + 240 * (t / seconds))), 16, red, -1)
        sx = int(W - 60 - (W - 120) * (t / seconds))
        cv2.rectangle(f, (sx, 210), (sx + 40, 250), blue, -1)
        ox = int(60 + (W - 120) * (t / seconds))
        cv2.rectangle(f, (ox, 300), (ox + 34, 326), orange, -1)
        frames.append(f)
    return frames


def subtle_speed(seconds: float = 12.0) -> list[np.ndarray]:
    """A brief 2.5x speed burst in the dominant flow direction only."""
    green = _bgr(60, 220, 210)
    blue = _bgr(115, 220, 220)
    red = _bgr(175, 220, 220)
    orange = _bgr(20, 230, 240)
    base = _bg(seed=3)
    speed = 60.0            # px/s for every object at rest
    burst_t0, burst_len = 3.0, 1.4
    frames = []
    x_orange = 20.0
    for i in range(int(seconds * FPS)):
        t = i / FPS
        dt = 1.0 / FPS
        f = base.copy()
        cx = 40 + speed * t
        cv2.circle(f, (int(cx), 95), 20, green, -1)
        bx = W - 40 - speed * t
        cv2.rectangle(f, (int(bx), 210), (int(bx) + 38, 248), blue, -1)
        rx = 40 + (speed * t * 0.7) % (W - 90)
        cv2.circle(f, (int(rx), 305), 13, red, -1)
        # Orange square: same heading as the green circle, brief 1.8x burst,
        # then it simply leaves the frame (no wrap-around teleport).
        boost = 48.0 if burst_t0 <= t < burst_t0 + burst_len else 0.0
        x_orange += (speed + boost) * dt
        if x_orange <= W - 36:
            cv2.rectangle(f, (int(x_orange), 155), (int(x_orange) + 36, 191),
                          orange, -1)
        frames.append(f)
    return frames


def short_pause(seconds: float = 12.0) -> list[np.ndarray]:
    """A 2.4 s stop, deliberately below the 3.0 s loiter threshold."""
    green = _bgr(60, 220, 210)
    blue = _bgr(115, 220, 220)
    yellow = _bgr(35, 230, 230)
    base = _bg(seed=4)
    pause_t0, pause_len = 4.0, 2.4
    frames = []
    x_yellow = 40.0
    for i in range(int(seconds * FPS)):
        t = i / FPS
        f = base.copy()
        cv2.circle(f, (int(40 + 60 * t), 95), 20, green, -1)
        bx = W - 40 - 60 * t
        cv2.rectangle(f, (int(bx), 215), (int(bx) + 38, 253), blue, -1)
        if not (pause_t0 <= t < pause_t0 + pause_len):
            x_yellow += 60.0 / FPS
        # Tiny in-place jitter while paused: not a detection gap.
        jitter = int(2 * math.sin(t * 9.0)) if pause_t0 <= t < pause_t0 + pause_len else 0
        cv2.circle(f, (int(x_yellow) + jitter, 305), 15, yellow, -1)
        frames.append(f)
    return frames


def grey_intruder(seconds: float = 12.0) -> list[np.ndarray]:
    """Intruders below the S/V floors beside normal, detectable traffic."""
    green = _bgr(60, 220, 210)
    blue = _bgr(115, 220, 220)
    grey = (110, 110, 110)          # S = 0
    dim_green = _bgr(60, 190, 45)   # V = 45: under both the V>60 and range floors
    base = _bg(seed=5)
    frames = []
    for i in range(int(seconds * FPS)):
        t = i / FPS
        f = base.copy()
        cv2.circle(f, (int(40 + 60 * t), 95), 20, green, -1)
        bx = W - 40 - 60 * t
        cv2.rectangle(f, (int(bx), 215), (int(bx) + 38, 253), blue, -1)
        # Grey runner: fast, diagonal, invisible to the saturation mask.
        cv2.rectangle(f, (int(40 + 480 * (t / seconds)),
                          int(80 + 200 * (t / seconds))),
                      (int(40 + 480 * (t / seconds)) + 26,
                       int(80 + 200 * (t / seconds)) + 26), grey, -1)
        # Dim-green drifter that sits below the value floor.
        cv2.circle(f, (int(500 + 6 * math.sin(t * 1.4)),
                       int(300 + 4 * math.cos(t * 1.7))), 14, dim_green, -1)
        frames.append(f)
    return frames


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="samples/hard")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    _write(out / "hard_low_light.mp4", low_light())
    _write(out / "hard_crowded_crossing.mp4", crowded_crossing())
    _write(out / "hard_subtle_speed.mp4", subtle_speed())
    _write(out / "hard_short_pause.mp4", short_pause())
    _write(out / "hard_grey_intruder.mp4", grey_intruder())


if __name__ == "__main__":
    main()
