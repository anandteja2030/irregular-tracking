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
- **Supported inputs:** the CLI opens any video OpenCV/ffmpeg can decode (mp4,
  avi, mov, mkv verified by tests); the dashboard uploader accepts
  mp4/avi/mov/mkv.
- **Invalid input is handled, not crashed on:** an unreadable or missing
  source prints a friendly `error:` + `hint:` message and exits with code 2
  (CLI), or shows a red error card instead of a traceback (dashboard).
- Annotated frames + summaries are written under `output/`; SQLite events to
  `data/app_data.db` and CSV exports on demand. Uploaded videos are saved as
  `output/upload_*` and cleaned up automatically after 24 h.

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

# 4. run the 76-test suite inside the image
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
config/config.py            all tunables (HSV ranges, gates, rule/ML weights,
                            restricted zones)
src/video/                  video sources (webcam/file/callables), HSV prep,
                            colour + shape detection
src/tracking/               Kalman filter (NumPy replication) + TrackManager
                            (Hungarian via scipy, IDs, trajectories)
src/analysis/               movement features, scenario self-calibration,
                            SQLite/CSV logging, ground truth, evaluation metrics
src/anomaly/                rule engine, Isolation Forest, weighted fusion
src/ui/                     OpenCV overlay + Streamlit dashboard
src/ui/session.py           per-run session model (frames, observations,
                            tracks, scene stats - isolated from history)
