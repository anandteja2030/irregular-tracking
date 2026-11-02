"""Read-only analytics queries over the existing SQLite schema.

Everything here is a *query*: detection, tracking, calibration and scoring all
stay in their original modules. The repository only reads the tables the
engine already writes (`track_events`, `track_summaries`, `run_stats`,
`ground_truth`) through the database path in the live config singleton, so a
session produced by the CLI, Streamlit or the API is readable the same way.

Efficiency notes
----------------
* Listing sessions or tracks is one query with aggregates joined in SQL, never
  a per-session/per-track round trip.
* Pagination happens in SQL, and counts come from a companion COUNT query.
* Connections are read-only, short-lived and per request; parameters are bound,
  never interpolated.
* Missing tables (fresh or empty database) read as "no data" instead of errors.
"""
from __future__ import annotations

import math
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator

import numpy as np

from config.config import load_config
from src.analysis.features import _octant

LEVELS = ("Normal", "Suspicious", "Irregular")
ANOMALY_LEVELS = ("Suspicious", "Irregular")

_TRACK_BASE = """
WITH agg AS (
    SELECT track_id,
           COUNT(*) AS observations,
           SUM(CASE WHEN level != 'Normal' THEN 1 ELSE 0 END) AS anomalies,
           SUM(CASE WHEN level = 'Suspicious' THEN 1 ELSE 0 END) AS suspicious,
           SUM(CASE WHEN level = 'Irregular' THEN 1 ELSE 0 END) AS irregular,
           MIN(frame_idx) AS first_frame,
           MAX(frame_idx) AS last_frame,
           MIN(ts_utc) AS first_ts,
           MAX(ts_utc) AS last_ts,
           AVG(speed_px_s) AS mean_speed_obs,
           MAX(speed_px_s) AS max_speed_obs,
           MAX(fused_score) AS max_fused
    FROM track_events
    WHERE session = :session
    GROUP BY track_id
)
SELECT agg.*, ts.color AS s_color, ts.shape AS s_shape,
       ts.n_points AS s_n_points, ts.n_seconds AS s_n_seconds,
       ts.mean_speed_px_s AS s_mean_speed, ts.max_speed_px_s AS s_max_speed,
       ts.path_length_px AS s_path_length,
       ts.straightness AS s_straightness, ts.directions AS s_directions,
       ts.first_frame AS s_first_frame, ts.last_frame AS s_last_frame
FROM agg
LEFT JOIN track_summaries ts
       ON ts.session = :session AND ts.track_id = agg.track_id
"""

_SESSION_BASE = """
WITH ids AS (
    SELECT session FROM run_stats
    UNION
    SELECT session FROM track_events
    UNION
    SELECT session FROM track_summaries
),
ev AS (
    SELECT session, COUNT(*) AS observations,
           SUM(CASE WHEN level != 'Normal' THEN 1 ELSE 0 END) AS anomalies,
           SUM(CASE WHEN level = 'Suspicious' THEN 1 ELSE 0 END) AS suspicious,
           SUM(CASE WHEN level = 'Irregular' THEN 1 ELSE 0 END) AS irregular,
           COUNT(DISTINCT track_id) AS tracks,
           MIN(frame_idx) AS first_frame, MAX(frame_idx) AS last_frame,
           MIN(ts_utc) AS first_ts, MAX(ts_utc) AS last_ts
    FROM track_events GROUP BY session
),
lb AS (
    SELECT session, COUNT(*) AS labels FROM ground_truth GROUP BY session
)
SELECT ids.session AS session, r.source AS source, r.kind AS kind,
       r.synthetic AS synthetic, r.frames AS frames, r.width AS width,
       r.height AS height, r.fps AS fps, r.wall_s AS wall_s,
       r.max_frames AS max_frames, r.started_ts AS started_ts,
       r.ended_ts AS ended_ts,
       COALESCE(ev.observations, 0) AS observations,
       COALESCE(ev.anomalies, 0) AS anomalies,
       COALESCE(ev.suspicious, 0) AS suspicious,
       COALESCE(ev.irregular, 0) AS irregular,
       COALESCE(ev.tracks, 0) AS tracks,
       ev.first_frame AS first_frame, ev.last_frame AS last_frame,
       ev.first_ts AS first_ts, ev.last_ts AS last_ts,
       COALESCE(lb.labels, 0) AS labels,
       COALESCE(r.ended_ts, ev.last_ts, r.started_ts) AS effective_ts
FROM ids
LEFT JOIN run_stats r ON r.session = ids.session
LEFT JOIN ev ON ev.session = ids.session
LEFT JOIN lb ON lb.session = ids.session
"""

