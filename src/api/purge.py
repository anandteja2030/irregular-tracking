"""Irreversible purge of every artifact this process and its database hold.

The console exposes this behind an explicit two-step confirmation. It is the
only write this API performs on the analysis database, and it deletes rows
rather than dropping the file so the schema, indexes and any future migration
state stay intact.

Everything is removed together so the console returns to a genuine first-run
state rather than a half-empty one:

* every row in every application table (observed through ``sqlite_master``, so
  a table added later cannot be silently left behind);
* retained preview frames and in-memory trajectories/evidence;
* uploaded video files and their registry;
* active live captures (cancelled) and analysis jobs (cancelled first, so a
  worker cannot write a row back after the delete);
* finished job history;
* the process-local configuration, restored to its shipped defaults.

The return value counts exactly what was deleted so the UI can report measured
numbers instead of claiming success.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from config.config import load_config

# Reported individually because the UI names them. Any other table found in the
# database is still cleared and added to ``tables_cleared``.
_COUNTED = {
    "track_events": "events",
    "track_summaries": "tracks",
    "track_points": "points",
    "calibration_snapshots": "calibration",
    "ground_truth": "labels",
    "run_stats": "runs",
}


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (table,)).fetchone()
    return row is not None


def _user_tables(conn: sqlite3.Connection) -> list[str]:
    return [str(row[0]) for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
        " AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def purge_all() -> dict:
    """Cancel live work, then erase every persisted and in-memory artifact."""
    from src.api import jobs, live, uploads
    from src.api.config_store import reset_config
    from src.api.session_store import store

    # 1. Stop writers before touching the database, and give an in-flight
    #    worker a moment to unwind. `wait_idle` is bounded on purpose.
    jobs.manager.cancel_all()
    jobs.manager.wait_idle(timeout=5.0)
    live_cancelled = len(live.manager.active())
    live.manager.cancel_all()

    removed = {key: 0 for key in _COUNTED.values()}
    tables_cleared = 0
    sessions: set[str] = set()
    db_path = Path(load_config().paths.db)
    if db_path.is_file():
        conn = sqlite3.connect(db_path, timeout=15.0)
        try:
            for table in _user_tables(conn):
                if table in ("track_events", "track_summaries", "track_points",
                             "ground_truth", "run_stats"):
                    try:
                        sessions.update(
                            str(row[0]) for row in conn.execute(
                                f"SELECT DISTINCT session FROM {table}"))
                    except sqlite3.DatabaseError:      # pragma: no cover
                        pass
                before = conn.execute(
                    f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                conn.execute(f"DELETE FROM {table}")
                if before:
                    tables_cleared += 1
                key = _COUNTED.get(table)
                if key is not None:
                    removed[key] = int(before or 0)
            # SQLite keeps AUTOINCREMENT counters outside the tables; clearing
            # the sequence makes the next run start at 1 again.
            if _table_exists(conn, "sqlite_sequence"):
                conn.execute("DELETE FROM sqlite_sequence")
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
    uploads_removed, upload_bytes = uploads.clear_all_measured()

    # 2. Configuration is process-local; returning it to defaults is what makes
    #    the next run start from scratch instead of inheriting tuned values.
    _, config_changes = reset_config()

    database_bytes = db_path.stat().st_size if db_path.is_file() else 0
    return {
        "sessions": len(sessions),
        "events": removed["events"],
        "tracks": removed["tracks"],
        "points": removed["points"],
        "calibration": removed["calibration"],
        "labels": removed["labels"],
        "runs": removed["runs"],
        "artifacts": artifacts,
        "uploads": uploads_removed,
        "upload_bytes": upload_bytes,
        "tables_cleared": tables_cleared,
        "database_bytes": database_bytes,
        "config_reset": len(config_changes),
        "config_changes": config_changes[:24],
        "live_cancelled": live_cancelled,
    }
