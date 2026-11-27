# Neural Command — Intelligent Irregular Object Tracking and Scene-Aware Anomaly Detection

*A complete, plain-language guide to what this project is, how it works, what it is built with, and how far it goes against the thirteen surveyed papers.*

---

## 1. Introduction

### 1.1 The problem in one paragraph

A modern CCTV installation records everything and understands almost nothing. An operator watching twelve screens sees movement, not meaning: a person crossing a yard, a car slowing near a gate, a trolley moving the wrong way down an aisle. To notice that one of those is *unusual*, the operator has to remember what normal looked like ten minutes ago, for this camera, at this time of day — and then explain the judgement to somebody else. Software should do that part. Most software does not: it either records silently, or it raises an alarm with no reason attached, so the operator learns to ignore it.

### 1.2 The question this project answers

For every moving object, on every frame, the system answers four questions:

1. **Which object is it?** — a stable identity and a measured path, not a blob that appears and disappears.
2. **How unusual is its behaviour right now?** — a number between 0 and 1, plus a band: `Normal`, `Suspicious` or `Irregular`.
3. **Why?** — the specific evidence that produced the score, in a sentence a human can read.
4. **Compared with what?** — a baseline that the system learned from *this* scene during *this* run, not a threshold typed in by a developer.

A single sentence summary: **it watches a scene, learns what normal movement looks like there, tracks every object, scores each observation against that learned normal using three independent kinds of evidence, and explains every verdict in words.**

### 1.3 What the project actually is

This is a working end-to-end system, not a dashboard mock-up and not a notebook experiment. It contains:

- a **computer-vision engine** that decodes video, detects objects, tracks them with stable IDs, extracts movement features and scores them;
- a **self-calibration stage** that learns the scene's speed envelope and dominant flow directions automatically;
- a **three-channel anomaly model** (expert rules, unsupervised machine learning, scene-relative comparison) fused into one bounded score;
- an **explanation generator** that turns the fired evidence into ranked, human-readable sentences;
- a **FastAPI service** with a versioned REST surface, WebSocket job progress, validated uploads and a live-webcam path;
- a **SQLite evidence store** holding every observation, track summary, trajectory point and calibration snapshot;
- a **React console** with seven read-only surfaces that render only measured data;
- a **benchmark and evaluation harness** with annotation matching, standard metrics and a reproducible manifest;
- **498 automated tests** (290 backend, 208 frontend) that pin the behaviour described in this document.

### 1.4 What makes it different

| Common approach | What this project does instead |
| --- | --- |
| Train a deep anomaly model on a labelled corpus | No labelled anomaly data is needed; the baseline is learned per run and the ML channel is unsupervised |
| Require a GPU and a large model | CPU-only classical CV: OpenCV, NumPy, SciPy, scikit-learn |
| Output one score per clip | Every *object* on every *frame* gets its own bounded score and verdict |
| Output a number with no reason | Deterministic rule sentences plus an ML note and a scene note, stored with the observation |
| Fixed thresholds that do not travel between cameras | Speed and flow baselines are learned from the footage itself; fusion weights and bands are configurable |
| Discard the evidence after the run | Observations, trajectories and calibration are persisted in SQLite and re-readable after a restart |

### 1.5 What it is not

Being clear about boundaries is part of being trustworthy:

- It is **not** face recognition and does **not** identify people across cameras.
- It does **not** claim real-world units: speeds are pixels per second, because no ground-plane homography is calibrated.
- It is **not** a certified security product; it is an explainable research and engineering system.
- It does **not** model crowd-level interaction between trajectories, road-lane semantics, or automatic regime switching — these are stated as remaining gaps in §10, not hidden.
- It does **not** invent data: an unavailable value is shown as `—`, never as a fabricated zero.

### 1.6 Who it is for

An operator who needs to know where to look; a researcher who needs a reproducible baseline; a student who needs to see the whole pipeline from pixels to explanation in one readable codebase; and a reviewer who wants every claim tied to a file.

### 1.7 By the numbers

66 Python modules, 72 TypeScript modules, 21 backend test modules with 290 tests, 26 frontend test files with 208 tests, 7 console surfaces, 6 SQLite tables, and five engine runtime packages plus the FastAPI service stack.

---

## 2. The problem, stated properly

### 2.1 Recording is not monitoring

Video is cheap; attention is expensive. A 30-minute clip at 12 fps contains 21,600 frames; no human reviews them. The useful signal is a tiny fraction of that: a handful of moments where behaviour departed from the scene's normal. The engineering problem is therefore not "store more video" but **"find and explain the few observations that matter, and do it without a labelled dataset for this camera."**

### 2.2 Why the research solutions are expensive

The surveyed literature solves this in three costly ways:

1. **Supervision.** Deep anomaly models are trained on normal footage and often tuned with labelled anomalies. Collecting those labels for every new site is the bottleneck the papers themselves list as a limitation.
2. **Compute.** Video-language models and attention networks deliver strong accuracy but need GPUs and large memory, which rules out the modest hardware where cameras actually live.
3. **Opacity.** A single reconstruction or attention score tells an operator *that* something is wrong, not *which object did what*, so it cannot be acted on or defended.

