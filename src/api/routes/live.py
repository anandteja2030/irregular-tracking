"""Live webcam session endpoints.

A browser opens a live session, posts decoded webcam frames one at a time, and
receives the real per-frame tracking output to draw over its own video element.
Stopping the capture persists it as a normal session id, so the rest of the
console (tracks, anomalies, scene, evaluation, media, report) reads it exactly
like any file-based run.
"""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

from src.api.errors import api_error
from src.api.live import (
    LiveFrameError,
    LiveLimitError,
    LiveNotFound,
    LivePersistError,
    LiveStateError,
    manager,
)

router = APIRouter(prefix="/live", tags=["live"])


def _translate(exc: Exception) -> HTTPException:
    if isinstance(exc, LiveNotFound):
        return api_error(404, "live_not_found",
                        f"No live capture with id {exc.live_id!r}.")
    if isinstance(exc, LiveStateError):
        return api_error(409, "live_state", str(exc))
    if isinstance(exc, LiveLimitError):
        return api_error(429, "live_limit", str(exc))
    if isinstance(exc, LiveFrameError):
        return api_error(422, "invalid_frame", str(exc))
    if isinstance(exc, LivePersistError):
        return api_error(500, "live_persist_failed", str(exc))
    return api_error(500, "live_failed", str(exc))


@router.post("/sessions", status_code=201,
             summary="Open a live camera session",
             responses={429: {"description": "Too many concurrent captures"}})
def create_live_session() -> dict:
    try:
        return {"session": manager.create()}
    except LiveLimitError as exc:
        raise _translate(exc) from exc


@router.get("/sessions", summary="List in-progress live sessions")
def list_live_sessions() -> dict:
    sessions = manager.active()
    return {"total": len(sessions), "sessions": sessions}


@router.get("/sessions/{live_id}", summary="Live session state")
def get_live_session(live_id: str) -> dict:
    try:
        return {"session": manager.snapshot(live_id)}
    except LiveNotFound as exc:
        raise _translate(exc) from exc


@router.post("/sessions/{live_id}/frames",
             summary="Score one webcam frame",
             responses={404: {"description": "Unknown live session"},
                        409: {"description": "Session already stopped"},
                        413: {"description": "Frame too large"},
                        422: {"description": "Undecodable frame"}})
def ingest_frame(live_id: str, frame: UploadFile = File(
        ..., description="A JPEG or PNG webcam frame")) -> dict:
    """Decode the frame, run the real pipeline once, return its tracking output.

    The response carries bounding boxes, levels, scores and the human-readable
    explanation for every object the pipeline tracked in this frame, plus
    running counts for the capture.
    """
    try:
        payload = frame.file.read()
        return manager.ingest(live_id, payload)
    except (LiveNotFound, LiveStateError, LiveLimitError, LiveFrameError) as exc:
        raise _translate(exc) from exc


@router.post("/sessions/{live_id}/stop",
             summary="Stop, persist and return the capture summary",
             responses={404: {"description": "Unknown live session"},
                        409: {"description": "No frames received"},
                        500: {"description": "Results could not be stored"}})
def stop_live_session(live_id: str) -> dict:
    try:
        return {"session": manager.stop(live_id)}
    except (LiveNotFound, LiveStateError, LivePersistError) as exc:
        raise _translate(exc) from exc


@router.post("/sessions/{live_id}/cancel",
             summary="Discard a live capture without persisting it")
def cancel_live_session(live_id: str) -> dict:
    try:
        return {"session": manager.cancel(live_id)}
    except LiveNotFound as exc:
        raise _translate(exc) from exc
