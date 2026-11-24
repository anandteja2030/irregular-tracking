"""Phase 14.2 - durable trajectories and calibration snapshots.

These tests exercise the real SQLite layer: points and versioned calibration
snapshots are written by `save_session_to_db` and read back through the API
after the process that analysed the session is gone. No trajectory is
reconstructed from event scores.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import threading
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from config.config import load_config
from scripts.run_pipeline import main as cli_main
from src.analysis.calibration import SceneStats
from src.analysis.features import TrajectoryStats
from src.analysis.logger import (
    CALIBRATION_SNAPSHOT_VERSION,
    SCHEMA_VERSION,
    SUPPORTED_CALIBRATION_SNAPSHOT_VERSIONS,
    ResultLogger,
)
from src.analysis.snapshot_validation import (
    MAX_CALIBRATION_SAMPLES,
    MAX_CALIBRATION_TRACKS,
    MAX_OBSERVED_SECONDS,
    MAX_SPEED_PX_S,
)
from src.api import repository as repo
from src.api.main import app
from src.core.analysis_service import (
    OBS_COLS,
    TRACK_COLS,
    SessionResult,
    save_session_to_db,
)

ROOT = Path(__file__).resolve().parents[1]
CLI_SAMPLE = ROOT / "samples" / "anomaly_clip.mp4"


@pytest.fixture()
def db(tmp_path, monkeypatch):
    cfg = load_config()
    original = cfg.paths.db
    cfg.paths.db = tmp_path / "phase14b.db"
    try:
        yield cfg.paths.db
    finally:
        cfg.paths.db = original


@pytest.fixture()
def client(db):
    with TestClient(app) as test_client:
        yield test_client


def scene(ready: bool = True) -> SceneStats:
    return SceneStats(
        ready=ready, n_samples=8, n_tracks=2, observed_seconds=0.8,
        speed_p10=10.0, speed_p50=20.0, speed_p90=30.0,
        speed_mean=20.0, speed_std=5.0,
        direction_hist={"E": 0.75, "W": 0.25},
        dominant_directions=["E"], moving_fraction=0.9,
    )


def make_result(session: str, *, frames: int = 4, scene_stats=None,
                with_coords: bool = True) -> SessionResult:
    rows = []
    for frame in range(frames):
        for track in (0, 1):
            rows.append({
                "frame": frame, "ts_s": frame / 10.0, "track_id": track,
                "color": "red" if track == 0 else "green", "shape": "circle",
                "level": "Normal", "fused_score": 0.0, "rule_score": 0.0,
                "ml_score": 0.0, "scene_score": 0.0,
                "speed_px_s": 20.0, "direction_deg": 0.0,
                "cx": (100.0 + frame * 5 + track) if with_coords else None,
                "cy": (50.0 + frame * 3) if with_coords else None,
                "zone": None, "zone_dwell_s": None, "rules_json": "[]",
                "ml_note": None, "scene_note": None, "why": "",
            })
    obs = pd.DataFrame(rows, columns=OBS_COLS)
    tracks = pd.DataFrame([
        {"track_id": track, "color": "red", "shape": "circle",
         "first_frame": 0, "last_frame": max(frames - 1, 0),
         "duration_s": 0.4, "n_obs": frames, "mean_speed_px_s": 20.0,
         "max_speed_px_s": 20.0, "path_length_px": 15.0, "straightness": 1.0,
         "start_x": 100.0, "start_y": 50.0, "end_x": 115.0, "end_y": 59.0,
         "directions": [], "n_events": 0, "worst_level": "Normal"}
        for track in (0, 1)
    ], columns=TRACK_COLS)
    return SessionResult(
        session=session, source_label="sample: synthetic.mp4",
        source_path="/tmp/synthetic.mp4", source_kind="sample",
        is_synthetic=True, started_ts="2026-11-09T00:00:00+00:00",
        ended_ts="2026-11-09T00:00:04+00:00", wall_s=1.5, fps=10.0,
        frame_width=640, frame_height=360, frames_available=frames,
        frames_processed=frames, max_frames=None, previews=[],
        obs=obs, tracks=tracks, track_points={}, scene=scene_stats,
        summaries=[], error=None,
    )


def _point_rows(db_path) -> list[tuple]:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(
            "SELECT track_id, frame_idx, x, y FROM track_points"
            " ORDER BY track_id, frame_idx").fetchall()
    finally:
        conn.close()


def _summary(*, color: str = "red") -> dict:
    """One real-shape track summary for exercising the summary table."""
    return {
        "stats": TrajectoryStats(
            track_id=0, n_points=4, n_seconds=0.3,
            mean_speed_px_s=20.0, max_speed_px_s=20.0,
            path_length_px=15.0, net_displacement_px=15.0,
            straightness=1.0, direction_hist={"E": 4}, dwell_seconds=0.3,
            start=(100.0, 50.0), end=(115.0, 59.0),
            bbox_extent=(15.0, 9.0)),
        "color": color, "shape": "circle",
        "first_frame": 0, "last_frame": 3,
    }


def _seed_atomic_pair() -> tuple[SessionResult, SessionResult]:
    """Save a complete old session, then prepare a different replacement."""
    old = make_result("atomic_target", scene_stats=scene())
    old.summaries = [_summary(color="red")]
    old.source_label = "old source"
    save_session_to_db(old)

    new = make_result("atomic_target", frames=6, scene_stats=scene())
    new.obs["cx"] = new.obs["cx"] + 1000.0
    new.obs["cy"] = new.obs["cy"] + 500.0
    new.summaries = [_summary(color="blue")]
    new.source_label = "new source"
    new.ended_ts = "2026-11-10T00:00:06+00:00"
    return old, new


def _session_state(db_path, session: str) -> dict:
    """Every persisted value for one session, independent of the API."""
    conn = sqlite3.connect(db_path)
    try:
        return {
            "events": conn.execute(
                "SELECT frame_idx, track_id, level, fused_score, rule_score,"
                " ml_score, scene_score, speed_px_s, direction_deg, why"
                " FROM track_events WHERE session = ?"
                " ORDER BY frame_idx, track_id", (session,)).fetchall(),
            "summaries": conn.execute(
                "SELECT track_id, color, shape, n_points, n_seconds,"
                " mean_speed_px_s, max_speed_px_s, path_length_px,"
                " straightness, directions, first_frame, last_frame"
                " FROM track_summaries WHERE session = ?"
                " ORDER BY track_id", (session,)).fetchall(),
            "run": conn.execute(
                "SELECT session, source, kind, synthetic, frames, width,"
                " height, fps, wall_s, max_frames, started_ts, ended_ts"
                " FROM run_stats WHERE session = ?", (session,)).fetchone(),
            "points": conn.execute(
                "SELECT track_id, frame_idx, ts_s, x, y, level, speed_px_s,"
                " direction_deg FROM track_points WHERE session = ?"
                " ORDER BY track_id, frame_idx", (session,)).fetchall(),
            "calibration": conn.execute(
                "SELECT schema_version, captured_ts, payload"
                " FROM calibration_snapshots WHERE session = ?",
                (session,)).fetchone(),
        }
    finally:
        conn.close()


def test_points_and_snapshot_are_persisted(db, client):
    result = make_result("durable_a", scene_stats=scene())
    counts = save_session_to_db(result)

    assert counts == {"events": 8, "summaries": 0, "points": 8,
                      "calibration": True}
    rows = _point_rows(db)
    assert len(rows) == 8
    assert rows[:4] == [(0, 0, 100.0, 50.0), (0, 1, 105.0, 53.0),
                        (0, 2, 110.0, 56.0), (0, 3, 115.0, 59.0)]

    trajectory = client.get(
        "/api/v1/sessions/durable_a/tracks/0/trajectory").json()
    assert trajectory["available"] is True
    assert trajectory["source"] == "persisted"
    assert [point["frame"] for point in trajectory["points"]] == [0, 1, 2, 3]
    assert [point["x"] for point in trajectory["points"]] == pytest.approx(
        [100.0, 105.0, 110.0, 115.0])
    assert [point["y"] for point in trajectory["points"]] == pytest.approx(
        [50.0, 53.0, 56.0, 59.0])

    body = client.get("/api/v1/sessions/durable_a/scene").json()
    calibration = body["calibration"]
    assert body["source"] == "run_calibration"
    assert calibration["available"] is True
    assert calibration["persisted"] is True
    assert calibration["snapshot_version"] == CALIBRATION_SNAPSHOT_VERSION
    assert CALIBRATION_SNAPSHOT_VERSION in SUPPORTED_CALIBRATION_SNAPSHOT_VERSIONS
    assert calibration["captured_ts"] == "2026-11-09T00:00:04+00:00"
    assert calibration["samples"] == 8 and calibration["tracks"] == 2
    assert calibration["observed_seconds"] == 0.8
    assert calibration["parameters"] == {
        "warmup_tracks": load_config().calibration.warmup_tracks,
        "tracks_seconds": load_config().calibration.tracks_seconds,
        "min_samples": load_config().calibration.min_samples,
        "direction_bin_deg": load_config().calibration.direction_bin_deg,
    }
    assert body["speed_baseline"]["source"] == "run_calibration"
    assert body["directions"]["dominant"] == ["E"]


def test_resaving_does_not_duplicate_points_or_snapshots(db):
    result = make_result("durable_retry", scene_stats=scene())
    save_session_to_db(result)
    save_session_to_db(result)
    save_session_to_db(result)

    conn = sqlite3.connect(db)
    try:
        points = conn.execute(
            "SELECT COUNT(*) FROM track_points WHERE session = ?",
            ("durable_retry",)).fetchone()[0]
        snapshots = conn.execute(
            "SELECT COUNT(*) FROM calibration_snapshots WHERE session = ?",
            ("durable_retry",)).fetchone()[0]
        events = conn.execute(
            "SELECT COUNT(*) FROM track_events WHERE session = ?",
            ("durable_retry",)).fetchone()[0]
    finally:
        conn.close()
    assert points == 8
    assert snapshots == 1
    assert events == 8


def test_historical_values_match_across_a_process_restart(db):
    save_session_to_db(make_result("durable_restart", scene_stats=scene()))

    with TestClient(app) as first:
        before_trajectory = first.get(
            "/api/v1/sessions/durable_restart/tracks/1/trajectory").json()
        before_scene = first.get(
            "/api/v1/sessions/durable_restart/scene").json()

    # A fresh process keeps no in-process artifacts; only SQLite survives.
    with TestClient(app) as second:
        after_trajectory = second.get(
            "/api/v1/sessions/durable_restart/tracks/1/trajectory").json()
        after_scene = second.get(
            "/api/v1/sessions/durable_restart/scene").json()
        detail = second.get("/api/v1/sessions/durable_restart").json()

    assert after_trajectory == before_trajectory
    assert after_scene == before_scene
    assert after_trajectory["source"] == "persisted"
    assert after_scene["calibration"]["persisted"] is True
    assert detail["artifacts"]["trajectories"] is True
    assert detail["artifacts"]["scene_calibration"] is True
    assert detail["artifacts"]["retained"] is False
    assert not any("were not persisted" in note for note in detail["limitations"])


def test_multiple_sessions_keep_their_own_points(db, client):
    save_session_to_db(make_result("multi_a", scene_stats=scene()))
    shifted = make_result("multi_b", scene_stats=scene())
    shifted.obs["cx"] = shifted.obs["cx"] + 1000.0
    save_session_to_db(shifted)
    shifted.obs["cx"] = shifted.obs["cx"] + 1000.0
    save_session_to_db(shifted)

    first = client.get(
        "/api/v1/sessions/multi_a/tracks/0/trajectory").json()["points"]
    second = client.get(
        "/api/v1/sessions/multi_b/tracks/0/trajectory").json()["points"]
    assert [point["x"] for point in first] == pytest.approx(
        [100.0, 105.0, 110.0, 115.0])
    assert [point["x"] for point in second] == pytest.approx(
        [2100.0, 2105.0, 2110.0, 2115.0])


def test_session_without_coordinates_stores_no_points(db, client):
    save_session_to_db(make_result("no_coords", with_coords=False,
                                   scene_stats=scene()))

    assert _point_rows(db) == []
    trajectory = client.get(
        "/api/v1/sessions/no_coords/tracks/0/trajectory").json()
    assert trajectory["available"] is False
    assert trajectory["points"] == []
    assert trajectory["source"] is None
    assert trajectory["reason"]
    body = client.get("/api/v1/sessions/no_coords/scene").json()
    assert body["calibration"]["persisted"] is True


def test_empty_video_is_supported_without_points(db, client):
    result = make_result("empty_video", frames=0, scene_stats=None)
    counts = save_session_to_db(result)

    assert counts == {"events": 0, "summaries": 0, "points": 0,
                      "calibration": False}
    assert client.get("/api/v1/sessions/empty_video/tracks").json()["total"] == 0
    body = client.get("/api/v1/sessions/empty_video/scene").json()
    assert body["source"] == "derived_observations"
    assert body["calibration"]["available"] is False
    assert body["calibration"]["persisted"] is False
    assert client.get(
        "/api/v1/sessions/empty_video/tracks/0/trajectory").status_code == 404


def test_legacy_session_without_snapshot_is_honest(db, client):
    save_session_to_db(make_result("legacy_no_snapshot", scene_stats=None))

    body = client.get("/api/v1/sessions/legacy_no_snapshot/scene").json()
    assert body["source"] == "derived_observations"
    assert body["calibration"]["available"] is False
    assert body["calibration"]["persisted"] is False
    assert body["calibration"]["reason"]
    assert body["speed_baseline"]["source"] == "derived_event_observations"

    detail = client.get("/api/v1/sessions/legacy_no_snapshot").json()
    assert detail["artifacts"]["trajectories"] is True
    assert detail["artifacts"]["scene_calibration"] is False
    limitations = " ".join(detail["limitations"])
    assert "calibration snapshot" in limitations
    assert "were not persisted" not in limitations


def test_legacy_database_migrates_and_keeps_rows(db):
    conn = sqlite3.connect(db)
    conn.executescript("""
    CREATE TABLE track_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_utc TEXT NOT NULL,
        session TEXT,
        frame_idx INTEGER NOT NULL,
        track_id INTEGER NOT NULL,
        level TEXT NOT NULL,
        fused_score REAL NOT NULL,
        rule_score REAL,
        ml_score REAL,
        scene_score REAL,
        speed_px_s REAL,
        direction_deg REAL,
        why TEXT
    );
    CREATE TABLE track_summaries (
        track_id INTEGER NOT NULL,
        session TEXT,
        color TEXT,
        shape TEXT,
        n_points INTEGER,
        n_seconds REAL,
        mean_speed_px_s REAL,
        max_speed_px_s REAL,
        path_length_px REAL,
        straightness REAL,
        directions TEXT,
        first_frame INTEGER,
        last_frame INTEGER,
        PRIMARY KEY (track_id)
    );
    CREATE TABLE run_stats (
        session TEXT PRIMARY KEY, source TEXT, kind TEXT, synthetic INTEGER,
        frames INTEGER, width INTEGER, height INTEGER, fps REAL, wall_s REAL,
        max_frames INTEGER, started_ts TEXT, ended_ts TEXT
    );
    CREATE TABLE ground_truth (
        session TEXT NOT NULL, frame_idx INTEGER NOT NULL,
        track_id INTEGER NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY (session, frame_idx, track_id)
    );
    INSERT INTO run_stats(session, source) VALUES ('legacy', 'sample');
    INSERT INTO track_summaries(track_id, session, color, shape, n_points)
        VALUES (0, 'legacy', 'red', 'circle', 4);
    INSERT INTO track_events(ts_utc, session, frame_idx, track_id, level,
        fused_score) VALUES ('2026-01-01T00:00:00+00:00', 'legacy', 0, 0,
        'Normal', 0.0);
    """)
    conn.commit()
    conn.close()

    save_session_to_db(make_result("migrated", scene_stats=scene()))

    conn = sqlite3.connect(db)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        legacy_events = conn.execute(
            "SELECT COUNT(*) FROM track_events WHERE session = 'legacy'"
        ).fetchone()[0]
        legacy_summary = conn.execute(
            "SELECT session, n_points FROM track_summaries WHERE track_id = 0"
        ).fetchone()
        new_points = conn.execute(
            "SELECT COUNT(*) FROM track_points WHERE session = 'migrated'"
        ).fetchone()[0]
        new_snapshot = conn.execute(
            "SELECT COUNT(*) FROM calibration_snapshots WHERE session = 'migrated'"
        ).fetchone()[0]
    finally:
        conn.close()

    assert version == SCHEMA_VERSION
    assert {"track_points", "calibration_snapshots"} <= tables
    assert legacy_events == 1
    assert legacy_summary == ("legacy", 4)
    assert new_points == 8
    assert new_snapshot == 1


def test_failed_point_batch_rolls_back(db):
    save_session_to_db(make_result("rollback", scene_stats=scene()))
    log = ResultLogger(db, session="rollback")
    try:
        with pytest.raises(sqlite3.Error):
            log.log_track_points("rollback", [
                {"track_id": 9, "frame": 0, "ts_s": 0.0, "x": 1.0, "y": 2.0},
                {"track_id": 9, "frame": 1, "ts_s": 0.1, "x": 3.0,
                 "y": 4.0, "level": ["not-a-scalar"]},
            ])
        after_failure = log.session_points("rollback")
    finally:
        log.close()

    # Neither the failing row nor the earlier row of the same batch survives.
    assert [row["track_id"] for row in after_failure] == [0, 0, 0, 0,
                                                          1, 1, 1, 1]
    assert _point_rows(db) == [
        (0, 0, 100.0, 50.0), (0, 1, 105.0, 53.0),
        (0, 2, 110.0, 56.0), (0, 3, 115.0, 59.0),
        (1, 0, 101.0, 50.0), (1, 1, 106.0, 53.0),
        (1, 2, 111.0, 56.0), (1, 3, 116.0, 59.0),
    ]


# ---------------------------------------------------- atomic session save
def _assert_failed_save_preserves(db, monkeypatch, result, method_name,
                                 replacement) -> None:
    before = _session_state(db, result.session)
    monkeypatch.setattr(ResultLogger, method_name, replacement)
    with pytest.raises(sqlite3.OperationalError, match="injected"):
        save_session_to_db(result)
    assert _session_state(db, result.session) == before


def test_successful_save_replaces_all_session_rows(db):
    _, new = _seed_atomic_pair()

    counts = save_session_to_db(new)

    assert counts == {"events": 12, "summaries": 1, "points": 12,
                      "calibration": True}
    state = _session_state(db, "atomic_target")
    assert len(state["events"]) == 12
    assert state["summaries"][0][1] == "blue"
    assert state["run"][1] == "new source"
    assert len(state["points"]) == 12
    assert state["points"][0][3] == pytest.approx(1100.0)
    assert state["calibration"][1] == "2026-11-10T00:00:06+00:00"


def test_failed_first_save_leaves_no_partial_session(db, monkeypatch):
    new = make_result("first_save", frames=4, scene_stats=scene())
    new.summaries = [_summary()]

    def fail(self, session, points):
        raise sqlite3.OperationalError("injected during first save")

    monkeypatch.setattr(ResultLogger, "log_track_points", fail)
    with pytest.raises(sqlite3.OperationalError, match="injected"):
        save_session_to_db(new)

    assert _session_state(db, "first_save") == {
        "events": [], "summaries": [], "run": None, "points": [],
        "calibration": None,
    }


def test_failed_save_after_clearing_events_restores_previous_session(
        db, monkeypatch):
    _, new = _seed_atomic_pair()

    def fail(self, session):
        raise sqlite3.OperationalError("injected after clearing events")

    _assert_failed_save_preserves(
        db, monkeypatch, new, "clear_session_summaries", fail)


def test_failed_save_after_writing_events_restores_previous_session(
        db, monkeypatch):
    _, new = _seed_atomic_pair()
    new.summaries = []                   # fail before any summary is written

    def fail(self, info):
        raise sqlite3.OperationalError("injected after writing events")

    _assert_failed_save_preserves(db, monkeypatch, new, "log_run", fail)


def test_failed_save_after_writing_summaries_restores_previous_session(
        db, monkeypatch):
    _, new = _seed_atomic_pair()

    def fail(self, info):
        raise sqlite3.OperationalError("injected after writing summaries")

    _assert_failed_save_preserves(db, monkeypatch, new, "log_run", fail)


def test_failed_save_after_writing_run_stats_restores_previous_session(
        db, monkeypatch):
    _, new = _seed_atomic_pair()

    def fail(self, session, points):
        raise sqlite3.OperationalError("injected after writing run stats")

    _assert_failed_save_preserves(
        db, monkeypatch, new, "log_track_points", fail)


def test_failed_save_during_trajectory_insertion_restores_previous_session(
        db, monkeypatch):
    _, new = _seed_atomic_pair()
    original = ResultLogger.log_track_points

    def fail_after_partial_batch(self, session, points):
        original(self, session, points[:2])
        raise sqlite3.OperationalError("injected during trajectory insertion")

    _assert_failed_save_preserves(
        db, monkeypatch, new, "log_track_points", fail_after_partial_batch)


def test_failed_save_during_calibration_insertion_restores_previous_session(
        db, monkeypatch):
    _, new = _seed_atomic_pair()
    original = ResultLogger.log_calibration

    def fail_after_snapshot(self, session, snapshot):
        original(self, session, snapshot)
        raise sqlite3.OperationalError("injected during calibration insertion")

    _assert_failed_save_preserves(
        db, monkeypatch, new, "log_calibration", fail_after_snapshot)


def test_nested_transactions_do_not_commit_early(db):
    _seed_atomic_pair()
    before = _session_state(db, "atomic_target")
    log = ResultLogger(db, session="atomic_target")
    try:
        with pytest.raises(RuntimeError, match="stop"):
            with log.transaction():
                log.clear_session_events("atomic_target")
                with log.transaction():
                    log.log_event(0, {"track_id": 0, "level": "Normal"})
                raise RuntimeError("stop")
    finally:
        log.close()

    assert _session_state(db, "atomic_target") == before


def test_saving_one_session_does_not_change_another(db):
    other = make_result("other_session", scene_stats=scene())
    other.summaries = [_summary(color="green")]
    save_session_to_db(other)
    other_before = _session_state(db, "other_session")

    _, new = _seed_atomic_pair()
    save_session_to_db(new)

    assert _session_state(db, "other_session") == other_before


def test_reads_during_a_rewrite_stay_consistent(db):
    result = make_result("concurrent", scene_stats=scene())
    save_session_to_db(result)
    expected = _point_rows(db)

    stop = threading.Event()
    failures: list[str] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                rows = repo.trajectory_points("concurrent", 0)
                # A committed write is either fully absent or fully present.
                assert len(rows) in (0, 4), f"partial read of {len(rows)} points"
            except Exception as exc:  # noqa: BLE001 - reported below
                failures.append(f"{type(exc).__name__}: {exc}")
                return

    readers = [threading.Thread(target=reader) for _ in range(3)]
    for thread in readers:
        thread.start()
    try:
        save_session_to_db(result)
    finally:
        stop.set()
        for thread in readers:
            thread.join(timeout=5)

    assert failures == []
    assert _point_rows(db) == expected
    assert sum(thread.is_alive() for thread in readers) == 0


def test_points_for_an_unknown_session_are_rejected(db):
    log = ResultLogger(db)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            log.log_track_points("ghost", [
                {"track_id": 0, "frame": 0, "ts_s": 0.0, "x": 1.0, "y": 2.0},
            ])
        assert log.session_points("ghost") == []
    finally:
        log.close()


# --------------------------------------------------- snapshot version checks
def _set_snapshot(db_path, session: str, *, version=..., payload=None,
                  captured_ts=...) -> None:
    conn = sqlite3.connect(db_path)
    try:
        if payload is not None:
            conn.execute(
                "UPDATE calibration_snapshots SET payload = ? WHERE session = ?",
                (payload, session))
        if version is not ...:
            conn.execute(
                "UPDATE calibration_snapshots SET schema_version = ?"
                " WHERE session = ?", (version, session))
        if captured_ts is not ...:
            conn.execute(
                "UPDATE calibration_snapshots SET captured_ts = ?"
                " WHERE session = ?", (captured_ts, session))
        conn.commit()
    finally:
        conn.close()


def _stored_snapshot(db_path, session: str) -> dict:
    conn = sqlite3.connect(db_path)
    try:
        payload = conn.execute(
            "SELECT payload FROM calibration_snapshots WHERE session = ?",
            (session,)).fetchone()[0]
    finally:
        conn.close()
    return json.loads(payload)


def _assert_snapshot_unavailable(client, session: str, needle: str) -> None:
    scene_body = client.get(f"/api/v1/sessions/{session}/scene").json()
    calibration = scene_body["calibration"]
    assert calibration["available"] is False
    assert calibration["persisted"] is False
    assert calibration["snapshot_version"] is None
    assert needle in calibration["reason"]
    assert scene_body["source"] == "derived_observations"

    detail = client.get(f"/api/v1/sessions/{session}").json()
    assert detail["artifacts"]["scene_calibration"] is False
    assert any(needle in note for note in detail["limitations"])


def test_deeply_nested_snapshot_payload_is_not_interpreted(db, client):
    save_session_to_db(make_result("deep_payload", scene_stats=scene()))
    deep = ('{"calibration":' + '[' * 10_000 + '0' + ']' * 10_000
            + ',"parameters":{}}')
    _set_snapshot(db, "deep_payload", payload=deep)

    _assert_snapshot_unavailable(client, "deep_payload", "malformed JSON")


def test_unknown_snapshot_version_is_not_interpreted(db, client):
    save_session_to_db(make_result("future_snapshot", scene_stats=scene()))
    _set_snapshot(db, "future_snapshot", version=999)

    body = client.get("/api/v1/sessions/future_snapshot/scene").json()
    calibration = body["calibration"]
    assert calibration["available"] is False
    assert calibration["persisted"] is False
    assert calibration["snapshot_version"] is None
    assert "999" in calibration["reason"]
    assert "not supported" in calibration["reason"]
    assert body["source"] == "derived_observations"
    assert body["speed_baseline"]["source"] == "derived_event_observations"


@pytest.mark.parametrize("version", [1.5, float("inf")])
def test_unreadable_snapshot_version_is_not_interpreted(db, client, version):
    save_session_to_db(make_result("bad_version", scene_stats=scene()))
    _set_snapshot(db, "bad_version", version=version)

    _assert_snapshot_unavailable(client, "bad_version", "unreadable")


def test_missing_snapshot_version_is_not_interpreted(db, client):
    save_session_to_db(make_result("missing_version", scene_stats=scene()))
    stale = json.dumps({"calibration": {"ready": True, "n_samples": 8},
                        "parameters": {}})
    conn = sqlite3.connect(db)
    try:
        # Simulate an older/foreign payload whose version column was never set.
        conn.execute("DROP TABLE calibration_snapshots")
        conn.execute(
            "CREATE TABLE calibration_snapshots ("
            "session TEXT PRIMARY KEY, schema_version INTEGER,"
            " captured_ts TEXT NOT NULL, payload TEXT NOT NULL)")
        conn.execute(
            "INSERT INTO calibration_snapshots"
            " (session, schema_version, captured_ts, payload)"
            " VALUES (?, NULL, ?, ?)",
            ("missing_version", "2026-11-09T00:00:04+00:00", stale))
        conn.commit()
    finally:
        conn.close()

    body = client.get("/api/v1/sessions/missing_version/scene").json()
    calibration = body["calibration"]
    assert calibration["available"] is False
    assert calibration["persisted"] is False
    assert "no schema version" in calibration["reason"]
    assert body["source"] == "derived_observations"


def test_malformed_snapshot_payload_is_not_interpreted(db, client):
    save_session_to_db(make_result("broken_payload", scene_stats=scene()))
    _set_snapshot(db, "broken_payload", payload="{not valid json")

    body = client.get("/api/v1/sessions/broken_payload/scene").json()
    calibration = body["calibration"]
    assert calibration["available"] is False
    assert calibration["persisted"] is False
    assert "malformed JSON" in calibration["reason"]
    assert body["source"] == "derived_observations"


def test_snapshot_parameters_must_be_a_dictionary(db, client):
    save_session_to_db(make_result("bad_parameters", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_parameters")
    payload["parameters"] = ["not", "a", "dict"]
    _set_snapshot(db, "bad_parameters", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_parameters", "parameters")


def test_snapshot_missing_numeric_field_is_not_interpreted(db, client):
    save_session_to_db(make_result("missing_numeric", scene_stats=scene()))
    payload = _stored_snapshot(db, "missing_numeric")
    payload["calibration"].pop("speed_p50")
    _set_snapshot(db, "missing_numeric", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "missing_numeric", "missing required")


def test_snapshot_wrong_numeric_type_is_not_interpreted(db, client):
    save_session_to_db(make_result("wrong_numeric", scene_stats=scene()))
    payload = _stored_snapshot(db, "wrong_numeric")
    payload["calibration"]["n_samples"] = "eight"
    _set_snapshot(db, "wrong_numeric", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "wrong_numeric", "n_samples")


def test_snapshot_malformed_histogram_is_not_interpreted(db, client):
    save_session_to_db(make_result("bad_histogram", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_histogram")
    payload["calibration"]["direction_hist"] = ["E", "W"]
    _set_snapshot(db, "bad_histogram", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_histogram", "histogram")


def test_snapshot_histogram_boundary_values_are_accepted(db, client):
    save_session_to_db(make_result("histogram_bounds", scene_stats=scene()))
    payload = _stored_snapshot(db, "histogram_bounds")
    payload["calibration"]["direction_hist"] = {"E": 0.0, "W": 1.0}
    payload["calibration"]["dominant_directions"] = ["W"]
    _set_snapshot(db, "histogram_bounds", payload=json.dumps(payload))

    snapshot, problem = repo.read_calibration_snapshot("histogram_bounds")
    assert problem is None
    assert snapshot is not None

    scene_body = client.get("/api/v1/sessions/histogram_bounds/scene").json()
    assert scene_body["calibration"]["available"] is True
    assert scene_body["directions"]["histogram"] == {"E": 0.0, "W": 1.0}


def test_snapshot_empty_histogram_is_accepted(db, client):
    save_session_to_db(make_result("empty_histogram", scene_stats=scene()))
    payload = _stored_snapshot(db, "empty_histogram")
    payload["calibration"]["direction_hist"] = {}
    payload["calibration"]["dominant_directions"] = []
    _set_snapshot(db, "empty_histogram", payload=json.dumps(payload))

    snapshot, problem = repo.read_calibration_snapshot("empty_histogram")
    assert problem is None
    assert snapshot is not None

    scene_body = client.get("/api/v1/sessions/empty_histogram/scene").json()
    assert scene_body["calibration"]["available"] is True
    assert scene_body["directions"]["histogram"] == {}


@pytest.mark.parametrize("histogram", [
    {"E": -0.1},
    {"E": 1.1},
    {"E": float("nan")},
    {"E": float("inf")},
    {"E": True},
    {"E": "0.5"},
    {"X": 0.5},
    {"E": 1.0, "W": 1.0},
])
def test_snapshot_invalid_histogram_values_are_rejected(db, client,
                                                        histogram):
    save_session_to_db(make_result("bad_histogram_value", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_histogram_value")
    payload["calibration"]["direction_hist"] = histogram
    _set_snapshot(db, "bad_histogram_value", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_histogram_value", "histogram")


@pytest.mark.parametrize("ready", [1, "true", None])
def test_snapshot_ready_must_be_boolean(db, client, ready):
    save_session_to_db(make_result("bad_ready", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_ready")
    payload["calibration"]["ready"] = ready
    _set_snapshot(db, "bad_ready", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_ready", "ready")


@pytest.mark.parametrize("field", [
    "n_samples", "n_tracks", "observed_seconds", "speed_p10",
    "speed_mean", "speed_std", "moving_fraction",
])
def test_snapshot_negative_numeric_values_are_rejected(db, client, field):
    save_session_to_db(make_result("bad_negative", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_negative")
    payload["calibration"][field] = -1
    _set_snapshot(db, "bad_negative", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_negative", field)


@pytest.mark.parametrize("field,value", [
    ("observed_seconds", float("nan")),
    ("speed_p50", float("inf")),
    ("speed_p90", float("-inf")),
])
def test_snapshot_non_finite_numeric_values_are_rejected(db, client, field,
                                                         value):
    save_session_to_db(make_result("bad_nonfinite", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_nonfinite")
    payload["calibration"][field] = value
    _set_snapshot(db, "bad_nonfinite", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_nonfinite", field)


@pytest.mark.parametrize("field,value", [
    ("n_samples", 10**12),
    ("n_tracks", 10**12),
    ("observed_seconds", 1e12),
    ("speed_p10", 1e12),
    ("moving_fraction", 1.1),
])
def test_snapshot_excessive_finite_numeric_values_are_rejected(db, client,
                                                               field, value):
    save_session_to_db(make_result("bad_excessive", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_excessive")
    payload["calibration"][field] = value
    _set_snapshot(db, "bad_excessive", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_excessive", field)


def test_snapshot_exact_upper_numeric_boundaries_are_accepted(db, client):
    save_session_to_db(make_result("upper_bounds", scene_stats=scene()))
    payload = _stored_snapshot(db, "upper_bounds")
    calibration = payload["calibration"]
    calibration.update({
        "n_samples": MAX_CALIBRATION_SAMPLES,
        "n_tracks": MAX_CALIBRATION_TRACKS,
        "observed_seconds": MAX_OBSERVED_SECONDS,
        "speed_p10": MAX_SPEED_PX_S,
        "speed_p50": MAX_SPEED_PX_S,
        "speed_p90": MAX_SPEED_PX_S,
        "speed_mean": MAX_SPEED_PX_S,
        "speed_std": MAX_SPEED_PX_S,
        "direction_hist": {"E": 0.0, "W": 1.0},
        "dominant_directions": ["W"],
        "moving_fraction": 1.0,
    })
    payload["parameters"] = {
        "warmup_tracks": 100,
        "tracks_seconds": 3600.0,
        "min_samples": 100_000,
        "direction_bin_deg": 180.0,
    }
    _set_snapshot(db, "upper_bounds", payload=json.dumps(payload))

    snapshot, problem = repo.read_calibration_snapshot("upper_bounds")
    assert problem is None
    assert snapshot is not None

    scene_body = client.get("/api/v1/sessions/upper_bounds/scene").json()
    body = scene_body["calibration"]
    assert body["available"] is True
    assert body["samples"] == MAX_CALIBRATION_SAMPLES
    assert body["tracks"] == MAX_CALIBRATION_TRACKS
    assert body["observed_seconds"] == MAX_OBSERVED_SECONDS
    assert body["parameters"] == payload["parameters"]

    detail = client.get("/api/v1/sessions/upper_bounds").json()
    assert detail["artifacts"]["scene_calibration"] is True


@pytest.mark.parametrize("dominant", [
    ["E", 1],
    ["E", "N", "W"],
    ["E", "E"],
    ["E", "X"],
])
def test_snapshot_malformed_dominant_directions_are_rejected(db, client,
                                                            dominant):
    save_session_to_db(make_result("bad_dominant", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_dominant")
    payload["calibration"]["dominant_directions"] = dominant
    _set_snapshot(db, "bad_dominant", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_dominant", "dominant")


@pytest.mark.parametrize("key", [
    "warmup_tracks", "tracks_seconds", "min_samples", "direction_bin_deg",
])
def test_snapshot_parameters_require_known_keys(db, client, key):
    save_session_to_db(make_result("missing_parameter", scene_stats=scene()))
    payload = _stored_snapshot(db, "missing_parameter")
    payload["parameters"].pop(key)
    _set_snapshot(db, "missing_parameter", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "missing_parameter", key)


def test_snapshot_parameters_reject_unexpected_keys(db, client):
    save_session_to_db(make_result("extra_parameter", scene_stats=scene()))
    payload = _stored_snapshot(db, "extra_parameter")
    payload["parameters"]["future_flag"] = 1
    _set_snapshot(db, "extra_parameter", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "extra_parameter", "unexpected")


def test_snapshot_empty_parameters_are_rejected(db, client):
    save_session_to_db(make_result("empty_parameters", scene_stats=scene()))
    payload = _stored_snapshot(db, "empty_parameters")
    payload["parameters"] = {}
    _set_snapshot(db, "empty_parameters", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "empty_parameters", "parameters")


@pytest.mark.parametrize("key,value", [
    ("warmup_tracks", 0),
    ("warmup_tracks", 101),
    ("warmup_tracks", True),
    ("warmup_tracks", 2.0),
    ("warmup_tracks", "2"),
    ("tracks_seconds", -1),
    ("tracks_seconds", 3600.1),
    ("tracks_seconds", True),
    ("tracks_seconds", "12"),
    ("min_samples", 0),
    ("min_samples", 100_001),
    ("min_samples", 30.0),
    ("min_samples", False),
    ("direction_bin_deg", 0),
    ("direction_bin_deg", 180.1),
    ("direction_bin_deg", True),
    ("direction_bin_deg", "30"),
])
def test_snapshot_parameter_ranges_and_types_are_validated(db, client, key,
                                                            value):
    save_session_to_db(make_result("bad_parameter", scene_stats=scene()))
    payload = _stored_snapshot(db, "bad_parameter")
    payload["parameters"][key] = value
    _set_snapshot(db, "bad_parameter", payload=json.dumps(payload))

    _assert_snapshot_unavailable(client, "bad_parameter", key)


@pytest.mark.parametrize("captured_ts", [
    "not-a-timestamp",
    "2026-11-09T00:00:04",       # ISO datetime without a timezone
    "",
])
def test_snapshot_captured_timestamp_must_be_valid_iso(db, client,
                                                       captured_ts):
    save_session_to_db(make_result("bad_timestamp", scene_stats=scene()))
    _set_snapshot(db, "bad_timestamp", captured_ts=captured_ts)

    _assert_snapshot_unavailable(client, "bad_timestamp", "captured_ts")


@pytest.mark.parametrize("captured_ts", [
    "2026-11-09T00:00:04Z",
    "2026-11-09T00:00:04-05:00",
    "2026-11-09T00:00:04+05:30",
])
def test_snapshot_timezone_offset_timestamps_are_accepted(db, client,
                                                          captured_ts):
    save_session_to_db(make_result("offset_timestamp", scene_stats=scene()))
    _set_snapshot(db, "offset_timestamp", captured_ts=captured_ts)

    snapshot, problem = repo.read_calibration_snapshot("offset_timestamp")
    assert problem is None
    assert snapshot is not None
    assert snapshot["captured_ts"] == captured_ts

    scene_body = client.get("/api/v1/sessions/offset_timestamp/scene").json()
    assert scene_body["calibration"]["available"] is True
    assert scene_body["calibration"]["persisted"] is True
    assert scene_body["calibration"]["captured_ts"] == captured_ts

    detail = client.get("/api/v1/sessions/offset_timestamp").json()
    assert detail["artifacts"]["scene_calibration"] is True

    log = ResultLogger(db)
    try:
        assert log.get_calibration("offset_timestamp") == snapshot
    finally:
        log.close()


def test_repository_and_logger_validate_snapshots_consistently(db):
    save_session_to_db(make_result("consistent", scene_stats=scene()))
    log = ResultLogger(db)
    try:
        assert (log.get_calibration("consistent")
                == repo.calibration_snapshot("consistent"))

        payload = _stored_snapshot(db, "consistent")
        payload["calibration"]["ready"] = 1
        _set_snapshot(db, "consistent", payload=json.dumps(payload))

        stored, problem = repo.read_calibration_snapshot("consistent")
        assert stored is None
        assert "ready" in problem
        assert log.get_calibration("consistent") is None
    finally:
        log.close()


def test_legacy_database_without_snapshot_tables_reads_safely(db):
    conn = sqlite3.connect(db)
    try:
        conn.execute("CREATE TABLE run_stats (session TEXT PRIMARY KEY,"
                     " source TEXT)")
        conn.execute("INSERT INTO run_stats(session, source)"
                     " VALUES ('legacy', 'sample')")
        conn.commit()
    finally:
        conn.close()

    assert repo.calibration_snapshot("legacy") is None
    assert repo.read_calibration_snapshot("legacy") == (None, None)
    assert repo.session_point_count("legacy") == 0
    assert repo.trajectory_points("legacy") == []


# ---------------------------------------------------------- CLI persistence
def test_cli_completion_persists_and_is_api_readable(db, client,
                                                     monkeypatch, capsys):
    assert CLI_SAMPLE.is_file(), f"missing sample video {CLI_SAMPLE}"
    monkeypatch.setattr(sys, "argv", ["run_pipeline", str(CLI_SAMPLE)])

    assert cli_main() == 0
    output = capsys.readouterr().out
    assert "done: frames=" in output

    session = CLI_SAMPLE.name
    points = repo.trajectory_points(session)
    assert points, "the CLI did not persist trajectory points"
    snapshot, problem = repo.read_calibration_snapshot(session)
    assert problem is None
    assert snapshot is not None
    assert snapshot["schema_version"] == CALIBRATION_SNAPSHOT_VERSION
    logger = ResultLogger(db)
    try:
        assert logger.get_calibration(session) == snapshot
    finally:
        logger.close()

    detail = client.get(f"/api/v1/sessions/{session}").json()
    assert detail["artifacts"]["retained"] is False
    assert detail["artifacts"]["trajectories"] is True
    assert detail["artifacts"]["scene_calibration"] is True

    tracks = client.get(f"/api/v1/sessions/{session}/tracks").json()["tracks"]
    assert tracks
    track_id = tracks[0]["track_id"]
    trajectory = client.get(
        f"/api/v1/sessions/{session}/tracks/{track_id}/trajectory").json()
    assert trajectory["available"] is True
    assert trajectory["source"] == "persisted"
    assert trajectory["points"]

    scene_body = client.get(f"/api/v1/sessions/{session}/scene").json()
    assert scene_body["source"] == "run_calibration"
    assert scene_body["calibration"]["persisted"] is True
    assert scene_body["calibration"]["snapshot_version"] == \
        CALIBRATION_SNAPSHOT_VERSION