### 2.3 The reframing used here

Instead of learning "what anomalies look like", learn **"what this scene normally does"**, then measure distance from it. Three independent measurements are combined:

- **Rules** encode expert judgement (too fast for this scene, against the flow, erratic, abruptly accelerating, loitering, inside a restricted zone).
- **Isolation Forest** detects "this motion looks unlike the rest of the session" without any labels.
- **Scene-relative comparison** asks "how does this object compare with the flow and speed envelope the scene itself produced?"

Each channel is understandable on its own; together they are harder to fool than any one of them.

### 2.4 What the three verdicts mean operationally

| Verdict | Meaning | Suggested operator response |
| --- | --- | --- |
| **Normal** | The evidence does not separate this observation from the learned baseline | No action; it remains in the record |
| **Suspicious** | At least one channel produced moderate evidence, or several small signals agree | Glance at the track and its reasons; a short-lived blip is common |
| **Irregular** | Fused evidence is strong (≥ 0.75) | Inspect the object, its trajectory and the fired rules |

The bands are deliberately conservative: a single noisy frame cannot turn a regular object into an irregular one, because the track-level verdict requires repeated evidence.

---

## 3. How it works — one object, start to finish

This section follows a single object through the system. It is the quickest way to understand the whole design.

### 3.1 The story

Suppose a red car enters a road scene at 180 px/s while the scene's learned fast envelope is 110 px/s.

1. **Decode.** OpenCV reads a frame and (optionally) resizes it to the configured processing size.
2. **Preprocess.** Gaussian blur and morphological cleanup remove sensor noise and specks.
3. **Detect.** The HSV colour mask isolates red; contours are extracted, filtered by area, and classified by shape. On real footage the optional YOLOv4-tiny path can name the object (`car`, `truck`, `person`) instead; on live webcam frames a MOG2 background model finds greyscale movers the colour mask would miss.
4. **Associate.** Candidate boxes are matched to existing tracks by a position-gated cost matrix solved with the Hungarian algorithm. Unmatched candidates can start new tracks; unmatched tracks coast for up to 12 frames before being dropped. A track is only reported after 3 matched frames, so one-frame false detections never reach the tables.
5. **Describe.** The Kalman filter smooths position and velocity; the feature extractor turns the last two positions into speed (px/s) and heading (degrees), a two-window estimate into acceleration, and the heading history into turn rate.
6. **Calibrate.** During warm-up the scene baseline is collected: after at least 2 distinct tracks, 12 seconds of observation and 30 movement samples, the calibrator publishes the speed p10/p50/p90, the mean and standard deviation, an eight-octant direction histogram and the dominant flow directions.
7. **Score.** For the car at this frame:
   - **Rule channel:** `speed 180 px/s ÷ p90 110 px/s = 1.64`, above the 1.6 threshold, so `excessive_speed` fires with severity ≈ 0.51. Its heading stays within the 70° flow tolerance, so no direction rule fires.
   - **ML channel:** the Isolation Forest scores the robust-scaled `[speed, heading-change, acceleration]` vector against the session's own distribution and returns, say, 0.42.
   - **Scene channel:** speed is 1.64× the scene p90, which contributes 0.40.
8. **Fuse.** `0.45 × 0.51 + 0.35 × 0.42 + 0.20 × 0.40 ≈ 0.46`, which is above the 0.40 suspicious threshold and below 0.75, so the verdict is **Suspicious**.
9. **Explain.** The same code that scored emits ranked sentences, for example: *"fired rule [excessive_speed] (51% severity): speed 180 px/s is 1.6x the scene's fast envelope (p90 110 px/s)"*, followed by the ML and scene notes.
10. **Present and persist.** The annotated frame shows the box, ID, trail and verdict colour; the observation is written to SQLite with all four scores, the rules and the explanation; the centroid is written to `track_points`; the track summary, run statistics and calibration snapshot are written when the session completes.

### 3.2 Why three channels instead of one

Each channel fails differently, and the failures are complementary:

- Rules are precise and explainable but need thresholds; calibration supplies them per scene.
- The Isolation Forest catches combinations nobody wrote a rule for, but its score is not self-explanatory.
- The scene channel keeps the judgement relative to the current scene, so a genuinely fast road is not permanently "anomalous".

Fusing them with fixed weights (0.45 / 0.35 / 0.20) gives one bounded number that is still fully auditable: the observation row stores the three contributions separately.

### 3.3 Why calibration matters

Without calibration, "fast" is a guess. With it, "fast" means "faster than 90% of the movement this scene has produced so far". That is why the same engine works on a corridor, a yard and a road without code changes — and why the console can show the baseline and its readiness instead of a hidden constant.

---

## 4. The complete workflow

### 4.1 File or bundled-sample analysis (the main path)

