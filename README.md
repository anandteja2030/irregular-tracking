# Intelligent Irregular Object Tracking and Scene-Aware Anomaly Detection

A real Python computer-vision project (no website-only mockup): it *sees and
tracks* coloured objects on a webcam or video file, *learns* per-object and
scene behaviour, and *explains* what is unusual about any object, in words, on
a live annotated view, API service and React console. All detections/verdicts
are logged to SQLite and exportable as CSV.

## What it does (objectives → modules)

| Objective | Modules |
| --- | --- |
| 1. SEE & TRACK — video input, preprocessing, HSV colour detection, contour shape detection, tracking | `src/video/video_input.py`, `src/video/preprocessing.py`, `src/video/detection.py` |
| 1. tracking — Kalman constant-velocity filter, Hungarian assignment, unique IDs, trajectory history | `src/tracking/kalman.py`, `src/tracking/track_manager.py` |
| 2. LEARN & ANALYZE — speed/direction/acceleration features, self-calibration, per-object + scene-relative comparison | `src/analysis/features.py`, `src/analysis/calibration.py` |
| 3. DETECT, EXPLAIN & SHOW — rules, Isolation Forest, signal fusion, Normal/Suspicious/Irregular, explanations, OpenCV visualization, logging, API/console | `src/anomaly/rules.py`, `src/anomaly/isolation.py`, `src/anomaly/fusion.py`, `src/ui/visualization.py`, `src/analysis/logger.py`, `src/pipeline.py`, `src/api/`, `frontend/` |

Everything is parameterised from one file: `config/config.py` (HSV ranges,
tracking gates, rules/ML weights, calibration warm-up).

## NEURAL COMMAND API + React console

This section documents the FastAPI service and the React console that wrap the
same engine, and it is the authoritative setup guide for that stack.

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
  │                 structured evidence, and live trajectory/calibration
  │                 enrichments (durable copies live in SQLite)
  ├─ repository.py  read-only SQL aggregates over the existing schema
  └─ analytics.py   payload builders shared by routes and reports.py

Engine — unchanged: src/video → src/tracking → src/analysis → src/anomaly
         → src/pipeline, writing data/app_data.db
```

One analysis run decodes frames, tracks them, scores every observation
(calibrated rules + Isolation Forest + scene-relative), and persists the rows
under its own session id. Completed API jobs and CLI runs all store their
observation centroids in `track_points` and a versioned
calibration snapshot in `calibration_snapshots`. SQLite is the durable source
of truth for those persisted values. For the current API process, preview
frames, structured rule evidence, and in-process copies of trajectories and
calibration may also remain available as bounded enrichment under the existing
retention behavior; those copies are temporary and disappear on restart, while
the SQLite rows remain readable.

### Prerequisites

- **Python 3.11+** (3.12 is what is tested) with a C toolchain for SciPy wheels.
- **Node 20+** and npm for the console.
- OpenCV can decode the video formats OpenCV normally supports; no browser
  plugin, cloud service, paid API or API key is involved anywhere.

### Python environment and dependencies

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt       # engine, pytest
.venv/bin/pip install -r requirements-api.txt   # FastAPI, uvicorn, httpx
.venv/bin/python scripts/generate_samples.py    # writes samples/*.mp4
```

### Database initialisation and schema

`data/app_data.db` is created automatically the first time the engine or the
logger writes. There is no manual migration command: `src/analysis/logger.py`
creates its tables with `CREATE TABLE IF NOT EXISTS` and records the persistence
schema version, so opening an older database adds missing tables and indexes
without rewriting existing rows. `ground_truth.SCHEMA` creates the label table
on first use.

| Table | Contents |
| --- | --- |
| `run_stats` | one row per run: source, kind, synthetic flag, frames, resolution, fps, wall time |
| `track_events` | one row per tracked observation: level, fused/rule/ML/scene scores, speed, heading, explanation |
| `track_summaries` | one row per track: colour, shape, duration, mean/max speed, path length, straightness |
| `track_points` | one row per observed centroid: track, frame, time, x/y, level, speed and direction; primary key `(session, track_id, frame_idx)` |
| `calibration_snapshots` | one versioned JSON snapshot per session: calibration status, speed/direction baseline, captured timestamp and calibration parameters |
| `ground_truth` | per-observation labels (`Normal`/`Anomaly`); empty until labels are written |

