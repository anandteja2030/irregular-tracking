"""In-memory retention of rich per-session artifacts (best effort, bounded).

What the database keeps for a session is deliberately small: one row per
observation (scores, speed, direction, explanation) plus one row per track
aggregate. It does **not** keep centroid positions, the structured rule
evidence, the calibrated scene baseline or any pixel data - those only exist
while a run is alive in memory.

This module captures that extra data when an API job finishes, in a compact
form, so the analytics API can serve trajectories, evidence and annotated
preview frames for sessions produced by *this* process:

* preview frames are re-encoded as JPEG once (not kept as NumPy arrays), so a
  full session costs a few megabytes instead of hundreds;
* only the most recent ``max_sessions`` sessions are retained, within a total
  byte budget;
* nothing here is a source of truth: historical sessions simply report the
  artifact as unavailable instead of inventing data.

The store is process-local by design (like the job registry). Sessions are
always read from SQLite; this is an enrichment layer only.
"""
from __future__ import annotations

import json
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import cv2

from src.core.analysis_service import PREVIEW_STRIDE

JPEG_QUALITY = 82
MAX_SESSIONS = 4
MAX_BYTES = 96 * 1024 * 1024          # 96 MiB of preview JPEGs, total


def _finite(value: Any) -> float | None:
    """float(value) when it is a real finite number, else None."""
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _encode(bgr) -> bytes | None:
    if bgr is None:
        return None
    try:
        ok, buf = cv2.imencode(".jpg", bgr,
                               [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    except cv2.error:
        return None
    return buf.tobytes() if ok else None


@dataclass
class PreviewImage:
    frame: int
    ts_s: float
    annotated: bytes
    original: bytes


@dataclass
class SessionArtifacts:
    """Everything the DB does not persist, for one in-process session."""

    session: str
    created_mono: float
    preview_stride: int
    previews: dict[int, PreviewImage] = field(default_factory=dict)
    trajectories: dict[int, list[dict]] = field(default_factory=dict)
    evidence: dict[tuple[int, int], dict] = field(default_factory=dict)
    scene: dict | None = None
    frames: int = 0
    width: int = 0
    height: int = 0
    n_bytes: int = 0

    @property
    def has_trajectories(self) -> bool:
        return bool(self.trajectories)

    @property
    def has_evidence(self) -> bool:
        return bool(self.evidence)


class SessionArtifactStore:
    """Thread-safe, bounded LRU of session artifacts."""

    def __init__(self, max_sessions: int = MAX_SESSIONS,
                 max_bytes: int = MAX_BYTES):
        self.max_sessions = max(1, int(max_sessions))
        self.max_bytes = max(1, int(max_bytes))
        self._lock = threading.RLock()
        self._items: dict[str, SessionArtifacts] = {}

    # ------------------------------------------------------------- write
    def record(self, result) -> SessionArtifacts | None:
        """Capture a finished `SessionResult`; safe to call for any run."""
        session = getattr(result, "session", None)
        if not session:
            return None
        previews: dict[int, PreviewImage] = {}
        n_bytes = 0
        for p in getattr(result, "previews", None) or []:
            annotated = _encode(p.annotated)
            original = _encode(p.original)
            if annotated is None or original is None:
                continue
            n_bytes += len(annotated) + len(original)
            previews[int(p.frame_idx)] = PreviewImage(
                frame=int(p.frame_idx), ts_s=float(p.ts_s or 0.0),
                annotated=annotated, original=original)

        trajectories: dict[int, list[dict]] = {}
        evidence: dict[tuple[int, int], dict] = {}
        obs = getattr(result, "obs", None)
        if obs is not None and not obs.empty:
            for rec in obs.to_dict("records"):
                track_id = int(rec["track_id"])
                frame = int(rec["frame"])
                try:
                    rules = json.loads(rec.get("rules_json") or "[]")
                except ValueError:
                    rules = []
                evidence[(frame, track_id)] = {
                    "rules": rules,
                    "ml_note": rec.get("ml_note") or "",
                    "scene_note": rec.get("scene_note") or "",
                    "zone": rec.get("zone"),
                    "zone_dwell_s": _finite(rec.get("zone_dwell_s")),
                    "color": rec.get("color"),
                    "shape": rec.get("shape"),
                }
                trajectories.setdefault(track_id, []).append({
                    "frame": frame,
                    "x": _finite(rec.get("cx")),
                    "y": _finite(rec.get("cy")),
                    "level": rec.get("level"),
                    "speed_px_s": _finite(rec.get("speed_px_s")),
                    "direction_deg": _finite(rec.get("direction_deg")),
                })

        scene = None
        scene_obj = getattr(result, "scene", None)
        if scene_obj is not None:
            try:
                scene = dict(vars(scene_obj))
            except TypeError:
                scene = None
            if scene is not None:
                scene = {k: v for k, v in scene.items()
                         if isinstance(v, (int, float, bool, str, dict, list))
                         or v is None}

        artifacts = SessionArtifacts(
            session=str(session), created_mono=time.monotonic(),
            preview_stride=PREVIEW_STRIDE,
            previews=previews, trajectories=trajectories, evidence=evidence,
            scene=scene, frames=int(getattr(result, "frames_processed", 0) or 0),
            width=int(getattr(result, "frame_width", 0) or 0),
            height=int(getattr(result, "frame_height", 0) or 0),
            n_bytes=n_bytes)

        with self._lock:
            self._items[artifacts.session] = artifacts
            self._evict_locked(keep=artifacts.session)
        return artifacts

    # -------------------------------------------------------------- read
    def get(self, session: str) -> SessionArtifacts | None:
        with self._lock:
            return self._items.get(session)

    def has(self, session: str) -> bool:
        with self._lock:
            return session in self._items

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def stats(self) -> dict:
        with self._lock:
            return {
                "sessions": len(self._items),
                "bytes": sum(a.n_bytes for a in self._items.values()),
                "max_sessions": self.max_sessions,
                "max_bytes": self.max_bytes,
            }

    # ----------------------------------------------------------- helpers
    def _evict_locked(self, *, keep: str) -> None:
        """Drop oldest sessions until both the count and byte budget hold."""
        def total() -> int:
            return sum(a.n_bytes for a in self._items.values())

        while len(self._items) > self.max_sessions:
            oldest = min(self._items.values(), key=lambda a: a.created_mono)
            if oldest.session == keep and len(self._items) == 1:
                break
            self._items.pop(oldest.session, None)
        while total() > self.max_bytes and len(self._items) > 1:
            oldest = min((a for a in self._items.values()
                          if a.session != keep), key=lambda a: a.created_mono,
                         default=None)
            if oldest is None:
                break
            self._items.pop(oldest.session, None)


store = SessionArtifactStore()