1. **Input resolution.** `VideoSource` accepts a webcam index, a file path, or a callable frame source. Invalid input produces a friendly `error:` + `hint:` instead of a traceback.
2. **Source validation.** Container metadata (fps, frame count, resolution) is read; the API additionally validates uploads by extension, MIME type, magic bytes and a real decode.
3. **Frame loop.** Each frame is decoded, preprocessed, detected, tracked, featurised, scored, annotated and persisted through one `TrackingPipeline.process_frame` call. Progress and stage callbacks feed the job API; `should_stop()` is polled per frame for cooperative cancellation.
4. **Session close.** Track summaries are aggregated, the calibration snapshot is taken, and one transaction writes observations, summaries, run statistics, trajectory points and the snapshot. Re-running the same session replaces its rows rather than duplicating them.
5. **Read surfaces.** The console reads sessions, summaries, tracks, trajectories, observations, anomalies, scene data, media and evaluation exports from the API.

### 4.2 Live webcam path

1. `POST /live/sessions` reserves a live id (at most 4 concurrent, 180 s idle expiry).
2. The browser captures with `getUserMedia`, downscales to ≤ 1280 px and posts each frame as multipart (≤ 4 MiB).
3. The API runs the *same* pipeline frame by frame and returns measured output: track id, box, centroid, trail, verdict, four scores, speed, heading, fired rules and `why`.
4. The console draws boxes, trails and headings over its own video and lists each object with its evidence.
5. `stop` builds a normal persisted session; `cancel` discards it. Frames are sent only after the previous one is scored, so a slow link lowers the rate instead of dropping frames.

### 4.3 Upload and job lifecycle

```
upload ─► extension → MIME → magic bytes → container → decode   (reject early)
       ─► POST /jobs {kind: sample|upload}
       ─► queued → running (one CPU-bound worker thread)
       ─► progress over WS /jobs/{id}/ws, or polling; percent is null when unknown
       ─► cancel sets a threading.Event polled per frame (never a mid-write kill)
       ─► completed → session rows → console surfaces
```

### 4.4 Console read path

`ApiHealthProvider` polls `/health` every 20 seconds to decide *online / linking / offline*. `SessionProvider` owns the selected session id (also carried in the URL, so a view is deep-linkable). Each panel uses `useResource`, which cancels in-flight requests, keeps the previous data during a refresh and skips re-renders when the payload is unchanged. Every number comes from a persisted row; a missing value is rendered as `—`.

### 4.5 Evaluation path (offline and read-only)

`annotations.json` → predictions converted from pipeline frames → IoU ≥ 0.5 matching → detection precision/recall/F1, identity switches and continuity, anomaly precision/recall/F1/FPR, a 2×2 confusion matrix and category confusion → JSON + Markdown + a SHA-256 manifest. This path never modifies the stored labels or the live scoring.

---

## 5. Technology stack — what, where, why

The stack was chosen for one property: every part must run on a normal CPU, in one process, with no external service. Each table below is a group of technologies doing one job.

### 5.1 Language and runtime

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **Python 3.12** | `src/`, `config/`, `scripts/` | the entire engine and API | the CV/ML ecosystem is Python-native; one runtime means one test suite and no cross-language boundary |
| **TypeScript 5.9** | `frontend/src` | types for every API payload | the console renders measured numbers, so silent shape drift must be a compile error |
| **Dataclasses** | `config/config.py`, results, snapshots | typed configuration and result objects | one place for every tunable, overridable in tests, no YAML dependency |

### 5.2 Perception — turning pixels into candidates

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **OpenCV** (`opencv-python-headless`) | `src/video/*` | decode, colour conversion, blur, morphology, contours, drawing, JPEG encoding | reads mp4/avi/mov/mkv without an ffmpeg glue layer and runs headless on a server |
| **HSV colour segmentation** | `src/video/detection.py` | six calibrated ranges (red wraps hue 0°), area filters | deterministic, explainable detection with zero training data |
| **Contour and shape analysis** | same | `findContours`, `approxPolyDP`, circularity/aspect heuristics | every track is born with a human-meaningful colour and shape label |
| **YOLOv4-tiny via OpenCV DNN** | `src/video/object_detector.py` | darknet loading, blob input, NMS, COCO allow-list | real-camera runs get real classes (`car`, `truck`, `person`) while staying CPU-only |
| **MOG2 background subtraction** | `src/pipeline.py` | moving-foreground mask for live captures | finds grey or low-saturation movers that colour segmentation misses |

### 5.3 Tracking — turning candidates into identities

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **Kalman filter (NumPy)** | `src/tracking/kalman.py` | constant-velocity predict/correct, coasting through misses | smooth positions and stable speed/heading despite noisy boxes |
| **Hungarian assignment (SciPy)** | `src/tracking/track_manager.py` | globally optimal detection↔track matching | avoids the swap errors of greedy nearest-neighbour matching |
| **Track lifecycle** | same | position gate (120 px), 3-hit confirmation, 12-frame coast, trajectory history | unique IDs and real paths — every downstream score depends on them |