To start from a clean store, stop the API, move `data/app_data.db` aside, and
let the next run recreate it. Never edit rows by
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

### Live webcam tracking

The console's Video Studio opens with two inputs: **upload a video** and **live
webcam tracking**. Live tracking runs the same `TrackingPipeline` as a file
run, one captured frame at a time, and turning it into a session is explicit:

1. `POST /api/v1/live/sessions` reserves a live id (at most **4** concurrent
   captures; an idle capture expires after 3 minutes).
2. The browser captures the webcam with `getUserMedia`, downscales each frame
   to at most 1280 px wide, and posts it as `multipart/form-data` to
   `POST /api/v1/live/sessions/{live_id}/frames` (4 MiB per frame).
3. Every response is that frame's real pipeline output: `track_id`, pixel
   `box`, `centroid`, the recent measured `trail`, `level`, the four scores,
   speed, heading, triggered rules and the human-readable `why`. The console
   draws each box with corner brackets, the measured path and a heading arrow
   over its own video, and lists every object with its score channels, mini
   path and reason. Nothing in the overlay is synthetic.

Live sessions add moving-foreground detection (a running background estimate)
before the tracker, so grey, dark or low-saturation objects are followed while
they move; the colour mask still finds saturated shapes that are stationary.
File runs keep the calibrated colour path unchanged, and both paths feed the
same tracker, calibration, fusion and explanation code — only detection
coverage differs, never the judgement.
4. `POST /api/v1/live/sessions/{live_id}/stop` builds a normal session from
   the captured frames (observations, track summaries, calibration snapshot and
   annotated preview frames) and persists it in SQLite. It then behaves like
   any other session: overview, tracks, anomalies, scene, evaluation, media and
   the markdown report all read it (its `source.kind` is `live`).
5. `POST /api/v1/live/sessions/{live_id}/cancel` discards a capture without
   writing anything.

Frames are captured only after the previous one has been scored, so a slow
round trip lowers the rate instead of queueing or dropping frames; the HUD
shows the measured rate. A capture is capped at 18,000 frames (~25 min at
12 fps). Camera access needs `https` or `localhost` in the browser.

### Design choices against the usual limitations

| Typical limitation | What this engine does instead |
| --- | --- |
| Fixed thresholds that do not travel between scenes | Speed, direction and fusion bands are learned per run by the calibrator; `/scene` exposes the baseline and its readiness. |
| Objects judged only against themselves | A scene-relative score compares each object with surrounding flow, and fusion weights all three channels. |
| Requires a labelled anomaly dataset | Isolation Forest plus statistical rules are unsupervised; labels are only used by the read-only evaluation surface. |
| Scores without a reason | Every observation carries triggered rules, an ML note, a scene note and a human-readable `why`. |
| Heavy deep models on modest hardware | Classical OpenCV detection, Kalman/Hungarian tracking and scikit-learn, no GPU requirement. |
| Normal behaviour must be defined by hand | Calibration starts automatically and keeps updating; zones and weights are optional overrides. |
| Detection limited to saturated colour blobs | Live captures add MOG2 moving-foreground detection; duplicate detections of one object are suppressed before tracking. |

### Reading the dashboard

Each surface states what it measures instead of only printing numbers:

- **Command Overview** shows the selected run's outcome ring, Normal/elevated
  shares, object leaders and a comparable elevated-share bar for every session.
- **Track Explorer** adds an object map (peak speed × peak fused score, colour
  = worst level), a per-object score ranking, the measured trajectory canvas,
  speed/heading series and frame investigation.
- **Anomaly Center** pairs the severity distribution with a fused-score
  histogram, a Suspicious/Irregular ring, channel contributions and a time
  timeline.
- **Scene Intelligence** draws the learned speed envelope, direction rose,
  spatial density and retained object paths.
- **Evaluation & Reports** adds a rate comparison bar beside the confusion
  matrix and the exported report.

Charts are dependency-free SVG built from persisted rows. A missing value
breaks a line or leaves a bar empty; it is never drawn as zero.

