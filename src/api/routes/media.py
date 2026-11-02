"""Frame and media endpoints.

Media availability is intentionally explicit: the engine never writes frames or
an annotated video to disk, so this router can only serve the preview frames
retained in this API process. Everything else returns a precise 404 that says
why the frame is unavailable instead of linking to an unrelated image.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Path, Query, Response

from src.api import analytics
from src.api.analytics_schemas import MediaResponse
from src.api.errors import api_error

router = APIRouter(prefix="/sessions", tags=["media"])


@router.get("/{session_id}/media", response_model=MediaResponse,
            summary="Media metadata for one session",
            responses={404: {"description": "Unknown session"}})
def session_media(session_id: str) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    return analytics.media_payload(session_id)


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