### 5.4 Analysis, calibration and scoring

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **Movement features** | `src/analysis/features.py` | speed, heading, acceleration, heading change, straightness, dwell | converts pixel paths into behaviour that can be compared |
| **Self-calibration** | `src/analysis/calibration.py` | warm-up gates → p10/p50/p90 speeds, std, eight-octant flow | "fast" and "wrong direction" are learned per scene, not hard-coded |
| **Rule engine** | `src/anomaly/rules.py` | six interpretable rules with bounded severity | deterministic evidence that can be printed as a sentence |
| **Isolation Forest (scikit-learn)** | `src/anomaly/isolation.py` | global + per-track rolling outlier score, refit every 60 observations | learns unusual motion without a single labelled anomaly |
| **Weighted fusion** | `src/anomaly/fusion.py` | `0.45·rule + 0.35·ml + 0.20·scene`, bands at 0.40 / 0.75 | one bounded score with three auditable contributions |
| **Explanation generator** | `src/anomaly/fusion.py` | ranked reasons + one-line `why` | the reason is produced by the code that scored, not reconstructed afterwards |

### 5.5 Persistence and export

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **SQLite (stdlib)** | `src/analysis/logger.py`, `src/api/repository.py` | six tables: run stats, events, summaries, points, calibration snapshots, labels | durable, zero-install, transactional evidence that the API queries directly |
| **pandas** | `src/core/analysis_service.py` | frame rows → tabular summaries and CSV | correct CSV handling without hand-rolled quoting |
| **CSV and Markdown reports** | `src/api/reports.py`, `src/ui/report.py` | event/track exports and a session report | results leave the tool in formats a supervisor or thesis appendix can use |
| **Bounded session store** | `src/api/session_store.py` | preview JPEGs and structured evidence for the last four sessions | large media stays out of SQLite while durable numbers are persisted |

### 5.6 Backend service and realtime

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **FastAPI** | `src/api/main.py`, `src/api/routes/*` | versioned `/api/v1` surface across 13 route modules | typed routes, automatic OpenAPI, async I/O around a CPU-bound engine |
| **Pydantic v2** | `src/api/schemas.py`, `analytics_schemas.py` | 72 request/response models | the console can never receive a half-shaped payload |
| **Uvicorn** | process entry | ASGI serving | the same app runs locally and in Docker |
| **WebSocket** | `src/api/routes/jobs.py` | live job progress | status without polling storms |
| **ThreadPoolExecutor + Event** | `src/api/jobs.py` | one CPU worker, cooperative cancellation | no thread is killed mid-write; results stay isolated per session |
| **Streaming upload validation** | `src/api/uploads.py` | extension → MIME → magic bytes → container → decode, size cap, stale sweep | rejects bad files before OpenCV sees them |
| **Docker + Compose** | `Dockerfile`, `docker-compose.yml` | non-root image, health check, named volumes | reproducible deployment with persistent data |

### 5.7 Frontend console

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **React 19** | `frontend/src` | seven-surface console | component model fits many read-only panels over one API |
| **React Router 7** | `src/App.tsx` | `/`, `/video-studio`, `/tracks`, `/anomalies`, `/scene`, `/evaluation`, `/settings` | deep-linkable views; session id travels in the URL |
| **Vite 7** | `vite.config.ts` | dev server, `/api` proxy including WebSocket, production build | same-origin development without CORS, fast HMR |
| **Context providers** | `app/ApiHealthProvider.tsx`, `app/SessionProvider.tsx` | health phase and selected session | one source of truth for "which run am I looking at" |
| **Custom hooks** | `hooks/useResource.ts`, `hooks/useJobStream.ts` | cancellable fetch, polling, payload dedupe; WS with fallback | no empty flashes and no redundant re-renders |
| **Hand-written CSS system** | `styles/*.css` | tokens, layout, panels, charts, the 3D hero | no framework payload; full control of the instrument look and reduced motion |
| **Custom SVG charts** | `components/charts.tsx`, `MotionChart.tsx`, `TrajectoryCanvas.tsx` | donut, bars, histograms, trajectory plots | zero chart dependencies; a missing value breaks a line instead of drawing a fake zero |
| **Self-hosted fonts** | `@fontsource` packages | Inter and JetBrains Mono | consistent typography with no external CDN request |

### 5.8 Testing, evaluation and tooling

| Technology | Where | What it does | Why it matters here |
| --- | --- | --- | --- |
| **pytest** | `tests/` | 21 modules, 290 tests over engine, API, uploads, cancellation, persistence | the CV and API claims are executable |
| **Vitest + Testing Library + jsdom** | `frontend/src/**/*.test.*` | 26 files, 208 tests over pages and components | UI contracts stay honest when the API changes |
| **Benchmark harness** | `src/evaluation/*`, `scripts/benchmark_pipeline.py` | IoU matching, detection/tracking/anomaly metrics, manifest | reproducible, publishable evaluation of the same detector |
| **Synthetic sample generator** | `scripts/generate_samples.py` | deterministic normal/anomaly/noise clips | offline end-to-end runs with no footage licensing |

### 5.9 What is deliberately absent

No GPU, no cloud API, no model download, no labelled anomaly corpus, no chart or state-management library, no ORM. Nothing in the runtime dependency list is unused: NumPy, OpenCV, SciPy, scikit-learn, pandas and FastAPI each sit on a live path.

