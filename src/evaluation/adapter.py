"""Convert pipeline frame results into documented prediction JSON.

``TrackingPipeline`` returns one :class:`src.pipeline.FrameResult` per frame.
Its ``entries`` are visualization/logging dictionaries containing a centroid,
a width/height pair and the anomaly level. This module is the small boundary
between that internal shape and the Phase 15 prediction schema.

Every pipeline entry is converted; the adapter does not add filtering or
change detector/tracker decisions. In particular, tentative and coasting
tracks that the pipeline reports are included exactly as reported.
"""
from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Protocol

from .annotations import SCHEMA_VERSION, parse_predictions


class _FrameLike(Protocol):
    """The subset of ``FrameResult`` this adapter needs."""

    frame_idx: int
    entries: Iterable[Mapping[str, Any]]


def _finite(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{field}: expected a finite number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise ValueError(f"{field}: expected a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field}: expected a finite number")
    return number


def _pair(value: Any, field: str) -> tuple[float, float]:
    try:
        first, second = value
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field}: expected a pair of numbers") from exc
    return _finite(first, f"{field}[0]"), _finite(second, f"{field}[1]")


def _bbox(entry: Mapping[str, Any], path: str) -> list[float]:
    """Convert pipeline ``centroid`` + ``bbox_wh`` to ``[x, y, w, h]``."""
    cx, cy = _pair(entry.get("centroid"), f"{path}.centroid")
    width, height = _pair(entry.get("bbox_wh"), f"{path}.bbox_wh")
    if width <= 0 or height <= 0:
        raise ValueError(f"{path}.bbox_wh: width and height must be positive")
    return [cx - width / 2, cy - height / 2, width, height]


def frame_to_prediction_frame(frame: _FrameLike) -> dict:
    """Convert one pipeline ``FrameResult`` to one prediction frame."""
    frame_idx = frame.frame_idx
    if isinstance(frame_idx, bool) or not isinstance(frame_idx, int) \
            or frame_idx < 0:
        raise ValueError("frame.frame_idx: expected a non-negative integer")
    try:
        entries = frame.entries
    except AttributeError as exc:
        raise ValueError("frame: expected FrameResult-like entries") from exc

    objects: list[dict] = []
    for index, entry in enumerate(entries):
        path = f"frame[{frame_idx}].entries[{index}]"
        if not isinstance(entry, Mapping):
            raise ValueError(f"{path}: expected an object mapping")
        track_id = entry.get("track_id")
        if isinstance(track_id, bool) or not isinstance(track_id, int):
            raise ValueError(f"{path}.track_id: expected an integer")
        objects.append({
            "track_id": track_id,
            "bbox": _bbox(entry, path),
            "level": entry.get("level"),
        })
    return {"frame_idx": frame_idx, "objects": objects}


def frames_to_predictions(video_id: str,
                          frames: Iterable[_FrameLike]) -> dict:
    """Convert an iterable of pipeline frame results to a predictions document."""
    document = {
        "schema_version": SCHEMA_VERSION,
        "videos": [{
            "video_id": video_id,
            "frames": [frame_to_prediction_frame(frame) for frame in frames],
        }],
    }
    parse_predictions(document)
    return document


def write_predictions(predictions: dict, path: Path | str) -> Path:
    """Validate and write prediction JSON, creating parent directories."""
    parse_predictions(predictions)
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(predictions, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")
    return output
