"""Phase 6 tests: visualization, logging, and an end-to-end run on a real
generated video file (written with cv2.VideoWriter and re-read through
VideoSource, exactly as the deployed app consumes it)."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, ROOT)

from config.config import SETTINGS, AppPaths
from src.analysis.logger import ResultLogger
from src.pipeline import TrackingPipeline
from src.ui import visualization
from src.video.video_input import VideoSource
import importlib

gen = importlib.import_module("scripts.generate_samples")


# ------------------------------------------------------------------ viz
def test_draw_tracked_objects_annotates_and_keeps_size():
    frame = np.zeros((240, 320, 3), np.uint8)
    entries = [{
        "frame_idx": 3, "track_id": 0, "centroid": (160.0, 120.0),
        "bbox_wh": (40.0, 40.0), "color": "green", "shape": "circle",
        "speed_px_s": 120.0, "direction_deg": 0.0,
        "trajectory": [(0, 120, 120), (1, 140, 120), (2, 160, 120)],
        "level": "Suspicious", "why": "speed 180 px/s is 4.0 sdevs above median",
    }]
    out = visualization.draw_tracked_objects(frame, entries)
    assert out.shape == frame.shape
    # something bright got drawn where the object is
    assert out[118:123, 138:183].max() > 50


def test_draw_calibration_badge_changes_frame():
    frame = np.zeros((100, 200, 3), np.uint8)
    out = visualization.draw_calibration_badge(frame, ready=True, n_samples=99)
    assert out.shape == frame.shape
    assert (out != frame).any()


def test_empty_entries_no_crash():
    frame = np.zeros((80, 80, 3), np.uint8)
    out = visualization.draw_tracked_objects(frame, [])
    assert out.shape == frame.shape


# ------------------------------------------------------------------ logger
def test_logger_events_csv_and_queries(tmp_path):
    log = ResultLogger(tmp_path / "t.db", session="s1")
    entry = {
        "track_id": 1, "level": "Irregular", "fused_score": 0.8,
        "rule_score": 0.9, "ml_score": 0.7, "scene_score": 0.4,
        "speed_px_s": 300.0, "direction_deg": 180.0,
        "why": "speed 300 px/s is 6.0 sdevs above the mean",
    }
    log.log_event(5, entry)
    log.log_event(6, {**entry, "level": "Normal", "fused_score": 0.1})
    summary_stub = type("S", (), {
        "track_id": 1, "n_points": 30, "n_seconds": 2.0, "mean_speed_px_s": 90.0,
        "max_speed_px_s": 300.0, "path_length_px": 400.0, "straightness": 0.9,
        "direction_hist": {"E": 29},
    })()
    log.log_track_summary(summary_stub, "green", "circle", 0, 30)
    counts = log.counts_by_level()
    assert counts == {"Irregular": 1, "Normal": 1}
    anomalies = log.recent_anomalies(limit=10)
    assert len(anomalies) == 1 and anomalies[0][3] == "Irregular"
    csv_path = log.export_csv(tmp_path / "events.csv")
    assert csv_path.exists() and csv_path.stat().st_size > 100
    traj_csv = log.export_trajectories_csv(tmp_path / "tracks.csv")
    assert traj_csv.exists()
    assert "track_id" in traj_csv.read_text().splitlines()[0]
    log.close()


# ------------------------------------------------------------------ e2e
@pytest.fixture(scope="module")
def sample_videos(tmp_path_factory):
    d = tmp_path_factory.mktemp("videos")
    fps = 30.0
    gen._write(d / "normal.mp4", gen.normal_traffic(fps=fps), fps)
    gen._write(d / "anomaly.mp4", gen.anomaly_clip(fps=fps), fps)
    return d / "normal.mp4", d / "anomaly.mp4"


def _run_file(path, logger=None, max_frames=None, session="t"):
    with VideoSource(src=str(path)) as vs:
        pipeline = TrackingPipeline(session=session, logger=logger)
        results = []
        for vf in vs:
            results.append(pipeline.process_frame(vf.bgr, vf.index, vf.fps))
            if max_frames and len(results) >= max_frames:
                break
        summaries = pipeline.summarize_tracks(vs.fps)
    return pipeline, results, summaries


def test_e2e_normal_video_tracks_objects_and_calibrates(sample_videos):
    normal_path = sample_videos[0]
    pipeline, results, summaries = _run_file(normal_path, session="e2e-normal")
    assert len(results) >= 200          # ~10 s @ 30 fps decoded
    assert results[-1].calibrated       # steady traffic -> should self-calibrate
    per_frame_positive = [r for r in results if r.n_detections >= 2]
    assert len(per_frame_positive) > len(results) * 0.8   # bundle at most frames
    ids = {e["track_id"] for r in results for e in r.entries}
    assert 2 <= len(ids) <= 4, f"unexpected track ids {ids}"
    speeds = [e["speed_px_s"] for r in results for e in r.entries
              if e["speed_px_s"] > 1]
    assert speeds and np.mean(speeds) > 20     # px/s of the moving shapes


def test_e2e_anomaly_video_flags_irregular_somewhere(sample_videos):
    _, anomaly_path = sample_videos
    pipeline, results, summaries = _run_file(anomaly_path, session="e2e-anomaly")
    levels = [e["level"] for r in results for e in r.entries if e["level"] != "Normal"]
    assert len(levels) > 0, "expected at least one non-Normal verdict"
    whys = [e["why"] for r in results for e in r.entries if e["level"] != "Normal"]
    assert any(len(w) > 20 for w in whys)     # human readable explanations


def test_e2e_with_logger_produces_artifacts(tmp_path, sample_videos):
    db = tmp_path / "e2e.db"
    log = ResultLogger(db, session="e2e-logged")
    try:
        normal_path = sample_videos[0]
        _run_file(normal_path, logger=log, max_frames=200, session="e2e-logged")
        csv_path = log.export_csv(tmp_path / "events.csv")
        traj_csv = log.export_trajectories_csv(tmp_path / "tracks.csv")
        assert db.exists() and csv_path.exists()
        rows = (tmp_path / "events.csv").read_text().strip().splitlines()
        assert len(rows) > 50           # many events logged
        assert "level" in rows[0]
        # each labelled level in known vocabulary
        lvl_col = rows[0].split(",").index("level")
        levels = {r.split(",")[lvl_col] for r in rows[1:]}
        assert levels <= {"Normal", "Suspicious", "Irregular"}
        assert traj_csv.exists()
        counts = log.counts_by_level()
        assert counts.get("Normal", 0) + counts.get("Suspicious", 0) \
            + counts.get("Irregular", 0) > 50
    finally:
        log.close()


def test_e2e_noise_video_runs_clean(sample_videos):
    tmp = Path(str(sample_videos[0]))
    gen._write(tmp.parent / "noise.mp4", gen.tiny_noise(fps=10.0), 10.0)
    pipeline, results, _ = _run_file(tmp.parent / "noise.mp4", session="e2e-noise")
    assert len(results) > 20
    # no crash; almost everything should be Normal or unconfirmed
    assert all(e["level"] in ("Normal", "Suspicious", "Irregular")
               for r in results for e in r.entries)
