"""Background analysis jobs.

Architecture
------------
* A bounded `ThreadPoolExecutor` (default 1 worker: analysis is CPU-bound and
  NumPy/OpenCV/Sklearn release the GIL, so threads keep a single core busy
  without interleaving frames — and the pipeline holds non-picklable
  ``cv2.VideoCapture`` state, which rules out a process pool).
* Each job owns its own **server-generated session id**, so results are
  isolated per job and cannot collide with history or with another client.
* Progress comes from the real per-frame callback in
  `src.core.analysis_service.run_analysis`; stages come from its optional
  `stage` hook.
  No percentages are invented: when the container reports no frame count,
  ``total`` stays null and ``percent`` is null.
* Cancellation is cooperative: the job sets a `threading.Event` the engine
  polls each frame (`should_stop`), so no thread is killed mid-write.
"""
from __future__ import annotations

import secrets
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait as _wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from src.api.session_store import store as artifact_store
from src.api.settings import settings
from src.core.analysis_service import (AnalysisCancelled, run_analysis,
                                       save_session_to_db)

QUEUED = "queued"
RUNNING = "running"
CANCELLATION_REQUESTED = "cancellation_requested"
CANCELLED = "cancelled"
COMPLETED = "completed"
FAILED = "failed"

ACTIVE_STATES = (QUEUED, RUNNING, CANCELLATION_REQUESTED)
TERMINAL_STATES = (COMPLETED, FAILED, CANCELLED)
ALL_STATES = (QUEUED, RUNNING, CANCELLATION_REQUESTED, CANCELLED,
              COMPLETED, FAILED)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _new_session_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"api_{stamp}_{secrets.token_hex(3)}"


class JobDuplicateError(Exception):
    """An identical job is already queued or running."""

    def __init__(self, existing: "Job"):
        super().__init__("an identical job is already active")
        self.existing = existing


class JobNotFoundError(KeyError):
    """Unknown job id."""


class JobStateError(Exception):
    """The job is already in a terminal state."""

    def __init__(self, state: str):
        super().__init__(f"job is {state}")
        self.state = state


@dataclass
class Job:
    job_id: str
    session_id: str
    source_kind: str
    source_ref: str
    source_label: str
    path: Path
    max_frames: int | None
    state: str = QUEUED
    stage: str = QUEUED
    created_ts: str = field(default_factory=_now_iso)
    started_ts: str | None = None
    ended_ts: str | None = None
    started_mono: float | None = None
    ended_mono: float | None = None
    processed: int = 0
    total: int | None = None
    error: dict | None = None
    summary: dict | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    future: Future | None = None

    def identity(self) -> tuple:
        return (self.source_kind, self.source_ref, self.max_frames)


def _row_count(value: Any) -> int:
    """len() of a DataFrame/sequence without triggering pandas truthiness."""
    return 0 if value is None else len(value)


def _summarise(result: Any) -> dict:
    counts = getattr(result, "level_counts", None) or {}
    return {
        "frames_processed": int(getattr(result, "frames_processed", 0) or 0),
        "frame_width": int(getattr(result, "frame_width", 0) or 0),
        "frame_height": int(getattr(result, "frame_height", 0) or 0),
        "fps": round(float(getattr(result, "fps", 0.0) or 0.0), 3),
        "tracks": _row_count(getattr(result, "tracks", None)),
        "observations": _row_count(getattr(result, "obs", None)),
        "levels": {k: int(counts.get(k, 0))
                   for k in ("Normal", "Suspicious", "Irregular")},
        "wall_s": round(float(getattr(result, "wall_s", 0.0) or 0.0), 2),
    }