_EVENT_COLUMNS = ("id, ts_utc, session, frame_idx, track_id, level, fused_score,"
                  " rule_score, ml_score, scene_score, speed_px_s,"
                  " direction_deg, why")

_LEVEL_FILTERS = {
    "Normal": "t.anomalies = 0",
    "Suspicious": "t.anomalies > 0",
    "Irregular": "t.irregular > 0",
    "any": "t.anomalies > 0",
}

_TRACK_SORTS = {
    "track_id": "t.track_id ASC",
    "anomalies": "t.anomalies DESC, t.track_id ASC",
    "speed": "COALESCE(t.s_mean_speed, t.mean_speed_obs, 0) DESC, t.track_id ASC",
    "first_frame": "t.first_frame ASC",
}

_SESSION_SORTS = {
    "newest": "COALESCE(s.effective_ts, '') DESC, s.session DESC",
    "oldest": "COALESCE(s.effective_ts, '') ASC, s.session ASC",
    "events": "s.observations DESC, s.session ASC",
    "anomalies": "s.anomalies DESC, s.session ASC",
}


# --------------------------------------------------------------------- utils
def _db_path() -> Path:
    return Path(load_config().paths.db)


@contextmanager
def connect() -> Iterator[sqlite3.Connection | None]:
    """Read-only connection; yields None when the database is unusable.

    Unavailable databases (absent file, corrupt header, unreadable) degrade to
    "no data" at open time. Errors raised by statements *inside* the ``with``
    block are not swallowed here: a context manager cannot resume a caller
    mid-block, and re-yielding used to surface an opaque
    ``RuntimeError: generator didn't stop after throw()``. Such errors now
    propagate as the real ``sqlite3`` error.
    """
    path = _db_path()
    if not path.is_file():
        yield None
        return
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
        conn.row_factory = sqlite3.Row
        # Cheap probe so a corrupt/unreadable file is detected here, where we
        # can still report "no data" instead of failing per query.
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    except sqlite3.DatabaseError:
        if conn is not None:
            conn.close()
        yield None
        return
    try:
        yield conn
    finally:
        conn.close()


def _has_table(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table'"
                       " AND name = ?", (table,)).fetchone()
    return row is not None


def _session_base(conn: sqlite3.Connection) -> str:
    """Session listing SQL, tolerant of databases without a labels table."""
    if _has_table(conn, "ground_truth"):
        return _SESSION_BASE
    return _SESSION_BASE.replace(
        "SELECT session, COUNT(*) AS labels FROM ground_truth GROUP BY session",
        "SELECT session, 0 AS labels FROM run_stats WHERE 0")


def _escape_like(value: str) -> str:
    return (value.replace("\\", "\\\\").replace("%", "\\%")
            .replace("_", "\\_"))


def _finite(value) -> float | None:
    if value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _round(value, digits: int = 3):
    out = _finite(value)
    return None if out is None else round(out, digits)


def round_or_none(value, digits: int = 3):
    """Round a possibly-missing measurement, preserving None for absence."""
    return _round(value, digits)


def parse_timestamp(value: str | None) -> str | None:
    """Validate an ISO-8601 filter and normalise it for string comparison."""
    if value is None:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()


