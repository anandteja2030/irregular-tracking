"""Phase 2 API tests: uploads, jobs, progress, cancellation, isolation.

Two kinds of job tests are used deliberately:

* **real** runs of a bundled sample through the actual engine, to prove the
  wrapper produces true counts and persists a real session;
* **injected** runs, to drive lifecycle edge cases (duplicates, cancellation,
  crash paths) deterministically without waiting on an 18 fps pipeline.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from config.config import load_config
from src.api import jobs as jobs_module
from src.api import settings as api_settings
from src.api.jobs import TERMINAL_STATES, manager
from src.api.main import app
from src.analysis.logger import ResultLogger
from src.ui.session import AnalysisCancelled

REPO = Path(__file__).resolve().parents[1]
ANOMALY = REPO / "samples" / "anomaly_clip.mp4"
TINY = REPO / "samples" / "tiny_noise.mp4"


# ------------------------------------------------------------------ fixtures
@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    """Temp upload dir + temp database; always restored afterwards."""
    monkeypatch.setattr(api_settings.settings, "upload_dir", tmp_path / "uploads")
    monkeypatch.setattr(api_settings.settings, "max_upload_bytes", 64 * 1024 * 1024)
    cfg = load_config()
    original_db = cfg.paths.db
    cfg.paths.db = tmp_path / "api_test.db"
    try:
        yield
    finally:
        cfg.paths.db = original_db


@pytest.fixture(autouse=True)
def _drain_jobs():
    yield
    manager.cancel_all()
    manager.wait_idle(20.0)
    manager.clear_finished()


@pytest.fixture()
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


def _upload(client: TestClient, *, filename: str = "clip.mp4",
            content_type: str = "video/mp4",
            data: bytes | None = None) -> object:
    payload = ANOMALY.read_bytes() if data is None else data
    return client.post("/api/v1/videos/upload",
                       files={"file": (filename, payload, content_type)})


def _create_job(client: TestClient, kind: str, ref: str,
                max_frames: int | None = None):
    body: dict = {"source": {"kind": kind, "ref": ref}}
    if max_frames is not None:
        body["max_frames"] = max_frames
    return client.post("/api/v1/jobs", json=body)


def _wait_for(client: TestClient, job_id: str,
              states: tuple[str, ...] = TERMINAL_STATES,
              timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    snapshot: dict = {}
    while time.time() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}")
        assert response.status_code == 200, response.text
        snapshot = response.json()["job"]
        if snapshot["state"] in states:
            return snapshot
        time.sleep(0.05)
    raise AssertionError(f"job never reached {states}: last={snapshot}")


def _wait_running(client: TestClient, job_id: str, timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        snapshot = client.get(f"/api/v1/jobs/{job_id}").json()["job"]
        if snapshot["state"] == "running":
            return snapshot
        time.sleep(0.02)
    raise AssertionError("job never entered running state")


def _fake_result(frames: int) -> SimpleNamespace:
    return SimpleNamespace(
        error=None, frames_processed=frames, frame_width=640,
        frame_height=360, fps=30.0, tracks=[{"track_id": 0}, {"track_id": 1}],
        obs=[{"level": "Normal"} for _ in range(frames)],
        level_counts={"Normal": frames, "Suspicious": 0, "Irregular": 0},
        wall_s=0.01, previews=[], session="fake")


@pytest.fixture()
def fake_engine(monkeypatch):
    """Install an injected engine; returns a controller dict."""
    state = {"gate": threading.Event(), "started": threading.Event(),
             "calls": 0, "saved": 0}

    def install(*, mode: str = "fast", frames: int = 5, fail: str | None = None):
        state["gate"].clear()
        state["started"].clear()
        state["calls"] = 0
        state["saved"] = 0

        def runner(**kwargs):
            state["calls"] += 1
            progress = kwargs.get("progress")
            stage = kwargs.get("stage")
            should_stop = kwargs.get("should_stop")
            session = kwargs.get("session", "")
            if stage:
                stage("processing")
            if fail == "crash":
                raise RuntimeError("boom")
            if mode == "block":
                state["started"].set()
                while not state["gate"].wait(0.02):
                    if should_stop and should_stop():
                        raise AnalysisCancelled(session)
                    if progress:
                        progress(1, frames)
            for index in range(1, frames + 1):
                if should_stop and should_stop():
                    raise AnalysisCancelled(session)
                if progress:
                    progress(index, frames)
                if mode == "slow":
                    time.sleep(0.01)
            if fail == "error":
                return SimpleNamespace(error="Could not open source",
                                       frames_processed=0)
            if fail == "zero":
                return _fake_result(0)
            return _fake_result(frames)

        def saver(result):
            state["saved"] += 1
            return {"events": 0}

        monkeypatch.setattr(jobs_module, "run_analysis", runner)
        monkeypatch.setattr(jobs_module, "save_session_to_db", saver)
        return state

    return install


# ------------------------------------------------------------------- uploads
def test_upload_valid_sample_returns_measured_metadata(client: TestClient):
    response = _upload(client)
    assert response.status_code == 201, response.text
    body = response.json()
    assert len(body["upload_id"]) == 24
    assert body["filename"] == "clip.mp4"
    assert body["bytes"] == ANOMALY.stat().st_size
    assert body["video"]["valid"] is True
    assert body["video"]["frames"] == 420
    assert (body["video"]["width"], body["video"]["height"]) == (640, 360)
    # No internal path may leak.
    assert "path" not in body and "path" not in body["video"]
    stored = list(api_settings.upload_dir().iterdir())
    assert len(stored) == 1 and stored[0].name.startswith(body["upload_id"])


def test_upload_rejects_empty_file(client: TestClient):
    response = _upload(client, data=b"")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "empty_file"
    assert list(api_settings.upload_dir().iterdir()) == []


def test_upload_rejects_corrupt_payload(client: TestClient):
    response = _upload(client, data=b"definitely not a video" * 50)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unreadable_video"
    assert list(api_settings.upload_dir().iterdir()) == []


def test_upload_rejects_unsupported_extension(client: TestClient):
    response = _upload(client, filename="notes.txt", content_type="text/plain",
                       data=b"hello")
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_type"


def test_upload_rejects_disallowed_mime_type(client: TestClient):
    response = _upload(client, content_type="text/plain")
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_mime"


def test_upload_rejects_oversized_file(client: TestClient, monkeypatch):
    monkeypatch.setattr(api_settings.settings, "max_upload_bytes", 2048)
    response = _upload(client)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"
    assert list(api_settings.upload_dir().iterdir()) == []


def test_upload_sanitises_traversal_filename(client: TestClient):
    response = _upload(client, filename="../../etc/passwd.mp4")
    assert response.status_code == 201, response.text
    body = response.json()
    assert "/" not in body["filename"] and ".." not in body["filename"]
    assert body["filename"] == "passwd.mp4"
    stored = list(api_settings.upload_dir().iterdir())
    assert len(stored) == 1 and stored[0].parent == api_settings.upload_dir()


def test_upload_rejects_extension_container_mismatch(client: TestClient):
    response = _upload(client, filename="clip.avi",
                       content_type="video/x-msvideo")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "extension_mismatch"


# ---------------------------------------------------------------- job basics
def test_job_rejects_unknown_sample(client: TestClient):
    response = _create_job(client, "sample", "no_such_clip.mp4", 5)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "source_not_found"


def test_job_rejects_traversal_sample_reference(client: TestClient):
    response = _create_job(client, "sample", "../../etc/passwd", 5)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_ref"


def test_job_rejects_malformed_and_unknown_upload_ids(client: TestClient):
    malformed = _create_job(client, "upload", "not-an-id", 5)
    assert malformed.status_code == 422
    assert malformed.json()["error"]["code"] == "invalid_ref"
    missing = _create_job(client, "upload", "0" * 24, 5)
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "upload_not_found"


def test_job_not_found_and_cancel_unknown(client: TestClient):
    assert client.get("/api/v1/jobs/job_missing").status_code == 404
    cancelled = client.post("/api/v1/jobs/job_missing/cancel")
    assert cancelled.status_code == 404
    assert cancelled.json()["error"]["code"] == "job_not_found"


def test_max_frames_cap_is_enforced(client: TestClient):
    response = _create_job(client, "sample", "tiny_noise.mp4",
                           api_settings.settings.max_frames_cap + 1)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "max_frames_too_large"


# ------------------------------------------------------- real processing runs
def test_real_sample_job_completes_with_true_counts(client: TestClient):
    response = _create_job(client, "sample", "anomaly_clip.mp4", 12)
    assert response.status_code == 202, response.text
    created = response.json()["job"]
    assert created["state"] in ("queued", "running")
    assert created["session_id"].startswith("api_")

    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed", final
    assert final["session_id"] == created["session_id"]
    assert final["timings"]["started_ts"] and final["timings"]["ended_ts"]
    assert final["timings"]["elapsed_s"] is not None
    assert final["progress"] == {"processed": 12, "total": 12,
                                 "percent": 100.0, "measured": True}
    result = final["result"]
    assert result["frames_processed"] == 12
    assert result["observations"] > 0
    assert sum(result["levels"].values()) == result["observations"]

    # The session really landed in SQLite under its own id.
    log = ResultLogger(load_config().paths.db, session=final["session_id"])
    try:
        _, rows = log.session_events(final["session_id"])
        run = log.get_run(final["session_id"])
    finally:
        log.close()
    assert len(rows) == result["observations"]
    assert run is not None and run["frames"] == 12


def test_real_upload_job_completes(client: TestClient):
    upload = _upload(client).json()
    response = _create_job(client, "upload", upload["upload_id"], 4)
    assert response.status_code == 202, response.text
    created = response.json()["job"]
    assert created["source"]["label"].startswith("upload: ")

    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed", final
    assert final["result"]["frames_processed"] == 4
    assert final["progress"]["percent"] == 100.0


def test_sessions_are_isolated_between_jobs(client: TestClient):
    first = _wait_for(client, _create_job(client, "sample", "anomaly_clip.mp4", 5)
                      .json()["job"]["job_id"])
    second = _wait_for(client, _create_job(client, "sample", "anomaly_clip.mp4", 9)
                       .json()["job"]["job_id"])
    assert first["session_id"] != second["session_id"]
    db = load_config().paths.db
    for snapshot in (first, second):
        log = ResultLogger(db, session=snapshot["session_id"])
        try:
            _, rows = log.session_events(snapshot["session_id"])
        finally:
            log.close()
        assert len(rows) == snapshot["result"]["observations"]
    assert first["result"]["observations"] != second["result"]["observations"]


# ------------------------------------------------------- injected lifecycle
def test_progress_is_measured_from_callbacks(client: TestClient, fake_engine):
    fake_engine(mode="slow", frames=7)
    created = _create_job(client, "sample", "tiny_noise.mp4", 7).json()["job"]
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed"
    assert final["progress"] == {"processed": 7, "total": 7,
                                 "percent": 100.0, "measured": True}
    assert final["stage"] == "completed"


def test_state_transitions_are_observable(client: TestClient, fake_engine):
    state = fake_engine(mode="block", frames=4)
    created = _create_job(client, "sample", "tiny_noise.mp4", 4).json()["job"]
    running = _wait_running(client, created["job_id"])
    assert running["stage"] in ("opening", "processing")
    assert running["timings"]["started_ts"] is not None
    assert running["timings"]["ended_ts"] is None
    state["gate"].set()
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed"
    assert final["timings"]["ended_ts"] is not None


def test_duplicate_active_job_is_rejected(client: TestClient, fake_engine):
    state = fake_engine(mode="block", frames=4)
    first = _create_job(client, "sample", "tiny_noise.mp4", 4)
    assert first.status_code == 202
    job_id = first.json()["job"]["job_id"]
    state["started"].wait(5)
    duplicate = _create_job(client, "sample", "tiny_noise.mp4", 4)
    assert duplicate.status_code == 409
    error = duplicate.json()["error"]
    assert error["code"] == "job_duplicate"
    assert error["job_id"] == job_id
    state["gate"].set()
    _wait_for(client, job_id)


def test_cancel_running_job_is_cooperative(client: TestClient, fake_engine):
    state = fake_engine(mode="block", frames=4)
    created = _create_job(client, "sample", "tiny_noise.mp4", 4).json()["job"]
    _wait_running(client, created["job_id"])
    response = client.post(f"/api/v1/jobs/{created['job_id']}/cancel")
    assert response.status_code == 200
    assert response.json()["job"]["state"] in ("cancellation_requested",
                                              "cancelled")
    state["gate"].set()
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "cancelled"
    assert final["result"] is None
    assert state["saved"] == 0          # nothing persisted for a cancelled run


def test_cancel_completed_job_conflicts(client: TestClient, fake_engine):
    fake_engine(mode="fast", frames=3)
    created = _create_job(client, "sample", "tiny_noise.mp4", 3).json()["job"]
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed"
    response = client.post(f"/api/v1/jobs/{created['job_id']}/cancel")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "job_not_cancellable"


def test_crash_is_reported_as_failed_not_completed(client: TestClient,
                                                   fake_engine):
    fake_engine(fail="crash")
    created = _create_job(client, "sample", "tiny_noise.mp4", 5).json()["job"]
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "failed"
    assert final["error"]["code"] == "job_crashed"
    assert "boom" in final["error"]["message"]
    assert final["result"] is None


def test_analysis_error_is_reported_as_failed(client: TestClient, fake_engine):
    fake_engine(fail="error")
    created = _create_job(client, "sample", "tiny_noise.mp4", 5).json()["job"]
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "failed"
    assert final["error"]["code"] == "analysis_failed"


def test_zero_frame_run_is_failure(client: TestClient, fake_engine):
    fake_engine(fail="zero")
    created = _create_job(client, "sample", "tiny_noise.mp4", 5).json()["job"]
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "failed"
    assert final["error"]["code"] == "no_frames"


def test_job_listing_filters_and_paginates(client: TestClient, fake_engine):
    fake_engine(mode="fast", frames=2)
    first = _create_job(client, "sample", "tiny_noise.mp4", 2).json()["job"]
    upload = _upload(client).json()
    second = _create_job(client, "upload", upload["upload_id"], 2).json()["job"]
    _wait_for(client, first["job_id"])
    _wait_for(client, second["job_id"])

    completed = client.get("/api/v1/jobs?status=completed").json()
    assert completed["total"] >= 2
    assert all(j["state"] == "completed" for j in completed["jobs"])

    samples = client.get("/api/v1/jobs?kind=sample&status=completed").json()
    assert all(j["source"]["kind"] == "sample" for j in samples["jobs"])
    assert any(j["job_id"] == first["job_id"] for j in samples["jobs"])

    page = client.get("/api/v1/jobs?limit=1&offset=0").json()
    assert page["count"] == 1

    bad = client.get("/api/v1/jobs?status=exploded")
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "invalid_status"


def test_empty_scene_video_completes_with_zero_observations(client: TestClient):
    """tiny_noise.mp4 is speckle-only: finishing with no objects is success."""
    created = _create_job(client, "sample", "tiny_noise.mp4", 8).json()["job"]
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed"
    assert final["result"]["frames_processed"] == 8
    assert final["result"]["observations"] == 0
    assert final["result"]["tracks"] == 0


def test_websocket_streams_and_disconnect_keeps_job_running(
        client: TestClient, fake_engine):
    state = fake_engine(mode="block", frames=3)
    created = _create_job(client, "sample", "tiny_noise.mp4", 3).json()["job"]
    _wait_running(client, created["job_id"])

    with client.websocket_connect(f"/api/v1/jobs/{created['job_id']}/ws") as ws:
        first = ws.receive_json()
        assert first["type"] == "job"
        assert first["job"]["job_id"] == created["job_id"]
        assert first["job"]["state"] in ("running", "queued")

    # The client disconnected; the job must still finish.
    state["gate"].set()
    final = _wait_for(client, created["job_id"])
    assert final["state"] == "completed"