### Current API/console limitations

- **Trajectories are persisted.** Every observation's real centroid is written
  to the indexed `track_points` table when a session completes, including CLI
  runs, so historical sessions return the same paths after
  a restart. Sessions analysed before this storage existed or tracks with no
  observations report an unavailable reason instead of a reconstructed path.
  A CLI execution that fails or is interrupted is not persisted as a completed
  session at all.
- **Calibration snapshots are persisted.** Completed sessions store a versioned
  JSON snapshot of the calibration status, baseline statistics, direction
  distribution and calibration parameters in `calibration_snapshots`. `/scene` prefers that
  snapshot over the running process's live calibrator. Snapshots with an
  unknown or missing schema version, or a malformed payload, are reported as
  unavailable rather than interpreted with current assumptions. Legacy sessions
  fall back to clearly-labelled observation-derived distributions.
- **Legacy databases remain readable.** Old sessions keep their events and
  summaries; they simply have no stored trajectory or calibration snapshot
  until they are analysed again.
- **Ground-truth labels cannot be edited from the console.** The evaluation
  surface is read-only: the API reports stored labels, but no write endpoint
  exists yet.
- **No annotated video is produced or downloadable.** Only decimated preview
  frames (JPEG, every 6th frame, max 240) are retained, for the most recent
  four sessions in memory.
- **Jobs and preview artifacts are lost on restart.** Persisted sessions, tracks,
  events and exports remain readable; the API says why media is unavailable
  instead of substituting other data.
- **Live captures are process-local until stopped.** An in-progress capture
  exists only in the API process that is scoring it; stopping writes it to
  SQLite. A restart therefore drops an unfinished capture, not a saved one.
- **The detector stays colour/saturation based.** It tracks saturated shapes and
  bright, high-saturation objects; low-contrast grey objects can be missed. The
  live panel states this rather than promising error-free detection, and the
  camera's measured fps and per-frame levels are reported as recorded.

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
```

- **Webcam:** pass `0`: `python -m scripts.run_pipeline 0` — requires a real
  camera device; nothing here can verify it from CI.
- **Supported inputs:** the CLI opens any video OpenCV/ffmpeg can decode (mp4,
  avi, mov, mkv verified by tests); the console uploader accepts
  mp4/avi/mov/mkv.
- **Invalid input is handled, not crashed on:** an unreadable or missing
  source prints a friendly `error:` + `hint:` message and exits with code 2
  (CLI), or shows a friendly error card instead of a traceback (console).
- Annotated frames + summaries are written under `output/`; SQLite events to
  `data/app_data.db` and CSV exports on demand. A completed CLI run also
  persists its trajectories and calibration snapshot under the session id
  (the source filename, or `webcam`), using the same storage API jobs use.
  Uploaded videos are saved as `output/upload_*` and cleaned up after 24 h.

## Docker (API service)

The image is `python:3.12-slim` + OpenCV system libs + `requirements.txt` and
`requirements-api.txt`, runs as a non-root user and exposes 8000 by default.
It runs the FastAPI service with Uvicorn; the React console is built and served
separately. **No secrets are stored in the repo or image** - inject them via
your platform's environment.

```bash
# 1. build the image
docker build -t irregular-tracking:latest .

# 2. run it (host 8000 -> container $PORT, default 8000)
docker run --rm -p 8000:8000 \
  -v irregular-data:/app/data -v irregular-output:/app/output \
  irregular-tracking:latest

# 3. verify health
curl -f http://localhost:8000/health && echo " healthy"

# 4. run the test suite inside the image
docker run --rm irregular-tracking:latest python -m pytest tests -q

# 5. or bring the service up with Compose (persistent volumes for SQLite logs
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
- **Health check:** `HEALTHCHECK` polls `/health` every 30 s using Python
  stdlib (no curl needed in the slim image).
- The image bakes in the sample videos under `samples/` so the API's sample
  endpoints work immediately after deployment.

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
src/evaluation/             JSON benchmark annotations, pipeline-output adapter,
                            IoU matching, detection/tracking/anomaly metrics,
                            reports
