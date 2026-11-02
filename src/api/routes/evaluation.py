"""Evaluation metrics plus session-specific CSV and markdown exports."""
from __future__ import annotations

import csv
import io
from typing import Literal

from fastapi import APIRouter, Query, Response

from src.api import analytics
from src.api import repository as repo
from src.api.analytics_schemas import EvaluationResponse
from src.api.reports import build_report

router = APIRouter(prefix="/sessions", tags=["evaluation"])

_EVENT_HEADER = ["frame", "ts_utc", "track_id", "level", "fused_score",
                 "rule_score", "ml_score", "scene_score", "speed_px_s",
                 "direction_deg", "why"]
_TRACK_HEADER = ["track_id", "color", "shape", "first_frame", "last_frame",
                 "observations", "anomalies", "normal", "suspicious",
                 "irregular", "worst_level", "duration_s", "mean_speed_px_s",
                 "max_speed_px_s", "path_length_px", "straightness",
                 "directions"]


@router.get("/{session_id}/evaluation", response_model=EvaluationResponse,
            summary="Ground-truth evaluation (available vs. zero is explicit)",
            responses={404: {"description": "Unknown session"}})
def session_evaluation(session_id: str) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    return analytics.evaluation_payload(session_id)


@router.get("/{session_id}/export/csv",
            summary="Session-specific CSV export (events or tracks)",
            response_class=Response,
            responses={200: {"content": {"text/csv": {}}},
                       404: {"description": "Unknown session"}})
def export_csv(session_id: str,
               dataset: Literal["events", "tracks"] = Query(default="events")) -> Response:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    if dataset == "tracks":
        header, rows = _TRACK_HEADER, repo.export_tracks(session_id)
    else:
        header, rows = _EVENT_HEADER, repo.export_events(session_id)

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    filename = f"{session_id}_{dataset}.csv"
    return Response(
        content=buffer.getvalue(), media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Row-Count": str(len(rows)),
            "Cache-Control": "private, no-store",
        })


@router.get("/{session_id}/report",
            summary="Session markdown report",
            response_class=Response,
            responses={200: {"content": {"text/markdown": {}}},
                       404: {"description": "Unknown session"}})
def session_report(session_id: str,
                   download: bool = Query(default=False)) -> Response:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    markdown = build_report(analytics.report_payload(session_id))
    disposition = ("attachment" if download else "inline")
    return Response(
        content=markdown, media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition":
                f'{disposition}; filename="{session_id}_report.md"',
            "Cache-Control": "private, no-store",
        })
