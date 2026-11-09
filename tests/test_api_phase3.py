"""Phase 3 API tests: sessions, tracks, anomalies, media, scene, evaluation.

Two data sources are exercised deliberately:

* a **seeded** SQLite database, so every aggregate, filter, ordering and
  degradation path is deterministic and independent of pipeline timing;
* one **real** short analysis job, to prove the endpoints read genuinely
  persisted results and that in-process artifacts (previews, trajectories,
  evidence, calibration) are actually wired to completed jobs.
"""
from __future__ import annotations

import csv
import io
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from config.config import load_config
from src.analysis.calibration import SceneStats
from src.analysis.logger import EVENT_SCHEMA
from src.api import settings as api_settings
from src.api.jobs import TERMINAL_STATES, manager
from src.api.main import app
from src.api.session_store import store
from src.ui.session import (OBS_COLS, TRACK_COLS, PreviewFrame, SessionResult)

REPO = Path(__file__).resolve().parents[1]
ANOMALY = REPO / "samples" / "anomaly_clip.mp4"

ALPHA, BETA, EMPTY = "seed_alpha", "seed_beta", "seed_empty"


# ------------------------------------------------------------------ fixtures
@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(api_settings.settings, "upload_dir", tmp_path / "uploads")
    cfg = load_config()
    original_db = cfg.paths.db
    cfg.paths.db = tmp_path / "phase3.db"
    store.clear()
    try:
        yield cfg.paths.db
    finally:
        cfg.paths.db = original_db
        store.clear()


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


_ALPHA_EVENTS = (
    # frame, track, level, fused, rule, ml, scene, speed, direction
    [(f, 1, "Normal", 0.10, 0.0, 0.0, 0.0, 100.0, 0.0) for f in range(7)]
    + [(7, 1, "Suspicious", 0.55, 0.50, 0.10, 0.20, 150.0, 45.0),
       (8, 1, "Suspicious", 0.60, 0.55, 0.15, 0.25, 180.0, 45.0),
       (9, 1, "Irregular", 0.85, 0.80, 0.50, 0.30, 300.0, 90.0)]
    + [(f, 2, "Normal", 0.05, 0.0, 0.0, 0.0, 80.0, 180.0) for f in range(5)]
)

_BETA_EVENTS = (
    [(0, 1, "Normal", 0.10, 0.0, 0.0, 0.0, 60.0, 270.0),
     (1, 1, "Normal", 0.10, 0.0, 0.0, 0.0, 62.0, 270.0),
     (2, 1, "Normal", 0.12, 0.0, 0.0, 0.0, 64.0, 270.0),
     (3, 1, "Suspicious", 0.51, 0.40, 0.05, 0.10, 70.0, 270.0),
     (4, 1, "Normal", 0.10, 0.0, 0.0, 0.0, 60.0, 270.0),
     (5, 1, "Normal", 0.10, 0.0, 0.0, 0.0, 58.0, 270.0)]
)


