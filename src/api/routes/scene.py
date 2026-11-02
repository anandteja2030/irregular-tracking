"""Scene intelligence: calibration, baseline, flow and scene-relative deviations."""
from __future__ import annotations

from fastapi import APIRouter

from src.api import analytics
from src.api.analytics_schemas import SceneResponse

router = APIRouter(prefix="/sessions", tags=["scene"])


@router.get("/{session_id}/scene", response_model=SceneResponse,
            summary="Calibration state, movement baseline and deviations",
            responses={404: {"description": "Unknown session"}})
def session_scene(session_id: str) -> dict:
    analytics.overview_or_404(analytics.validate_session_id(session_id))
    return analytics.scene_payload(session_id)
