"""Irreversible purge of every artifact this process and its database hold.

The console exposes this behind an explicit two-step confirmation. It is the
only write this API performs on the analysis database, and it deletes rows
rather than dropping the file so the schema, indexes and any future migration
state stay intact.

Everything is removed together so the dashboard cannot be left half-empty:

* persisted observation, summary, run, ground-truth, trajectory and calibration
  rows;
* retained preview frames and in-memory trajectories/evidence;
* uploaded video files and their registry;
* active live captures (cancelled) and analysis jobs (cancelled first, so a
  worker cannot write a row back after the delete);
* finished job history.

The return value counts exactly what was deleted so the UI can report measured
numbers instead of claiming success.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from config.config import load_config

# Ordered child -> parent. SQLite has no foreign keys here, but deleting the
# high-volume tables first keeps a partial failure from orphaning summaries.
_TABLES = (
    "track_events",
    "track_summaries",
    "track_points",
    "calibration_snapshots",
    "ground_truth",
    "run_stats",
)
_SESSION_TABLES = ("track_events", "track_summaries", "track_points",
                   "ground_truth", "run_stats")


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (table,)).fetchone()
    return row is not None


def purge_all() -> dict:
    """Cancel live work, then erase every persisted and in-memory artifact."""
    from src.api import jobs, live, uploads
    from src.api.session_store import store

    # 1. Stop writers before touching the database, and give an in-flight
    #    worker a moment to unwind. `wait_idle` is bounded on purpose.
    jobs.manager.cancel_all()
    jobs.manager.wait_idle(timeout=5.0)
    live_cancelled = len(live.manager.active())
    live.manager.cancel_all()

    removed = {table: 0 for table in _TABLES}
    sessions: set[str] = set()
    db_path = Path(load_config().paths.db)
    if db_path.is_file():
        conn = sqlite3.connect(db_path, timeout=15.0)
        try:
            for table in _TABLES:
                if not _table_exists(conn, table):
                    continue
                if table in _SESSION_TABLES:
                    sessions.update(
                        str(row[0]) for row in conn.execute(
                            f"SELECT DISTINCT session FROM {table}"))
                before = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                conn.execute(f"DELETE FROM {table}")
                removed[table] = int(before or 0)
            conn.commit()
            # Reclaim the pages so a long-lived SQLite file shrinks as well.
            try:
                conn.execute("VACUUM")
            except sqlite3.DatabaseError:
                pass
        finally:
            conn.close()

    artifacts = store.stats()["sessions"]
    store.clear()
    jobs.manager.clear_finished()
    removed_uploads = uploads.clear_all()

    return {
        "sessions": len(sessions),
        "events": removed["track_events"],
        "tracks": removed["track_summaries"],
        "points": removed["track_points"],
        "calibration": removed["calibration_snapshots"],
        "labels": removed["ground_truth"],
        "runs": removed["run_stats"],
        "artifacts": artifacts,
        "uploads": removed_uploads,
        "live_cancelled": live_cancelled,
    }
