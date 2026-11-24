"""Session engine, CLI and persistence tests that do not depend on a UI."""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config.config import SETTINGS, AppPaths          # noqa: E402
from src.analysis.logger import ResultLogger          # noqa: E402
from src.ui import session                            # noqa: E402


# ------------------------------------------------------- session engine unit
def test_run_analysis_frames_and_evidence(tmp_path):
    calls: list[tuple[int, int]] = []
    res = session.run_analysis(
        str(ROOT / "samples" / "tiny_noise.mp4"), "sample: tiny_noise.mp4",
        "sample", None, "unit1", progress=lambda d, t: calls.append((d, t)))
    assert res.error is None
    assert res.frames_processed == 40
    assert res.is_synthetic is True
    assert list(res.obs.columns) == session.OBS_COLS
    assert list(res.tracks.columns) == session.TRACK_COLS
    assert calls and calls[-1][0] == 40        # progress finished at frame 40
    # noise clip: no detections at all -> empty tables, still valid
    assert res.obs.empty and res.tracks.empty
    assert res.level_counts == {"Normal": 0, "Suspicious": 0, "Irregular": 0}


def test_run_analysis_error_is_friendly(tmp_path):
    bad = tmp_path / "x.mp4"
    bad.write_bytes(b"garbage")
    res = session.run_analysis(str(bad), "upload: x.mp4", "upload", 10,
                               "unit2")
    assert res.error and "Could not open" in res.error
    assert res.frames_processed == 0
    assert res.obs.empty


def test_upload_path_sanitizes_and_cleanup(tmp_path):
    p = session.upload_path(tmp_path, "../../etc/passwd")
    assert p.parent == tmp_path and p.name.startswith("upload_")
    assert session.upload_path(tmp_path, "my video (1).mp4").name == \
        "upload_myvideo1.mp4"
    old = tmp_path / "upload_old.mp4"
    new = tmp_path / "upload_new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"y")
    os.utime(old, (1, 1))
    assert session.cleanup_stale_uploads(tmp_path) == 1
    assert not old.exists() and new.exists()


def test_is_synthetic_source_flags_bundled_samples_only():
    assert session.is_synthetic_source(ROOT / "samples" / "normal_traffic.mp4")
    assert not session.is_synthetic_source(Path("/tmp/other.mp4"))


def test_session_history_roundtrip(tmp_path):
    res = session.run_analysis(str(ROOT / "samples" / "tiny_noise.mp4"),
                               "sample: tiny_noise.mp4", "sample", None,
                               "hist1")
    res.obs = pd.DataFrame([{
        "frame": 1, "ts_s": 0.1, "track_id": 3, "color": "red",
        "shape": "circle", "level": "Irregular", "fused_score": 0.9,
        "rule_score": 1.0, "ml_score": 0.5, "scene_score": 0.2,
        "speed_px_s": 100.0, "direction_deg": 90.0, "cx": 10.0, "cy": 20.0,
        "zone": None, "zone_dwell_s": 0.0, "rules_json": "[]",
        "ml_note": "", "scene_note": "", "why": "test row"}],
        columns=session.OBS_COLS)
    db = tmp_path / "h.db"
    monkey_paths = AppPaths(samples=SETTINGS.paths.samples,
                            output=SETTINGS.paths.output, db=db)
    old = SETTINGS.paths
    SETTINGS.paths = monkey_paths
    try:
        counts = session.save_session_to_db(res)
        assert counts["events"] == 1
        hist = session.load_history(db)
        assert len(hist) == 1 and hist[0]["session"] == "hist1"
        ev, summ, run = session.load_session_data(db, "hist1")
        assert len(ev) == 1 and ev.iloc[0]["level"] == "Irregular"
        assert run["frames"] == res.frames_processed
        removed = session.delete_session(db, "hist1")
        assert removed["events"] == 1
        assert session.load_history(db) == []
    finally:
        SETTINGS.paths = old