The configuration surface was also audited. Eight settings across five groups were editable in the console and accepted by the API while no engine module read them — `min_contour_perimeter`, `iou_gate`, `speed_history_limit`, `speed_pctl_fast`/`speed_pctl_slow`, `max_z`, and `scene_cluster_k_min`/`scene_cluster_k_max`. They implied control that did not exist, so they were removed from the engine, the API contract, the settings UI and the affected tests. A local-only `tools/` directory of downloaded Chromium libraries was deleted as well. Optional capabilities that are genuinely used — YOLO class detection, MOG2 for live frames, the live webcam path — were kept.

---

## 6. Architecture

### 6.1 Layered view

```
┌──────────────────────────────────────────────────────────────────────────┐
│ PRESENTATION — React 19 + TypeScript SPA (frontend/)                     │
│ providers → routes → pages → panels → SVG charts / CSS 3D hero           │
│ lib/api.ts (typed fetch) · useResource (poll) · useJobStream (WS)        │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ /api/v1 (Vite proxy in dev, CORS allowlist)
┌───────────────────────────────▼──────────────────────────────────────────┐
│ SERVICE — FastAPI + Uvicorn (src/api)                                    │
│ routes/ · jobs.py · uploads.py · session_store.py · repository.py        │
│ analytics.py · reports.py · live.py · middleware.py                      │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ run_analysis(...) (progress + stage callbacks)
┌───────────────────────────────▼──────────────────────────────────────────┐
│ CORE ENGINE — src/core/analysis_service.py → src/pipeline.py             │
│                                                                          │
│ VIDEO ──▶ PREPROCESS ──▶ DETECT ──▶ TRACK ──▶ FEATURES ──▶ CALIBRATE     │
│           blur/morph     HSV+contour  Kalman     speed /     p10/p50/p90 │
│                          (+YOLO,      +Hungarian heading /   + 8-octant  │
│                          +MOG2 live)  IDs         accel       flow       │
│                                                     │                    │
│                                                     ▼                    │
│                         RULES ──┐  ISOLATION FOREST ──┐  SCENE-RELATIVE  │
│                         (speed,  │  (global + per-track│  (speed vs p90, │
│                          flow,   │   rolling window)   │   octant flow)   │
│                          loiter) ┘                    ┘                  │
│                                     │                                    │
│                                     ▼                                    │
│                     FUSION  0.45·rule + 0.35·ml + 0.20·scene              │
│                     bands 0.40 / 0.75 → Normal / Suspicious / Irregular   │
│                                     │                                    │
│                                     ▼                                    │
│                     EXPLAIN  (ranked reasons + one-line why)              │
└───────────────┬───────────────────────────────────┬──────────────────────┘
                ▼                                   ▼
┌───────────────────────────────┐   ┌──────────────────────────────────────┐
│ OUTPUT — OpenCV overlay       │   │ STORE — SQLite data/app_data.db      │
│ boxes, IDs, trails, HUD,      │   │ run_stats · track_events ·           │
│ calibration badge, previews   │   │ track_summaries · track_points ·     │
│ (bounded session store)       │   │ calibration_snapshots · ground_truth │
└───────────────────────────────┘   └──────────────────────────────────────┘
```

### 6.2 Module map

| Layer | Modules | Responsibility |
| --- | --- | --- |
| Config | `config/config.py` | HSV ranges, detector allow-list, tracking gates, calibration gates, rule thresholds, fusion weights and bands, zones, paths |
| Input | `src/video/video_input.py` | webcam index, file, or callable source; friendly open errors |
| Preprocess | `src/video/preprocessing.py` | blur, morphology, speck removal |
| Detect | `src/video/detection.py`, `src/video/object_detector.py` | HSV + contour/shape; optional YOLOv4-tiny with NMS |
| Track | `src/tracking/kalman.py`, `track_manager.py` | constant-velocity filter; Hungarian assignment; IDs, gates, coasting, history |
| Features | `src/analysis/features.py` | speed, heading, acceleration, heading change, straightness, dwell |
| Calibrate | `src/analysis/calibration.py` | learned speed envelope, flow histogram, readiness, scene-relative score |
| Score | `src/anomaly/rules.py`, `isolation.py`, `fusion.py` | three evidence channels → fused band → explanation |
| Persist | `src/analysis/logger.py`, `ground_truth.py` | schema creation/migration, idempotent per-session writes, CSV |
| Render | `src/ui/visualization.py`, `report.py` | annotated frames, HUD, Markdown report |
| Orchestrate | `src/pipeline.py`, `src/core/analysis_service.py` | one integration point per frame; callbacks; session persistence |
| Serve | `src/api/*` | validation, jobs, sessions, analytics, exports, media, live capture |
| Evaluate | `src/evaluation/*` | annotation schema, IoU matching, metrics, manifest |
| Console | `frontend/src/*` | seven surfaces over the API, dependency-free charts |

### 6.3 The scoring model in detail

