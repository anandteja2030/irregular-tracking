"""Live camera API tests.

The frames posted here are real JPEGs decoded from a bundled sample, so each
request exercises the actual detector/tracker/fusion path rather than a stub.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from config.config import load_config
from src.api import live as live_module
from src.api import settings as api_settings
from src.api.main import app
from src.api.middleware import RequestBodyLimitMiddleware

REPO = Path(__file__).resolve().parents[1]
ANOMALY = REPO / "samples" / "anomaly_clip.mp4"


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(api_settings.settings, "upload_dir", tmp_path / "uploads")
    cfg = load_config()
    original_db = cfg.paths.db
    cfg.paths.db = tmp_path / "live_test.db"
    live_module.manager.cancel_all()
    try:
        yield
    finally:
        live_module.manager.cancel_all()
        cfg.paths.db = original_db


@pytest.fixture()
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def frames() -> list[bytes]:
    capture = cv2.VideoCapture(str(ANOMALY))
    assert capture.isOpened(), "bundled sample must be decodable"
    out: list[bytes] = []
    try:
        for _ in range(4):
            ok, bgr = capture.read()
            assert ok
            ok, buf = cv2.imencode(".jpg", bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            assert ok
            out.append(buf.tobytes())
    finally:
        capture.release()
    return out


def _open(client: TestClient) -> str:
    # The bundled sample clips are synthetic shapes, so these tests exercise
    # the colour + motion engine explicitly; the COCO engine is covered by its
    # own test below.
    response = client.post("/api/v1/live/sessions", json={"engine": "motion"})
    assert response.status_code == 201, response.text
    return response.json()["session"]["live_id"]


def _post(client: TestClient, live_id: str, payload: bytes):
    return client.post(f"/api/v1/live/sessions/{live_id}/frames",
                       files={"frame": ("frame.jpg", payload, "image/jpeg")})


def test_open_live_session_reports_limits(client: TestClient) -> None:
    response = client.post("/api/v1/live/sessions")
    assert response.status_code == 201
    session = response.json()["session"]
    assert session["live_id"].startswith("live_")
    assert session["session_id"].startswith("live_")
    assert session["state"] == "live"
    assert session["limits"]["max_frames"] == live_module.MAX_LIVE_FRAMES
    assert session["limits"]["max_frame_bytes"] == live_module.MAX_FRAME_BYTES


def test_frames_return_real_tracking_output(client: TestClient,
                                            frames: list[bytes]) -> None:
    live_id = _open(client)
    payload = None
    for frame in frames[:3]:
        response = _post(client, live_id, frame)
        assert response.status_code == 200, response.text
        payload = response.json()

    assert payload is not None
    assert payload["frame_idx"] == 2
    assert payload["counts"]["frames"] == 3
    assert payload["counts"]["observations"] >= 0
    assert payload["counts"]["tracks_seen"] >= 1
    assert isinstance(payload["calibrated"], bool)
    assert payload["fps"] >= 1.0
    for track in payload["tracks"]:
        assert {"track_id", "box", "centroid", "trail", "level", "scores",
                "why", "rules"} <= set(track)
        assert len(track["box"]) == 4
        assert isinstance(track["trail"], list)
        assert all(len(point) == 2 for point in track["trail"])
        assert track["level"] in ("Normal", "Suspicious", "Irregular")
        assert set(track["scores"]) == {"fused", "rule", "ml", "scene"}

    client.post(f"/api/v1/live/sessions/{live_id}/cancel")


def test_stop_persists_a_normal_session(client: TestClient,
                                        frames: list[bytes]) -> None:
    live_id = _open(client)
    for frame in frames[:4]:
        assert _post(client, live_id, frame).status_code == 200

    stopped = client.post(f"/api/v1/live/sessions/{live_id}/stop")
    assert stopped.status_code == 200, stopped.text
    summary = stopped.json()["session"]
    session_id = summary["session_id"]
    assert summary["state"] == "stopped"
    assert summary["frames_processed"] == 4
    assert summary["tracks"] >= 1
    assert summary["observations"] >= 1
    assert summary["previews"] >= 1
    assert session_id.startswith("live_")

    # The capture is now readable through the ordinary session surface.
    detail = client.get(f"/api/v1/sessions/{session_id}")
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["source"]["kind"] == "live"
    assert body["counts"]["tracks"] >= 1

    summary_response = client.get(f"/api/v1/sessions/{session_id}/summary")
    assert summary_response.status_code == 200

    media = client.get(f"/api/v1/sessions/{session_id}/media").json()
    assert media["available"] is True
    assert media["preview_count"] >= 1
    frame_number = media["frames"][0]["frame"]
    preview = client.get(
        f"/api/v1/sessions/{session_id}/frames/{frame_number}")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/jpeg"

    tracks = client.get(f"/api/v1/sessions/{session_id}/tracks").json()
    assert tracks["total"] >= 1

    report = client.get(f"/api/v1/sessions/{session_id}/report")
    assert report.status_code == 200
    markdown = report.text
    assert "## 2. Detection & tracking" in markdown
    assert "Tracked objects" in markdown
    assert "Distribution" in markdown
    assert "█" in markdown
    assert "Retained annotated frames" in markdown


def test_stop_without_frames_is_rejected(client: TestClient) -> None:
    live_id = _open(client)
    response = client.post(f"/api/v1/live/sessions/{live_id}/stop")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "live_state"
    client.post(f"/api/v1/live/sessions/{live_id}/cancel")


def test_unknown_and_cancelled_sessions_are_404(client: TestClient,
                                                frames: list[bytes]) -> None:
    missing = client.post("/api/v1/live/sessions/live_missing/frames",
                          files={"frame": ("frame.jpg", frames[0],
                                           "image/jpeg")})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "live_not_found"

    live_id = _open(client)
    cancelled = client.post(f"/api/v1/live/sessions/{live_id}/cancel")
    assert cancelled.status_code == 200
    after = _post(client, live_id, frames[0])
    assert after.status_code == 404


def test_undecodable_frame_is_rejected(client: TestClient) -> None:
    live_id = _open(client)
    response = _post(client, live_id, b"not an image")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_frame"
    client.post(f"/api/v1/live/sessions/{live_id}/cancel")


def test_concurrent_capture_limit(client: TestClient) -> None:
    created = [_open(client) for _ in range(live_module.MAX_LIVE_SESSIONS)]
    assert len(set(created)) == live_module.MAX_LIVE_SESSIONS
    refused = client.post("/api/v1/live/sessions")
    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "live_limit"
    for live_id in created:
        client.post(f"/api/v1/live/sessions/{live_id}/cancel")


def test_frame_paths_get_their_own_body_budget() -> None:
    middleware = RequestBodyLimitMiddleware(app=None)
    upload = middleware._limit_for({"path": "/api/v1/videos/upload"})
    frame = middleware._limit_for({"path": "/api/v1/live/sessions/live_ab12/frames"})
    other = middleware._limit_for({"path": "/api/v1/jobs"})
    assert frame < upload
    assert frame > other
    assert middleware._limit_for({"path": "/live/sessions/live_ab12/frames"}) == frame


def test_engine_selection_is_explicit_and_validated(client: TestClient) -> None:
    """A caller can choose the engine, and a bad name is rejected, not guessed."""
    response = client.post("/api/v1/live/sessions", json={"engine": "motion"})
    assert response.status_code == 201, response.text
    motion = response.json()["session"]
    assert motion["engine"] == "motion"
    assert motion["calibration"]["needed"] >= 1
    client.post(f"/api/v1/live/sessions/{motion['live_id']}/cancel")

    bad = client.post("/api/v1/live/sessions", json={"engine": "magic"})
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "invalid_engine"


def test_object_engine_reports_real_class_names_when_model_present(
        client: TestClient) -> None:
    """With the COCO model shipped, webcam frames use class names, not colours."""
    created = client.post("/api/v1/live/sessions", json={"engine": "objects"})
    assert created.status_code == 201, created.text
    session = created.json()["session"]
    if session["engine"] != "objects":
        pytest.skip("COCO model files are not installed in this environment")
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    ok, buffer = cv2.imencode(".jpg", frame)
    assert ok
    payload = _post(client, session["live_id"], buffer.tobytes()).json()
    assert payload["engine"] == "objects"
    assert payload["calibration"]["progress"] <= 1.0
    client.post(f"/api/v1/live/sessions/{session['live_id']}/cancel")
