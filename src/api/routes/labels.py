"""Ground-truth labels: the write path evaluation depends on.

`GET /sessions/{id}/evaluation` scores a run against the `ground_truth` table,
but until now nothing in the API ever wrote to it, so every session stayed at
zero labels and metrics could never be computed. This route is the explicit
user input that table needs.

A label always belongs to one persisted observation `(frame_idx, track_id)` and
uses the binary vocabulary the detector uses: `Normal` or `Anomaly`. Labelling
a whole track expands to the frames that track actually has in `track_events`,
so no frame is invented and no prediction is copied into the labels.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from config.config import load_config
from src.analysis.ground_truth import clear_labels, load_labels, save_labels
from src.api import analytics
from src.api import repository as repo

router = APIRouter(prefix="/sessions", tags=["labels"])

Label = Literal["Normal", "Anomaly"]


class ObservationLabel(BaseModel):
    frame_idx: int = Field(ge=0)
    track_id: int = Field(ge=0)
    label: Label


class TrackLabel(BaseModel):
    track_id: int = Field(ge=0)
    label: Label


class LabelWrite(BaseModel):
    """Explicit labels for one session.

    `observations` labels single rows; `tracks` labels every persisted
    observation of an object. Both may be sent together.
    """

    observations: list[ObservationLabel] = Field(default_factory=list)
    tracks: list[TrackLabel] = Field(default_factory=list)


class LabelPayload(BaseModel):
    session: str
    count: int
    counts: dict[str, int]
    labels: list[dict]


def _db_path() -> Path:
    return Path(load_config().paths.db)


def _payload(session: str) -> dict:
    rows = load_labels(_db_path(), session)
    counts = {"Normal": 0, "Anomaly": 0}
    for row in rows:
        counts[row["label"]] = counts.get(row["label"], 0) + 1
    return {"session": session, "count": len(rows), "counts": counts,
            "labels": rows}


@router.get("/{session_id}/labels", response_model=LabelPayload,
            summary="Stored ground-truth labels for a session",
            responses={404: {"description": "Unknown session"}})
def read_labels(session_id: str) -> dict:
    session = analytics.validate_session_id(session_id)
    analytics.overview_or_404(session)
    return _payload(session)


@router.post("/{session_id}/labels", response_model=dict,
             summary="Store ground-truth labels (explicit user input only)",
             responses={404: {"description": "Unknown session"}})
def write_labels(session_id: str, body: LabelWrite) -> dict:
    session = analytics.validate_session_id(session_id)
    analytics.overview_or_404(session)

    rows: list[dict] = [
        {"frame_idx": item.frame_idx, "track_id": item.track_id,
         "label": item.label}
        for item in body.observations
    ]
    expanded = 0
    for track in body.tracks:
        frames = repo.track_frame_indices(session, track.track_id)
        expanded += len(frames)
        rows.extend({"frame_idx": frame, "track_id": track.track_id,
                     "label": track.label} for frame in frames)

    saved = save_labels(_db_path(), session, rows)
    payload = _payload(session)
    payload["saved"] = saved
    payload["expanded_from_tracks"] = expanded
    return payload


@router.delete("/{session_id}/labels", response_model=dict,
               summary="Remove every stored label for a session",
               responses={404: {"description": "Unknown session"}})
def delete_labels(session_id: str) -> dict:
    session = analytics.validate_session_id(session_id)
    analytics.overview_or_404(session)
    removed = clear_labels(_db_path(), session)
    payload = _payload(session)
    payload["removed"] = removed
    return payload
