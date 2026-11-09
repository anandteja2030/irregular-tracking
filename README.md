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

## NEURAL COMMAND API + React console

The Streamlit dashboard below is still the reference desktop UI. This section
documents the FastAPI service and the React console that wrap the same engine,
and it is the authoritative setup guide for that stack.

### Architecture

```
Browser — React 18 + TypeScript (Vite)
        │  /api/v1  (Vite proxy in development; same origin or
        │            VITE_API_BASE_URL in a deployment)
FastAPI — src/api
  ├─ routes/        system, config, sources, videos, jobs, sessions, tracks,
  │                 anomalies, scene, evaluation, media
  ├─ jobs.py        one-worker ThreadPoolExecutor, cooperative cancellation,
  │                 progress WebSocket at /api/v1/jobs/{id}/ws
  ├─ uploads.py     streaming upload validation (extension → MIME → magic
  │                 bytes → container match → real OpenCV decode)
  ├─ session_store.py  bounded in-process retention of preview JPEGs,
  │                 trajectories, structured evidence and calibration
  ├─ repository.py  read-only SQL aggregates over the existing schema
  └─ analytics.py   payload builders shared by routes and reports.py

Engine — unchanged: src/video → src/tracking → src/analysis → src/anomaly
         → src/pipeline, writing data/app_data.db
```

One analysis job decodes frames, tracks them, scores every observation
(calibrated rules + Isolation Forest + scene-relative), persists the rows under
its own server-generated session id, and only then keeps the extra in-memory
artifacts (preview frames, centroid trajectories, structured rule evidence).
SQLite is always the source of truth; in-memory data is an enrichment layer
that is reported as unavailable once it is gone.

### Prerequisites

- **Python 3.11+** (3.12 is what is tested) with a C toolchain for SciPy wheels.
- **Node 20+** and npm for the console.
- OpenCV can decode the video formats OpenCV normally supports; no browser
  plugin, cloud service, paid API or API key is involved anywhere.

### Python environment and dependencies

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt       # engine, Streamlit, pytest
.venv/bin/pip install -r requirements-api.txt   # FastAPI, uvicorn, httpx
.venv/bin/python scripts/generate_samples.py    # writes samples/*.mp4
```

### Database initialisation and schema

`data/app_data.db` is created automatically the first time the engine or the
logger writes. There is no migration command: `src/analysis/logger.py` creates
its tables with `CREATE TABLE IF NOT EXISTS`, and `ground_truth.SCHEMA` creates
the label table on first use.

| Table | Contents |
| --- | --- |
| `run_stats` | one row per run: source, kind, synthetic flag, frames, resolution, fps, wall time |
| `track_events` | one row per tracked observation: level, fused/rule/ML/scene scores, speed, heading, explanation |
| `track_summaries` | one row per track: colour, shape, duration, mean/max speed, path length, straightness |
| `ground_truth` | per-observation labels (`Normal`/`Anomaly`); empty until labels are written |

To start from a clean store, stop the API and Streamlit, move
`data/app_data.db` aside, and let the next run recreate it. Never edit rows by
hand while a job is running.

### Backend startup

```bash
.venv/bin/uvicorn src.api.main:app --host 127.0.0.1 --port 8000
```

- `GET /health` (cheap liveness), `GET /system` (measured runtime and storage
  facts, enforced limits, report formats), `GET /docs` and `/openapi.json`.
- The console uses the versioned mirror under `/api/v1`; the unversioned routes
  are kept for existing clients.
- Shutdown cancels active jobs and waits briefly for workers, so no thread is
  killed mid-write.

### Frontend startup

```bash
cd frontend
npm ci
npm run dev -- --host 0.0.0.0     # http://localhost:5173, proxies /api to :8000
npm run typecheck
npm test                          # vitest
npm run build                     # static bundle in frontend/dist
```

In development Vite proxies `/api` (including the job WebSocket) to
`http://127.0.0.1:8000`, so the browser stays same-origin. Set
`NEURAL_API_URL` to proxy somewhere else, or `VITE_API_BASE_URL` to point a
built console at an API on another origin (add that origin to
`NEURAL_ALLOWED_ORIGINS`).

### Environment configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `NEURAL_UPLOAD_DIR` | `output/uploads` | where validated uploads are stored |
| `NEURAL_MAX_UPLOAD_MB` | `256` | hard streaming size cap |
| `NEURAL_UPLOAD_TTL_HOURS` | `24` | abandoned uploads are swept on start-up and on each new upload |
| `NEURAL_JOB_WORKERS` | `1` | analysis workers (CPU-bound; more workers do not speed up one run) |
| `NEURAL_MAX_FRAMES_CAP` | `5000` | largest accepted `max_frames` per job |
| `NEURAL_ALLOWED_ORIGINS` | localhost:5173/3000 | CORS allowlist for a cross-origin console |
| `NEURAL_API_URL` | `http://127.0.0.1:8000` | Vite dev proxy target |
| `VITE_API_BASE_URL` | `/api/v1` | API base baked into a production console build |