def _octant_counts(angles: list[float]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for angle in angles:
        label = _octant(angle)
        counts[label] = counts.get(label, 0) + 1
    return dict(sorted(counts.items()))


def _dominant(counts: dict[str, int], share: float = 0.20) -> list[str]:
    total = sum(counts.values())
    if not total:
        return []
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    return [label for label, n in ranked if n / total >= share][:2]


# ------------------------------------------------------------------ sessions
def session_exists(session: str) -> bool:
    with connect() as conn:
        if conn is None:
            return False
        for table in ("run_stats", "track_events", "track_summaries",
                      "ground_truth"):
            if not _has_table(conn, table):
                continue
            row = conn.execute(f"SELECT 1 FROM {table} WHERE session = ? LIMIT 1",
                               (session,)).fetchone()
            if row is not None:
                return True
    return False


def _level_counts(suspicious: int | None, irregular: int | None,
                  observations: int | None) -> dict[str, int]:
    susp = int(suspicious or 0)
    irr = int(irregular or 0)
    total = int(observations or 0)
    return {"Normal": max(total - susp - irr, 0),
            "Suspicious": susp, "Irregular": irr}


def overview_from_row(row: dict) -> dict:
    """Shape one session row (list or detail query) into API fields."""
    observations = int(row.get("observations") or 0)
    levels = _level_counts(row.get("suspicious"), row.get("irregular"),
                           observations)
    run_present = row.get("source") is not None or row.get("frames") is not None
    frames = int(row["frames"]) if row.get("frames") is not None else None
    fps = _finite(row.get("fps"))
    wall_s = _finite(row.get("wall_s"))
    duration_s = round(frames / fps, 3) if frames and fps else None
    proc_fps = round(frames / wall_s, 2) if frames and wall_s else None
    return {
        "session": row["session"],
        "source": {
            "label": row.get("source"),
            "kind": row.get("kind"),
            "synthetic": bool(row.get("synthetic")),
        },
        "processing": {
            "frames_processed": frames,
            "width": row.get("width"),
            "height": row.get("height"),
            "fps": fps,
            "wall_s": wall_s,
            "max_frames": row.get("max_frames"),
            "processing_fps": proc_fps,
            "video_duration_s": duration_s,
            "started_ts": row.get("started_ts"),
            "ended_ts": row.get("ended_ts"),
            "run_stats_available": bool(run_present),
        },
        "counts": {
            "observations": observations,
            "tracks": int(row.get("tracks") or 0),
            "anomalies": int(row.get("anomalies") or 0),
            "levels": levels,
            "labels": int(row.get("labels") or 0),
        },
        "frame_range": {
            "first": row.get("first_frame"),
            "last": row.get("last_frame"),
        },
        "timestamps": {
            "first_ts": row.get("first_ts"),
            "last_ts": row.get("last_ts"),
        },
    }


def list_sessions(*, kind: str | None = None, synthetic: bool | None = None,
                  has_labels: bool | None = None,
                  has_anomalies: bool | None = None,
                  q: str | None = None, since: str | None = None,
                  until: str | None = None, sort: str = "newest",
                  limit: int = 50, offset: int = 0) -> tuple[int, list[dict]]:
    where: list[str] = []
    params: dict = {}
    if kind is not None:
        where.append("s.kind = :kind")
        params["kind"] = kind
    if synthetic is not None:
        where.append("COALESCE(s.synthetic, 0) = :synthetic")
        params["synthetic"] = int(synthetic)
    if has_labels is not None:
        where.append("s.labels " + ("> 0" if has_labels else "= 0"))
    if has_anomalies is not None:
        where.append("s.anomalies " + ("> 0" if has_anomalies else "= 0"))
    if q:
        where.append("s.session LIKE :q ESCAPE '\\'")
        params["q"] = f"%{_escape_like(q)}%"
    if since:
        where.append("COALESCE(s.effective_ts, '') >= :since")
        params["since"] = since
    if until:
        where.append("COALESCE(s.effective_ts, '') <= :until")
        params["until"] = until
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    order = _SESSION_SORTS.get(sort, _SESSION_SORTS["newest"])

    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return 0, []
        base = f"SELECT * FROM ({_session_base(conn)}) AS s{clause}"
        total = int(conn.execute(f"SELECT COUNT(*) FROM ({base}) AS c",
                                 params).fetchone()[0])
        rows = conn.execute(
            f"{base} ORDER BY {order} LIMIT :limit OFFSET :offset",
            {**params, "limit": limit, "offset": offset}).fetchall()
    return total, [overview_from_row(dict(r)) for r in rows]


def session_overview(session: str) -> dict | None:
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return None
        row = conn.execute(
            f"SELECT * FROM ({_session_base(conn)}) AS s"
            " WHERE s.session = :session", {"session": session}).fetchone()
    return overview_from_row(dict(row)) if row is not None else None


# -------------------------------------------------------------------- tracks
def _track_rows(session: str, *, level: str | None = None,
                min_events: int | None = None, track_id: int | None = None,
                sort: str = "track_id", limit: int | None = 50,
                offset: int = 0) -> tuple[int, list[dict]]:
    where: list[str] = []
    params: dict = {"session": session}
    if level and level in _LEVEL_FILTERS:
        where.append(_LEVEL_FILTERS[level])
    if min_events is not None:
        where.append("t.anomalies >= :min_events")
        params["min_events"] = min_events
    if track_id is not None:
        where.append("t.track_id = :track_id")
        params["track_id"] = track_id
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    order = _TRACK_SORTS.get(sort, _TRACK_SORTS["track_id"])
    base = f"SELECT * FROM ({_TRACK_BASE}) AS t{clause}"
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return 0, []
        total = int(conn.execute(f"SELECT COUNT(*) FROM ({base}) AS c",
                                 params).fetchone()[0])
        if limit is None:
            rows = conn.execute(f"{base} ORDER BY {order}", params).fetchall()
        else:
            rows = conn.execute(
                f"{base} ORDER BY {order} LIMIT :limit OFFSET :offset",
                {**params, "limit": limit, "offset": offset}).fetchall()
    return total, [dict(r) for r in rows]


def _worst_level(irregular: int, anomalies: int) -> str:
    if irregular > 0:
        return "Irregular"
    return "Suspicious" if anomalies > 0 else "Normal"


def track_from_row(row: dict, fps: float | None) -> dict:
    """Merge persisted summary aggregates with event-derived measurements."""
    observations = int(row.get("observations") or 0)
    anomalies = int(row.get("anomalies") or 0)
    irregular = int(row.get("irregular") or 0)
    first = row.get("first_frame")
    last = row.get("last_frame")
    observed_s = (round((last - first) / fps, 3)
                  if fps and first is not None and last is not None else None)
    summary_speed = _finite(row.get("s_mean_speed"))
    mean_speed = summary_speed if summary_speed is not None \
        else _finite(row.get("mean_speed_obs"))
    max_speed = _finite(row.get("s_max_speed"))
    if max_speed is None:
        max_speed = _finite(row.get("max_speed_obs"))
    directions = [d for d in (row.get("s_directions") or "").split(",") if d]
    return {
        "track_id": int(row["track_id"]),
        "appearance": {
            "color": row.get("s_color"),
            "shape": row.get("s_shape"),
        },
        "frames": {
            "first": first,
            "last": last,
            "summary_first": row.get("s_first_frame"),
            "summary_last": row.get("s_last_frame"),
        },
        "observed": {
            "observations": observations,
            "anomalies": anomalies,
            "levels": _level_counts(row.get("suspicious"), irregular,
                                    observations),
            "worst_level": _worst_level(irregular, anomalies),
            "duration_s": observed_s,
        },
        "motion": {
            "mean_speed_px_s": _round(mean_speed, 1),
            "max_speed_px_s": _round(max_speed, 1),
            "path_length_px": _round(row.get("s_path_length"), 1),
            "straightness": _round(row.get("s_straightness"), 3),
            "n_points": row.get("s_n_points"),
            "n_seconds": _round(row.get("s_n_seconds"), 2),
            "summary_directions": directions,
            "max_fused_score": _round(row.get("max_fused"), 3),
            "speed_source": ("track_summary" if summary_speed is not None
                             else "event_observations"),
        },
        "timestamps": {
            "first_ts": row.get("first_ts"),
            "last_ts": row.get("last_ts"),
        },
    }


def list_tracks(session: str, *, level: str | None = None,
                min_events: int | None = None, sort: str = "track_id",
                limit: int = 50, offset: int = 0) -> tuple[int, list[dict]]:
    total, rows = _track_rows(session, level=level, min_events=min_events,
                              sort=sort, limit=limit, offset=offset)
    return total, [track_from_row(r, _session_fps(session)) for r in rows]


def track_detail(session: str, track_id: int) -> dict | None:
    _, rows = _track_rows(session, track_id=track_id, limit=1)
    if not rows:
        return None
    return track_from_row(rows[0], _session_fps(session))


def track_angles(session: str, track_id: int) -> list[float]:
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return []
        rows = conn.execute(
            "SELECT direction_deg FROM track_events"
            " WHERE session = ? AND track_id = ? AND direction_deg IS NOT NULL",
            (session, track_id)).fetchall()
    return [float(r[0]) for r in rows if _finite(r[0]) is not None]


def _session_fps(session: str) -> float | None:
    with connect() as conn:
        if conn is None or not _has_table(conn, "run_stats"):
            return None
        row = conn.execute("SELECT fps FROM run_stats WHERE session = ?",
                           (session,)).fetchone()
    return _finite(row[0]) if row is not None else None


def track_observations(session: str, track_id: int, *, level: str | None = None,
                       from_frame: int | None = None,
                       to_frame: int | None = None, limit: int = 100,
                       offset: int = 0) -> tuple[int, list[dict]]:
    where = ["session = ?", "track_id = ?"]
    params: list = [session, track_id]
    if level is not None:
        where.append("level = ?")
        params.append(level)
    if from_frame is not None:
        where.append("frame_idx >= ?")
        params.append(from_frame)
    if to_frame is not None:
        where.append("frame_idx <= ?")
        params.append(to_frame)
    clause = " AND ".join(where)
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return 0, []
        total = int(conn.execute(
            f"SELECT COUNT(*) FROM track_events WHERE {clause}",
            params).fetchone()[0])
        rows = conn.execute(
            f"SELECT {_EVENT_COLUMNS} FROM track_events WHERE {clause}"
            " ORDER BY frame_idx, id LIMIT ? OFFSET ?",
            [*params, limit, offset]).fetchall()
    return total, [event_item(dict(r)) for r in rows]


def track_frames(session: str, track_id: int, *, limit: int = 100,
                 offset: int = 0) -> tuple[int, list[dict]]:
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return 0, []
        total = int(conn.execute(
            "SELECT COUNT(*) FROM track_events WHERE session = ?"
            " AND track_id = ?", (session, track_id)).fetchone()[0])
        rows = conn.execute(
            "SELECT frame_idx, ts_utc, level, fused_score, speed_px_s"
            " FROM track_events WHERE session = ? AND track_id = ?"
            " ORDER BY frame_idx LIMIT ? OFFSET ?",
            (session, track_id, limit, offset)).fetchall()
    return total, [{"frame": int(r["frame_idx"]), "ts_utc": r["ts_utc"],
                    "level": r["level"], "fused_score": _round(r["fused_score"], 3),
                    "speed_px_s": _round(r["speed_px_s"], 1)} for r in rows]


def event_item(row: dict) -> dict:
    return {
        "event_id": int(row["id"]),
        "session": row["session"],
        "frame": int(row["frame_idx"]),
        "ts_utc": row["ts_utc"],
        "track_id": int(row["track_id"]),
        "level": row["level"],
        "scores": {
            "fused": _round(row.get("fused_score"), 3),
            "rule": _round(row.get("rule_score"), 3),
            "ml": _round(row.get("ml_score"), 3),
            "scene": _round(row.get("scene_score"), 3),
        },
        "motion": {
            "speed_px_s": _round(row.get("speed_px_s"), 1),
            "direction_deg": _round(row.get("direction_deg"), 1),
        },
        "summary": row.get("why") or "",
    }


# ----------------------------------------------------------------- anomalies
_ANOMALY_SORTS = {
    "frame": "frame_idx ASC, id ASC",
    "frame_desc": "frame_idx DESC, id DESC",
    "score": "fused_score DESC, id ASC",
    "score_asc": "fused_score ASC, id ASC",
}


def list_anomalies(session: str, *, severity: str | None = None,
                   track_id: int | None = None, min_score: float | None = None,
                   from_frame: int | None = None, to_frame: int | None = None,
                   sort: str = "score", limit: int | None = 50,
                   offset: int = 0) -> tuple[int, list[dict]]:
    where = ["session = ?", "level != 'Normal'"]
    params: list = [session]
    if severity == "any":
        pass
    elif severity in ANOMALY_LEVELS:
        where.append("level = ?")
        params.append(severity)
    if track_id is not None:
        where.append("track_id = ?")
        params.append(track_id)
    if min_score is not None:
        where.append("fused_score >= ?")
        params.append(min_score)
    if from_frame is not None:
        where.append("frame_idx >= ?")
        params.append(from_frame)
    if to_frame is not None:
        where.append("frame_idx <= ?")
        params.append(to_frame)
    clause = " AND ".join(where)
    order = _ANOMALY_SORTS.get(sort, _ANOMALY_SORTS["score"])
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return 0, []
        total = int(conn.execute(
            f"SELECT COUNT(*) FROM track_events WHERE {clause}",
            params).fetchone()[0])
        sql = (f"SELECT {_EVENT_COLUMNS} FROM track_events WHERE {clause}"
               f" ORDER BY {order}")
        if limit is None:
            rows = conn.execute(sql, params).fetchall()
        else:
            rows = conn.execute(sql + " LIMIT ? OFFSET ?",
                                [*params, limit, offset]).fetchall()
    return total, [event_item(dict(r)) for r in rows]


def anomaly_event(session: str, event_id: int) -> dict | None:
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return None
        row = conn.execute(
            f"SELECT {_EVENT_COLUMNS} FROM track_events"
            " WHERE session = ? AND id = ?", (session, event_id)).fetchone()
    return event_item(dict(row)) if row is not None else None


# ----------------------------------------------------------------- scene data
def scene_observations(session: str) -> dict:
    """Raw per-observation scene signals for derivation (bounded by session)."""
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return {"speeds": [], "angles": [], "scene_scores": [],
                    "tracks": {}}
        rows = conn.execute(
            "SELECT track_id, speed_px_s, direction_deg, scene_score"
            " FROM track_events WHERE session = ?", (session,)).fetchall()
    speeds: list[float] = []
    angles: list[float] = []
    scores: list[float] = []
    per_track: dict[int, list[float]] = {}
    for row in rows:
        speed = _finite(row["speed_px_s"])
        if speed is not None:
            speeds.append(speed)
        angle = _finite(row["direction_deg"])
        if angle is not None:
            angles.append(angle)
        score = _finite(row["scene_score"])
        if score is not None:
            scores.append(score)
            per_track.setdefault(int(row["track_id"]), []).append(score)
    return {"speeds": speeds, "angles": angles, "scene_scores": scores,
            "tracks": per_track}


def speed_distribution(speeds: list[float]) -> dict | None:
    if not speeds:
        return None
    values = np.asarray(speeds, dtype=float)
    return {
        "samples": int(values.size),
        "p10": round(float(np.percentile(values, 10)), 2),
        "p50": round(float(np.percentile(values, 50)), 2),
        "p90": round(float(np.percentile(values, 90)), 2),
        "mean": round(float(np.mean(values)), 2),
        "std": round(float(np.std(values)), 2),
        "min": round(float(np.min(values)), 2),
        "max": round(float(np.max(values)), 2),
    }


def direction_profile(angles: list[float]) -> dict:
    counts = _octant_counts(angles)
    total = sum(counts.values())
    histogram = {k: round(v / total, 4) for k, v in counts.items()} \
        if total else {}
    return {"samples": total, "counts": counts, "histogram": histogram,
            "dominant": _dominant(counts)}


# ---------------------------------------------------------------- evaluation
def evaluation_observations(session: str) -> list[dict]:
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return []
        rows = conn.execute(
            "SELECT frame_idx, track_id, level FROM track_events"
            " WHERE session = ? ORDER BY frame_idx, track_id",
            (session,)).fetchall()
    return [{"frame": int(r["frame_idx"]), "track_id": int(r["track_id"]),
             "level": r["level"]} for r in rows]


# -------------------------------------------------------------------- export
def export_events(session: str) -> list[list]:
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return []
        rows = conn.execute(
            "SELECT frame_idx, ts_utc, track_id, level, fused_score,"
            " rule_score, ml_score, scene_score, speed_px_s, direction_deg, why"
            " FROM track_events WHERE session = ?"
            " ORDER BY frame_idx, track_id", (session,)).fetchall()
    return [list(r) for r in rows]


def session_summary_stats(session: str) -> dict:
    """Aggregate anomaly + track statistics in a fixed number of queries."""
    empty = {"count": 0, "tracks": 0, "score_min": None, "score_max": None,
             "score_mean": None, "highest": None,
             "track_total": 0, "with_anomalies": 0, "with_irregular": 0}
    with connect() as conn:
        if conn is None or not _has_table(conn, "track_events"):
            return empty
        agg = conn.execute(
            "SELECT COUNT(*) AS n, COUNT(DISTINCT track_id) AS tracks,"
            " MIN(fused_score) AS mn, MAX(fused_score) AS mx,"
            " AVG(fused_score) AS mean FROM track_events"
            " WHERE session = ? AND level != 'Normal'", (session,)).fetchone()
        highest = conn.execute(
            "SELECT id, frame_idx, track_id, level, fused_score FROM track_events"
            " WHERE session = ? AND level != 'Normal'"
            " ORDER BY fused_score DESC, id ASC LIMIT 1", (session,)).fetchone()
        tracks = conn.execute(
            "SELECT COUNT(*) AS total,"
            " SUM(CASE WHEN anomalies > 0 THEN 1 ELSE 0 END) AS with_anomalies,"
            " SUM(CASE WHEN irregular > 0 THEN 1 ELSE 0 END) AS with_irregular"
            " FROM (SELECT track_id,"
            "   SUM(CASE WHEN level != 'Normal' THEN 1 ELSE 0 END) AS anomalies,"
            "   SUM(CASE WHEN level = 'Irregular' THEN 1 ELSE 0 END) AS irregular"
            "  FROM track_events WHERE session = ? GROUP BY track_id)",
            (session,)).fetchone()
    return {
        "count": int(agg["n"] or 0),
        "tracks": int(agg["tracks"] or 0),
        "score_min": _round(agg["mn"], 3),
        "score_max": _round(agg["mx"], 3),
        "score_mean": _round(agg["mean"], 3),
        "highest": ({"event_id": int(highest["id"]),
                     "frame": int(highest["frame_idx"]),
                     "track_id": int(highest["track_id"]),
                     "level": highest["level"],
                     "fused_score": _round(highest["fused_score"], 3)}
                    if highest is not None else None),
        "track_total": int(tracks["total"] or 0),
        "with_anomalies": int(tracks["with_anomalies"] or 0),
        "with_irregular": int(tracks["with_irregular"] or 0),
    }


def export_tracks(session: str) -> list[list]:
    _, rows = _track_rows(session, limit=None)
    out: list[list] = []
    for row in rows:
        track = track_from_row(row, _session_fps(session))
        out.append([
            track["track_id"], track["appearance"]["color"],
            track["appearance"]["shape"], track["frames"]["first"],
            track["frames"]["last"], track["observed"]["observations"],
            track["observed"]["anomalies"], track["observed"]["levels"]["Normal"],
            track["observed"]["levels"]["Suspicious"],
            track["observed"]["levels"]["Irregular"],
            track["observed"]["worst_level"], track["observed"]["duration_s"],
            track["motion"]["mean_speed_px_s"], track["motion"]["max_speed_px_s"],
            track["motion"]["path_length_px"], track["motion"]["straightness"],
            ";".join(track["motion"]["summary_directions"]),
        ])
    return out
