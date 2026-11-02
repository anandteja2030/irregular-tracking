"""Phase 6 - persistence: SQLite event log + CSV exports.

`ResultLogger` stores one row per tracked-object observation (or at least one
per anomaly manifestation rate-limited to avoid flooding, configurable), plus:

  * track_summaries   one row per completed track (trajectory aggregates)
  * queries for the dashboard: recent anomalies, per-level counts

CSV export mirrors the event table for spreadsheets.
"""
from __future__ import annotations

import csv
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

EVENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS track_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_utc TEXT NOT NULL,
    session TEXT,
    frame_idx INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    level TEXT NOT NULL,              -- Normal / Suspicious / Irregular
    fused_score REAL NOT NULL,
    rule_score REAL,
    ml_score REAL,
    scene_score REAL,
    speed_px_s REAL,
    direction_deg REAL,
    why TEXT
);
CREATE TABLE IF NOT EXISTS track_summaries (
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
    PRIMARY KEY (session, track_id)
);
CREATE TABLE IF NOT EXISTS run_stats (
    session TEXT PRIMARY KEY,
    source TEXT,
    kind TEXT,
    synthetic INTEGER,
    frames INTEGER,
    width INTEGER,
    height INTEGER,
    fps REAL,
    wall_s REAL,
    max_frames INTEGER,
    started_ts TEXT,
    ended_ts TEXT
);
CREATE TABLE IF NOT EXISTS ground_truth (
    session TEXT NOT NULL,
    frame_idx INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (session, frame_idx, track_id)
);
"""

# Older databases keyed track_summaries by track_id alone, so a second
# session silently overwrote the first session's rows. This rebuild keeps
# the data and upgrades the key to (session, track_id).
_MIGRATE_SUMMARIES_PK = """
ALTER TABLE track_summaries RENAME TO track_summaries_legacy;
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
    PRIMARY KEY (session, track_id)
);
INSERT INTO track_summaries (track_id, session, color, shape, n_points,
    n_seconds, mean_speed_px_s, max_speed_px_s, path_length_px, straightness,
    directions, first_frame, last_frame)
SELECT track_id, session, color, shape, n_points, n_seconds, mean_speed_px_s,
    max_speed_px_s, path_length_px, straightness, directions, first_frame,
    last_frame