**Rule signals** (each has a severity in 0..1 and a sentence):

| Rule | Fires when | Purpose |
| --- | --- | --- |
| `excessive_speed` | speed ≥ 1.6× the calibrated p90 | catches speeding relative to the scene |
| `direction_against_flow` | heading > 70° off the dominant flow and not itself a common heading | catches wrong-way movement |
| `erratic_heading` | consecutive heading change > 45° | catches swerving or unstable motion |
| `sudden_acceleration` | two-window acceleration beyond 1200 px/s² | catches braking, bursts, collisions |
| `loitering` | dwell ≥ 3 s with net displacement under 1.5 body lengths and low mean speed | catches standing/blocking |
| `zone_violation` | dwell inside an enabled restricted zone beyond its threshold | enforces operator-defined areas |

**ML signal.** Robust-scaled speed, heading change and acceleration feed an Isolation Forest fitted globally on the session (80 trees, contamination 0.08) and on a 40-observation window per track; it refits every 60 observations. The score is "how isolated is this motion from the rest of the session", not a probability.

**Scene signal.** Speed ratio against the learned p90 (0.4 at >1.5×, 0.2 at >1.2×, 0.2 for far below the median) plus heading deviation from the dominant flow with tolerance for natural lane drift.

**Fusion.** `0.45·rule + 0.35·ml + 0.20·scene`, with rule severity aggregated so several moderate signals cannot silently saturate. Bands: `< 0.40` Normal, `0.40–0.75` Suspicious, `≥ 0.75` Irregular.

**Track-level verdict.** A track is reported as Suspicious or Irregular only when at least two observations agree and they are at least 8% of its observations — one noisy frame is not enough.

### 6.4 Data model

| Table | Grain | What it makes possible |
| --- | --- | --- |
| `run_stats` | one row per run | overview vitals, history, comparison |
| `track_events` | one row per tracked observation | anomaly lists, timelines, four scores, fired rules, explanation |
| `track_summaries` | one row per track | track explorer, motion aggregates, worst level |
| `track_points` | one row per observed centroid | trajectory canvas and scene map after a restart |
| `calibration_snapshots` | one versioned JSON document per session | scene page shows exactly what the baseline was |
| `ground_truth` | one label per observation | read-only evaluation |

Schema creation is idempotent (`CREATE TABLE IF NOT EXISTS` plus a recorded schema version), so an older database gains missing tables without rewriting rows. A malformed or unknown snapshot version is reported as unavailable rather than interpreted with current assumptions.

---

## 7. The console — seven surfaces

| Surface | Route | Question it answers | What it shows |
| --- | --- | --- | --- |
| **Command Overview** | `/` | How did this run go, at a glance? | Outcome ring, level shares, object leaders, comparable elevated-share bars, the 3D detection-core hero driven by real counts |
| **Video Studio** | `/video-studio` | Can I analyse this footage? | Sample/upload sources, validation, job progress, preview frames, cancellation |
| **Track Explorer** | `/tracks` | Which object did what? | Object map, score ranking, measured trajectory, speed/heading series, per-frame investigation |
| **Anomaly Center** | `/anomalies` | Where is the strongest evidence? | Severity distribution, fused-score histogram, channel contributions, event timeline and details |
| **Scene Intelligence** | `/scene` | What did the system think was normal? | Calibration readiness and gates, speed envelope, direction rose, spatial density, retained paths, deviations |
| **Evaluation & Reports** | `/evaluation` | How accurate is it against labels? | Detection/tracking/anomaly metrics, confusion matrix, rate comparison, CSV/Markdown export |
| **Settings** | `/settings` | What is it configured to do? | Validated engine settings with immediate feedback; the API re-validates the merged document |

All seven are read-only over persisted data. Live capture is driven from Video Studio; the live view overlays the API's per-object evidence on the browser's own video.

---

## 8. Quality and evidence

- **Backend tests (290).** Engine contracts, tracking gates, calibration readiness, rule behaviour, fusion bands, persistence and migration, upload rejection, job cancellation, API shapes, live motion and evaluation.
- **Frontend tests (208).** Page and component behaviour against mocked API payloads, formatting, validation and error states.
- **Benchmark harness.** IoU ≥ 0.5 matching against `annotations.json`, detection precision/recall/F1, identity switches and continuity, anomaly precision/recall/F1/FPR, confusion matrix, JSON + Markdown + SHA-256 manifest.
- **Reproducible samples.** `scripts/generate_samples.py` produces deterministic normal, anomaly and noise clips, so the full path can be run without licensed footage.
- **Honest coverage gaps.** No shared-benchmark comparison against the thirteen papers was run; this document compares *capabilities*, not metrics. Backend tests exercise the engine but do not prove accuracy on unseen real footage.

---

## 9. Coverage of the 13 surveyed limitations

> **How to read this table.** Each row takes the research gap exactly as the survey states it and asks whether *this codebase* closes it. This is a capability comparison against the stated gap, not a benchmark win over those models. No shared dataset or re-implementation of papers 1–13 was run, so no metric is claimed against them.

