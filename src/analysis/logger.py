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
    track_id INTEGER PRIMARY KEY,
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
    last_frame INTEGER
);
"""


class ResultLogger:
    """SQLite-backed observation + anomaly logger with CSV export."""

    def __init__(self, db_path: Path | str, session: str = "session0"):
        self.db_path = Path(db_path)
        self.session = session
        self._conn = sqlite3.connect(self.db_path)
        self._conn.executescript(EVENT_SCHEMA)
        self._conn.commit()

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
