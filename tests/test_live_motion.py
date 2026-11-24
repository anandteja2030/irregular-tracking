"""Live sessions add moving-foreground detection to the colour path.

A webcam sees grey, dark or dull objects that the calibrated HSV ranges cannot
segment. These tests pin both halves of the contract: motion augmentation finds
such an object, and the same frames stay undetected when augmentation is off, so
file runs are unchanged.
"""
from __future__ import annotations

import cv2
import numpy as np

from src.pipeline import TrackingPipeline


def _frame(offset: int) -> np.ndarray:
    """Dark scene with one unsaturated grey square moving right."""
    frame = np.full((240, 320, 3), 30, np.uint8)
    cv2.rectangle(frame, (offset, 100), (offset + 50, 160), (120, 120, 120), -1)
    return frame


def _run(motion_augment: bool) -> list[int]:
    pipeline = TrackingPipeline(session="motion-test", motion_augment=motion_augment)
    return [
        pipeline.process_frame(_frame(40 + index * 22), index, 12.0).n_detections
        for index in range(7)
    ]


def test_motion_augment_detects_an_unsaturated_moving_object() -> None:
    detections = _run(motion_augment=True)
    # The opening frame only seeds the background, so motion starts later.
    assert max(detections[1:]) >= 1


def test_colour_only_path_ignores_the_same_grey_object() -> None:
    assert all(count == 0 for count in _run(motion_augment=False))
