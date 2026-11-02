"""Analysis job endpoints: create, inspect, list, cancel, stream progress."""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Literal

from fastapi import (APIRouter, HTTPException, Query, WebSocket,
                     WebSocketDisconnect)
from pydantic import BaseModel, Field

from config.config import load_config
from src.api.jobs import (ALL_STATES, TERMINAL_STATES, JobDuplicateError,
                          JobNotFoundError, JobStateError, manager)
from src.api.probe import VIDEO_EXTENSIONS
from src.api.settings import settings
from src.api.uploads import get_upload

router = APIRouter(prefix="/jobs", tags=["jobs"])
_UPLOAD_ID = re.compile(r"^[0-9a-f]{24}$")


class SourceSpec(BaseModel):
    kind: Literal["sample", "upload"]
    ref: str = Field(min_length=1, max_length=200)


class JobCreateRequest(BaseModel):
    source: SourceSpec
    max_frames: int | None = Field(default=None, ge=1)


def _error(status_code: int, code: str, message: str,
           **extra) -> HTTPException:
    detail = {"code": code, "message": message, **extra}
    return HTTPException(status_code=status_code, detail={"error": detail})


def _resolve_source(request: JobCreateRequest) -> tuple[str, str, str, Path]:
    kind, ref = request.source.kind, request.source.ref
    if kind == "sample":
        if ref != Path(ref).name or "/" in ref or "\\" in ref or ".." in ref:
            raise _error(422, "invalid_ref",
                         "Sample reference must be a plain file name.")
        path = Path(load_config().paths.samples) / ref
        if path.suffix.lower() not in VIDEO_EXTENSIONS or not path.is_file():
            raise _error(404, "source_not_found",
                         f"No bundled sample named {ref!r}.")
        return "sample", ref, f"sample: {ref}", path

    if not _UPLOAD_ID.match(ref):
        raise _error(422, "invalid_ref",
                     "Upload reference must be a 24-character hex id.")
    record = get_upload(ref)
    if record is None:
        raise _error(404, "upload_not_found",
                     "That upload is unknown or has expired.")
    return "upload", ref, f"upload: {record.original_name}", record.path


@router.post("", status_code=202, summary="Start an analysis job")
def create_job(request: JobCreateRequest) -> dict:
    if (request.max_frames is not None
            and request.max_frames > settings.max_frames_cap):
        raise _error(422, "max_frames_too_large",
                     f"max_frames is capped at {settings.max_frames_cap}.")
    kind, ref, label, path = _resolve_source(request)
    try:
        job = manager.submit(source_kind=kind, source_ref=ref,
                             source_label=label, path=path,
                             max_frames=request.max_frames)
    except JobDuplicateError as exc:
        raise _error(409, "job_duplicate",
                     f"An identical job is already {exc.existing.state}.",
                     job_id=exc.existing.job_id) from exc
    return {"job": manager.snapshot(job.job_id)}


@router.get("", summary="List jobs (newest first)")
def list_jobs(status: str | None = Query(default=None),
              kind: str | None = Query(default=None),
              limit: int = Query(default=50, ge=1, le=200),
              offset: int = Query(default=0, ge=0)) -> dict:
    if status is not None and status not in ALL_STATES:
        raise _error(422, "invalid_status",
                     f"status must be one of {', '.join(ALL_STATES)}.")
    if kind is not None and kind not in ("sample", "upload"):
        raise _error(422, "invalid_kind", "kind must be 'sample' or 'upload'.")
    total, jobs = manager.list(status=status, kind=kind,
                               limit=limit, offset=offset)
    return {"total": total, "count": len(jobs), "jobs": jobs}


@router.get("/{job_id}", summary="Job status, progress and result")
def get_job(job_id: str) -> dict:
    try:
        return {"job": manager.snapshot(job_id)}
    except JobNotFoundError as exc:
        raise _error(404, "job_not_found",
                     f"No job with id {job_id!r}.") from exc


@router.post("/{job_id}/cancel", summary="Request job cancellation")
def cancel_job(job_id: str) -> dict:
    try:
        return {"job": manager.cancel(job_id)}
    except JobNotFoundError as exc:
        raise _error(404, "job_not_found",
                     f"No job with id {job_id!r}.") from exc
    except JobStateError as exc:
        raise _error(409, "job_not_cancellable",
                     f"Job is already {exc.state}.") from exc


@router.websocket("/{job_id}/ws")
async def job_progress_ws(websocket: WebSocket, job_id: str) -> None:
    """Push real job snapshots on change; disconnecting does not stop the job."""
    await websocket.accept()
    last: dict | None = None
    try:
        while True:
            try:
                snapshot = manager.snapshot(job_id)
            except JobNotFoundError:
                await websocket.close(code=4404)
                return
            if snapshot != last:
                await websocket.send_json({"type": "job", "job": snapshot})
                last = snapshot
            if snapshot["state"] in TERMINAL_STATES:
                await websocket.close()
                return
            await asyncio.sleep(0.4)
    except WebSocketDisconnect:
        return                        # client went away; the job keeps running