Engine tunables (HSV ranges, gates, rule/ML weights, zones) live in
`config/config.py`. They can be read and deep-patched at runtime through
`GET/PUT /api/v1/config` and `POST /api/v1/config/reset`; changes are
process-local and reset on restart, which `/system` reports explicitly.

### Video processing workflow

1. `POST /api/v1/videos/upload` streams the file and validates extension, MIME,
   container magic bytes and a real decode; it returns an `upload_id`.
2. `POST /api/v1/jobs` starts a job for a bundled sample (`kind: "sample"`) or
   an `upload_id` (`kind: "upload"`), with optional `max_frames`.
3. `GET /api/v1/jobs/{id}` or the WebSocket `/api/v1/jobs/{id}/ws` reports real
   progress (`percent` is `null` while the total is unknown).
4. `POST /api/v1/jobs/{id}/cancel` requests cooperative cancellation.
5. A completed job persists its session; explore it with
   `/sessions/{id}`, `/summary`, `/tracks`, `/tracks/{id}/trajectory`,
   `/observations`, `/anomalies`, `/anomalies/{event}`, `/scene`, `/media`,
   `/frames/{n}`, `/evaluation`.
6. Exports: `/sessions/{id}/export/csv?dataset=events|tracks` and
   `/sessions/{id}/report` (markdown, `?download=true` for attachment).

### Current API/console limitations

- **Trajectories are persisted.** Every observation's real centroid is written
  to the indexed `track_points` table when a session completes, so historical
  sessions return the same paths after a restart. Sessions analysed before this
  storage existed (or tracks with no observations) report an unavailable reason
  instead of a reconstructed path.
- **Calibration snapshots are persisted.** Completed sessions store a versioned
  JSON snapshot of the calibration status, baseline statistics, direction
  distribution and thresholds in `calibration_snapshots`. `/scene` prefers that
  snapshot over the running process's live calibrator; legacy sessions fall
  back to clearly-labelled observation-derived distributions.
- **Ground-truth labels cannot be edited from the console.** The evaluation
  surface is read-only: the API reports stored labels, but no write endpoint or
  UI exists yet (the Streamlit Evaluation page can still write labels).
- **No annotated video is produced or downloadable.** Only decimated preview
  frames (JPEG, every 6th frame, max 240) are retained, for the most recent
  four sessions in memory.
- **Jobs and preview artifacts are lost on restart.** Persisted sessions, tracks,
  events and exports remain readable; the API says why media is unavailable
  instead of substituting other data.

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

# 4. run the test suite inside the image
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
tests/                      pytest suites per phase (176 tests, incl. API)
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

**Verified by the test suite (176 tests, all passing):**
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
| Console shows "service unreachable" | Start the API on `127.0.0.1:8000` (or set `NEURAL_API_URL` / `VITE_API_BASE_URL`); `GET /health` must answer before the console can load data. |
| Console loads but previews are 404 | Preview frames are in-process only: restarting the API drops them for old sessions, and the response says so. Re-run the analysis to regenerate them. |
| Job disappeared after a restart | The job registry is in memory. The persisted session is still listed and fully readable; start the analysis again if you need a live job. |
| CORS errors from a deployed console | Add the console origin to `NEURAL_ALLOWED_ORIGINS` (comma-separated) and restart the API. |

## Testing

```bash
# backend: engine, dashboard, and the FastAPI integration suite
.venv/bin/python -m pytest tests -q

# frontend: types, unit tests, production build
cd frontend && npm run typecheck && npm test && npm run build

.venv/bin/python scripts/generate_samples.py
.venv/bin/python -m scripts.run_pipeline samples/anomaly_clip.mp4
```

The API tests (`tests/test_api_phase*.py`) run against a temporary database and
temporary upload directory. They exercise upload rejection paths, job lifecycle
(progress, duplicates, cooperative cancellation, crash handling), WebSocket
streaming, every analytics endpoint, both CSV exports and the markdown report.

Logs: `data/app_data.db` (tables `track_events`, `track_summaries`),
`output/*.csv`.

Expected outcome on the bundled samples (verified):

| Clip | Result |
| --- | --- |
| `samples/normal_traffic.mp4` (300 frames) | **0 Irregular**, 64 Suspicious, 536 Normal |
| `samples/anomaly_clip.mp4` (420 frames) | **69 Irregular**, 256 Suspicious, 743 Normal — runner/loiterer caught |
| `samples/tiny_noise.mp4` (40 frames) | runs clean, no detections, no crash |
