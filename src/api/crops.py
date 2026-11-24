"""Object crops cut out of the retained annotated preview frames.

What is honestly available
--------------------------
The pipeline never writes frames or an annotated video to disk, and SQLite
keeps no bounding boxes. What does exist for a session analysed by this API
process is the decimated set of annotated preview JPEGs (every
``PREVIEW_STRIDE``-th frame) plus the measured centroid of each track in each
frame, both in the in-process artifact store.

A crop is therefore: the retained annotated preview frame nearest the object's
peak irregular frame, cut to a fixed window centred on that track's measured
centroid. The engine's own detection box and ID label sit inside the crop
because the source frame is the annotated one. The window is a viewing window,
not a detector box; it is reported in the response so nobody mistakes it for
one. When the artifacts are gone the endpoint says so instead of returning an
unrelated image.
"""
from __future__ import annotations

from urllib.parse import quote

import cv2
import numpy as np

from src.api import analytics
from src.api import repository as repo
from src.api.errors import api_error
from src.api.session_store import SessionArtifacts

MIN_WINDOW = 128
MAX_WINDOW = 480
DEFAULT_WINDOW_RATIO = 0.32
MAX_EVIDENCE = 8
JPEG_QUALITY = 88

CROP_LIMITATION = (
    "Crops are cut from the annotated preview frames retained in memory for "
    "sessions analysed by this API process ({stride}th frame). The window is "
    "centred on the track's measured centroid, so it is a viewing crop, not a "
    "detector box, and it is not available after an API restart."
)


def _nearest(values: list[int], target: int) -> int:
    return min(values, key=lambda value: (abs(value - target), value))


def _window_px(width: int, height: int, requested: int | None) -> int:
    natural = round(min(width, height) * DEFAULT_WINDOW_RATIO)
    limit = max(1, min(MAX_WINDOW, min(width, height)))
    floor = min(MIN_WINDOW, limit)
    value = natural if requested is None else int(requested)
    return int(max(floor, min(limit, value)))


def artifacts_or_404(session: str) -> SessionArtifacts:
    art = analytics.artifacts(session)
    if art is None or not art.previews:
        raise api_error(
            404, "media_not_available",
            "No preview frames are retained for this session, so object "
            "crops cannot be cut.",
            reason=analytics.MEDIA_LIMITATION.format(stride=6))
    return art


def _frame_size(art: SessionArtifacts, preview) -> tuple[int, int]:
    image = cv2.imdecode(np.frombuffer(preview.annotated, np.uint8),
                         cv2.IMREAD_COLOR)
    if image is None:
        raise api_error(
            404, "frame_undecodable",
            "The retained preview frame for this session could not be decoded.")
    height, width = image.shape[:2]
    return width, height


def _preview_scale(art: SessionArtifacts, width: int,
                   height: int) -> tuple[float, float]:
    """Measured centroids are in source coordinates; previews may be scaled."""
    if art.width > 0 and art.height > 0:
        return width / art.width, height / art.height
    return 1.0, 1.0


def _point(art: SessionArtifacts, track_id: int, frame: int) -> dict | None:
    points = art.trajectories.get(int(track_id)) or []
    best: dict | None = None
    for point in points:
        x, y = point.get("x"), point.get("y")
        if x is None or y is None:
            continue
        if best is None or abs(int(point["frame"]) - frame) < abs(int(best["frame"]) - frame):
            best = point
        if int(point["frame"]) == frame:
            return point
    return best


def crop_url(session: str, track_id: int, *, frame: int | None,
             window: int | None) -> str:
    query = []
    if frame is not None:
        query.append(f"frame={int(frame)}")
    if window is not None:
        query.append(f"window={int(window)}")
    suffix = f"?{'&'.join(query)}" if query else ""
    return (f"/api/v1/sessions/{quote(session, safe='')}"
            f"/crops/{int(track_id)}{suffix}")