def _seed(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(EVENT_SCHEMA)
    for i, (frame, track, level, fused, rule, ml, scene, speed, direction) in \
            enumerate(_ALPHA_EVENTS):
        conn.execute(
            "INSERT INTO track_events(ts_utc, session, frame_idx, track_id,"
            " level, fused_score, rule_score, ml_score, scene_score,"
            " speed_px_s, direction_deg, why) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"2026-10-30T10:00:{i:02d}+00:00", ALPHA, frame, track, level,
             fused, rule, ml, scene, speed, direction,
             f"{level} observation for track {track} at frame {frame}"))
    for i, (frame, track, level, fused, rule, ml, scene, speed, direction) in \
            enumerate(_BETA_EVENTS):
        conn.execute(
            "INSERT INTO track_events(ts_utc, session, frame_idx, track_id,"
            " level, fused_score, rule_score, ml_score, scene_score,"
            " speed_px_s, direction_deg, why) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"2026-10-31T09:00:{i:02d}+00:00", BETA, frame, track, level,
             fused, rule, ml, scene, speed, direction, "beta explanation"))
    summaries = (
        (1, ALPHA, "red", "circle", 10, 0.36, 145.0, 300.0, 650.0, 0.95,
         "E,NE", 0, 9),
        (2, ALPHA, "blue", "square", 5, 0.16, 80.0, 80.0, 300.0, 1.0,
         "W", 0, 4),
        (1, BETA, "green", "triangle", 6, 0.2, 60.0, 70.0, 200.0, 0.8,
         "S", 0, 5),
    )
    conn.executemany(
        "INSERT INTO track_summaries(track_id, session, color, shape, n_points,"
        " n_seconds, mean_speed_px_s, max_speed_px_s, path_length_px,"
        " straightness, directions, first_frame, last_frame)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", summaries)
    runs = (
        (ALPHA, "sample: alpha.mp4", "sample", 1, 40, 640, 360, 25.0, 2.0,
         None, "2026-10-30T10:00:00+00:00", "2026-10-30T10:00:03+00:00"),
        (BETA, "upload: beta.mp4", "upload", 0, 30, 1280, 720, 30.0, 1.5,
         30, "2026-10-31T09:00:00+00:00", "2026-10-31T09:00:02+00:00"),
        (EMPTY, "sample: empty.mp4", "sample", 1, 10, 640, 360, 10.0, 0.5,
         10, "2026-10-29T08:00:00+00:00", "2026-10-29T08:00:01+00:00"),
    )
    conn.executemany(
        "INSERT INTO run_stats(session, source, kind, synthetic, frames, width,"
        " height, fps, wall_s, max_frames, started_ts, ended_ts)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", runs)
    conn.executemany(
        "INSERT INTO ground_truth(session, frame_idx, track_id, label)"
        " VALUES (?,?,?,?)",
        [(ALPHA, 7, 1, "Anomaly"), (ALPHA, 0, 1, "Normal"),
         (ALPHA, 1, 1, "Normal"), (ALPHA, 2, 2, "Normal"),
         (ALPHA, 3, 1, "Anomaly")])
    conn.commit()
    conn.close()


@pytest.fixture()
def seeded(_isolated_state) -> Path:
    _seed(_isolated_state)
    return _isolated_state


@pytest.fixture()
def alpha_artifacts(seeded) -> str:
    """Retain synthetic artifacts for ALPHA without running the pipeline."""
    rows = []
    for (frame, track, level, fused, rule, ml, scene, speed, direction) in \
            _ALPHA_EVENTS:
        rules = ("[{\"rule\": \"excessive_speed\", \"severity\": 0.6,"
                 " \"description\": \"speed above scene envelope\"}]"
                 if level == "Irregular" else "[]")
        rows.append({
            "frame": frame, "ts_s": round(frame / 25.0, 2), "track_id": track,
            "color": "red" if track == 1 else "blue",
            "shape": "circle" if track == 1 else "square", "level": level,
            "fused_score": fused, "rule_score": rule, "ml_score": ml,
            "scene_score": scene, "speed_px_s": speed,
            "direction_deg": direction, "cx": 100.0 + frame, "cy": 200.0 + frame,
            "zone": None, "zone_dwell_s": 0.0, "rules_json": rules,
            "ml_note": "Isolation Forest: learning baseline",
            "scene_note": "movement matches scene baseline",
            "why": f"{level} observation for track {track} at frame {frame}",
        })
    obs = pd.DataFrame(rows, columns=OBS_COLS)
    tracks = pd.DataFrame([{
        "track_id": 1, "color": "red", "shape": "circle", "first_frame": 0,
        "last_frame": 9, "duration_s": 0.36, "n_obs": 10,
        "mean_speed_px_s": 145.0, "max_speed_px_s": 300.0,
        "path_length_px": 650.0, "straightness": 0.95, "start_x": 100.0,
        "start_y": 200.0, "end_x": 109.0, "end_y": 209.0, "directions": "E,NE",
        "n_events": 3, "worst_level": "Irregular",
    }], columns=TRACK_COLS)
    previews = [
        PreviewFrame(frame_idx=0, ts_s=0.0,
                     annotated=np.full((36, 64, 3), 40, np.uint8),
                     original=np.full((36, 64, 3), 90, np.uint8)),
        PreviewFrame(frame_idx=6, ts_s=0.24,
                     annotated=np.full((36, 64, 3), 60, np.uint8),
                     original=np.full((36, 64, 3), 120, np.uint8)),
    ]
    result = SessionResult(
        session=ALPHA, source_label="sample: alpha.mp4", source_path="x.mp4",
        source_kind="sample", is_synthetic=True,
        started_ts="2026-10-30T10:00:00+00:00",
        ended_ts="2026-10-30T10:00:03+00:00", wall_s=2.0, fps=25.0,
        frame_width=640, frame_height=360, frames_available=40,
        frames_processed=40, max_frames=None, previews=previews, obs=obs,
        tracks=tracks,
        track_points={1: [(0, 100.0, 200.0), (9, 109.0, 209.0)]},
        scene=SceneStats(
            ready=True, n_samples=12, n_tracks=2, observed_seconds=0.6,
            speed_p10=80.0, speed_p50=100.0, speed_p90=180.0,
            speed_mean=121.0, speed_std=40.0,
            direction_hist={"E": 0.5, "NE": 0.3, "W": 0.2},
            dominant_directions=["E"], moving_fraction=0.8),
        summaries=[])
    assert store.record(result) is not None
    return ALPHA