| S.No | Paper (Year) | Limitation stated in the survey | Status | How this project addresses it — with evidence |
| --- | --- | --- | --- | --- |
| 1 | **Track Any Anomalous Object: A Granular Video Anomaly Detection Pipeline** (2025) | No focus on lightweight self-calibration, explicit scene-relative motion comparison, or deterministic explanations | **Overcome** | All three are first-class modules: `ScenarioCalibrator` learns the scene baseline, the scene channel compares each object with the learned p90/flow, and explanations are deterministic rule sentences plus `why` (same input → same sentence) |
| 2 | **Odd-One-Out: Anomaly Detection by Comparing with Neighbors** (2025) | Analyses visual instance relationships; not designed for moving-object trajectories | **Overcome** | The engine is trajectory-first: Kalman + Hungarian tracking, per-track speed/heading/acceleration/straightness, persisted centroids, trajectory canvas. The stated gap is its core |
| 3 | **VERA: Explainable Video Anomaly Detection via Verbalized Learning of Vision-Language Representations** (2025) | Requires more computationally intensive models than a classical/lightweight pipeline | **Overcome (cost gap)** | Classical OpenCV + NumPy + SciPy + scikit-learn, CPU-only, no GPU, no language model. Explanations are template-generated from fired signals rather than verbalized by a VLM — cheaper and reproducible, but not natural-language *learning* |
| 4 | **Anomaly Detection in Crowd Scenes via Cross Trajectories** (2025) | Crowd-level focus; lacks individual self-calibration and object-specific explanations | **Partly** | Every object is scored per frame with its own four channels, rules and `why`, and each scene is self-calibrated. What is missing is crowd-level *cross-trajectory* reasoning: pairwise/group interaction between trajectories is not modelled; the scene channel compares each object with aggregate flow, which is not the same thing |
| 5 | **Deep Learning Based Anomaly Detection in Real-Time Video** (2025) | Compute cost and limited interpretability block deployment on modest hardware | **Overcome** | No deep model in the scoring path; Isolation Forest on three scalars, refit every 60 observations; every verdict prints its rule names. Docker image on `python:3.12-slim`, no GPU requirement |
| 6 | **C²Net: Content-Dependent and Content-Independent Cross-Attention Network** (2024) | Provides no Kalman/Hungarian tracking, trajectory management, or scene-relative explanations | **Overcome** | Explicitly present: `tracking/kalman.py`, Hungarian via `linear_sum_assignment`, `TrackManager` with gates/coasting/history, persisted trajectories, a dedicated scene-relative score and a scene surface |
| 7 | **Appearance-Motion Heterogeneous Networks for Video Anomaly Detection** (2024) | Deep architecture is more complex than a lightweight feature-based system and may need substantial training data | **Overcome** | Feature-based and unsupervised: no training corpus, the forest is fitted online per session; detection uses HSV/contours (optional YOLO for real cameras); five runtime packages |
| 8 | **Human-Centric Video Anomaly Detection via VAEs and Trajectory Prediction** (2024) | Human-centric deep models; calibration and explainable rule-level output are not central | **Overcome** | Calibration is a core stage with a readiness contract exposed at `/scene`; output is rule-level and explainable, and the console shows channel contributions. It is not human-class-specific — it tracks any moving object |
| 9 | **A Survey on Deep Learning Models for Anomaly Trajectory Detection** (2026) | A survey: no deployable implementation, no lightweight scene-aware architecture | **Overcome** | A deployable system: FastAPI service, React console, Docker/Compose, CSV/Markdown exports, live webcam path, 498 automated tests |
| 10 | **Trajectory-Based Anomaly Detection in Highway Traffic** (2024) | Domain-specific to highway traffic; explanation generation and general scene adaptation are limited | **Partly** | Scene adaptation is learned per run (no highway constants) and explanations exist per observation. But there is no traffic semantics — lanes, signal phases, vehicle classes beyond COCO names — so it generalises by calibration, not by domain modelling |
| 11 | **From Surveillance to Mobile Robots: Regime-Aware Video Anomaly Detection** (2026) | Regime-aware learning is more advanced and complex than a lightweight system | **Not addressed** | The calibrator adapts continuously, but there is no explicit regime detection or switching between operating modes (day/night, indoor/outdoor, camera motion). A genuine open item |
| 12 | **Anomaly Detection by Exploiting the Tracking Trajectory in Surveillance Videos** (2020) | Earlier work with less emphasis on explainability, scene-relative comparison, and adaptive calibration | **Overcome** | All three are implemented: deterministic `why`/rule evidence, scene-relative scoring against learned flow, calibration that starts automatically and keeps updating through the run |
| 13 | **Motion Anomaly Detection and Trajectory Analysis in Visual Surveillance** (2017) | Does not address continual adaptation, anomaly fusion, or real-time explanations | **Overcome** | Continual adaptation (rolling calibration + per-track forest refit), three-channel weighted fusion, and per-frame explanations delivered live over WebSocket and in the annotated view |

### 9.1 Summary

