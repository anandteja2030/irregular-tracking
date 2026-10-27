"""Phase 2 unit tests: HSV colour + contour shape detection on synthetic frames."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, ROOT)

from src.video.detection import (
    DRAW_BGR, HSVColorDetector, ContourDetector, ShapeDetector, ObjectDetection)
from src.video.preprocessing import Preprocessor


def _bg_frame(w=640, h=480, bg=(25, 25, 25)):
    return np.full((h, w, 3), bg, dtype=np.uint8)


def _add_shape(frame, center, size, color_bgr, shape):
    """Draw a filled primitive of a known colour into frame, in place."""
    cx, cy = center
    if shape == "circle":
        cv2.circle(frame, (cx, cy), size, color_bgr, -1)
    elif shape == "square":
        cv2.rectangle(frame, (cx - size, cy - size), (cx + size, cy + size), color_bgr, -1)
    elif shape == "rectangle":
        cv2.rectangle(frame, (cx - 2 * size, cy - size), (cx + 2 * size, cy + size), color_bgr, -1)
    elif shape == "triangle":
        pts = np.array([[cx, cy - size], [cx - size, cy + size], [cx + size, cy + size]])
        cv2.fillPoly(frame, [pts], color_bgr)
    return frame


def _detect(shape_mask_config=None):
    """Build a detector chain configured for clean synthetic shapes, and a
    detection helper that preprocesses a frame the normal pipeline way."""
    from config.config import ColorDetectionConfig, PreprocessConfig, ShapeDetectionConfig
    pre = Preprocessor(PreprocessConfig(fill_small_blobs_px=30))
    det = ContourDetector(
        color_cfg=ColorDetectionConfig(min_area=200, max_area=100_000),
        shape_cfg=ShapeDetectionConfig(),
    )

    def run(frame):
        pm = pre.process(frame)
        # Generic "saturated enough to be coloured" mask; colour labelling is
        # done afterwards by the ContourDetector using the configured ranges.
        mask = cv2.inRange(pm.hsv, np.array([0, 60, 40], np.uint8),
                           np.array([179, 255, 255], np.uint8))
        mask = pre.clean_mask(mask)
        return det.detect(0, pm.hsv, mask)
    return run


# ------------------------------------------------------------------ colour
def test_color_detector_masks_known_hue():
    frame = np.zeros((120, 120, 3), np.uint8)
    frame[40:80, 40:80] = DRAW_BGR["green"]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    m = HSVColorDetector().mask(hsv, "green")
    assert m[60, 60] == 255 and m[10, 10] == 0


def test_red_mask_handles_hue_wraparound():
    # Pure red hue sits at both 0 (from HSV(0,...)) and near 170 when shifted.
    hsv = np.zeros((60, 60, 3), np.uint8)
    hsv[20:40, 20:40, 0] = 3      # H near 0
    hsv[42:52, 20:40, 0] = 175
    hsv[20:52, 20:40, 1] = 240
    hsv[20:52, 20:40, 2] = 240
    m = HSVColorDetector().mask(hsv, "red")
    assert m[30, 30] == 255, "H near 0 must count as red"
    assert m[46, 30] == 255, "H near 179 must also count as red"
    assert m[5, 5] == 0


def test_mask_any_unions_all_ranges():
    hsv = np.zeros((40, 40, 3), np.uint8)
    hsv[5, 5] = (60, 255, 255)    # green
    hsv[25, 25] = (110, 255, 255)  # blue
    m = HSVColorDetector().mask_any(hsv)
    assert m[5, 5] == 255 and m[25, 25] == 255


# ------------------------------------------------------------------ shape
def test_shape_classifier_circle():
    contour = np.array([[[0, 10]], [[7, 7]], [[10, 0]], [[7, -7]],
                        [[0, -10]], [[-7, -7]], [[-10, 0]], [[-7, 7]]], np.int32)
    assert ShapeDetector().classify(contour, area=314.0) == "circle"


def test_shape_classifier_edges():
    det = ShapeDetector()
    assert det.classify(np.array([[[10, 0]], [[0, 10]], [[-10, 0]], [[0, -10]]],
                                 np.int32), area=100.0) != "triangle"
    tri = np.array([[[0, 0]], [[100, 0]], [[50, 80]]], np.int32)
    assert det.classify(tri, area=4000.0) == "triangle"
    square = np.array([[[0, 0]], [[100, 0]], [[100, 100]], [[0, 100]]], np.int32)
    assert det.classify(square, area=10000.0) == "square"


# ------------------------------------------------------------------ full chain
def test_full_chain_finds_colored_blobs_with_color_shape():
    frame = _bg_frame()
    _add_shape(frame, (100, 100), 30, DRAW_BGR["green"], "circle")
    _add_shape(frame, (400, 260), 25, DRAW_BGR["blue"], "square")
    _add_shape(frame, (500, 100), 25, DRAW_BGR["red"], "triangle")
    run = _detect()
    dets = run(frame)
    assert len(dets) == 3
    colors = {d.color for d in dets}
    shapes = {d.shape for d in dets}
    assert colors == {"green", "blue", "red"}, f"colors={colors}"
    assert "circle" in shapes, f"shapes={shapes}"
    # dataclass fields populated
    d = dets[0]
    assert d.frame_idx == 0
    assert isinstance(d.bbox, tuple) and len(d.bbox) == 4
    assert d.centroid is not None and d.area > 200


def test_area_filters_reject_tiny_and_huge_blobs():
    frame = _bg_frame()
    _add_shape(frame, (60, 60), 3, DRAW_BGR["green"], "circle")     # ~28 px²
    _add_shape(frame, (300, 300), 200, DRAW_BGR["blue"], "circle")  # huge
    run = _detect()
    dets = run(frame)
    assert len(dets) == 0


def test_sorted_by_position_for_determinism():
    frame = _bg_frame()
    _add_shape(frame, (500, 100), 25, DRAW_BGR["green"], "triangle")
    _add_shape(frame, (100, 300), 25, DRAW_BGR["blue"], "square")
    _add_shape(frame, (300, 200), 25, DRAW_BGR["red"], "circle")
    run = _detect()
    dets = run(frame)
    ys = [d.bbox[1] for d in dets]
    assert ys == sorted(ys)


def test_shape_field_and_object_detection_dataclass_contract():
    d = ObjectDetection(frame_idx=1, bbox=(5, 6, 10, 8), centroid=(10.0, 10.0),
                        area=80, color=None, shape="rectangle", aspect=1.25,
                        contour=np.zeros((1, 1, 2), np.int32))
    assert d.xyxy == (5, 6, 15, 14)
