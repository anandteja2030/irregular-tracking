"""Operational reset: erase every tracked session and its artifacts."""
from __future__ import annotations

from fastapi import APIRouter

from src.api.purge import purge_all

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post(
    "/reset",
    summary="Erase every persisted session and in-memory artifact",
    description=(
        "Cancels running analysis jobs and live captures, deletes every row "
        "from the analysis database, clears retained preview frames, "
        "trajectories and evidence, removes uploaded videos and empties the "
        "finished-job history. This cannot be undone."),
    responses={200: {"description": "Measured counts of everything removed"}})
def reset_everything() -> dict:
    return {"purged": purge_all()}