src/anomaly/                rule engine, Isolation Forest, weighted fusion
src/ui/visualization.py     OpenCV overlays (boxes, IDs, trails, HUD)
src/ui/session.py           backward-compatible analysis shim
src/ui/report.py            markdown session report builder
src/api/                    FastAPI service (system, jobs, sessions, analytics)
frontend/                   React + TypeScript console
scripts/generate_samples.py synthetic sample videos
scripts/run_pipeline.py     CLI entry point
scripts/benchmark_pipeline.py    run pipeline + evaluate + manifest
tests/                      pytest suites per phase (incl. API and restart integration)
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

## Ground-truth evaluation (Phase 15)

`src/evaluation/` is a file-based benchmark for the existing detector and
tracker. It does not alter the API observation labels or the SQLite schema. Ground truth is object-centric; predictions are frame-centric:

```json
{
  "schema_version": 1,
  "videos": [{
    "video_id": "clip-a",
    "objects": [{
      "object_id": "pedestrian-1",
      "label": "Anomaly",
      "category": "loitering",
      "frames": [{"frame_idx": 0, "bbox": [10, 20, 30, 40]}],
      "trajectory": [{"frame_idx": 0, "x": 25, "y": 40}]
    }]
  }]
}
```

Predictions use `videos[].frames[].objects[]` with `track_id`, `bbox`, `level`
(`Normal`, `Suspicious` or `Irregular`; the binary alias `Anomaly` is also
accepted) and optional `category`. Boxes are pixel `[x, y, width, height]`,
matching the detector. Full schema and validation live in
`src/evaluation/annotations.py`.

Evaluation matches one-to-one per video/frame using IoU >= **0.5** by default;
candidates are greedy-sorted by descending IoU and then stable IDs. GT objects
matched to changing predicted track IDs across consecutive visible frames
contribute ID switches; a gap breaks the comparison. Detection precision,
recall and F1 come from matched/unmatched boxes. Anomaly precision, recall,
F1, false-positive rate and the 2x2 confusion matrix are end-to-end over all GT
object-frames: missed anomalies are false negatives and unmatched positive
predictions are false positives. Category confusion is computed where a GT
anomaly was predicted positive and carries a category. Track continuity is
matched GT observations divided by all GT observations; fragmented,
mostly-tracked and mean-coverage figures are also reported. Trajectory points
are validated and preserved for provenance, but tracking metrics use the
per-frame boxes rather than a trajectory-similarity score.

Existing pipeline frame results can be converted without running a second
detector. `FrameResult.entries` carry the tracker's `track_id`, centroid,
`bbox_wh` and level; the adapter converts the box to `[x, y, width, height]`
and includes every entry the pipeline reports (no extra filtering):

```python
from src.evaluation import frames_to_predictions, write_predictions

# Collect the FrameResult objects already returned by the pipeline, e.g.
# run_analysis(..., on_frame=lambda frame, fps: frames.append(frame)).
frames = []
predictions = frames_to_predictions("clip-a", frames)
write_predictions(predictions, "predictions.json")
```

### End-to-end benchmark runner

`scripts/benchmark_pipeline.py` runs the existing pipeline with its
`on_frame` hook, adapts every returned `FrameResult`, evaluates the result
against ground truth, and writes the prediction JSON, evaluation JSON,
Markdown report and a reproducibility manifest. It does not persist a
session to SQLite and does not change the detector or API.

```bash
.venv/bin/python -m scripts.benchmark_pipeline \
  --source samples/anomaly_clip.mp4 \
  --ground-truth annotations.json \
  --video-id anomaly_clip \
  --iou-threshold 0.5 \
  --predictions benchmark_predictions.json \
  --output-json benchmark_evaluation.json \
  --output-report benchmark_report.md \
  --manifest benchmark_manifest.json
```

The manifest records the source and ground-truth SHA-256 hashes, source/frame
metadata, runtime config values and config-file hash, IoU threshold, matching
policy, Python version, and Git commit/branch/dirty state. Use
`--max-frames` for a quick bounded run.

To evaluate predictions that already exist without rerunning the pipeline:

```bash
.venv/bin/python -m scripts.evaluate_predictions \
  --ground-truth annotations.json --predictions predictions.json \
  --iou-threshold 0.5 --output-json evaluation.json --output-report evaluation.md
```