def object_evidence(session: str, *, limit: int = 6,
                    window: int | None = None) -> dict:
    """One peak irregular crop per object, ranked by fused score."""
    art = artifacts_or_404(session)
    frames = sorted(art.previews)
    total, events = repo.list_anomalies(
        session, severity="Irregular", sort="score", limit=400)

    best: dict[int, dict] = {}
    for event in events:
        best.setdefault(int(event["track_id"]), event)

    ranked = sorted(
        best.items(),
        key=lambda item: (-(item[1]["scores"]["fused"] or 0.0), item[0]))[:limit]

    items: list[dict] = []
    for track_id, event in ranked:
        requested = int(event["frame"])
        retained = _nearest(frames, requested)
        point = _point(art, track_id, retained)
        if point is None:
            continue
        width, height = _frame_size(art, art.previews[retained])
        sx, sy = _preview_scale(art, width, height)
        cx, cy = float(point["x"]) * sx, float(point["y"]) * sy
        size = _window_px(width, height, window)
        items.append({
            "track_id": track_id,
            "event_id": event["event_id"],
            "requested_frame": requested,
            "retained_frame": retained,
            "frame_offset": retained - requested,
            "level": event["level"],
            "fused_score": event["scores"]["fused"],
            "speed_px_s": event["motion"]["speed_px_s"],
            "direction_deg": event["motion"]["direction_deg"],
            "summary": event["summary"],
            "window_px": size,
            "centroid": {"x": round(cx, 1), "y": round(cy, 1)},
            "crop_url": crop_url(session, track_id, frame=requested,
                                 window=size),
        })

    return {
        "session": session,
        "available": bool(items),
        "count": len(items),
        "irregular_objects": total,
        "ranked_objects": len(best),
        "preview_frames": len(frames),
        "preview_stride": art.preview_stride,
        "window_rule": (f"window = {int(DEFAULT_WINDOW_RATIO * 100)}% of the "
                        "shorter frame side, clamped to "
                        f"{MIN_WINDOW}-{MAX_WINDOW} px"),
        "items": items,
        "source": "retained_annotated_previews",
        "note": CROP_LIMITATION.format(stride=art.preview_stride),
    }


def object_crop(session: str, track_id: int, *, frame: int | None = None,
                window: int | None = None) -> tuple[bytes, dict]:
    """Return one JPEG crop plus the metadata describing how it was cut."""
    art = artifacts_or_404(session)
    frames = sorted(art.previews)

    requested = frame
    if requested is None:
        _, events = repo.list_anomalies(
            session, severity="any", track_id=track_id, sort="score", limit=1)
        if events:
            requested = int(events[0]["frame"])
    target = requested if requested is not None else frames[len(frames) // 2]
    retained = _nearest(frames, target)

    preview = art.previews[retained]
    width, height = _frame_size(art, preview)
    point = _point(art, track_id, retained)
    if point is None:
        raise api_error(
            404, "crop_position_unavailable",
            f"No measured position is retained for track {track_id} at frame "
            f"{retained}, so a crop cannot be centred on it.",
            retained_frame=retained)

    sx, sy = _preview_scale(art, width, height)
    cx, cy = float(point["x"]) * sx, float(point["y"]) * sy
    size = _window_px(width, height, window)
    half = size / 2
    x0 = int(round(min(max(cx - half, 0), max(width - size, 0))))
    y0 = int(round(min(max(cy - half, 0), max(height - size, 0))))

    image = cv2.imdecode(np.frombuffer(preview.annotated, np.uint8),
                         cv2.IMREAD_COLOR)
    if image is None:
        raise api_error(
            404, "frame_undecodable",
            "The retained preview frame for this session could not be decoded.")
    crop = image[y0:y0 + size, x0:x0 + size]
    ok, buffer = cv2.imencode(
        ".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    if not ok:
        raise api_error(
            500, "crop_encode_failed",
            "The crop was cut but could not be encoded as JPEG.")

    meta = {
        "track_id": track_id,
        "requested_frame": requested,
        "retained_frame": retained,
        "frame_offset": retained - requested if requested is not None else None,
        "window_px": size,
        "box": {"x": x0, "y": y0, "width": size, "height": size},
        "frame_size": {"width": width, "height": height},
        "centroid": {"x": round(cx, 1), "y": round(cy, 1)},
        "source": "retained_annotated_previews",
    }
    return buffer.tobytes(), meta