def _tiny_result(session: str, tone: int = 40) -> SessionResult:
    return SessionResult(
        session=session, source_label="tiny", source_path="t.mp4",
        source_kind="sample", is_synthetic=True, started_ts="t0", ended_ts="t1",
        wall_s=0.1, fps=10.0, frame_width=64, frame_height=64,
        frames_available=1, frames_processed=1, max_frames=1,
        previews=[PreviewFrame(frame_idx=0, ts_s=0.0,
                               annotated=np.full((64, 64, 3), tone, np.uint8),
                               original=np.full((64, 64, 3), tone, np.uint8))],
        obs=pd.DataFrame(columns=OBS_COLS),
        tracks=pd.DataFrame(columns=TRACK_COLS))


def test_artifact_store_is_bounded(tmp_path):
    from src.api.session_store import SessionArtifactStore

    by_count = SessionArtifactStore(max_sessions=2)
    for session in ("s1", "s2", "s3"):
        by_count.record(_tiny_result(session))
    assert by_count.get("s1") is None
    assert by_count.get("s2") is not None and by_count.get("s3") is not None
    assert by_count.stats()["sessions"] == 2

    by_bytes = SessionArtifactStore(max_sessions=10, max_bytes=1)
    by_bytes.record(_tiny_result("b1"))
    by_bytes.record(_tiny_result("b2"))
    assert by_bytes.get("b1") is None
    assert by_bytes.get("b2") is not None
    assert by_bytes.stats()["bytes"] > 0


