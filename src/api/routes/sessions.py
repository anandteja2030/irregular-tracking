"""Session listing, detail and summary (Phase 3)."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query

from src.api import analytics
from src.api import repository as repo
from src.api.analytics_schemas import (SessionDetail, SessionList,
                                       SessionSummary)
from src.api.errors import api_error

router = APIRouter(prefix="/sessions", tags=["sessions"])

_SESSION_SORTS = ("newest", "oldest", "events", "anomalies")
_KINDS = ("sample", "upload", "file")


@router.get("", response_model=SessionList,
            summary="List persisted analysis sessions",
            responses={422: {"description": "Invalid filter or pagination"}})
def list_sessions(
        kind: Literal["sample", "upload", "file"] | None = Query(
            default=None, description="Origin of the analysed source"),
        synthetic: bool | None = Query(
            default=None, description="True for bundled synthetic samples"),
        has_labels: bool | None = Query(
            default=None, description="Only sessions with/without ground truth"),
        has_anomalies: bool | None = Query(
            default=None, description="Only sessions with/without anomalies"),
        q: str | None = Query(default=None, max_length=80,
                             description="Substring match on the session id"),
        since: str | None = Query(default=None,
                                  description="ISO-8601 lower bound on end time"),
        until: str | None = Query(default=None,
                                  description="ISO-8601 upper bound on end time"),
        sort: Literal["newest", "oldest", "events", "anomalies"] = "newest",
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0)) -> dict:
    try:
        since_ts = repo.parse_timestamp(since)
        until_ts = repo.parse_timestamp(until)
    except ValueError as exc:
        raise api_error(422, "invalid_timestamp",
                        "since/until must be ISO-8601 timestamps.") from exc
    if since_ts and until_ts and since_ts > until_ts:
        raise api_error(422, "invalid_range",
                        "since must be earlier than until.")
    total, sessions = repo.list_sessions(
        kind=kind, synthetic=synthetic, has_labels=has_labels,
        has_anomalies=has_anomalies, q=q, since=since_ts, until=until_ts,
        sort=sort, limit=limit, offset=offset)
    return {"total": total, "count": len(sessions), "limit": limit,
            "offset": offset, "sessions": sessions}


@router.get("/{session_id}", response_model=SessionDetail,
            summary="Session metadata, statistics and data availability",
            responses={404: {"description": "Unknown session"}})
def session_detail(session_id: str) -> dict:
    return analytics.detail_payload(analytics.validate_session_id(session_id))


@router.get("/{session_id}/summary", response_model=SessionSummary,
            summary="Aggregated results for one session",
            responses={404: {"description": "Unknown session"}})
def session_summary(session_id: str) -> dict:
    return analytics.summary_payload(analytics.validate_session_id(session_id))
