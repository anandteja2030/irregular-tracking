"""Per-track analytics: list, detail, observations, trajectory, frames."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query

from src.api import analytics
from src.api import repository as repo
from src.api.analytics_schemas import (ObservationList, TrackDetail, TrackFramesResponse,
                                       TrackList, TrajectoryResponse)
from src.api.errors import api_error

router = APIRouter(prefix="/sessions", tags=["tracks"])

_TRACK_SORTS = ("track_id", "anomalies", "speed", "first_frame")
_LEVEL_FILTER = ("Normal", "Suspicious", "Irregular", "any")


def _require_track(session: str, track_id: int) -> dict:
    detail = repo.track_detail(session, track_id)
    if detail is None:
        raise api_error(404, "track_not_found",
                        f"Session {session!r} has no track {track_id}.")
    return detail


@router.get("/{session_id}/tracks", response_model=TrackList,
            summary="Tracked objects with measured aggregates",
            responses={404: {"description": "Unknown session"}})
def list_tracks(
        session_id: str,
        level: Literal["Normal", "Suspicious", "Irregular", "any"] | None = Query(
            default=None,
            description="'any' = tracks with at least one anomaly; a named "
                        "level filters by that level (Normal = no anomalies)"),
        min_events: int | None = Query(default=None, ge=0),
        sort: Literal["track_id", "anomalies", "speed", "first_frame"] = "track_id",
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0)) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    total, tracks = repo.list_tracks(session_id, level=level,
                                     min_events=min_events, sort=sort,
                                     limit=limit, offset=offset)
    return {"total": total, "count": len(tracks), "limit": limit,
            "offset": offset, "tracks": tracks}


@router.get("/{session_id}/tracks/{track_id}", response_model=TrackDetail,
            summary="One track: motion, appearance, direction profile",
            responses={404: {"description": "Unknown session or track"}})
def track_detail(session_id: str, track_id: int) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    detail = _require_track(session_id, track_id)
    angles = repo.track_angles(session_id, track_id)
    art = analytics.artifacts(session_id)
    points = (art.trajectories.get(track_id) if art else None) or []
    return {
        "session": session_id,
        **detail,
        "direction_profile": {
            **repo.direction_profile(angles),
            "source": "derived_event_observations",
        },
        "trajectory": {
            "available": bool(points),
            "points": len(points),
            "reason": None if points else analytics.TRAJECTORY_LIMITATION,
        },
    }


@router.get("/{session_id}/tracks/{track_id}/observations",
            response_model=ObservationList,
            summary="Per-frame observations for one track",
            responses={404: {"description": "Unknown session or track"}})
def track_observations(
        session_id: str, track_id: int,
        level: Literal["Normal", "Suspicious", "Irregular"] | None = None,
        from_frame: int | None = Query(default=None, ge=0),
        to_frame: int | None = Query(default=None, ge=0),
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0)) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    _require_track(session_id, track_id)
    total, rows = repo.track_observations(
        session_id, track_id, level=level, from_frame=from_frame,
        to_frame=to_frame, limit=limit, offset=offset)
    return {"total": total, "count": len(rows), "limit": limit,
            "offset": offset, "observations": rows}


@router.get("/{session_id}/tracks/{track_id}/trajectory",
            response_model=TrajectoryResponse,
            summary="Centroid path of one track (when retained in memory)",
            responses={404: {"description": "Unknown session or track"}})
def track_trajectory(session_id: str, track_id: int) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    _require_track(session_id, track_id)
    art = analytics.artifacts(session_id)
    points = (art.trajectories.get(track_id) if art else None) or []
    reason = None
    if not points:
        reason = (analytics.TRAJECTORY_LIMITATION if art is None else
                  "This API process retains no centroid positions for this "
                  "track (the session may have been analysed elsewhere).")
    return {"session": session_id, "track_id": track_id,
            "available": bool(points), "points": points, "reason": reason}


@router.get("/{session_id}/tracks/{track_id}/frames",
            response_model=TrackFramesResponse,
            summary="Frames in which one track was observed",
            responses={404: {"description": "Unknown session or track"}})
def track_frames(session_id: str, track_id: int,
                 limit: int = Query(default=100, ge=1, le=500),
                 offset: int = Query(default=0, ge=0)) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    _require_track(session_id, track_id)
    art = analytics.artifacts(session_id)
    previews = art.previews if art else {}
    total, rows = repo.track_frames(session_id, track_id, limit=limit,
                                    offset=offset)
    frames = []
    for row in rows:
        available = row["frame"] in previews
        frames.append({
            **row,
            "preview_available": available,
            "frame_url": (analytics.frame_url(session_id, row["frame"])
                          if available else None),
        })
    reason = None
    if not previews:
        reason = analytics.MEDIA_LIMITATION.format(stride=6)
    return {"session": session_id, "track_id": track_id, "total": total,
            "count": len(frames), "limit": limit, "offset": offset,
            "media_available": bool(previews), "reason": reason,
            "frames": frames}