def _wait_for(client: TestClient, job_id: str, timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    snapshot: dict = {}
    while time.time() < deadline:
        response = client.get(f"/api/v1/jobs/{job_id}")
        assert response.status_code == 200, response.text
        snapshot = response.json()["job"]
        if snapshot["state"] in TERMINAL_STATES:
            return snapshot
        time.sleep(0.05)
    raise AssertionError(f"job never finished: {snapshot}")


def _count(db_path: Path, sql: str, params: tuple = ()) -> int:
    conn = sqlite3.connect(db_path)
    try:
        return int(conn.execute(sql, params).fetchone()[0])
    finally:
        conn.close()


# ------------------------------------------------------------------- sessions
def test_session_list_pagination_and_ordering(client, seeded):
    first = client.get("/api/v1/sessions?limit=2").json()
    assert first["total"] == 3
    assert first["count"] == 2
    assert [s["session"] for s in first["sessions"]] == [BETA, ALPHA]

    second = client.get("/api/v1/sessions?limit=2&offset=2").json()
    assert [s["session"] for s in second["sessions"]] == [EMPTY]

    oldest = client.get("/api/v1/sessions?sort=oldest").json()["sessions"]
    assert oldest[0]["session"] == EMPTY
    busiest = client.get("/api/v1/sessions?sort=events").json()["sessions"]
    assert busiest[0]["session"] == ALPHA


def test_session_list_filters(client, seeded):
    assert client.get("/api/v1/sessions?kind=upload").json()["total"] == 1
    assert client.get("/api/v1/sessions?synthetic=true").json()["total"] == 2
    assert client.get("/api/v1/sessions?has_labels=true").json()["total"] == 1
    assert client.get("/api/v1/sessions?has_anomalies=false").json()["total"] == 1
    assert client.get(f"/api/v1/sessions?q={ALPHA[:6]}").json()["total"] == 1
    assert client.get("/api/v1/sessions?since=2026-10-30T00:00:00").json()[
        "total"] == 2
    assert client.get("/api/v1/sessions?until=2026-10-30T09:00:00").json()[
        "total"] == 1


def test_session_list_rejects_bad_filters(client, seeded):
    assert client.get("/api/v1/sessions?since=not-a-date").status_code == 422
    bad_range = client.get(
        "/api/v1/sessions?since=2026-11-01T00:00:00&until=2026-10-01T00:00:00")
    assert bad_range.status_code == 422
    assert bad_range.json()["error"]["code"] == "invalid_range"
    assert client.get("/api/v1/sessions?limit=0").status_code == 422
    assert client.get("/api/v1/sessions?kind=weird").status_code == 422


def test_session_detail_and_summary(client, seeded):
    detail = client.get(f"/api/v1/sessions/{ALPHA}").json()
    assert detail["counts"] == {
        "observations": 15, "tracks": 2, "anomalies": 3,
        "levels": {"Normal": 12, "Suspicious": 2, "Irregular": 1}, "labels": 5,
    }
    assert detail["processing"]["frames_processed"] == 40
    assert detail["processing"]["video_duration_s"] == pytest.approx(1.6)
    assert detail["processing"]["processing_fps"] == pytest.approx(20.0)
    assert detail["frame_range"] == {"first": 0, "last": 9}
    assert detail["artifacts"]["retained"] is False
    assert detail["media"]["available"] is False
    assert any("not persisted" in note for note in detail["limitations"])

    summary = client.get(f"/api/v1/sessions/{ALPHA}/summary").json()
    assert summary["level_share"]["Irregular"] == pytest.approx(1 / 15, abs=1e-4)
    assert summary["anomalies"]["count"] == 3
    assert summary["anomalies"]["tracks_affected"] == 1
    assert summary["anomalies"]["highest"]["frame"] == 9
    assert summary["anomalies"]["score_max"] == pytest.approx(0.85)
    assert summary["tracks"] == {"count": 2, "with_anomalies": 1,
                                 "with_irregular": 1}
    assert summary["temporal"]["observed_seconds"] == pytest.approx(0.36)


def test_empty_session_is_zero_not_null(client, seeded):
    detail = client.get(f"/api/v1/sessions/{EMPTY}").json()
    assert detail["counts"]["observations"] == 0
    assert detail["counts"]["levels"] == {"Normal": 0, "Suspicious": 0,
                                          "Irregular": 0}
    assert detail["frame_range"] == {"first": None, "last": None}
    assert detail["processing"]["frames_processed"] == 10

    summary = client.get(f"/api/v1/sessions/{EMPTY}/summary").json()
    assert summary["anomalies"]["count"] == 0
    assert summary["anomalies"]["highest"] is None
    assert summary["anomalies"]["score_max"] is None
    assert summary["level_share"]["Normal"] == 0.0

    assert client.get(f"/api/v1/sessions/{EMPTY}/tracks").json()["total"] == 0
    assert client.get(f"/api/v1/sessions/{EMPTY}/anomalies").json()["total"] == 0
    assert client.get(f"/api/v1/sessions/{EMPTY}/scene").json()[
        "speed_baseline"] is None


def test_unknown_and_invalid_session_ids(client, seeded):
    missing = client.get("/api/v1/sessions/does_not_exist")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "session_not_found"

    invalid = client.get("/api/v1/sessions/bad*id")
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_session_id"

    for suffix in ("summary", "tracks", "anomalies", "scene", "evaluation",
                   "media", "export/csv", "report"):
        response = client.get(f"/api/v1/sessions/does_not_exist/{suffix}")
        assert response.status_code == 404, (suffix, response.text)


# --------------------------------------------------------------------- tracks
def test_track_list_filters_and_sorting(client, seeded):
    body = client.get(f"/api/v1/sessions/{ALPHA}/tracks").json()
    assert body["total"] == 2
    first = body["tracks"][0]
    assert first["track_id"] == 1
    assert first["appearance"] == {"color": "red", "shape": "circle"}
    assert first["observed"] == {
        "observations": 10, "anomalies": 3,
        "levels": {"Normal": 7, "Suspicious": 2, "Irregular": 1},
        "worst_level": "Irregular", "duration_s": pytest.approx(0.36),
    }
    assert first["motion"]["mean_speed_px_s"] == 145.0
    assert first["motion"]["speed_source"] == "track_summary"

    only_anomalies = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks?level=any").json()
    assert [t["track_id"] for t in only_anomalies["tracks"]] == [1]
    irregular = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks?level=Irregular").json()
    assert irregular["total"] == 1
    normal_only = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks?level=Normal").json()
    assert [t["track_id"] for t in normal_only["tracks"]] == [2]
    assert client.get(
        f"/api/v1/sessions/{ALPHA}/tracks?min_events=2").json()["total"] == 1
    by_speed = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks?sort=speed").json()["tracks"]
    assert by_speed[0]["track_id"] == 1
    page = client.get(f"/api/v1/sessions/{ALPHA}/tracks?limit=1&offset=1").json()
    assert page["count"] == 1 and page["total"] == 2


def test_track_detail_and_observations(client, seeded):
    detail = client.get(f"/api/v1/sessions/{ALPHA}/tracks/1").json()
    assert detail["session"] == ALPHA
    assert detail["motion"]["max_speed_px_s"] == 300.0
    assert detail["motion"]["summary_directions"] == ["E", "NE"]
    assert detail["direction_profile"]["samples"] == 10
    assert detail["direction_profile"]["source"] == "derived_event_observations"
    assert detail["trajectory"]["available"] is False
    assert detail["trajectory"]["reason"]

    observations = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks/1/observations").json()
    assert observations["total"] == 10
    assert observations["observations"][-1]["level"] == "Irregular"
    assert observations["observations"][-1]["scores"]["fused"] == 0.85
    irregular = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks/1/observations?level=Irregular").json()
    assert irregular["total"] == 1
    window = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks/1/observations"
        "?from_frame=7&to_frame=8").json()
    assert [o["frame"] for o in window["observations"]] == [7, 8]

    missing = client.get(f"/api/v1/sessions/{ALPHA}/tracks/77")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "track_not_found"


