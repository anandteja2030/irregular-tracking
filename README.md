# Intelligent Irregular Object Tracking and Scene-Aware Anomaly Detection

A real Python computer-vision project (no website-only mockup): it *sees and
tracks* coloured objects on a webcam or video file, *learns* per-object and
scene behaviour, and *explains* what is unusual about any object, in words, on
a live annotated view and a Streamlit dashboard. All detections/verdicts are
logged to SQLite and exportable as CSV.

## What it does (objectives → modules)

| Objective | Modules |
| --- | --- |
| 1. SEE & TRACK — video input, preprocessing, HSV colour detection, contour shape detection, tracking | `src/video/video_input.py`, `src/video/preprocessing.py`, `src/video/detection.py` |
| 1. tracking — Kalman constant-velocity filter, Hungarian assignment, unique IDs, trajectory history | `src/tracking/kalman.py`, `src/tracking/track_manager.py` |
| 2. LEARN & ANALYZE — speed/direction/acceleration features, self-calibration, per-object + scene-relative comparison | `src/analysis/features.py`, `src/analysis/calibration.py` |
| 3. DETECT, EXPLAIN & SHOW — rules, Isolation Forest, signal fusion, Normal/Suspicious/Irregular, explanations, OpenCV visualization, logging, dashboard | `src/anomaly/rules.py`, `src/anomaly/isolation.py`, `src/anomaly/fusion.py`, `src/ui/visualization.py`, `src/analysis/logger.py`, `src/pipeline.py`, `src/ui/dashboard.py` |

Everything is parameterised from one file: `config/config.py` (HSV ranges,
tracking gates, rules/ML weights, calibration warm-up).

## Quick start (local machine with a webcam)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 1. generate the bundled sample/test videos
.venv/bin/python scripts/generate_samples.py          # -> samples/*.mp4

# 2. run the test suite (offline, uses only virtual video sources)
.venv/bin/python -m pytest tests -q

# 3. run the pipeline on a sample video from the CLI
.venv/bin/python -m scripts.run_pipeline samples/anomaly_clip.mp4

# 4. open the dashboard
.venv/bin/streamlit run src/ui/dashboard.py
```

- **Webcam:** pass `0`: `python -m scripts.run_pipeline 0` — requires a real
  camera device; nothing here can verify it from CI.
- Any video file (mp4/avi/mkv) works the same way: `python -m scripts.run_pipeline path/to/file.mp4`.
- Annotated frames + summaries are written under `output/`; SQLite events to
  `data/app_data.db` and CSV exports on demand.

## Docker (production)

The image is `python:3.12-slim` + OpenCV system libs + `requirements.txt`,
runs as a non-root user, exposes 8501 and listens on `$PORT` (default 8501).
Streamlit runs headless from `.streamlit/config.toml` (address `0.0.0.0`,
XSRF/CORS protection on, telemetry off, 64 MB upload limit). **No secrets are
stored in the repo or image** - inject them via your platform's environment.

```bash
# 1. build the image
docker build -t irregular-tracking:latest .

# 2. run it (host 8501 -> container $PORT, default 8501)
docker run --rm -p 8501:8501 \
  -v irregular-data:/app/data -v irregular-output:/app/output \
  irregular-tracking:latest

# 3. verify health (endpoint verified on streamlit 1.66.x: 200 + body "ok")
curl -f http://localhost:8501/_stcore/health && echo " healthy"

# 4. run the 63-test suite inside the image
docker run --rm irregular-tracking:latest python -m pytest tests -q

# 5. or bring the stack up with Compose (persistent volumes for SQLite logs
#    and exported artifacts; see docker-compose.yml)
docker compose up --build -d
docker compose ps            # STATUS should become "healthy"
docker compose down          # stop (volumes are kept)
```

- **Port selection:** set `PORT` (what platforms like Railway/Fly/Render
  inject) and optionally `HOST_PORT` for the published port, e.g.
  `PORT=9000 HOST_PORT=80 docker compose up --build -d`.
- **Persistent storage:** named volumes `app-data` -> `/app/data`
  (SQLite `app_data.db`) and `app-output` -> `/app/output` (CSV/frames),
  matching `config/config.py` paths. They survive `docker compose down`.
- **Health check:** `HEALTHCHECK` polls `/_stcore/health` every 30 s using
  Python stdlib (no curl needed in the slim image).
- The image bakes in the sample videos under `samples/` so the dashboard's
  sample-picker works immediately after deployment.

## Architecture

```
config/config.py            all tunables (HSV ranges, gates, rule/ML weights)
src/video/                  video sources (webcam/file/callables), HSV prep,
                            colour + shape detection