The result JSON is machine-readable and includes per-video and aggregate
metrics plus the matching policy; the Markdown report records the same scope
and limitations. The existing per-session evaluation and API remain unchanged,
and the baseline detector is not replaced.

## What is verified vs what is not

**Verified by the backend test suite:**
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
- **ground truth & metrics:** precision/recall/F1/FPR/accuracy against known
  values, rejection of single-class/empty labels, unlabelled-count accounting,
  ground-truth CSV round-trip and validation.
- **Phase 15 benchmark framework:** annotation/prediction validation, IoU
  matching, detection/tracking/anomaly aggregation, pipeline-result adapter,
  end-to-end runner outputs, and manifest/config/hash metadata.
- **CLI contract:** unreadable/missing sources exit with code 2 and a friendly
  message (no traceback); mp4 and avi inputs both run end-to-end; re-running
  the same source **replaces** its rows instead of appending a duplicate copy
  of every observation, and each run records `run_stats` (frames, resolution,
  wall time, synthetic flag) for the console's history view.
- **longer videos:** a 1800-frame (60 s) clip processed at ~18 fps with a
  ~277 MB peak RSS (memory stays bounded; preview frames are capped and
  downscaled).

**Not verified here (requires hardware or a browser):**
- **Webcam playback** `VideoSource(src=0)` is implemented via cv2 but cannot
  be exercised from this environment - run it on a machine with a camera.
- **Browser-only console interactions:** the actual file-upload widget and
  drag interactions in a real browser (the upload *code path* is covered by
  tests through source resolution, sanitization and error handling).
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
- API previews keep every ~6th frame, downscaled to 640 px wide, and the
  frame budget caps a run at 1200 frames — this keeps the cached payload small
  on long videos instead of loading them fully into memory. A live capture
  keeps the same stride and preview cap.
- A live capture is scored at whatever rate the browser and network allow
  (typically a few frames per second through a remote tunnel, much faster on a
  local machine); `fps` is measured from real frame arrivals, and speeds are
  derived from it.
- `sudden_acceleration` fires on the synthetic samples' loop seam (a clip
  built by repeating another video teleports objects back to the start);
  real footage has no such seam.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `error: cannot read source ...` (exit 2) | File missing, empty, or not a video. Regenerate samples: `.venv/bin/python scripts/generate_samples.py`. |
| Console says *No sample videos found* | `samples/` is empty — run `scripts/generate_samples.py` or upload a file. |
| *Could not open ...* error card in the console | Corrupt/unsupported upload. Use mp4/avi/mov/mkv re-encoded from the source. |
| Webcam: `cannot read source '0'` | No camera attached (SSH/VM/container), or the camera is held by another process. Expected in Docker/CI — run the webcam on the host machine. |
| `Address already in use` when starting the API | Another process holds 8000: start Uvicorn on another port and point `NEURAL_API_URL` at it. |
| Suspicious rows on an otherwise normal video | The fusion is deliberately sensitive: Suspicious (≥0.35) is a soft flag; check the *Irregular* count and the per-row `why` text to judge. |
| `ModuleNotFoundError: No module named 'config'` | Launching from an odd directory is handled by a path bootstrap — if you still see it, run from the project root or use `.venv/bin/python -m scripts.run_pipeline ...`. |
| Slow long videos | Processing is ~18 fps at 720p on a modest CPU; use a shorter clip or lower resolution. |
| Console shows "service unreachable" | Start the API on `127.0.0.1:8000` (or set `NEURAL_API_URL` / `VITE_API_BASE_URL`); `GET /health` must answer before the console can load data. |
| Console loads but previews are 404 | Preview frames are in-process only: restarting the API drops them for old sessions, and the response says so. Re-run the analysis to regenerate them. |
| Job disappeared after a restart | The job registry is in memory. The persisted session is still listed and fully readable; start the analysis again if you need a live job. |
| CORS errors from a deployed console | Add the console origin to `NEURAL_ALLOWED_ORIGINS` (comma-separated) and restart the API. |

## Testing

```bash
# backend: engine and the FastAPI integration suite
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