def test_track_frames_without_media(client, seeded):
    body = client.get(f"/api/v1/sessions/{ALPHA}/tracks/1/frames").json()
    assert body["total"] == 10
    assert body["media_available"] is False
    assert body["reason"]
    assert all(f["preview_available"] is False for f in body["frames"])
    assert all(f["frame_url"] is None for f in body["frames"])
    assert [f["frame"] for f in body["frames"]] == list(range(10))


# ---------------------------------------------------------------- artifacts
def test_artifacts_enable_trajectory_evidence_and_frames(client, alpha_artifacts):
    detail = client.get(f"/api/v1/sessions/{ALPHA}").json()
    assert detail["artifacts"]["retained"] is True
    assert detail["artifacts"]["trajectories"] is True
    assert detail["artifacts"]["structured_evidence"] is True
    assert detail["artifacts"]["preview_frames"] == 2
    assert detail["media"]["preview_stride"] == 6

    trajectory = client.get(
        f"/api/v1/sessions/{ALPHA}/tracks/1/trajectory").json()
    assert trajectory["available"] is True
    assert [p["frame"] for p in trajectory["points"]] == list(range(10))
    assert trajectory["points"][0]["x"] == 100.0
    assert trajectory["points"][0]["y"] == 200.0
    assert trajectory["points"][-1]["level"] == "Irregular"

    media = client.get(f"/api/v1/sessions/{ALPHA}/media").json()
    assert media["available"] is True
    assert media["preview_count"] == 2
    assert media["frames"][0]["annotated_url"].endswith(
        f"/sessions/{ALPHA}/frames/0?kind=annotated")
    assert media["annotated_video"]["available"] is False

    jpeg = client.get(f"/api/v1/sessions/{ALPHA}/frames/0")
    assert jpeg.status_code == 200
    assert jpeg.headers["content-type"] == "image/jpeg"
    assert jpeg.content.startswith(b"\xff\xd8")
    assert jpeg.headers["X-Frame-Kind"] == "annotated"
    original = client.get(f"/api/v1/sessions/{ALPHA}/frames/6?kind=original")
    assert original.status_code == 200 and original.content.startswith(b"\xff\xd8")

    gap = client.get(f"/api/v1/sessions/{ALPHA}/frames/3")
    assert gap.status_code == 404
    assert gap.json()["error"]["code"] == "frame_not_available"
    assert gap.json()["error"]["preview_stride"] == 6
    assert client.get(f"/api/v1/sessions/{ALPHA}/frames/-1").status_code == 422
    assert client.get(f"/api/v1/sessions/{ALPHA}/frames/0?kind=raw").status_code == 422

    frames = client.get(f"/api/v1/sessions/{ALPHA}/tracks/1/frames").json()
    assert frames["media_available"] is True
    assert [f["preview_available"] for f in frames["frames"][:2]] == [True, False]
    assert frames["frames"][0]["frame_url"]

    anomalies = client.get(f"/api/v1/sessions/{ALPHA}/anomalies").json()
    irregular = [a for a in anomalies["anomalies"] if a["level"] == "Irregular"][0]
    assert irregular["evidence"]["available"] is True
    assert irregular["evidence"]["rules"][0]["rule"] == "excessive_speed"
    assert irregular["evidence"]["ml_note"]
    by_rule = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?event_type=excessive_speed").json()
    assert by_rule["total"] == 1
    assert by_rule["anomalies"][0]["track_id"] == 1

    scene = client.get(f"/api/v1/sessions/{ALPHA}/scene").json()
    assert scene["source"] == "run_calibration"
    assert scene["calibration"] == {
        "available": True, "ready": True, "samples": 12, "tracks": 2,
        "observed_seconds": 0.6, "reason": None,
    }
    assert scene["speed_baseline"]["p90"] == 180.0
    assert scene["directions"]["dominant"] == ["E"]