src/ui/pages/               the six dashboard pages (see below)
src/ui/charts.py            Altair charts built from real session data
src/ui/report.py            markdown session report builder
src/ui/theme.py             dark theme, layout + shared components
scripts/generate_samples.py synthetic sample videos
scripts/run_pipeline.py     CLI entry point
tests/                      pytest suites per phase (96 tests)
```

## Dashboard tour (six pages)

`streamlit run src/ui/dashboard.py` opens a multi-page app with a compact
sidebar (navigation, active session, DB/CLI shortcuts):

| Page | What it shows |
| --- | --- |
| **Overview** | KPI cards from the active session, recent alerts, activity timeline, session summary, pipeline capability notes, bundled-sample picker. Complete-looking empty state before any run. |
| **Video Studio** | The workspace: upload (mp4/avi/mov/mkv) or pick a sample, frame budget, real progress during analysis, then a frame-by-frame viewer with annotated/original toggle, bounding boxes, track IDs, trajectory trails, HUD, timestamps and per-frame level chips. Friendly error cards for corrupt/unsupported input. |
| **Track Explorer** | Searchable track list, per-track KPIs (duration, observations, mean/max speed, path length, straightness, events), trajectory plot, speed-over-time with mean reference, direction mix, event history table, per-track CSV export. |
| **Anomaly Center** | Filterable/searchable event table + timeline; selecting an event shows its timestamp, track, severity, fused/rule/ML/scene score breakdown, triggered rules, evidence frame and the human-readable explanation. Rule-based evidence is visually separated from Isolation-Forest output. |
| **Scene Intelligence** | Learned baseline (speed percentiles, dominant flow, calibration sample count/status), speed distribution vs baseline, per-track deviation, a working restricted-zone editor with dwell evidence, and honest limitation notes. |
| **Evaluation & Reports** | Measured processing stats; ground-truth labelling per track → precision/recall/F1/FPR/accuracy + confusion matrix **only when both classes are labelled** (single-class runs say so instead of faking numbers); markdown session report, CSV/JSON exports, and stored-session history (save/load/delete, isolated per session). |

Every chart, counter and table reads the active session's real observations —
nothing is generated for display. Synthetic bundled samples are labelled as
synthetic. Webcam capture is intentionally CLI-only (a deployed Streamlit
server has no camera attached).

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

**Verified by the test suite (96 tests, all passing):**
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
- SQLite logging + CSV export contracts, session-idempotent event rewrites,
  cross-session track summaries (composite key) and legacy-DB schema migration
- **end-to-end on real video files** generated by `scripts/generate_samples.py`:
  normal clip calibrates and tracks; anomaly clip yields non-Normal verdicts
  with explanations; noise clip runs clean; logger writes DB/CSV
- **the dashboard itself** via `streamlit.testing.v1.AppTest`: all six pages
  navigate and render (empty states before a run, no exceptions), Video Studio
  analysis produces a session with evidence rows, a corrupt source shows a
  friendly error card — not a traceback, anomaly filtering and event
  investigation work, track search filters, the zone editor round-trips,
  evaluation reports real metrics and an honest single-class fallback, session
  save/history round-trips, and reports disclose measured values only. The real
  server was also started (`streamlit run ...`) and served in a headless
  Chromium: all pages captured with zero console errors.
- **ground truth & metrics:** precision/recall/F1/FPR/accuracy against known
  values, rejection of single-class/empty labels, unlabelled-count accounting,
  ground-truth CSV round-trip and validation.
- **CLI contract:** unreadable/missing sources exit with code 2 and a friendly
  message (no traceback); mp4 and avi inputs both run end-to-end; re-running
  the same source **replaces** its rows instead of appending a duplicate copy
  of every observation, and each run records `run_stats` (frames, resolution,
  wall time, synthetic flag) for the dashboard's history panel.
- **longer videos:** a 1800-frame (60 s) clip processed at ~18 fps with a
  ~277 MB peak RSS (memory stays bounded; dashboard previews are capped and
  downscaled).

**Not verified here (requires hardware or a browser):**
- **Webcam playback** `VideoSource(src=0)` is implemented via cv2 but cannot
  be exercised from this environment - run it on a machine with a camera.
- **Browser-only dashboard interactions:** dragging the frame-preview slider
  and the actual file-upload widget in a real browser (the upload *code path*
  is covered by tests through source resolution, sanitization and error
  handling; AppTest cannot drive the uploader widget itself).
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
- Dashboard previews keep every ~6th frame, downscaled to 640 px wide, and
  the frame budget slider caps a run at 1200 frames — this keeps the cached
  payload small on long videos instead of loading them fully into memory.
- `sudden_acceleration` fires on the synthetic samples' loop seam (a clip
  built by repeating another video teleports objects back to the start);
  real footage has no such seam.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `error: cannot read source ...` (exit 2) | File missing, empty, or not a video. Regenerate samples: `.venv/bin/python scripts/generate_samples.py`. |
| Dashboard says *No sample videos found* | `samples/` is empty — run `scripts/generate_samples.py` or upload a file. |
| *Could not open ...* error card in the dashboard | Corrupt/unsupported upload. Use mp4/avi/mov/mkv re-encoded from the source. |
| Webcam: `cannot read source '0'` | No camera attached (SSH/VM/container), or the camera is held by another process. Expected in Docker/CI — run the webcam on the host machine. |
| `Address already in use` when starting Streamlit | Another process holds 8501: `streamlit run src/ui/dashboard.py --server.port 8502`. |
| Counts differ between CLI and dashboard | They process different frame budgets — the dashboard slider caps frames (default 450); set it to the full length for a like-for-like run. |
| Suspicious rows on an otherwise normal video | The fusion is deliberately sensitive: Suspicious (≥0.35) is a soft flag; check the *Irregular* count and the per-row `why` text to judge. |
| `ModuleNotFoundError: No module named 'config'` | Launching from an odd directory is handled by a path bootstrap — if you still see it, run from the project root or use `.venv/bin/python -m scripts.run_pipeline ...`. |
| Slow long videos | Lower the frame-budget slider; processing is ~18 fps at 720p on a modest CPU. |

## Testing

```bash
.venv/bin/python -m pytest tests -q         # full suite
.venv/bin/python scripts/generate_samples.py
.venv/bin/python -m scripts.run_pipeline samples/anomaly_clip.mp4
```

Logs: `data/app_data.db` (tables `track_events`, `track_summaries`),
`output/*.csv`.

Expected outcome on the bundled samples (verified):

| Clip | Result |
| --- | --- |
| `samples/normal_traffic.mp4` (300 frames) | **0 Irregular**, 64 Suspicious, 536 Normal |
| `samples/anomaly_clip.mp4` (420 frames) | **69 Irregular**, 256 Suspicious, 743 Normal — runner/loiterer caught |
| `samples/tiny_noise.mp4` (40 frames) | runs clean, no detections, no crash |
