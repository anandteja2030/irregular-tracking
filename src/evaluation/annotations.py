"""Ground-truth annotation schema and normalized data structures.

The format is intentionally file-based and versioned. It does not change the
SQLite label table used by the API; this module supports reproducible
benchmarks across one or more videos while the existing per-session
observation labels continue to work exactly as before.

Ground truth document
---------------------
::

    {
      "schema_version": 1,
      "videos": [
        {
          "video_id": "clip-a",
          "objects": [
            {
              "object_id": "pedestrian-1",
              "label": "Anomaly",              # Normal | Anomaly
              "category": "loitering",         # optional
              "frames": [
                {"frame_idx": 0, "bbox": [x, y, width, height]}
              ],
              "trajectory": [                  # optional
                {"frame_idx": 0, "x": 105.0, "y": 50.0}
              ]
            }
          ]
        }
      ]
    }

``bbox`` uses pixel coordinates in ``[x, y, width, height]`` order, matching
the detector's ``ObjectDetection.bbox``. Object IDs must be unique within a
video. A trajectory may contain points where no box was annotated; it is
preserved for provenance and trajectory inspection, not silently interpreted
as a detection.

Prediction document
-------------------
::

    {
      "schema_version": 1,
      "videos": [
        {
          "video_id": "clip-a",
          "frames": [
            {
              "frame_idx": 0,
              "objects": [
                {
                  "track_id": 7,
                  "bbox": [x, y, width, height],
                  "level": "Suspicious",      # Normal | Suspicious | Irregular
                  "category": "loitering"      # optional
                }
              ]
            }
          ]
        }
      ]
    }

``track_id`` is the tracker's identity for that frame. It is compared across
frames to detect identity switches; it does not have to equal the ground-truth
``object_id``. ``level`` follows the pipeline vocabulary. A positive anomaly
prediction is ``Suspicious``, ``Irregular``, or the binary-benchmark alias
``Anomaly``.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

SCHEMA_VERSION = 1
PREDICTION_LEVELS = frozenset(
    {"Normal", "Suspicious", "Irregular", "Anomaly"})
POSITIVE_LEVELS = frozenset({"Suspicious", "Irregular", "Anomaly"})
DEFAULT_IOU_THRESHOLD = 0.5


class AnnotationError(ValueError):
    """A malformed or inconsistent annotation/prediction document."""


@dataclass(frozen=True)
class BoundingBox:
    x: float
    y: float
    width: float
    height: float

    @property
    def xyxy(self) -> tuple[float, float, float, float]:
        return self.x, self.y, self.x + self.width, self.y + self.height


@dataclass(frozen=True)
class TrajectoryPoint:
    frame_idx: int
    x: float
    y: float


@dataclass(frozen=True)
class GroundTruthObject:
    object_id: str
    label: str
    category: str | None
    frames: dict[int, BoundingBox]
    trajectory: tuple[TrajectoryPoint, ...]


@dataclass(frozen=True)
class GroundTruthVideo:
    video_id: str
    objects: tuple[GroundTruthObject, ...]


@dataclass(frozen=True)
class Prediction:
    track_id: str
    bbox: BoundingBox
    level: str
    category: str | None


@dataclass(frozen=True)
class PredictionVideo:
    video_id: str
    frames: dict[int, tuple[Prediction, ...]]


def bbox_iou(first: BoundingBox, second: BoundingBox) -> float:
    """Intersection-over-union for two axis-aligned ``x,y,w,h`` boxes."""
    ax1, ay1, ax2, ay2 = first.xyxy
    bx1, by1, bx2, by2 = second.xyxy
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    intersection = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = first.width * first.height + second.width * second.height \
        - intersection
    return intersection / union if union > 0 else 0.0


def _fail(path: str, message: str) -> NoReturn:
    raise AnnotationError(f"{path}: {message}")


def _mapping(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        _fail(path, "expected a JSON object")
    return value


def _list(value: Any, path: str) -> list:
    if not isinstance(value, list):
        _fail(path, "expected a JSON array")
    return value


def _string(value: Any, path: str) -> str:
    if not isinstance(value, str):
        _fail(path, "expected a string")
    text = value.strip()
    if not text:
        _fail(path, "must not be empty")
    return text


def _identifier(value: Any, path: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        _fail(path, "expected a string or integer identifier")
    text = str(value).strip()
    if not text:
        _fail(path, "must not be empty")
    return text


def _number(value: Any, path: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "expected a finite number")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        _fail(path, "expected a finite number")
    if not math.isfinite(number):
        _fail(path, "expected a finite number")
    if positive and number <= 0:
        _fail(path, "must be greater than zero")
    return number


def _frame_idx(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _fail(path, "expected a non-negative integer")
    return value


def _bbox(value: Any, path: str) -> BoundingBox:
    values = _list(value, path)
    if len(values) != 4:
        _fail(path, "expected [x, y, width, height]")
    x = _number(values[0], f"{path}[0]")
    y = _number(values[1], f"{path}[1]")
    width = _number(values[2], f"{path}[2]", positive=True)
    height = _number(values[3], f"{path}[3]", positive=True)
    return BoundingBox(x, y, width, height)


def _optional_text(value: Any, path: str) -> str | None:
    if value is None:
        return None
    return _string(value, path)


def _ground_truth_label(value: Any, path: str) -> str:
    text = _string(value, path).casefold()
    labels = {"normal": "Normal", "anomaly": "Anomaly"}
    if text not in labels:
        _fail(path, "expected 'Normal' or 'Anomaly'")
    return labels[text]


def _prediction_level(value: Any, path: str) -> str:
    text = _string(value, path).casefold()
    levels = {
        "normal": "Normal",
        "suspicious": "Suspicious",
        "irregular": "Irregular",
        "anomaly": "Anomaly",
    }
    if text not in levels:
        _fail(path, f"expected one of {sorted(PREDICTION_LEVELS)}")
    return levels[text]


def _videos(document: Any, kind: str) -> list:
    root = _mapping(document, kind)
    version = root.get("schema_version")
    if isinstance(version, bool) or version != SCHEMA_VERSION:
        _fail(f"{kind}.schema_version",
              f"expected {SCHEMA_VERSION}, got {version!r}")
    return _list(root.get("videos"), f"{kind}.videos")


def parse_ground_truth(document: Any) -> tuple[GroundTruthVideo, ...]:
    """Validate a ground-truth document and return normalized videos."""
    videos: list[GroundTruthVideo] = []
    seen_videos: set[str] = set()
    for vi, raw_video in enumerate(_videos(document, "ground_truth")):
        video_path = f"ground_truth.videos[{vi}]"
        video = _mapping(raw_video, video_path)
        video_id = _string(video.get("video_id"), f"{video_path}.video_id")
        if video_id in seen_videos:
            _fail(f"{video_path}.video_id", f"duplicate video id {video_id!r}")
        seen_videos.add(video_id)
        objects: list[GroundTruthObject] = []
        seen_objects: set[str] = set()
        raw_objects = _list(video.get("objects"), f"{video_path}.objects")
        for oi, raw_object in enumerate(raw_objects):
            object_path = f"{video_path}.objects[{oi}]"
            obj = _mapping(raw_object, object_path)
            object_id = _identifier(obj.get("object_id"),
                                    f"{object_path}.object_id")
            if object_id in seen_objects:
                _fail(f"{object_path}.object_id",
                      f"duplicate object id {object_id!r}")
            seen_objects.add(object_id)
            label = _ground_truth_label(obj.get("label"),
                                        f"{object_path}.label")
            category = _optional_text(obj.get("category"),
                                      f"{object_path}.category")
            frames: dict[int, BoundingBox] = {}
            raw_frames = _list(obj.get("frames"), f"{object_path}.frames")
            if not raw_frames:
                _fail(f"{object_path}.frames", "must contain at least one frame")
            for fi, raw_frame in enumerate(raw_frames):
                frame_path = f"{object_path}.frames[{fi}]"
                frame = _mapping(raw_frame, frame_path)
                frame_idx = _frame_idx(frame.get("frame_idx"),
                                       f"{frame_path}.frame_idx")
                if frame_idx in frames:
                    _fail(f"{frame_path}.frame_idx",
                          f"duplicate frame {frame_idx}")
                frames[frame_idx] = _bbox(frame.get("bbox"),
                                          f"{frame_path}.bbox")
            trajectory: list[TrajectoryPoint] = []
            raw_trajectory = obj.get("trajectory")
            if raw_trajectory is not None:
                seen_trajectory_frames: set[int] = set()
                for pi, raw_point in enumerate(
                        _list(raw_trajectory, f"{object_path}.trajectory")):
                    point_path = f"{object_path}.trajectory[{pi}]"
                    point = _mapping(raw_point, point_path)
                    frame_idx = _frame_idx(point.get("frame_idx"),
                                           f"{point_path}.frame_idx")
                    if frame_idx in seen_trajectory_frames:
                        _fail(f"{point_path}.frame_idx",
                              f"duplicate trajectory frame {frame_idx}")
                    seen_trajectory_frames.add(frame_idx)
                    trajectory.append(TrajectoryPoint(
                        frame_idx=frame_idx,
                        x=_number(point.get("x"), f"{point_path}.x"),
                        y=_number(point.get("y"), f"{point_path}.y")))
            objects.append(GroundTruthObject(
                object_id=object_id, label=label, category=category,
                frames=frames, trajectory=tuple(trajectory)))
        videos.append(GroundTruthVideo(video_id=video_id,
                                       objects=tuple(objects)))
    if not videos:
        _fail("ground_truth.videos", "must contain at least one video")
    return tuple(videos)


def parse_predictions(document: Any) -> dict[str, PredictionVideo]:
    """Validate a prediction document and return it keyed by video id."""
    videos: dict[str, PredictionVideo] = {}
    for vi, raw_video in enumerate(_videos(document, "predictions")):
        video_path = f"predictions.videos[{vi}]"
        video = _mapping(raw_video, video_path)
        video_id = _string(video.get("video_id"), f"{video_path}.video_id")
        if video_id in videos:
            _fail(f"{video_path}.video_id", f"duplicate video id {video_id!r}")
        frames: dict[int, tuple[Prediction, ...]] = {}
        for fi, raw_frame in enumerate(
                _list(video.get("frames"), f"{video_path}.frames")):
            frame_path = f"{video_path}.frames[{fi}]"
            frame = _mapping(raw_frame, frame_path)
            frame_idx = _frame_idx(frame.get("frame_idx"),
                                   f"{frame_path}.frame_idx")
            if frame_idx in frames:
                _fail(f"{frame_path}.frame_idx",
                      f"duplicate frame {frame_idx}")
            predictions: list[Prediction] = []
            seen_tracks: set[str] = set()
            for oi, raw_object in enumerate(
                    _list(frame.get("objects"), f"{frame_path}.objects")):
                object_path = f"{frame_path}.objects[{oi}]"
                obj = _mapping(raw_object, object_path)
                track_id = _identifier(obj.get("track_id"),
                                       f"{object_path}.track_id")
                if track_id in seen_tracks:
                    _fail(f"{object_path}.track_id",
                          f"duplicate track id {track_id!r} in frame")
                seen_tracks.add(track_id)
                predictions.append(Prediction(
                    track_id=track_id,
                    bbox=_bbox(obj.get("bbox"), f"{object_path}.bbox"),
                    level=_prediction_level(obj.get("level"),
                                            f"{object_path}.level"),
                    category=_optional_text(obj.get("category"),
                                            f"{object_path}.category")))
            frames[frame_idx] = tuple(predictions)
        videos[video_id] = PredictionVideo(video_id=video_id, frames=frames)
    return videos


def _load_json(path: Path | str) -> Any:
    try:
        with Path(path).open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, UnicodeError) as exc:
        raise AnnotationError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise AnnotationError(f"invalid JSON in {path}: {exc}") from exc
    except RecursionError as exc:
        raise AnnotationError(f"JSON nesting is too deep in {path}") from exc


def load_ground_truth(path: Path | str) -> tuple[GroundTruthVideo, ...]:
    return parse_ground_truth(_load_json(path))


def load_predictions(path: Path | str) -> dict[str, PredictionVideo]:
    return parse_predictions(_load_json(path))
