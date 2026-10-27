"""Phase 2 - object detection: HSV colour segmentation + contour shape detection.

Two cooperating resolvers:
  * `HSVColorDetector`  - builds a binary mask per configured HSV colour range,
    handling the red hue wrap-around (165..10) that H values in [0,179] need.
  * `ShapeDetector`     - classifies a contour as circle / square / rectangle /
    triangle / polygon using approxPolyDP vertex count, circularity and aspect.
  * `ContourDetector`   - facade that turns a PreprocessResult into
    `ObjectDetection`s suitable for handing to the tracker.

BGR note: OpenCV stores channels B-G-R, so `shape=(255, 0, 0)` is BLUE; tests
use named constants from COLORMAP to avoid mistakes.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from config.config import ColorDetectionConfig, ShapeDetectionConfig, load_config
from src.video.preprocessing import PreprocessResult

# Human-friendly -> OpenCV HSV (H in 0..179, S/V in 0..255). Used by the sample
# generator and tests so colour names are written once, in one place.
SET_HSV = {
    "red":     np.uint8([[[0, 255, 255]]]),
    "orange":  np.uint8([[[10, 255, 255]]]),
    "yellow":  np.uint8([[[30, 255, 255]]]),
    "green":   np.uint8([[[60, 255, 255]]]),
    "blue":    np.uint8([[[110, 255, 255]]]),
    "magenta": np.uint8([[[150, 255, 255]]]),
}
DRAW_BGR = {n: cv2.cvtColor(v, cv2.COLOR_HSV2BGR)[0, 0].tolist() for n, v in SET_HSV.items()}


@dataclass
class ObjectDetection:
    """One detected object candidate for the current frame."""
    frame_idx: int
    bbox: tuple[int, int, int, int]     # x, y, w, h in frame pixels
    centroid: tuple[float, float]       # cx, cy
    area: float
    color: str | None                   # one of config colour names, or None
    shape: str                          # circle/square/rectangle/triangle/polygon/unknown
    aspect: float                       # w / h
    contour: np.ndarray

    # accessor the visualizer uses: (x1, y1, x2, y2)
    @property
    def xyxy(self) -> tuple[int, int, int, int]:
        x, y, w, h = self.bbox
        return (x, y, x + w, y + h)


class HSVColorDetector:
    """Threshold the frame's HSV image with the configured colour ranges."""

    def __init__(self, config: ColorDetectionConfig | None = None):
        self.cfg = config or load_config().color

    def _mask_for_range(self, hsv: np.ndarray, lo: tuple, hi: tuple) -> np.ndarray:
        sub = np.uint8([[list(lo), list(hi)]])
        return cv2.inRange(hsv, sub[0][0], sub[0][1])

    def mask(self, hsv: np.ndarray, color_name: str) -> np.ndarray:
        """Binary mask (255/0) for one named colour; handles H wrap-around."""
        h_lo, s_lo, v_lo, h_hi, s_hi, v_hi = self.cfg.ranges[color_name]
        if h_lo <= h_hi:
            lo = np.array([h_lo, s_lo, v_lo], np.uint8)
            hi = np.array([h_hi, s_hi, v_hi], np.uint8)
            return cv2.inRange(hsv, lo, hi)
        # Wrapped range (e.g. red 165..10): split and OR the two sub-ranges.
        lo1 = np.array([0,   s_lo, 0], np.uint8)     # keeps pixels with H<=h_hi
        lo2 = np.array([h_lo, s_lo, 0], np.uint8)
        hi1 = np.array([h_hi, 255, 255], np.uint8)
        hi2 = np.array([179, 255, 255], np.uint8)
        m1 = cv2.inRange(hsv, lo1, hi1)
        m2 = cv2.inRange(hsv, lo2, hi2)
        return cv2.bitwise_or(m1, m2)

    def mask_any(self, hsv: np.ndarray) -> np.ndarray:
        masks = [self.mask(hsv, name) for name in self.cfg.ranges]
        if not masks:
            return np.zeros_like(hsv[:, :, 0])
        return np.bitwise_or.reduce(np.stack(masks), axis=0)


class ShapeDetector:
    """Classify a contour into a shape label."""

    def __init__(self, config: ShapeDetectionConfig | None = None):
        self.cfg = config or load_config().shape

    def classify(self, contour: np.ndarray, *, area: float) -> str:
        eps = self.cfg.epsilon_factor * cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, eps, True)
        vertices = len(approx)
        _, _, w, h = cv2.boundingRect(contour)
        aspect = w / max(h, 1)

        perimeter = cv2.arcLength(contour, True)
        circularity = 4 * np.pi * area / max(perimeter * perimeter, 1e-6)
        if circularity >= self.cfg.circularity_target:
            return "circle"
        if vertices == 3:
            return "triangle"
        if vertices == 4:
            if abs(1.0 - aspect) < self.cfg.min_rotation_lock_aspect:
                return "square"
            return "rectangle"
        if vertices > 4:
            return "polygon"
        return "unknown"


class ContourDetector:
    """Detect objects across all configured HSV colour ranges."""

    def __init__(self, color_cfg: ColorDetectionConfig | None = None,
                 shape_cfg: ShapeDetectionConfig | None = None,
                 color_detector: HSVColorDetector | None = None,
                 shape_detector: ShapeDetector | None = None):
        self.color_cfg = color_cfg or load_config().color
        self.shape_cfg = shape_cfg or load_config().shape
        self.color_detector = color_detector or HSVColorDetector(self.color_cfg)
        self.shape_detector = shape_detector or ShapeDetector(self.shape_cfg)

    def _best_color(self, hsv: np.ndarray, box_mask: np.ndarray) -> str | None:
        """Which configured colour dominates inside this blob?"""
        best, best_count = None, 0
        for name in self.color_cfg.ranges:
            m = self.color_detector.mask(hsv, name)
            count = int(np.count_nonzero(cv2.bitwise_and(m, box_mask)))
            if count > best_count:
                best, best_count = name, count
        return best

    def detect(self, frame_idx: int, hsv: np.ndarray,
               clean_mask: np.ndarray) -> list[ObjectDetection]:
        """hsv: V channel can be any of the 3 channels; only H/S needed here.
        clean_mask: binary mask of candidate blobs (from preprocessing)."""
        contours, _ = cv2.findContours(clean_mask, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        min_a, max_a = self.color_cfg.min_area, self.color_cfg.max_area
        out: list[ObjectDetection] = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < min_a or area > max_a:
                continue
            x, y, w, h = cv2.boundingRect(c)
            box_mask = np.zeros(clean_mask.shape[:2], np.uint8)
            cv2.drawContours(box_mask, [c], -1, 255, thickness=-1)
            out.append(ObjectDetection(
                frame_idx=frame_idx,
                bbox=(x, y, w, h),
                centroid=(x + w / 2.0, y + h / 2.0),
                area=float(area),
                color=self._best_color(hsv, box_mask),
                shape=self.shape_detector.classify(c, area=area),
                aspect=w / max(h, 1),
                contour=c,
            ))
        # Stable ordering: left-to-right, top-to-bottom (helps tests & viz).
        out.sort(key=lambda d: (d.bbox[1], d.bbox[0]))
        return out
