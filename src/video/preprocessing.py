"""Phase 1 - image preprocessing.

`Preprocessor` turns a raw BGR frame into the per-channel colour/HSV versions
the downstream detection stage needs. The idea is that every stage below is
small, unit-testable, and side-effect-free.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from config.config import PreprocessConfig, load_config


@dataclass
class PreprocessResult:
    """Bundle of intermediate preprocessed artifacts for one frame."""
    bgr: np.ndarray       # blurred, lightly-denoised BGR (same H x W as input)
    hsv: np.ndarray       # same image converted to HSV (uint8 0-179 hue)
    gray: np.ndarray      # grayscale uint8, useful for edge/texture ideas later
    blurred_lab: np.ndarray   # optional CIELAB boost for tricky lighting


class Preprocessor:
    """Frame denoise + colour-space pipeline. Stateless per call."""

    def __init__(self, config: PreprocessConfig | None = None):
        self.cfg = config or load_config().preprocess

    # ------------------------------------------------------------ steps
    def _blur(self, bgr: np.ndarray) -> np.ndarray:
        k = max(1, int(self.cfg.gaussian_blur_ksize) | 1)   # force odd
        if k <= 1:
            return bgr
        return cv2.GaussianBlur(bgr, (k, k), 0)

    def _to_hsv(self, bgr: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)

    def _to_gray(self, bgr: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

    def _to_lab(self, bgr: np.ndarray) -> np.ndarray:
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)

    def _morph_open(self, mask: np.ndarray) -> np.ndarray:
        k = self.cfg.morph_kernel_size
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        return cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

    def _drop_small_blobs(self, mask: np.ndarray) -> np.ndarray:
        """Remove tiny specks from a binary mask so colour noise doesn't
        create fake contours downstream (connected-component cleanup)."""
        min_px = int(self.cfg.fill_small_blobs_px)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
        out = np.zeros_like(mask)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_px:
                out[labels == i] = 255
        return out

    # ------------------------------------------------------------ facade
    def process(self, bgr: np.ndarray) -> PreprocessResult:
        blurred = self._blur(bgr)
        return PreprocessResult(
            bgr=blurred,
            hsv=self._to_hsv(blurred),
            gray=self._to_gray(blurred),
            blurred_lab=self._to_lab(blurred),
        )

    # Public so unit tests and the detection stage can clean a mask using the
    # exact same settings the preprocessor was configured with.
    def clean_mask(self, mask: np.ndarray) -> np.ndarray:
        opened = self._morph_open(mask)
        return self._drop_small_blobs(opened)
