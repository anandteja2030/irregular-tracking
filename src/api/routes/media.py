"""Frame and media endpoints.

Media availability is intentionally explicit: the engine never writes frames or
an annotated video to disk, so this router can only serve the preview frames
retained in this API process. Everything else returns a precise 404 that says
why the frame is unavailable instead of linking to an unrelated image.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Path, Query, Response

from src.api import analytics, crops
from src.api.analytics_schemas import MediaResponse
from src.api.errors import api_error

router = APIRouter(prefix="/sessions", tags=["media"])


@router.get("/{session_id}/media", response_model=MediaResponse,
            summary="Media metadata for one session",
            responses={404: {"description": "Unknown session"}})
def session_media(session_id: str) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    return analytics.media_payload(session_id)


@router.get("/{session_id}/object-evidence",
            summary="Irregular objects with crops cut from retained frames",
            responses={404: {"description": "Unknown session or no frames"}})
def session_object_evidence(
        session_id: str,
        limit: int = Query(default=6, ge=1, le=crops.MAX_EVIDENCE),
        window: int | None = Query(default=None, ge=crops.MIN_WINDOW,
                                  le=crops.MAX_WINDOW)) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    return crops.object_evidence(session_id, limit=limit, window=window)


@router.get("/{session_id}/crops/{track_id}",
            summary="One irregular object crop (JPEG)",
            response_class=Response,
            responses={
                200: {"content": {"image/jpeg": {}},
                      "description": "JPEG crop of the retained annotated frame"},
                404: {"description": "Session, frames or crop position unavailable"},
                422: {"description": "Invalid track, frame or window"},
            })
def session_object_crop(
        session_id: str,
        track_id: int = Path(ge=0, description="Track id in this session"),
        frame: int | None = Query(default=None, ge=0,
                                 description="Requested source frame; defaults to the object's peak irregular frame"),
        window: int | None = Query(default=None, ge=crops.MIN_WINDOW,
                                  le=crops.MAX_WINDOW)) -> Response:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    data, meta = crops.object_crop(session_id, track_id, frame=frame,
                                   window=window)
    return Response(content=data, media_type="image/jpeg", headers={
        "Cache-Control": "private, max-age=120",
        "X-Track-Id": str(meta["track_id"]),
        "X-Retained-Frame": str(meta["retained_frame"]),
        "X-Requested-Frame": (
            "" if meta["requested_frame"] is None
            else str(meta["requested_frame"])),
        "X-Crop-Window": str(meta["window_px"]),
        "X-Crop-Source": meta["source"],
    })


@router.get("/{session_id}/frames/{frame_number}",
            summary="One annotated or original preview frame (JPEG)",
            response_class=Response,
            responses={
                200: {"content": {"image/jpeg": {}},
                      "description": "JPEG preview frame"},
                404: {"description": "Session, frame or media unavailable"},
                422: {"description": "Invalid frame number or kind"},
            })
def session_frame(
        session_id: str,
        frame_number: int = Path(ge=0, description="Source frame index"),
        kind: Literal["annotated", "original"] = Query(default="annotated")) -> Response:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    art = analytics.artifacts(session_id)
    if art is None:
        raise api_error(
            404, "media_not_available",
            "No preview frames are retained for this session.",
            reason=analytics.MEDIA_LIMITATION.format(stride=6))
    preview = art.previews.get(frame_number)
    if preview is None:
        frames = sorted(art.previews)
        raise api_error(
            404, "frame_not_available",
            f"Frame {frame_number} is not in this session's retained preview "
            "set.",
            preview_stride=art.preview_stride,
            preview_count=len(frames),
            first_preview_frame=frames[0] if frames else None,
            last_preview_frame=frames[-1] if frames else None)
    data = preview.annotated if kind == "annotated" else preview.original
    return Response(content=data, media_type="image/jpeg", headers={
        "Cache-Control": "private, max-age=300",
        "X-Frame-Index": str(preview.frame),
        "X-Frame-Kind": kind,
        "X-Frame-Timestamp-S": f"{preview.ts_s:.3f}",
    })