# ------------------------------------------------------------------ anomalies
def test_anomaly_filters_and_detail(client, seeded):
    body = client.get(f"/api/v1/sessions/{ALPHA}/anomalies").json()
    assert body["total"] == 3
    assert [a["level"] for a in body["anomalies"]] == [
        "Irregular", "Suspicious", "Suspicious"]
    assert body["anomalies"][0]["evidence"]["available"] is False
    assert body["anomalies"][0]["evidence"]["source"] == "not_persisted"

    one_level = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?severity=Suspicious").json()
    assert one_level["total"] == 2
    by_track = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?track_id=2").json()
    assert by_track["total"] == 0
    # Track ids start at zero, so filtering by track 0 must be accepted.
    zero_track = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?track_id=0")
    assert zero_track.status_code == 200
    assert zero_track.json()["total"] == 0
    by_score = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?min_score=0.6").json()
    assert by_score["total"] == 2
    by_frame = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?from_frame=8&to_frame=9").json()
    assert [a["frame"] for a in by_frame["anomalies"]] == [9, 8]
    by_ml = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?event_type=ml").json()
    assert by_ml["total"] == 3
    assert all(a["scores"]["ml"] > 0 for a in by_ml["anomalies"])

    rules_unavailable = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?event_type=loitering")
    assert rules_unavailable.status_code == 400
    assert rules_unavailable.json()["error"]["code"] == "event_type_unavailable"
    assert client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?from_frame=9&to_frame=2"
    ).status_code == 422
    assert client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies?severity=Normal").status_code == 422

    conn = sqlite3.connect(seeded)
    irregular_id = conn.execute(
        "SELECT id FROM track_events WHERE session = ? AND level = 'Irregular'",
        (ALPHA,)).fetchone()[0]
    conn.close()
    detail = client.get(
        f"/api/v1/sessions/{ALPHA}/anomalies/{irregular_id}").json()
    assert detail["track"]["track_id"] == 1
    assert detail["track"]["worst_level"] == "Irregular"
    assert detail["frame_info"]["media_available"] is False
    assert detail["frame_info"]["frame_url"] is None
    assert detail["evidence"]["available"] is False
    assert any("Rule-based evidence" in note for note in detail["notes"])


def test_anomaly_detail_is_session_scoped(client, seeded):
    conn = sqlite3.connect(seeded)
    alpha_id = conn.execute(
        "SELECT id FROM track_events WHERE session = ? AND level != 'Normal'"
        " ORDER BY fused_score DESC LIMIT 1", (ALPHA,)).fetchone()[0]
    normal_id = conn.execute(
        "SELECT id FROM track_events WHERE session = ? AND level = 'Normal'"
        " LIMIT 1", (ALPHA,)).fetchone()[0]
    conn.close()

    assert client.get(f"/api/v1/sessions/{ALPHA}/anomalies/{alpha_id}").status_code == 200
    # Same numeric id requested through another session must not leak.
    assert client.get(f"/api/v1/sessions/{BETA}/anomalies/{alpha_id}").status_code == 404
    assert client.get(f"/api/v1/sessions/{ALPHA}/anomalies/{normal_id}").status_code == 404


