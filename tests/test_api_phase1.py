"""Phase 1 API tests: health, system, config (get/patch/reset), sources, docs.

The autouse fixture restores the mutable config singleton after every test so
these cases can never leak settings into the Streamlit/engine suites.
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from config.config import load_config
from src.api.config_store import apply_patch, serialize_config
from src.api.main import app
from src.api.probe import probe_video


@pytest.fixture()
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _pristine_config():
    """Snapshot -> test -> restore, so singleton mutations never leak."""
    snapshot = copy.deepcopy(serialize_config())
    yield
    apply_patch({k: v for k, v in snapshot.items() if k != "paths"})


# ------------------------------------------------------------------- health
def test_health_reports_ok_and_uptime(client: TestClient):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"]
    assert isinstance(body["uptime_s"], (int, float)) and body["uptime_s"] >= 0


def test_versioned_mirror_answers_but_is_not_documented(client: TestClient):
    assert client.get("/api/v1/health").status_code == 200
    schema = client.get("/openapi.json").json()
    assert "/health" in schema["paths"]
    assert "/api/v1/health" not in schema["paths"]


# ------------------------------------------------------------------- system
def test_system_reports_measured_environment(client: TestClient):
    r = client.get("/system")
    assert r.status_code == 200
    body = r.json()
    assert body["python"].startswith("3.")
    assert body["packages"]["numpy"]
    assert body["packages"]["fastapi"]
    assert body["storage"]["db"]["path"].endswith("app_data.db")
    assert body["storage"]["samples"]["videos"] == 3
    assert body["storage"]["samples"]["bytes"] > 0
    assert body["runtime"]["pid"] > 0
    # Limits and formats are the values the API actually enforces.
    assert body["limits"]["max_upload_bytes"] > 0
    assert body["limits"]["max_frames_cap"] > 0
    assert ".mp4" in body["formats"]["extensions"]
    assert "video/mp4" in body["formats"]["mime_types"]
    assert body["configuration"]["persistence"] == "process_local"
    assert body["configuration"]["resets_on_restart"] is True


# ------------------------------------------------------------------- config
def test_get_config_returns_full_document(client: TestClient):
    body = client.get("/config").json()
    assert body["anomaly"]["threshold_suspicious"] == pytest.approx(0.35)
    assert body["anomaly"]["threshold_irregular"] == pytest.approx(0.65)
    assert sum(body["anomaly"]["weights"].values()) == pytest.approx(1.0)
    assert len(body["color"]["ranges"]) == 6
    assert body["paths"]["db"].endswith("app_data.db")
    assert body["paths"]["read_only"] is True
    for section in ("video", "preprocess", "tracking", "features",
                    "calibration", "zone", "dashboard"):
        assert section in body


def test_patch_applies_to_engine_singleton(client: TestClient):
    r = client.put("/config", json={"anomaly": {"threshold_suspicious": 0.4}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] is True
    assert body["applied"] == ["anomaly.threshold_suspicious"]
    assert body["config"]["anomaly"]["threshold_suspicious"] == pytest.approx(0.4)
    # The engine reads the same object, so the patch is really in effect.
    assert load_config().anomaly.threshold_suspicious == pytest.approx(0.4)
    assert client.get("/config").json()["anomaly"]["threshold_suspicious"] == \
        pytest.approx(0.4)


def test_patch_rejects_threshold_ordering_and_changes_nothing(client: TestClient):
    r = client.put("/config", json={"anomaly": {"threshold_suspicious": 0.9}})
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "config_invalid"
    assert error["detail"]
    assert load_config().anomaly.threshold_suspicious == pytest.approx(0.35)


def test_patch_rejects_unknown_section(client: TestClient):
    r = client.put("/config", json={"nope": {"x": 1}})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "config_invalid"
    assert load_config().anomaly.threshold_suspicious == pytest.approx(0.35)


def test_patch_rejects_unnormalised_fusion_weights(client: TestClient):
    r = client.put("/config", json={
        "anomaly": {"weights": {"rule": 0.9, "ml": 0.9, "scene": 0.9}}})
    assert r.status_code == 422
    assert "sum" in str(r.json()["error"]["detail"]).lower()


def test_patch_rejects_half_configured_frame_size(client: TestClient):
    r = client.put("/config", json={"video": {"frame_width": None}})
    assert r.status_code == 422
    assert "frame_width and frame_height" in str(r.json()["error"]["detail"])


def test_patch_rejects_read_only_paths(client: TestClient):
    r = client.put("/config", json={"paths": {"db": "/tmp/other.db"}})
    assert r.status_code == 422
    assert load_config().paths.db.name == "app_data.db"


def test_reset_restores_defaults(client: TestClient):
    client.put("/config", json={"anomaly": {"threshold_suspicious": 0.4}})
    r = client.post("/config/reset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reset_to_defaults"] is True
    assert body["config"]["anomaly"]["threshold_suspicious"] == \
        pytest.approx(0.35)
    assert load_config().anomaly.threshold_suspicious == pytest.approx(0.35)


# ------------------------------------------------------------------ sources
def test_sources_report_real_sample_metadata(client: TestClient):
    r = client.get("/sources")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 3
    assert body["valid"] == 3 and body["invalid"] == 0
    by_name = {s["name"]: s for s in body["sources"]}
    anomaly = by_name["anomaly_clip.mp4"]
    assert anomaly["synthetic"] is True
    assert anomaly["kind"] == "sample"
    assert anomaly["valid"] is True
    assert anomaly["bytes"] > 0
    assert anomaly["frames"] == 420
    # Raw sample resolution; the pipeline resizes to 1280x720 at runtime.
    assert anomaly["width"] == 640 and anomaly["height"] == 360
    assert anomaly["fps"] == pytest.approx(30.0, abs=0.5)
    assert anomaly["duration_s"] == pytest.approx(14.0, abs=0.5)
    tiny = by_name["tiny_noise.mp4"]
    assert tiny["frames"] == 40
    assert (tiny["width"], tiny["height"]) == (320, 240)


def test_probe_flags_undecodable_file(tmp_path):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"this is not a video")
    result = probe_video(broken)
    assert result["valid"] is False
    assert result["error"]


def test_probe_reports_missing_file_without_raising(tmp_path):
    result = probe_video(tmp_path / "missing.mp4")
    assert result["valid"] is False
    assert "stat" in result["error"]


# --------------------------------------------------------------------- docs
def test_openapi_documents_the_foundation(client: TestClient):
    schema = client.get("/openapi.json").json()
    assert schema["info"]["title"] == "NEURAL COMMAND API"
    for path in ("/health", "/system", "/config", "/config/reset", "/sources"):
        assert path in schema["paths"]
    assert "put" in schema["paths"]["/config"]
    assert client.get("/docs").status_code == 200


def test_unknown_route_uses_error_envelope(client: TestClient):
    r = client.get("/does-not-exist")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "http_404"
