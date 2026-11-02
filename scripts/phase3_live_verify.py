"""Live HTTP verification for the Phase 3 analytics API.

Runs against a real uvicorn process and the real project database, then starts
one real short analysis job so media/evidence/scene endpoints are exercised
with genuine pipeline output. Cross-checks every count against SQLite.

Usage:
    .venv/bin/python scripts/phase3_live_verify.py [base_url]
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import sys
import time
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
REPO = Path(__file__).resolve().parents[1]
DB = REPO / "data" / "app_data.db"
PRIOR_SESSION = "api_20261031_170640_0c6d6c"

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}" + (f" — {detail}" if detail else ""))
    if not condition:
        failures.append(label)


def q(sql: str, params: tuple = ()) -> int:
    conn = sqlite3.connect(DB)
    try:
        return int(conn.execute(sql, params).fetchone()[0])
    finally:
        conn.close()


def main() -> int:
    client = httpx.Client(base_url=BASE, timeout=120.0)

    health = client.get("/health").json()
    print("health:", health)
    check("health endpoint", health["status"] == "ok")

    listing = client.get("/api/v1/sessions", params={"limit": 100}).json()
    db_sessions = q("SELECT COUNT(*) FROM (SELECT session FROM run_stats"
                    " UNION SELECT session FROM track_events)")
    print(f"sessions: api={listing['total']} db={db_sessions}")
    check("session count matches database", listing["total"] == db_sessions)
    ids = [s["session"] for s in listing["sessions"]]
    print("session ids:", ids)

    # ---------------------------------------------------- prior Phase 2 session
    detail = client.get(f"/api/v1/sessions/{PRIOR_SESSION}").json()
    db_obs = q("SELECT COUNT(*) FROM track_events WHERE session = ?",
               (PRIOR_SESSION,))
    db_anom = q("SELECT COUNT(*) FROM track_events WHERE session = ?"
                " AND level != 'Normal'", (PRIOR_SESSION,))
    db_tracks = q("SELECT COUNT(DISTINCT track_id) FROM track_events"
                  " WHERE session = ?", (PRIOR_SESSION,))
    print(f"prior session: observations={detail['counts']['observations']}"
          f" tracks={detail['counts']['tracks']} anomalies={detail['counts']['anomalies']}")
    check("prior observations match DB",
          detail["counts"]["observations"] == db_obs, f"{db_obs}")
    check("prior tracks match DB", detail["counts"]["tracks"] == db_tracks,
          f"{db_tracks}")
    check("prior anomalies match DB",
          detail["counts"]["anomalies"] == db_anom, f"{db_anom}")

    summary = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/summary").json()
    check("summary frames match run_stats",
          summary["processing"]["frames_processed"]
          == q("SELECT frames FROM run_stats WHERE session = ?",
               (PRIOR_SESSION,)))
    check("summary anomaly count matches DB",
          summary["anomalies"]["count"] == db_anom)

    tracks = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/tracks").json()
    check("track list matches DB distinct ids", tracks["total"] == db_tracks)
    for track in tracks["tracks"]:
        tid = track["track_id"]
        rows = q("SELECT COUNT(*) FROM track_events WHERE session = ?"
                 " AND track_id = ?", (PRIOR_SESSION, tid))
        check(f"track {tid} observations match DB",
              track["observed"]["observations"] == rows, f"{rows}")
        series = client.get(
            f"/api/v1/sessions/{PRIOR_SESSION}/tracks/{tid}/observations").json()
        check(f"track {tid} observation endpoint matches DB",
              series["total"] == rows)

    anomalies = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/anomalies",
                           params={"limit": 5}).json()
    check("anomaly list matches DB", anomalies["total"] == db_anom)
    check("anomaly evidence honestly reported unavailable",
          anomalies["anomalies"][0]["evidence"]["available"] is False)
    rule_filter = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/anomalies",
                             params={"event_type": "loitering"})
    check("rule filter explains missing structured evidence",
          rule_filter.status_code == 400
          and rule_filter.json()["error"]["code"] == "event_type_unavailable")
    ml_filter = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/anomalies",
                           params={"event_type": "ml"}).json()
    ml_db = q("SELECT COUNT(*) FROM track_events WHERE session = ?"
              " AND level != 'Normal' AND ml_score > 0", (PRIOR_SESSION,))
    check("event_type=ml matches DB score column", ml_filter["total"] == ml_db,
          f"{ml_db}")

    trajectory = client.get(
        f"/api/v1/sessions/{PRIOR_SESSION}/tracks/1/trajectory").json()
    check("historical trajectory marked unavailable with reason",
          trajectory["available"] is False and bool(trajectory["reason"]))

    media = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/media").json()
    check("historical media marked unavailable",
          media["available"] is False and media["frames"] == [])

    frame = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/frames/0")
    check("historical frame returns explicit 404",
          frame.status_code == 404
          and frame.json()["error"]["code"] == "media_not_available")

    scene = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/scene").json()
    check("scene derived from persisted observations",
          scene["source"] == "derived_observations"
          and scene["speed_baseline"]["samples"] > 0)
    check("calibration honestly unavailable for history",
          scene["calibration"]["available"] is False)

    evaluation = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/evaluation").json()
    labels = q("SELECT COUNT(*) FROM ground_truth WHERE session = ?",
               (PRIOR_SESSION,))
    check("evaluation availability matches labels",
          (labels > 0) == evaluation["available"], f"labels={labels}")
    check("evaluation metrics null without labels",
          (evaluation["metrics"] is None) == (labels == 0))

    exported = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/export/csv")
    rows = list(csv.reader(io.StringIO(exported.text)))
    check("event CSV row count matches DB", len(rows) - 1 == db_obs,
          f"{len(rows) - 1}")
    check("event CSV is session-scoped",
          all(row[1] != "2026-10-28T18:48:47+00:00" for row in rows[1:]))
    track_csv = list(csv.reader(io.StringIO(client.get(
        f"/api/v1/sessions/{PRIOR_SESSION}/export/csv",
        params={"dataset": "tracks"}).text)))
    check("track CSV row count matches DB", len(track_csv) - 1 == db_tracks)

    report = client.get(f"/api/v1/sessions/{PRIOR_SESSION}/report")
    check("markdown report served",
          report.status_code == 200 and report.text.startswith("# NEURAL COMMAND")
          and PRIOR_SESSION in report.text)
    check("report discloses missing labels", "Not available" in report.text)

    # isolation: another session must not leak this one's rows
    other = next((sid for sid in ids if sid != PRIOR_SESSION), None)
    if other:
        other_csv = client.get(f"/api/v1/sessions/{other}/export/csv").text
        check("CSV isolation between sessions",
              PRIOR_SESSION not in other_csv)

    # ---------------------------------------------------------- live sitemap
    spec = client.get("/openapi.json").json()
    paths = [p for p in spec["paths"] if p.startswith("/api/v1/sessions")]
    check("16 analytics paths documented once", len(paths) == 16, str(len(paths)))

    # ------------------------------------------------------- real live job
    created = client.post("/api/v1/jobs", json={
        "source": {"kind": "sample", "ref": "anomaly_clip.mp4"},
        "max_frames": 30,
    })
    check("job accepted", created.status_code == 202, created.text[:120])
    job_id = created.json()["job"]["job_id"]
    snapshot = {}
    deadline = time.time() + 120
    while time.time() < deadline:
        snapshot = client.get(f"/api/v1/jobs/{job_id}").json()["job"]
        if snapshot["state"] in ("completed", "failed", "cancelled"):
            break
        time.sleep(0.2)
    print("job:", json.dumps(snapshot["result"]), snapshot["state"])
    check("live job completed", snapshot["state"] == "completed")
    session = snapshot["session_id"]

    live_detail = client.get(f"/api/v1/sessions/{session}").json()
    live_obs = q("SELECT COUNT(*) FROM track_events WHERE session = ?",
                 (session,))
    check("new session observations match DB",
          live_detail["counts"]["observations"] == live_obs, f"{live_obs}")
    check("new session artifacts retained",
          live_detail["artifacts"]["retained"] is True)

    live_media = client.get(f"/api/v1/sessions/{session}/media").json()
    check("preview frames listed", live_media["available"]
          and len(live_media["frames"]) > 0, f"{live_media['preview_count']}")
    jpeg = client.get(live_media["frames"][0]["annotated_url"])
    check("frame endpoint returns JPEG",
          jpeg.status_code == 200
          and jpeg.headers["content-type"] == "image/jpeg"
          and jpeg.content.startswith(b"\xff\xd8"),
          f"{len(jpeg.content)} bytes")
    original = client.get(live_media["frames"][0]["original_url"])
    check("original frame endpoint returns JPEG",
          original.status_code == 200
          and original.content.startswith(b"\xff\xd8"),
          f"{len(original.content)} bytes")
    gap = client.get(f"/api/v1/sessions/{session}/frames/1")
    check("non-preview frame returns explicit 404",
          gap.status_code == 404
          and gap.json()["error"]["code"] == "frame_not_available")

    live_tracks = client.get(f"/api/v1/sessions/{session}/tracks").json()
    tid = live_tracks["tracks"][0]["track_id"]
    live_traj = client.get(
        f"/api/v1/sessions/{session}/tracks/{tid}/trajectory").json()
    check("trajectory available for live session",
          live_traj["available"] and len(live_traj["points"]) > 0,
          f"{len(live_traj['points'])} points")

    live_anomalies = client.get(f"/api/v1/sessions/{session}/anomalies",
                                params={"limit": 500}).json()
    db_live_anom = q("SELECT COUNT(*) FROM track_events WHERE session = ?"
                     " AND level != 'Normal'", (session,))
    check("live anomaly count matches DB",
          live_anomalies["total"] == db_live_anom, f"{db_live_anom}")
    rules_seen = set()
    for anomaly in live_anomalies["anomalies"]:
        check_single = anomaly["evidence"]["available"]
        if not check_single:
            failures.append("anomaly evidence missing for live session")
            print("[FAIL] anomaly evidence missing for live session")
            break
        rules_seen.update(rule["rule"] for rule in anomaly["evidence"]["rules"])
    print("rules seen in live evidence:", sorted(rules_seen))

    live_scene = client.get(f"/api/v1/sessions/{session}/scene").json()
    check("calibration available for live session",
          live_scene["source"] == "run_calibration"
          and live_scene["calibration"]["available"] is True)
    print("calibration:", json.dumps(live_scene["calibration"]))

    live_eval = client.get(f"/api/v1/sessions/{session}/evaluation").json()
    check("new session has no labels and says so",
          live_eval["available"] is False and live_eval["metrics"] is None)

    live_csv = client.get(f"/api/v1/sessions/{session}/export/csv")
    check("live CSV row count matches DB",
          live_csv.headers["X-Row-Count"] == str(live_obs),
          live_csv.headers["X-Row-Count"])
    live_report = client.get(f"/api/v1/sessions/{session}/report").text
    check("live report contains session and results",
          session in live_report and "Detection & tracking" in live_report)

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        return 1
    print("ALL LIVE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