# ---------------------------------------------------------------------- scene
def test_scene_derived_from_observations(client, seeded):
    body = client.get(f"/api/v1/sessions/{ALPHA}/scene").json()
    assert body["source"] == "derived_observations"
    assert body["calibration"]["available"] is False
    assert body["calibration"]["ready"] is None
    baseline = body["speed_baseline"]
    assert baseline["source"] == "derived_event_observations"
    assert baseline["samples"] == 15
    assert baseline["min"] == 80.0 and baseline["max"] == 300.0
    expected_mean = (100.0 * 7 + 150.0 + 180.0 + 300.0 + 80.0 * 5) / 15
    assert baseline["mean"] == pytest.approx(expected_mean, abs=0.01)
    assert body["directions"]["source"] == "derived_event_observations"
    assert body["directions"]["samples"] == 15
    assert body["directions"]["dominant"] == ["E", "W"]

    deviations = body["deviations"]
    assert deviations["scene_score"]["samples"] == 15
    assert deviations["scene_score"]["max"] == pytest.approx(0.30)
    assert deviations["above_0_2"] == 3
    assert deviations["above_0_3"] == 1
    assert deviations["affected_tracks"] == 1
    assert deviations["top_tracks"][0]["track_id"] == 1


# ----------------------------------------------------------------- evaluation
def test_evaluation_available_vs_unavailable(client, seeded):
    unavailable = client.get(f"/api/v1/sessions/{BETA}/evaluation").json()
    assert unavailable["available"] is False
    assert unavailable["computable"] is False
    assert unavailable["metrics"] is None
    assert unavailable["reason"]
    assert unavailable["label_counts"] == {"Normal": 0, "Anomaly": 0}
    assert unavailable["coverage"] == 0.0
    assert unavailable["total_observations"] == 6

    body = client.get(f"/api/v1/sessions/{ALPHA}/evaluation").json()
    assert body["available"] is True
    assert body["computable"] is True
    metrics = body["metrics"]
    assert (metrics["tp"], metrics["fp"], metrics["fn"], metrics["tn"]) == (1, 0, 1, 3)
    assert metrics["precision"] == pytest.approx(1.0)
    assert metrics["recall"] == pytest.approx(0.5)
    assert metrics["f1"] == pytest.approx(0.6667, abs=1e-4)
    assert metrics["fpr"] == 0.0 and metrics["accuracy"] == pytest.approx(0.8)
    assert body["labeled_observations"] == 5
    assert body["label_counts"] == {"Normal": 3, "Anomaly": 2}
    assert body["coverage"] == pytest.approx(5 / 15, abs=1e-4)
    assert body["predicted_positive"] == 3


def test_evaluation_single_class_is_not_a_zero_score(client, seeded):
    conn = sqlite3.connect(seeded)
    conn.execute("DELETE FROM ground_truth WHERE session = ?", (ALPHA,))
    conn.execute(
        "INSERT INTO ground_truth(session, frame_idx, track_id, label)"
        " VALUES (?,?,?,?)", (ALPHA, 0, 1, "Normal"))
    conn.commit()
    conn.close()
    body = client.get(f"/api/v1/sessions/{ALPHA}/evaluation").json()
    assert body["available"] is True
    assert body["computable"] is False
    assert body["metrics"] is None
    assert "one class" in body["reason"]


# ------------------------------------------------------------------- exports
def test_csv_export_is_session_specific(client, seeded):
    response = client.get(f"/api/v1/sessions/{ALPHA}/export/csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert ALPHA in response.headers["content-disposition"]
    assert response.headers["X-Row-Count"] == "15"
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0][:4] == ["frame", "ts_utc", "track_id", "level"]
    assert len(rows) == 16
    assert all(BETA not in line for line in rows)

    tracks = csv.reader(io.StringIO(
        client.get(f"/api/v1/sessions/{ALPHA}/export/csv?dataset=tracks").text))
    rows = list(tracks)
    assert rows[0][0] == "track_id"
    assert len(rows) == 3
    assert rows[1][0] == "1" and rows[1][10] == "Irregular"

    empty = client.get(f"/api/v1/sessions/{EMPTY}/export/csv")
    assert len(list(csv.reader(io.StringIO(empty.text)))) == 1
    assert client.get(
        f"/api/v1/sessions/{ALPHA}/export/csv?dataset=everything").status_code == 422