FROM track_summaries_legacy;
DROP TABLE track_summaries_legacy;
"""


class ResultLogger:
    """SQLite-backed observation + anomaly logger with CSV export."""

    def __init__(self, db_path: Path | str, session: str = "session0"):
        self.db_path = Path(db_path)
        self.session = session
        self._conn = sqlite3.connect(self.db_path)
        self._conn.executescript(EVENT_SCHEMA)
        self._migrate_summaries_pk()
        self._conn.commit()

    def _migrate_summaries_pk(self) -> None:
        """One-time upgrade of legacy databases (idempotent, data-preserving)."""
        info = self._conn.execute("PRAGMA table_info(track_summaries)").fetchall()
        pk_cols = [row[1] for row in sorted(info, key=lambda r: r[5]) if row[5] > 0]
        if pk_cols == ["session", "track_id"]:
            return                      # fresh or already-migrated schema
        self._conn.executescript(_MIGRATE_SUMMARIES_PK)

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------ events
    def log_event(self, frame_idx: int, entry: dict) -> None:
        """entry: the same dict shape visualization consumes, holding verdict."""
        with closing(self._conn.cursor()) as cur:
            cur.execute(
                "INSERT INTO track_events(ts_utc, session, frame_idx, track_id,"
                " level, fused_score, rule_score, ml_score, scene_score,"
                " speed_px_s, direction_deg, why)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    self.session, frame_idx,
                    entry.get("track_id", 0), entry.get("level", "Normal"),
                    entry.get("fused_score", 0.0), entry.get("rule_score", 0.0),
                    entry.get("ml_score", 0.0), entry.get("scene_score", 0.0),
                    entry.get("speed_px_s", 0.0), entry.get("direction_deg"),
                    entry.get("why", ""),
                ))
        self._conn.commit()

    # ------------------------------------------------------------ delete
    def clear_session_events(self, session: str) -> int:
        """Delete one session's event rows (makes re-exports idempotent)."""
        with closing(self._conn.cursor()) as cur:
            cur.execute("DELETE FROM track_events WHERE session = ?", (session,))
            n = cur.rowcount
        self._conn.commit()
        return n

    def clear_session_summaries(self, session: str) -> int:
        """Delete one session's track-summary rows before re-writing them."""
        with closing(self._conn.cursor()) as cur:
            cur.execute("DELETE FROM track_summaries WHERE session = ?", (session,))
            n = cur.rowcount
        self._conn.commit()
        return n

    def close_session(self, session: str) -> dict[str, int]:
        """Remove every persisted row of one session (history deletion)."""
        with closing(self._conn.cursor()) as cur:
            cur.execute("DELETE FROM track_events WHERE session = ?", (session,))
            ev = cur.rowcount
            cur.execute("DELETE FROM track_summaries WHERE session = ?", (session,))
            su = cur.rowcount
            cur.execute("DELETE FROM run_stats WHERE session = ?", (session,))
            cur.execute("DELETE FROM ground_truth WHERE session = ?", (session,))
        self._conn.commit()
        return {"events": ev, "summaries": su}

    # --------------------------------------------------------- run stats
    def log_run(self, info: dict) -> None:
        """Persist processing statistics for one analysis session."""
        with closing(self._conn.cursor()) as cur:
            cur.execute(
                "INSERT OR REPLACE INTO run_stats(session, source, kind,"
                " synthetic, frames, width, height, fps, wall_s, max_frames,"
                " started_ts, ended_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (info.get("session"), info.get("source"), info.get("kind"),
                 int(bool(info.get("synthetic"))), info.get("frames"),
                 info.get("width"), info.get("height"), info.get("fps"),
                 info.get("wall_s"), info.get("max_frames"),
                 info.get("started_ts"), info.get("ended_ts")))
        self._conn.commit()

    def get_run(self, session: str) -> dict | None:
        with closing(self._conn.cursor()) as cur:
            cur.execute("SELECT session, source, kind, synthetic, frames,"
                        " width, height, fps, wall_s, max_frames, started_ts,"
                        " ended_ts FROM run_stats WHERE session = ?", (session,))
            row = cur.fetchone()
        if row is None:
            return None
        keys = ("session", "source", "kind", "synthetic", "frames", "width",
                "height", "fps", "wall_s", "max_frames", "started_ts",
                "ended_ts")
        return dict(zip(keys, row))

    # ----------------------------------------------------- session history
    def list_sessions(self) -> list[dict]:
        """Persisted sessions, newest first, with per-session event counts."""
        with closing(self._conn.cursor()) as cur:
            rows = cur.execute(
                "SELECT session, COUNT(*), MIN(ts_utc), MAX(ts_utc),"
                " SUM(CASE WHEN level != 'Normal' THEN 1 ELSE 0 END)"
                " FROM track_events GROUP BY session"
                " ORDER BY MAX(ts_utc) DESC").fetchall()
        return [{"session": r[0], "events": r[1], "first_ts": r[2],
                 "last_ts": r[3], "anomalies": r[4] or 0} for r in rows]

    def session_events(self, session: str) -> tuple[list[str], list[tuple]]:
        with closing(self._conn.cursor()) as cur:
            cur.execute("SELECT id, ts_utc, frame_idx, track_id, level,"
                        " fused_score, rule_score, ml_score, scene_score,"
                        " speed_px_s, direction_deg, why"
                        " FROM track_events WHERE session = ? ORDER BY frame_idx,"
                        " track_id", (session,))
            cols = [d[0] for d in cur.description]
            return cols, cur.fetchall()

    def session_summaries(self, session: str) -> tuple[list[str], list[tuple]]:
        with closing(self._conn.cursor()) as cur:
            cur.execute("SELECT track_id, color, shape, n_points, n_seconds,"
                        " mean_speed_px_s, max_speed_px_s, path_length_px,"
                        " straightness, directions, first_frame, last_frame"
                        " FROM track_summaries WHERE session = ?"
                        " ORDER BY track_id", (session,))
            cols = [d[0] for d in cur.description]
            return cols, cur.fetchall()

    # --------------------------------------------------------- summaries
    def log_track_summary(self, stats, color: str | None, shape: str,
                          first_frame: int, last_frame: int) -> None:
        with closing(self._conn.cursor()) as cur:
            cur.execute(
                "INSERT OR REPLACE INTO track_summaries"
                " (track_id, session, color, shape, n_points, n_seconds,"
                "  mean_speed_px_s, max_speed_px_s, path_length_px, straightness,"
                "  directions, first_frame, last_frame)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (stats.track_id, self.session, color, shape, stats.n_points,
                 round(stats.n_seconds, 3), round(stats.mean_speed_px_s, 2),
                 round(stats.max_speed_px_s, 2), round(stats.path_length_px, 2),
                 round(stats.straightness, 4), ",".join(stats.direction_hist),
                 first_frame, last_frame))
        self._conn.commit()

    # ------------------------------------------------------------ queries
    def counts_by_level(self) -> dict[str, int]:
        with closing(self._conn.cursor()) as cur:
            rows = cur.execute(
                "SELECT level, COUNT(*) FROM track_events GROUP BY level").fetchall()
        return {row[0]: row[1] for row in rows}

    def recent_anomalies(self, limit: int = 50) -> list[tuple]:
        with closing(self._conn.cursor()) as cur:
            rows = cur.execute(
                "SELECT ts_utc, frame_idx, track_id, level, fused_score,"
                " speed_px_s, direction_deg, why"
                " FROM track_events WHERE level != 'Normal'"
                " ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return rows

    # ------------------------------------------------------------- export
    def export_csv(self, csv_path: Path | str) -> Path:
        csv_path = Path(csv_path)
        with closing(self._conn.cursor()) as cur, csv_path.open("w", newline="") as fh:
            cur.execute("SELECT * FROM track_events ORDER BY id")
            cols = [d[0] for d in cur.description]
            writer = csv.writer(fh)
            writer.writerow(cols)
            writer.writerows(cur.fetchall())
        return csv_path

    def export_trajectories_csv(self, csv_path: Path | str) -> Path:
        csv_path = Path(csv_path)
        with closing(self._conn.cursor()) as cur, csv_path.open("w", newline="") as fh:
            cur.execute("SELECT * FROM track_summaries ORDER BY track_id")
            cols = [d[0] for d in cur.description]
            writer = csv.writer(fh)
            writer.writerow(cols)
            writer.writerows(cur.fetchall())
        return csv_path
