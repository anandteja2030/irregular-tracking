"""Anomaly (Suspicious/Irregular) listing and evidence detail."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query

from src.api import analytics
from src.api import repository as repo
from src.api.analytics_schemas import AnomalyDetail, AnomalyList
from src.api.errors import api_error

router = APIRouter(prefix="/sessions", tags=["anomalies"])

_SORTS = ("score", "score_asc", "frame", "frame_desc")


@router.get("/{session_id}/anomalies", response_model=AnomalyList,
            summary="Non-Normal observations with evidence",
            responses={400: {"description": "Rule filter unavailable"},
                       404: {"description": "Unknown session"},
                       422: {"description": "Invalid filter"}})
def list_anomalies(
        session_id: str,
        severity: Literal["Suspicious", "Irregular"] | None = Query(
            default=None, description="Restrict to one fused level"),
        track_id: int | None = Query(default=None, ge=1),
        event_type: Literal["excessive_speed", "direction_against_flow",
                            "erratic_heading", "sudden_acceleration",
                            "zone_violation", "loitering", "ml", "scene"]
        | None = Query(default=None,
                       description="Rule name, or 'ml' / 'scene' for those "
                                   "score streams"),
        min_score: float | None = Query(default=None, ge=0, le=1),
        from_frame: int | None = Query(default=None, ge=0),
        to_frame: int | None = Query(default=None, ge=0),
        sort: Literal["score", "score_asc", "frame", "frame_desc"] = "score",
        limit: int = Query(default=50, ge=1, le=500),
        offset: int = Query(default=0, ge=0)) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    if (from_frame is not None and to_frame is not None
            and from_frame > to_frame):
        raise api_error(422, "invalid_range",
                        "from_frame must be <= to_frame.")

    if event_type is None:
        total, rows = repo.list_anomalies(
            session_id, severity=severity, track_id=track_id,
            min_score=min_score, from_frame=from_frame, to_frame=to_frame,
            sort=sort, limit=limit, offset=offset)
    else:
        # Rule membership lives in in-process evidence, so filtering must
        # happen before pagination. Bounded by this session's anomaly count.
        _, candidates = repo.list_anomalies(
            session_id, severity=severity, track_id=track_id,
            min_score=min_score, from_frame=from_frame, to_frame=to_frame,
            sort=sort, limit=None)
        enriched = analytics.anomaly_evidence_map(session_id, candidates)
        filtered = analytics.filter_by_event_type(enriched, event_type,
                                                  session=session_id)
        total = len(filtered)
        rows = filtered[offset:offset + limit]

    items = (rows if event_type is not None
             else analytics.anomaly_evidence_map(session_id, rows))
    return {"total": total, "count": len(items), "limit": limit,
            "offset": offset, "severity": severity,
            "event_type": event_type, "anomalies": items}


@router.get("/{session_id}/anomalies/{event_id}", response_model=AnomalyDetail,
            summary="One anomaly with track and frame context",
            responses={404: {"description": "Unknown session or anomaly"}})
def anomaly_detail(session_id: str, event_id: int) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    row = repo.anomaly_event(session_id, event_id)
    if row is None or row["level"] == "Normal":
        raise api_error(404, "anomaly_not_found",
                        f"Session {session_id!r} has no anomaly event "
                        f"{event_id}.")
    payload = analytics.anomaly_evidence_map(session_id, [row])[0]

    track = repo.track_detail(session_id, row["track_id"])
    track_context = None
    if track is not None:
        track_context = {
            "track_id": track["track_id"],
            "color": track["appearance"]["color"],
            "shape": track["appearance"]["shape"],
            "observations": track["observed"]["observations"],
            "anomalies": track["observed"]["anomalies"],
            "worst_level": track["observed"]["worst_level"],
            "first_frame": track["frames"]["first"],
            "last_frame": track["frames"]["last"],
        }

    art = analytics.artifacts(session_id)
    preview = art.previews.get(row["frame"]) if art else None
    notes = [
        "Rule-based evidence and the Isolation Forest note are separate "
        "streams; scores are fused only in the 'fused' value.",
        analytics.EVIDENCE_LIMITATION if payload["evidence"]["available"] is False
        else "Structured rule evidence is retained in memory for this session.",
    ]
    return {
        **payload,
        "track": track_context,
        "frame_info": {
            "index": row["frame"],
            "ts_utc": row["ts_utc"],
            "media_available": preview is not None,
            "frame_url": (analytics.frame_url(session_id, row["frame"])
                          if preview is not None else None),
        },
        "notes": notes,
    }