src/tracking/               Kalman filter (NumPy replication) + TrackManager
                            (Hungarian via scipy, IDs, trajectories)
src/analysis/               movement features, scenario self-calibration,
                            SQLite/CSV logging
src/anomaly/                rule engine, Isolation Forest, weighted fusion
src/ui/                     OpenCV overlay + Streamlit dashboard
scripts/generate_samples.py synthetic sample videos
scripts/run_pipeline.py     CLI entry point
tests/                      pytest suites per phase (63 tests)
```

## Anomaly reasoning — how each verdict is produced

Every tracked object every frame gets three independent scores:

1. **rule-based signals** (calibrated): excessive speed (z-score vs the
   learned distribution), direction against dominant flow, erratic heading
   change, sudden acceleration, loitering (long dwell, low straightness).
2. **IsolationForest** on robust-scaled `speed / heading-change / acceleration`
   windows, global across the session *and* a per-track rolling window.
3. **scene-relative** score from the self-calibrator (speed ratio vs the
   scene p90, octant flow direction).

`AnomalyFusion` weights them (rule 0.45, ML 0.35, scene 0.20 - tunable) into a
fused score, then classifies `Normal < 0.35 <= Suspicious < 0.65 <= Irregular`.
`explain()` attaches short human-readable reasons, e.g.
*"speed 180 px/s is 4.0 standard deviations above the calibrated mean (50 px/s)"*.

## Self-calibration

`ScenarioCalibrator` learns from the warm-up window (default: ≥2 distinct
tracks, ≥12 s observed, ≥30 movement samples): speed p10/p50/p90, std, and an
8-octant direction histogram with dominant-flow labels. Before calibration the
ML/scene streams stay quiet; after it, rules and scene-relative scoring switch
on (`SceneStats.ready`), so behaviour is judged relative to the actual scene.

## What is verified vs what is not

**Verified by the test suite (63 tests, all passing):**
- video-input contract, preprocessing purity/cleanup, HSV masks incl. red
  wrap-around, shape classification, area filters
- Kalman constant-velocity convergence, noisy-measurement smoothing,
  Hungarian 1:1 assignment, ID stability, position-gate rejection, coasting
  through missed detections, trajectory history
- speed/direction/acceleration math, straightness, calibrator readiness and
  percentiles, scene-relative scoring
- rule severity bounds, Isolation-Forest low-scores-normal / high-scores-
  anomalous behaviour, per-track shift detection, fusion levels,
  human-readable explanations
- SQLite logging + CSV export contracts
- **end-to-end on real video files** generated by `scripts/generate_samples.py`:
  normal clip calibrates and tracks; anomaly clip yields non-Normal verdicts
  with explanations; noise clip runs clean; logger writes DB/CSV

**Not verified here (requires hardware):**
- **Webcam playback** `VideoSource(src=0)` is implemented via cv2 but cannot
  be exercised from this environment - run it on a machine with a camera.
- **Streamlit interactive UX** was smoke-tested (server boots, page serves
  HTTP 200, no import/runtime errors in its log); clicking through upload /
  sliders in a browser is left to the user.
- My colour ranges are tuned for saturated shapes on dark backgrounds
  (like the samples); real footage needs `config/config.py` range tuning.

## Notes / honest caveats

- `opencv-python-headless` is used for VM compatibility; on a desktop with a
  display you may prefer `opencv-python`. No GUI window is opened by the CLI.
- Sample videos are MJPEG/MP4 (`mp4v` fallback is normal in the OpenCV logging).
- Known simplified area: two objects that heavily and persistently overlap
  can, in edge cases, swap IDs (an intrinsic limitation of IoU/position-only
  matching without appearance features); the colour/shape labels attached at
  birth keep human-readable context. This is documented, not hidden.
- Positions/velocities are in pixels and px/s; adding a homography for
  real-world m/s would be a natural next step.

## Testing

```bash
.venv/bin/python -m pytest tests -q         # full suite
.venv/bin/python scripts/generate_samples.py
.venv/bin/python -m scripts.run_pipeline samples/anomaly_clip.mp4
```

Logs: `data/app_data.db` (tables `track_events`, `track_summaries`),
`output/*.csv`.