class JobManager:
    """Thread-safe registry + executor for analysis jobs."""

    def __init__(self, workers: int | None = None):
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=workers or settings.max_workers,
            thread_name_prefix="analysis")

    # ------------------------------------------------------------- lifecycle
    def submit(self, *, source_kind: str, source_ref: str,
               source_label: str, path: Path,
               max_frames: int | None) -> Job:
        identity = (source_kind, source_ref, max_frames)
        with self._lock:
            for job in self._jobs.values():
                if job.state in ACTIVE_STATES and job.identity() == identity:
                    raise JobDuplicateError(job)
            job = Job(job_id="job_" + secrets.token_hex(8),
                      session_id=_new_session_id(), source_kind=source_kind,
                      source_ref=source_ref, source_label=source_label,
                      path=path, max_frames=max_frames)
            self._jobs[job.job_id] = job
            job.future = self._executor.submit(self._run, job.job_id)
            return job

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            job = self._get_locked(job_id)
            if job.state in TERMINAL_STATES:
                raise JobStateError(job.state)
            job.cancel_event.set()
            if job.state == QUEUED:
                if job.future is not None:
                    job.future.cancel()
                job.state = CANCELLED
                job.stage = CANCELLED
                job.ended_ts = _now_iso()
                job.ended_mono = time.monotonic()
            else:
                job.state = CANCELLATION_REQUESTED
                job.stage = "cancelling"
            return self._snapshot_locked(job)

    # ---------------------------------------------------------------- queries
    def get(self, job_id: str) -> Job:
        with self._lock:
            return self._get_locked(job_id)

    def snapshot(self, job_id: str) -> dict:
        with self._lock:
            return self._snapshot_locked(self._get_locked(job_id))

    def list(self, *, status: str | None = None, kind: str | None = None,
             limit: int = 50, offset: int = 0) -> tuple[int, list[dict]]:
        with self._lock:
            jobs = [j for j in self._jobs.values()
                    if (status is None or j.state == status)
                    and (kind is None or j.source_kind == kind)]
            jobs.sort(key=lambda j: (j.created_ts, j.job_id), reverse=True)
            total = len(jobs)
            return total, [self._snapshot_locked(j)
                           for j in jobs[offset:offset + limit]]

    def active_upload_refs(self) -> set[str]:
        with self._lock:
            return {j.source_ref for j in self._jobs.values()
                    if j.source_kind == "upload" and j.state in ACTIVE_STATES}

    def cancel_all(self) -> None:
        with self._lock:
            active = [j for j in self._jobs.values() if j.state in ACTIVE_STATES]
        for job in active:
            try:
                self.cancel(job.job_id)
            except JobStateError:
                continue

    def wait_idle(self, timeout: float = 10.0) -> bool:
        with self._lock:
            futures = [j.future for j in self._jobs.values()
                       if j.future is not None and not j.future.done()]
        if not futures:
            return True
        _wait(futures, timeout=timeout)
        return all(f.done() for f in futures)

    def clear_finished(self) -> None:
        with self._lock:
            for job_id in [jid for jid, j in self._jobs.items()
                           if j.state in TERMINAL_STATES]:
                self._jobs.pop(job_id, None)

    # ---------------------------------------------------------------- worker
    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        with self._lock:
            if job.state != QUEUED:            # cancelled while queued
                job.state = CANCELLED
                job.stage = CANCELLED
                job.ended_ts = _now_iso()
                return
            job.state = RUNNING
            job.stage = "opening"
            job.started_ts = _now_iso()
            job.started_mono = time.monotonic()

        def _progress(done: int, total: int) -> None:
            with self._lock:
                if job.state != RUNNING:
                    return
                job.processed = int(done)
                if total and total > 0:
                    job.total = int(total)
                job.stage = "processing"

        def _stage(name: str) -> None:
            with self._lock:
                if job.state == RUNNING:
                    job.stage = name

        def _finish(state: str, *, error: dict | None = None,
                    summary: dict | None = None) -> None:
            with self._lock:
                job.state = state
                job.stage = state
                job.ended_ts = _now_iso()
                job.ended_mono = time.monotonic()
                if error is not None:
                    job.error = error
                if summary is not None:
                    job.summary = summary

        try:
            result = run_analysis(
                src=str(job.path), source_label=job.source_label,
                source_kind=job.source_kind, max_frames=job.max_frames,
                session=job.session_id, progress=_progress, stage=_stage,
                should_stop=job.cancel_event.is_set)

            if job.cancel_event.is_set():
                _finish(CANCELLED)
                return

            failure = getattr(result, "error", None)
            if failure:
                _finish(FAILED, error={"code": "analysis_failed",
                                       "message": str(failure)})
                return

            frames = int(getattr(result, "frames_processed", 0) or 0)
            if frames <= 0:
                _finish(FAILED, error={
                    "code": "no_frames",
                    "message": "No frames could be decoded from this source."})
                return

            with self._lock:
                if job.state == RUNNING:
                    job.stage = "persisting"
            try:
                save_session_to_db(result)
            except Exception as exc:                       # noqa: BLE001
                _finish(FAILED, error={
                    "code": "persist_failed",
                    "message": f"Results could not be stored: {exc}"})
                return

            # Rich per-session artifacts (previews, trajectories, structured
            # evidence, calibration) are best effort: a retention failure must
            # never turn a successfully persisted analysis into a failed job.
            try:
                artifact_store.record(result)
            except Exception:                              # noqa: BLE001
                pass

            with self._lock:
                job.processed = frames
                if job.total is None:
                    job.total = frames
            _finish(COMPLETED, summary=_summarise(result))
        except AnalysisCancelled:
            _finish(CANCELLED)
        except Exception as exc:                           # noqa: BLE001
            _finish(FAILED, error={"code": "job_crashed",
                                   "message": str(exc)})

    # --------------------------------------------------------------- helpers
    def _get_locked(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise JobNotFoundError(job_id)
        return job

    def _snapshot_locked(self, job: Job) -> dict:
        elapsed = None
        if job.started_mono is not None:
            end = (job.ended_mono if job.ended_mono is not None
                   else time.monotonic())
            elapsed = round(max(0.0, end - job.started_mono), 2)
        total = job.total
        percent = None
        if total and total > 0:
            percent = round(min(100.0, 100.0 * job.processed / total), 1)
        return {
            "job_id": job.job_id,
            "session_id": job.session_id,
            "state": job.state,
            "stage": job.stage,
            "source": {
                "kind": job.source_kind,
                "ref": job.source_ref,
                "label": job.source_label,
                "max_frames": job.max_frames,
            },
            "progress": {
                "processed": job.processed,
                "total": total,
                "percent": percent,
                "measured": bool(total and total > 0),
            },
            "timings": {
                "created_ts": job.created_ts,
                "started_ts": job.started_ts,
                "ended_ts": job.ended_ts,
                "elapsed_s": elapsed,
            },
            "error": job.error,
            "result": job.summary,
        }


manager = JobManager()
