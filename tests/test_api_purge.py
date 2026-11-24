"""The explicit data purge: what it removes and what it leaves behind."""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from src.api.main import app
from src.api.session_store import SessionArtifactStore, store
from config.config import load_config

TABLES = ("track_events", "track_summaries", "run_stats", "ground_truth",
          "track_points", "calibration_snapshots")


def _seed(db_path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS track_events ("
                     "id INTEGER PRIMARY KEY, ts_utc TEXT, session TEXT,"
                     " frame_idx INTEGER, track_id INTEGER, level TEXT,"
                     " fused_score REAL, rule_score REAL, ml_score REAL,"
                     " scene_score REAL, speed_px_s REAL, direction_deg REAL,"
                     " why TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS track_summaries ("
                     "session TEXT, track_id INTEGER, color TEXT, shape TEXT,"
                     " n_points INTEGER, n_seconds REAL, mean_speed_px_s REAL,"
                     " max_speed_px_s REAL, path_length_px REAL,"
                     " straightness REAL, directions TEXT, first_frame INTEGER,"
                     " last_frame INTEGER)")
        conn.execute("CREATE TABLE IF NOT EXISTS run_stats ("
                     "session TEXT, source TEXT, kind TEXT, synthetic INTEGER,"
                     " frames INTEGER, width INTEGER, height INTEGER, fps REAL,"
                     " wall_s REAL, max_frames INTEGER, started_ts TEXT,"
                     " ended_ts TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS track_points (session TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS ground_truth ("
                     "session TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS calibration_snapshots ("
                     "session TEXT)")
        conn.execute("INSERT INTO track_events (ts_utc, session, frame_idx,"
                     " track_id, level) VALUES ('2026-01-01T00:00:00Z',"
                     " 's1', 1, 1, 'Suspicious')")
        conn.execute("INSERT INTO run_stats (session, source, kind, synthetic,"
                     " frames, width, height, fps, started_ts, ended_ts)"
                     " VALUES ('s1', 'clip.mp4', 'file', 0, 40, 640, 360, 10.0,"
                     " '2026-01-01T00:00:00Z', '2026-01-01T00:00:04Z')")
        conn.execute("INSERT INTO track_points (session) VALUES ('s1')")
        conn.commit()
    finally:
        conn.close()


def test_purge_erases_rows_artifacts_and_uploads(tmp_path, monkeypatch):
    db_path = tmp_path / "analysis.db"
    monkeypatch.setattr(load_config().paths, "db", str(db_path))
    _seed(db_path)

    fresh_store = SessionArtifactStore()
    monkeypatch.setattr("src.api.purge.store", fresh_store, raising=False)
    monkeypatch.setattr("src.api.session_store.store", fresh_store)

    client = TestClient(app)
    response = client.post("/api/v1/admin/reset")
    assert response.status_code == 200, response.text
    purged = response.json()["purged"]
    assert purged["sessions"] == 1
    assert purged["events"] == 1
    assert purged["runs"] == 1
    assert purged["points"] == 1
    assert purged["artifacts"] == 0

    conn = sqlite3.connect(db_path)
    try:
        for table in ("track_events", "run_stats", "track_points"):
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            assert count == 0, table
    finally:
        conn.close()

    # The list endpoint now reports no sessions, so the console starts fresh.
    listing = client.get("/api/v1/sessions")
    assert listing.status_code == 200
    assert listing.json()["total"] == 0


def test_purge_without_a_database_is_a_noop_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(load_config().paths, "db", str(tmp_path / "absent.db"))
    client = TestClient(app)
    response = client.post("/api/v1/admin/reset")
    assert response.status_code == 200
    body = response.json()["purged"]
    assert body["sessions"] == 0
    assert body["events"] == 0


def test_purge_is_also_mirrored_on_the_unversioned_surface():
    client = TestClient(app)
    assert client.post("/admin/reset").status_code == 200