# ------------------------------------------------------------------ CLI
def test_cli_invalid_source_exits_2_with_friendly_message(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"junk")
    proc = subprocess.run(
        [sys.executable, "-m", "scripts.run_pipeline", str(bad)],
        capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert proc.returncode == 2
    assert "error: cannot read source" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_missing_source_exits_2_with_friendly_message():
    proc = subprocess.run(
        [sys.executable, "-m", "scripts.run_pipeline", "does_not_exist.mp4"],
        capture_output=True, text=True, cwd=ROOT, timeout=120)
    assert proc.returncode == 2
    assert "Traceback" not in proc.stderr


def test_cli_rerun_replaces_rows_instead_of_duplicating(tmp_path):
    """Regression: a second CLI run on the same source used to append a full
    second copy of every observation (and never wrote run stats)."""
    import importlib
    gen = importlib.import_module("scripts.generate_samples")
    src = tmp_path / "cli_idem.mp4"
    gen._write(src, gen.normal_traffic(seconds=2.0, fps=15.0), 15.0)
    session_name = src.name

    def _run():
        return subprocess.run(
            [sys.executable, "-m", "scripts.run_pipeline", str(src)],
            capture_output=True, text=True, cwd=ROOT, timeout=300)

    def _cleanup():
        log = ResultLogger(SETTINGS.paths.db, session=session_name)
        try:
            log.clear_session_events(session_name)
            log.clear_session_summaries(session_name)
            log.close_session(session_name)
        finally:
            log.close()

    _cleanup()                      # idempotent pre-condition
    try:
        first, second = _run(), _run()
        assert first.returncode == 0, first.stderr[-500:]
        assert second.returncode == 0, second.stderr[-500:]
        con = sqlite3.connect(SETTINGS.paths.db)
        try:
            rows = con.execute(
                "SELECT COUNT(*) FROM track_events WHERE session=?",
                (session_name,)).fetchone()[0]
            dups = con.execute(
                "SELECT COUNT(*) FROM (SELECT frame_idx, track_id FROM"
                " track_events WHERE session=? GROUP BY frame_idx, track_id"
                " HAVING COUNT(*) > 1)", (session_name,)).fetchone()[0]
            runs = con.execute(
                "SELECT COUNT(*) FROM run_stats WHERE session=?",
                (session_name,)).fetchone()[0]
            frames = con.execute(
                "SELECT frames FROM run_stats WHERE session=?",
                (session_name,)).fetchone()[0]
            points = con.execute(
                "SELECT COUNT(*) FROM track_points WHERE session=?",
                (session_name,)).fetchone()[0]
            snapshots = con.execute(
                "SELECT COUNT(*) FROM calibration_snapshots WHERE session=?",
                (session_name,)).fetchone()[0]
        finally:
            con.close()
        assert rows > 0             # the clip really produced observations
        assert dups == 0            # second run replaced, not appended
        assert runs == 1            # run stats recorded (one row per session)
        assert frames == 30         # 2.0 s @ 15 fps actually processed
        assert points > 0           # CLI trajectories are persisted
        assert snapshots == 1       # and the calibration snapshot is idempotent
    finally:
        _cleanup()                  # leave the shared DB as we found it


# ------------------------------------------------------------------ logger
def test_logger_clear_session_events_makes_rewrites_idempotent(tmp_path):
    log = ResultLogger(tmp_path / "t.db", session="sA")
    entry = {"track_id": 1, "level": "Normal", "fused_score": 0.1,
             "rule_score": 0.0, "ml_score": 0.0, "scene_score": 0.0,
             "speed_px_s": 10.0, "direction_deg": 90.0, "why": "ok"}
    log.log_event(1, entry)
    log.log_event(2, entry)
    assert log.clear_session_events("sA") == 2
    assert log.counts_by_level() == {}
    assert log.clear_session_events("sA") == 0
    log.close()


def test_logger_sessions_are_isolated(tmp_path):
    a = ResultLogger(tmp_path / "t.db", session="sA")
    entry = {"track_id": 1, "level": "Irregular", "fused_score": 0.8,
             "rule_score": 1.0, "ml_score": 0.0, "scene_score": 0.0,
             "speed_px_s": 500.0, "direction_deg": 10.0, "why": "x"}
    a.log_event(1, entry)
    a.close()
    b = ResultLogger(tmp_path / "t.db", session="sB")
    b.log_event(1, entry)
    sessions = b.list_sessions()
    cols, rows = b.session_events("sA")
    b.close()
    assert {s["session"] for s in sessions} == {"sA", "sB"}
    assert len(rows) == 1 and rows[0][4] == "Irregular"
    assert b is not None


def test_logger_summaries_keyed_by_session_not_overwritten(tmp_path):
    stub = type("S", (), dict(track_id=7, n_points=10, n_seconds=1.0,
                               mean_speed_px_s=1.0, max_speed_px_s=2.0,
                               path_length_px=5.0, straightness=0.9,
                               direction_hist={"E": 9}))()
    a = ResultLogger(tmp_path / "t.db", session="sA")
    a.log_track_summary(stub, "green", "circle", 0, 9)
    a.close()
    b = ResultLogger(tmp_path / "t.db", session="sB")
    b.log_track_summary(stub, "blue", "square", 0, 9)
    rows = sorted(b._conn.execute(
        "SELECT session, color FROM track_summaries").fetchall())
    b.close()
    assert rows == [("sA", "green"), ("sB", "blue")]


def test_logger_migrates_legacy_track_summaries_schema(tmp_path):
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE track_summaries (
            track_id INTEGER PRIMARY KEY, session TEXT, color TEXT, shape TEXT,
            n_points INTEGER, n_seconds REAL, mean_speed_px_s REAL,
            max_speed_px_s REAL, path_length_px REAL, straightness REAL,
            directions TEXT, first_frame INTEGER, last_frame INTEGER);
        INSERT INTO track_summaries VALUES
            (1,'old','green','circle',10,1.0,1.0,2.0,5.0,0.9,'E',0,9);
    """)
    conn.commit()
    conn.close()
    log = ResultLogger(db, session="new")
    info = log._conn.execute("PRAGMA table_info(track_summaries)").fetchall()
    pk = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5] > 0]
    rows = log._conn.execute(
        "SELECT track_id, session FROM track_summaries").fetchall()
    log.close()
    assert pk == ["session", "track_id"]
    assert rows == [(1, "old")]