| Outcome | Count | Serials |
| --- | --- | --- |
| **Fully addressed** | **10** | 1, 2, 3, 5, 6, 7, 8, 9, 12, 13 |
| **Partially addressed** | 2 | 4, 10 |
| **Not addressed** | 1 | 11 |

**The titles whose stated limitation this project overcomes (by serial number):**

1. *Track Any Anomalous Object: A Granular Video Anomaly Detection Pipeline* (2025)
2. *Odd-One-Out: Anomaly Detection by Comparing with Neighbors* (2025)
3. *VERA: Explainable Video Anomaly Detection via Verbalized Learning of Vision-Language Representations* (2025)
4. *Deep Learning Based Anomaly Detection in Real-Time Video* (2025)
5. *C²Net: Content-Dependent and Content-Independent Cross-Attention Network for Anomaly Detection in Videos* (2024)
6. *Appearance-Motion Heterogeneous Networks for Video Anomaly Detection* (2024)
7. *An Exploratory Study on Human-Centric Video Anomaly Detection Through Variational Autoencoders and Trajectory Prediction* (2024)
8. *A Survey on Deep Learning Models for Anomaly Trajectory Detection* (2026)
9. *Anomaly Detection by Exploiting the Tracking Trajectory in Surveillance Videos* (2020)
10. *Motion Anomaly Detection and Trajectory Analysis in Visual Surveillance* (2017)

**Partly:** 4 — *Anomaly Detection in Crowd Scenes via Cross Trajectories* (2025): per-object calibration and explanations are covered, but crowd-level cross-trajectory interaction is not modelled. 10 — *Trajectory-Based Anomaly Detection in Highway Traffic* (2024): scene adaptation and explanations are covered; traffic-domain semantics (lanes, signal phases, vehicle classes) are not.

**Not addressed:** 11 — *From Surveillance to Mobile Robots: Regime-Aware Video Anomaly Detection* (2026): no explicit regime detection/switching.

---

## 10. Honest remaining limits

These are visible in the code and the README; they are not hidden behind the comparison above.

| Limit | Consequence | Why it is acceptable / next step |
| --- | --- | --- |
| Colour/saturation detection is the default | Grey, dark or low-contrast objects can be missed on the file path | Live captures add MOG2; a COCO YOLO path exists for real cameras; a learned detector is the natural next step |
| Speeds are pixels per second | No real-world m/s across cameras | A homography/scale calibration would convert units without changing the scoring logic |
| Two heavily overlapping objects can swap IDs | Attribution can briefly follow the wrong object | Documented; an appearance embedding in the assignment cost would fix it |
| No crowd cross-trajectory interaction (item 4) | Crowd-level group behaviour is visible only as aggregate flow deviation | Pairwise trajectory-interaction features would close it; per-object evidence already exists |
| No regime switching (item 11) | A camera that changes scene type mid-run keeps the old baseline | Add change-point detection on the speed/flow distribution and re-arm calibration |
| Ground truth is read-only in the console | Labels must be written by script/CSV | A write endpoint is deliberately out of scope today |
| Preview frames are in-process only | Restarting the API drops previews (numbers persist) | Durable media storage is a follow-up; the API says why media is unavailable |
| Jobs registry is in memory | A restart loses an in-flight job (a finished session is safe) | The persisted session remains readable; re-run to regenerate |
| No annotated video download | Only decimated preview JPEGs | Full-video export needs an encoder pipeline |

---

## 11. Conclusion

This project is a complete pipeline from pixels to an explained verdict: OpenCV for perception, Kalman + Hungarian for tracking, a self-calibrating statistical baseline, three independent anomaly channels fused into one bounded score, deterministic explanations, SQLite for durable evidence, FastAPI for the service, and a React console that renders only measured data.

It closes the stated gap of **ten** of the thirteen surveyed works (serials 1, 2, 3, 5, 6, 7, 8, 9, 12, 13), **partly** closes two (4, crowd-level cross-trajectory reasoning; 10, traffic-domain semantics), and does **not** close one (11, explicit regime-aware learning). Every status is tied to a module, a route or a stored row that can be opened and checked. The remaining limits are technical and named — which is the point of building a system around measured evidence and honest empty states.

---

## 12. Glossary

- **Calibration** — the learned baseline of a scene: speed percentiles and dominant movement directions, gathered during warm-up.
- **Observation** — one tracked object on one frame; the unit that is scored, explained and stored.
- **Track** — one object's identity across frames, maintained by the Kalman filter and Hungarian assignment.
- **p50 / p90** — the median and the 90th percentile of the scene's observed speeds; "fast" means above the p90 envelope.
- **Isolation Forest** — an unsupervised model that scores how easy an observation is to isolate from the rest; unusual motion scores higher.
- **Fused score** — the weighted combination of rule, ML and scene evidence, between 0 and 1.
- **Suspicious / Irregular** — fused-score bands at 0.40 and 0.75; they describe evidence strength, not a criminal verdict.
- **IoU** — intersection-over-union of two boxes; used for detection matching in evaluation.
- **Regime** — an operating mode of a scene (e.g. day vs night). This build does not detect regime changes; see §10.
