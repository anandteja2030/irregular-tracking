"""Ground-truth labels for reproducible evaluation.

Labels are stored per observation (session, frame_idx, track_id) with the
binary vocabulary used by the detector: ``Normal`` or ``Anomaly``.  The
dashboard's Evaluation page writes them from explicit user input; nothing
here ever invents labels, and metrics are only computed where labels exist.
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS ground_truth (
    session TEXT NOT NULL,
    frame_idx INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    label TEXT NOT NULL,          -- 'Normal' | 'Anomaly'
    PRIMARY KEY (session, frame_idx, track_id)
);
"""

VALID_LABELS = ("Normal", "Anomaly")


def _connect(db_path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def save_labels(db_path: Path | str, session: str,
                labels: list[dict]) -> int:
    """Upsert labels; each dict needs frame_idx, track_id, label."""
    if not labels:
        return 0
    with closing(_connect(db_path)) as conn, closing(conn.cursor()) as cur:
        n = 0
        for row in labels:
            label = str(row["label"])
            if label not in VALID_LABELS:
                raise ValueError(f"label must be one of {VALID_LABELS}, got {label!r}")
            cur.execute(
                "INSERT OR REPLACE INTO ground_truth(session, frame_idx,"
                " track_id, label) VALUES (?,?,?,?)",
                (session, int(row["frame_idx"]), int(row["track_id"]), label))
            n += 1
        conn.commit()
        return n


def load_labels(db_path: Path | str, session: str) -> list[dict]:
    with closing(_connect(db_path)) as conn, closing(conn.cursor()) as cur:
        rows = cur.execute(
            "SELECT frame_idx, track_id, label FROM ground_truth"
            " WHERE session = ? ORDER BY frame_idx, track_id",
            (session,)).fetchall()
    return [{"frame_idx": r[0], "track_id": r[1], "label": r[2]} for r in rows]


def clear_labels(db_path: Path | str, session: str) -> int:
    with closing(_connect(db_path)) as conn, closing(conn.cursor()) as cur:
        cur.execute("DELETE FROM ground_truth WHERE session = ?", (session,))
        n = cur.rowcount
        conn.commit()
    return n
