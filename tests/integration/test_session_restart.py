"""Two-process restart integration test for durable session intelligence.

Process A is a real uvicorn server on its own port; it accepts an uploaded
video, runs a real analysis job, persists the session and returns its
trajectory and calibration snapshot. The process is then shut down. Process B
is a second, independent uvicorn process on a different port, pointed at the
same temporary SQLite file, and must return exactly the same session data.

Nothing is mocked: both processes run the production app, the real database
layer and the real OpenCV pipeline. No production database or upload directory
is touched.
"""
from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import httpx

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = Path(__file__).with_name("_restart_server.py")
SAMPLE = ROOT / "samples" / "anomaly_clip.mp4"

MAX_FRAMES = 40
STARTUP_TIMEOUT_S = 60.0
JOB_TIMEOUT_S = 180.0


def _log_tail(path: Path, limit: int = 6000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "(no server log)"
    return text[-limit:] or "(empty server log)"


def _free_port() -> int:
    """Reserve a currently free loopback port for this process only."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@contextmanager
def _server(db: Path, upload_dir: Path,
            log_path: Path) -> Iterator[tuple[subprocess.Popen, httpx.Client]]:
    """Start one real uvicorn OS process and always stop it afterwards."""
    assert LAUNCHER.is_file(), f"missing uvicorn launcher {LAUNCHER}"
    port = _free_port()
    env = os.environ.copy()
    env["NEURAL_TEST_DB"] = str(db)
    env["NEURAL_UPLOAD_DIR"] = str(upload_dir)
    env["NEURAL_JOB_WORKERS"] = "1"
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ROOT)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))

    log = log_path.open("wb")
    proc = subprocess.Popen(
        [sys.executable, str(LAUNCHER), str(port)],
        cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    client = httpx.Client(
        base_url=f"http://127.0.0.1:{port}",
        timeout=httpx.Timeout(connect=5.0, read=30.0, write=60.0, pool=5.0),
        follow_redirects=False)
    try:
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        while True:
            if proc.poll() is not None:
                raise AssertionError(
                    f"uvicorn exited during startup (code {proc.returncode}):\n"
                    f"{_log_tail(log_path)}")
            try:
                if client.get("/health").status_code == 200:
                    break
            except httpx.TransportError:
                pass
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"uvicorn did not become healthy within "
                    f"{STARTUP_TIMEOUT_S:.0f}s:\n{_log_tail(log_path)}")
            time.sleep(0.2)
        yield proc, client
    finally:
        client.close()
        if proc.poll() is None:
            proc.terminate()                 # graceful SIGTERM, runs shutdown
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        log.close()


def _wait_for_job(client: httpx.Client, job_id: str) -> dict:
    deadline = time.monotonic() + JOB_TIMEOUT_S
    while True:
        response = client.get(f"/api/v1/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()["job"]
        if job["state"] == "completed":
            return job
        if job["state"] in ("failed", "cancelled"):
            raise AssertionError(
                f"analysis job {job_id} ended {job['state']}: {job.get('error')}")
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"analysis job {job_id} still {job['state']} after "
                f"{JOB_TIMEOUT_S:.0f}s")
        time.sleep(0.5)


def _stored_rows(db: Path, session: str) -> tuple[list[tuple], tuple | None]:
    """Read the isolated SQLite file directly, independent of the API."""
    conn = sqlite3.connect(db)
    try:
        points = conn.execute(
            "SELECT track_id, frame_idx, ts_s, x, y, speed_px_s, direction_deg"
            " FROM track_points WHERE session = ?"
            " ORDER BY track_id, frame_idx", (session,)).fetchall()
        snapshot = conn.execute(
            "SELECT schema_version, captured_ts, payload"
            " FROM calibration_snapshots WHERE session = ?",
            (session,)).fetchone()
    finally:
        conn.close()
    return points, snapshot


def _session_read(client: httpx.Client, session: str,
                  track_ids: list[int]) -> dict:
    """Collect the complete persisted response set for one session."""
    detail = client.get(f"/api/v1/sessions/{session}")
    assert detail.status_code == 200, detail.text
    scene = client.get(f"/api/v1/sessions/{session}/scene")
    assert scene.status_code == 200, scene.text
    trajectories = {}
    for track_id in track_ids:
        response = client.get(
            f"/api/v1/sessions/{session}/tracks/{track_id}/trajectory")
        assert response.status_code == 200, response.text
        trajectories[str(track_id)] = response.json()
    return {"detail": detail.json(), "scene": scene.json(),
            "trajectories": trajectories}


def test_session_survives_a_real_uvicorn_restart(tmp_path: Path) -> None:
    assert SAMPLE.is_file(), f"missing sample video {SAMPLE}"

    db = tmp_path / "restart.db"
    uploads = tmp_path / "uploads"
    logs = tmp_path / "logs"
    logs.mkdir()

    # ---------------------------------------------------------------- process A
    with _server(db, uploads, logs / "process_a.log") as (proc_a, client_a):
        system_a = client_a.get("/system")
        assert system_a.status_code == 200, system_a.text
        assert system_a.json()["runtime"]["pid"] == proc_a.pid

        upload = client_a.post(
            "/api/v1/videos/upload",
            files={"file": (SAMPLE.name, SAMPLE.read_bytes(), "video/mp4")})
        assert upload.status_code == 201, upload.text
        upload_id = upload.json()["upload_id"]

        created = client_a.post("/api/v1/jobs", json={
            "source": {"kind": "upload", "ref": upload_id},
            "max_frames": MAX_FRAMES,
        })
        assert created.status_code == 202, created.text
        job = _wait_for_job(client_a, created.json()["job"]["job_id"])
        session = job["session_id"]

        tracks_a = client_a.get(f"/api/v1/sessions/{session}/tracks")
        assert tracks_a.status_code == 200, tracks_a.text
        track_ids = sorted(track["track_id"]
                           for track in tracks_a.json()["tracks"])
        assert track_ids, "the real analysis produced no tracks"

        a = _session_read(client_a, session, track_ids)
        assert a["trajectories"], "no trajectory responses"
        for trajectory in a["trajectories"].values():
            assert trajectory["available"] is True
            assert trajectory["source"] == "persisted"
            assert trajectory["points"], "persisted trajectory has no points"
        calibration_a = a["scene"]["calibration"]
        assert calibration_a["available"] is True
        assert calibration_a["persisted"] is True
        assert a["detail"]["artifacts"]["trajectories"] is True
        assert a["detail"]["artifacts"]["scene_calibration"] is True

        pid_a = system_a.json()["runtime"]["pid"]
        point_total = sum(len(t["points"])
                          for t in a["trajectories"].values())
        print(f"\n[restart] process A pid={pid_a} port={client_a.base_url} "
              f"session={session} tracks={track_ids} points={point_total}")
        (tmp_path / "process_a_responses.json").write_text(
            json.dumps({"session": session, "track_ids": track_ids, **a},
                       indent=2), encoding="utf-8")

    assert proc_a.poll() is not None, "process A was not stopped"

    # The session must survive on disk alone, with A's memory gone.
    points_a, snapshot_a = _stored_rows(db, session)
    assert points_a, "no track_points rows persisted"
    assert snapshot_a is not None, "no calibration snapshot persisted"
    expected_points = sum(len(t["points"])
                          for t in a["trajectories"].values())
    assert len(points_a) == expected_points
    assert snapshot_a[0] == calibration_a["snapshot_version"]
    assert snapshot_a[1] == calibration_a["captured_ts"]
    stored_payload = json.loads(snapshot_a[2])
    assert stored_payload["calibration"]["n_samples"] == calibration_a["samples"]
    frames_by_track: dict[int, list[int]] = {}
    for track_id, frame_idx, *_ in points_a:
        frames_by_track.setdefault(track_id, []).append(frame_idx)
    for frames in frames_by_track.values():
        assert frames == sorted(set(frames)), "frames must be stored once, in order"

    # ---------------------------------------------------------------- process B
    with _server(db, uploads, logs / "process_b.log") as (proc_b, client_b):
        system_b = client_b.get("/system")
        assert system_b.status_code == 200, system_b.text
        pid_b = system_b.json()["runtime"]["pid"]
        assert pid_b == proc_b.pid
        assert pid_b != pid_a, "process B reused process A's interpreter"

        b = _session_read(client_b, session, track_ids)
        (tmp_path / "process_b_responses.json").write_text(
            json.dumps({"session": session, "track_ids": track_ids, **b},
                       indent=2), encoding="utf-8")
        restored_total = sum(len(t["points"])
                             for t in b["trajectories"].values())
        print(f"[restart] process B pid={pid_b} port={client_b.base_url} "
              f"restored_points={restored_total}")

    assert proc_b.poll() is not None, "process B was not stopped"

    # --------------------------------------------------------- restored result
    assert b["detail"]["session"] == a["detail"]["session"] == session
    assert b["detail"]["timestamps"] == a["detail"]["timestamps"]
    assert b["detail"]["counts"] == a["detail"]["counts"]
    assert b["detail"]["frame_range"] == a["detail"]["frame_range"]
    assert b["detail"]["artifacts"]["retained"] is False
    assert b["detail"]["artifacts"]["trajectories"] is True
    assert b["detail"]["artifacts"]["scene_calibration"] is True
    assert b["trajectories"].keys() == a["trajectories"].keys()

    for track_id, trajectory_a in a["trajectories"].items():
        trajectory_b = b["trajectories"][track_id]
        assert trajectory_b["source"] == "persisted"
        assert trajectory_b["available"] is True
        assert len(trajectory_b["points"]) == len(trajectory_a["points"])
        assert [point["frame"] for point in trajectory_b["points"]] == [
            point["frame"] for point in trajectory_a["points"]]
        assert trajectory_b["points"] == trajectory_a["points"]
        for point in trajectory_b["points"]:
            # Coordinates are stored observations, never interpolated values.
            assert point["x"] is not None and point["y"] is not None

    assert b["scene"]["calibration"] == a["scene"]["calibration"]
    calibration_b = b["scene"]["calibration"]
    assert calibration_b["snapshot_version"] == calibration_a["snapshot_version"]
    assert calibration_b["captured_ts"] == calibration_a["captured_ts"]
    assert calibration_b["samples"] == calibration_a["samples"]
    assert b["scene"]["speed_baseline"]["source"] == "run_calibration"
    assert b["scene"]["directions"]["source"] == "run_calibration"
    assert b["scene"] == a["scene"]

    after_points, after_snapshot = _stored_rows(db, session)
    assert after_points == points_a
    assert after_snapshot == snapshot_a