def test_report_is_session_specific_markdown(client, seeded):
    response = client.get(f"/api/v1/sessions/{ALPHA}/report")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    text = response.text
    assert text.startswith("# NEURAL COMMAND")
    assert f"`{ALPHA}`" in text
    assert "**15**" in text
    assert "SYNTHETIC SAMPLE FOOTAGE" in text
    assert "Precision" in text and "0.667" in text
    assert BETA not in text

    download = client.get(f"/api/v1/sessions/{ALPHA}/report?download=true")
    assert download.headers["content-disposition"].startswith("attachment")

    empty = client.get(f"/api/v1/sessions/{EMPTY}/report").text
    assert "No Suspicious/Irregular observations" in empty
    assert "Not available" in empty


# --------------------------------------------------------------- real pipeline
def test_real_job_results_are_served_and_match_database(client, _isolated_state):
    response = client.post("/api/v1/jobs", json={
        "source": {"kind": "sample", "ref": "anomaly_clip.mp4"},
        "max_frames": 30})
    assert response.status_code == 202, response.text
    job_id = response.json()["job"]["job_id"]
    job = _wait_for(client, job_id)
    assert job["state"] == "completed", job
    session = job["session_id"]

    overview = client.get(f"/api/v1/sessions/{session}").json()
    db_events = _count(_isolated_state,
                       "SELECT COUNT(*) FROM track_events WHERE session = ?",
                       (session,))
    assert overview["counts"]["observations"] == db_events
    assert overview["counts"]["tracks"] == job["result"]["tracks"]

    summary = client.get(f"/api/v1/sessions/{session}/summary").json()
    assert summary["counts"]["observations"] == db_events
    assert summary["processing"]["frames_processed"] == 30
    assert summary["processing"]["run_stats_available"] is True

    tracks = client.get(f"/api/v1/sessions/{session}/tracks").json()
    assert tracks["total"] == _count(
        _isolated_state,
        "SELECT COUNT(DISTINCT track_id) FROM track_events WHERE session = ?",
        (session,))
    track_id = tracks["tracks"][0]["track_id"]
    observations = client.get(
        f"/api/v1/sessions/{session}/tracks/{track_id}/observations").json()
    assert observations["total"] == _count(
        _isolated_state,
        "SELECT COUNT(*) FROM track_events WHERE session = ? AND track_id = ?",
        (session, track_id))

    trajectory = client.get(
        f"/api/v1/sessions/{session}/tracks/{track_id}/trajectory").json()
    assert trajectory["available"] is True
    assert trajectory["points"]

    anomalies = client.get(f"/api/v1/sessions/{session}/anomalies").json()
    db_anomalies = _count(
        _isolated_state,
        "SELECT COUNT(*) FROM track_events WHERE session = ? AND level != 'Normal'",
        (session,))
    assert anomalies["total"] == db_anomalies
    assert anomalies["total"] > 0
    for anomaly in anomalies["anomalies"]:
        assert anomaly["evidence"]["available"] is True

    media = client.get(f"/api/v1/sessions/{session}/media").json()
    assert media["available"] is True and media["frames"]
    frame = client.get(media["frames"][0]["annotated_url"])
    assert frame.status_code == 200
    assert frame.content.startswith(b"\xff\xd8")

    scene = client.get(f"/api/v1/sessions/{session}/scene").json()
    assert scene["source"] == "run_calibration"
    assert scene["calibration"]["available"] is True
    assert scene["calibration"]["samples"] >= 1

    evaluation = client.get(f"/api/v1/sessions/{session}/evaluation").json()
    assert evaluation["available"] is False and evaluation["metrics"] is None

    exported = client.get(f"/api/v1/sessions/{session}/export/csv")
    assert exported.headers["X-Row-Count"] == str(db_events)
    report = client.get(f"/api/v1/sessions/{session}/report").text
    assert session in report and "Not available" in report


# -------------------------------------------------------------------- OpenAPI
def test_openapi_documents_each_analytics_path_once(client):
    spec = client.get("/openapi.json").json()
    keys = [key for key in spec["paths"]
            if key.startswith("/api/v1/sessions")]
    assert len(keys) == 16
    assert "/sessions" not in spec["paths"]
    for path in keys:
        for operation in spec["paths"][path].values():
            assert operation.get("summary")
            assert operation.get("tags")
    detail = spec["paths"]["/api/v1/sessions/{session_id}"]["get"]
    assert detail["responses"]["200"]["content"]["application/json"][
        "schema"]["$ref"].endswith("SessionDetail")
    frame = spec["paths"][
        "/api/v1/sessions/{session_id}/frames/{frame_number}"]["get"]
    assert "image/jpeg" in frame["responses"]["200"]["content"]
