/** The FastAPI surface, implemented in the browser.
 *
 * Every method here answers the same shape the Python service returns, so the
 * pages do not need to know which backend produced them. What cannot be
 * measured in a tab is reported as unavailable rather than invented: there is
 * no object detector, so appearance is the measured dominant colour, and the
 * ML channel is `null` because no model runs here.
 */
import { ApiError } from "../api";
import type {
  AnomalyDetail,
  AnomalyItem,
  AnomalyList,
  ConfigResetResponse,
  ConfigUpdateResponse,
  EngineConfig,
  EvaluationResponse,
  GroundTruthLabel,
  Health,
  JobList,
  JobSnapshot,
  LabelPayload,
  Level,
  LevelCounts,
  MediaResponse,
  ObjectEvidenceResponse,
  ObservationItem,
  PurgeResponse,
  RocPoint,
  SceneResponse,
  SessionDetail,
  SessionItem,
  SessionList,
  SessionSummary,
  SourceEntry,
  SourcesResponse,
  StatSummary,
  SystemStatus,
  TrackDetail,
  TrackFramesResponse,
  TrackItem,
  TrackList,
  TrajectoryResponse,
  UploadRecord,
} from "../types";
import {
  clearAll,
  getMeta,
  getSession,
  getUpload,
  listSessions,
  putSession,
  putUpload,
  setMeta,
  type StoredObservation,
  type StoredSession,
} from "./store";
import { analyseVideo, MAX_ANALYSIS_FRAMES, probeVideo } from "./pipeline";

const LEVEL_ORDER: Record<Level, number> = { Normal: 0, Suspicious: 1, Irregular: 2 };
const DEFAULT_CONFIG_PREFIX = "engine-config";
const DEFAULT_ANOMALY = { suspicious: 0.45, irregular: 0.75 };

export function defaultConfig(): EngineConfig {
  return {
    video: { frame_width: null, frame_height: null, process_fps: 10 },
    preprocess: { gaussian_blur_ksize: 3, fill_small_blobs_px: 12, morph_kernel_size: 3 },
    shape: { epsilon_factor: 0.02, min_rotation_lock_aspect: 1.2, circularity_target: 0.7 },
    tracking: { max_age: 8, min_hits: 2, position_gate_px: 48, kalman_process_noise: 0.03, kalman_measurement_noise: 0.1 },
    calibration: { warmup_tracks: 1, tracks_seconds: 0, min_samples: 30, direction_bin_deg: 45 },
    anomaly: {
      contamination: 0.05,
      per_object_window: 30,
      threshold_suspicious: DEFAULT_ANOMALY.suspicious,
      threshold_irregular: DEFAULT_ANOMALY.irregular,
      weights: { rule: 0.5, ml: 0, scene: 0.5 },
      rule: { loiter_seconds: 6, direction_dev_deg: 60 },
    },
    zone: { enabled: false, zones: [], dwell_seconds: 4 },
    dashboard: { page_title: "Irregular Tracking" },
    paths: { samples: "public/samples", output: "browser", db: "IndexedDB · neural-command", read_only: false },
  };
}

function iso(ts: number | string): string {
  return typeof ts === "string" ? ts : new Date(ts).toISOString();
}

function notFound(what: string): ApiError {
  return new ApiError(404, "not_found", `No ${what} with that identifier exists in this browser.`);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function stdDev(values: number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function statSummary(values: number[]): StatSummary | null {
  if (values.length === 0) return null;
  return {
    samples: values.length,
    p10: round(percentile(values, 0.1) ?? 0),
    p50: round(percentile(values, 0.5) ?? 0),
    p90: round(percentile(values, 0.9) ?? 0),
    mean: round(mean(values) ?? 0),
    std: round(stdDev(values) ?? 0),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    source: "in-browser motion engine",
  };
}

/* ------------------------------------------------------------------ */
/* Session aggregation                                                 */
/* ------------------------------------------------------------------ */

interface TrackAggregate {
  trackId: number;
  colour: string;
  first: number;
  last: number;
  observations: StoredObservation[];
  levels: LevelCounts;
  worst: Level;
  meanSpeed: number | null;
  maxSpeed: number | null;
  pathLength: number | null;
  straightness: number | null;
  seconds: number | null;
  directions: string[];
  maxScore: number | null;
  directionProfile: Record<string, number>;
}

function compass(degrees: number): string {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  // Screen space: 0° points right, 90° points down. Report a readable heading.
  const normalised = ((degrees % 360) + 360) % 360;
  // Convert screen angle to compass: right = E, down = S.
  const compassIndex = Math.round((normalised + 90) / 45) % 8;
  return names[compassIndex];
}

function trackAggregates(session: StoredSession): TrackAggregate[] {
  const byTrack = new Map<number, StoredObservation[]>();
  for (const observation of session.observations) {
    const list = byTrack.get(observation.trackId);
    if (list) list.push(observation);
    else byTrack.set(observation.trackId, [observation]);
  }
  const aggregates: TrackAggregate[] = [];
  for (const [trackId, rows] of byTrack) {
    rows.sort((a, b) => a.frame - b.frame);
    const levels: LevelCounts = { Normal: 0, Suspicious: 0, Irregular: 0 };
    for (const row of rows) levels[row.level] += 1;
    const speeds = rows.map((row) => row.speed).filter((value): value is number => value !== null && value >= 0);
    const dx = rows[rows.length - 1].centroid[0] - rows[0].centroid[0];
    const dy = rows[rows.length - 1].centroid[1] - rows[0].centroid[1];
    const displacement = Math.hypot(dx, dy);
    let path = 0;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].frame - rows[index - 1].frame > 3) continue;
      path += Math.hypot(
        rows[index].centroid[0] - rows[index - 1].centroid[0],
        rows[index].centroid[1] - rows[index - 1].centroid[1],
      );
    }
    const directionHistogram: Record<string, number> = {};
    for (const row of rows) {
      if (row.direction === null) continue;
      const key = compass(row.direction);
      directionHistogram[key] = (directionHistogram[key] ?? 0) + 1;
    }
    const dominant = Object.entries(directionHistogram)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 2)
      .map(([key]) => key);
    aggregates.push({
      trackId,
      colour: rows[rows.length - 1].colour,
      first: rows[0].frame,
      last: rows[rows.length - 1].frame,
      observations: rows,
      levels,
      worst: levels.Irregular > 0 ? "Irregular" : levels.Suspicious > 0 ? "Suspicious" : "Normal",
      meanSpeed: speeds.length ? round(mean(speeds) ?? 0) : null,
      maxSpeed: speeds.length ? round(Math.max(...speeds)) : null,
      pathLength: rows.length > 1 ? round(path) : null,
      straightness: path > 0 ? round(displacement / path, 3) : null,
      seconds: round(rows[rows.length - 1].ts - rows[0].ts),
      directions: dominant,
      maxScore: rows.reduce((best, row) => Math.max(best, row.score), 0),
      directionProfile: directionHistogram,
    });
  }
  return aggregates.sort((a, b) => a.first - b.first || a.trackId - b.trackId);
}

interface EventRow {
  eventId: number;
  trackId: number;
  frame: number;
  firstFrame: number;
  lastFrame: number;
  level: Level;
  score: number;
  speed: number | null;
  direction: number | null;
  ts: number;
  observation: StoredObservation;
}

/** Consecutive elevated observations of one track collapse into one event. */
function sessionEvents(session: StoredSession): EventRow[] {
  const groups = new Map<number, StoredObservation[]>();
  for (const row of session.observations) {
    if (row.level === "Normal") continue;
    const list = groups.get(row.trackId);
    if (list) list.push(row);
    else groups.set(row.trackId, [row]);
  }
  const events: EventRow[] = [];
  for (const [trackId, rows] of groups) {
    rows.sort((a, b) => a.frame - b.frame);
    let run: StoredObservation[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const peak = run.reduce((best, row) =>
        LEVEL_ORDER[row.level] > LEVEL_ORDER[best.level] ||
        (row.level === best.level && row.score > best.score)
          ? row
          : best,
      );
      events.push({
        eventId: 0,
        trackId,
        frame: peak.frame,
        firstFrame: run[0].frame,
        lastFrame: run[run.length - 1].frame,
        level: peak.level,
        score: peak.score,
        speed: peak.speed,
        direction: peak.direction,
        ts: peak.ts,
        observation: peak,
      });
      run = [];
    };
    for (const row of rows) {
      if (run.length === 0) {
        run.push(row);
        continue;
      }
      if (row.frame - run[run.length - 1].frame <= 2) run.push(row);
      else {
        flush();
        run.push(row);
      }
    }
    flush();
  }
  events.sort((a, b) => a.frame - b.frame || a.trackId - b.trackId);
  events.forEach((event, index) => {
    event.eventId = index + 1;
  });
  return events;
}

function levelShare(counts: LevelCounts): { Normal: number; Suspicious: number; Irregular: number } {
  const total = counts.Normal + counts.Suspicious + counts.Irregular;
  if (total === 0) return { Normal: 0, Suspicious: 0, Irregular: 0 };
  return {
    Normal: round(counts.Normal / total, 4),
    Suspicious: round(counts.Suspicious / total, 4),
    Irregular: round(counts.Irregular / total, 4),
  };
}

function sessionCounts(session: StoredSession): { counts: LevelCounts; observations: number; tracks: number; events: EventRow[] } {
  const counts: LevelCounts = { Normal: 0, Suspicious: 0, Irregular: 0 };
  for (const row of session.observations) counts[row.level] += 1;
  const tracks = new Set(session.observations.map((row) => row.trackId)).size;
  return { counts, observations: session.observations.length, tracks, events: sessionEvents(session) };
}

function toSessionItem(session: StoredSession): SessionItem {
  const { counts, observations, tracks, events } = sessionCounts(session);
  const frames = session.observations.map((row) => row.frame);
  return {
    session: session.id,
    source: {
      label: session.source.label,
      kind: session.source.kind,
      synthetic: session.source.synthetic,
    },
    processing: {
      frames_processed: session.processing.frames,
      width: session.processing.width,
      height: session.processing.height,
      fps: session.processing.fps,
      wall_s: round(session.processing.wallS, 2),
      max_frames: session.processing.maxFrames,
      processing_fps: round(session.processing.processFps, 1),
      video_duration_s: session.processing.videoDurationS,
      started_ts: session.startedTs,
      ended_ts: session.endedTs,
      run_stats_available: true,
    },
    counts: {
      observations,
      tracks,
      anomalies: events.length,
      levels: counts,
      labels: session.labels.length,
    },
    frame_range: {
      first: frames.length ? Math.min(...frames) : null,
      last: frames.length ? Math.max(...frames) : null,
    },
    timestamps: {
      first_ts: session.observations.length ? iso(session.startedTs) : null,
      last_ts: session.observations.length ? iso(session.endedTs) : null,
    },
  };
}

function observationItem(session: StoredSession, event: EventRow): ObservationItem {
  const peak = event.observation;
  const speed = peak.speed === null ? "unmeasured" : `${round(peak.speed, 1)} px/s`;
  return {
    event_id: event.eventId,
    session: session.id,
    frame: event.frame,
    ts_utc: new Date(Date.parse(session.startedTs) + peak.ts * 1000).toISOString(),
    track_id: event.trackId,
    level: event.level,
    scores: {
      fused: round(event.score, 4),
      rule: round(peak.rule, 4),
      ml: peak.ml,
      scene: peak.scene === null ? null : round(peak.scene, 4),
    },
    motion: { speed_px_s: peak.speed === null ? null : round(peak.speed, 2), direction_deg: peak.direction },
    summary: `Object T${String(event.trackId).padStart(2, "0")} measured ${speed} at frame ${event.frame}, ${levelNote(event.level, event.score)}.`,
  };
}

function levelNote(level: Level, score: number): string {
  const share = round(score * 100, 1);
  if (level === "Irregular") return `a scene-relative deviation of ${share}% above the learned baseline`;
  if (level === "Suspicious") return `a scene-relative deviation of ${share}% that leaves the normal band`;
  return `inside the learned normal band (${share}%)`;
}

function anomalyItem(session: StoredSession, event: EventRow): AnomalyItem {
  const peak = event.observation;
  return {
    ...observationItem(session, event),
    evidence: {
      available: true,
      source: "in-browser motion engine",
      rules: [
        {
          rule: "speed_deviation",
          severity: round(peak.rule, 4),
          description: `Measured ${peak.speed === null ? "no settled speed" : `${round(peak.speed, 1)} px/s`} against the scene baseline.`,
        },
      ],
      ml_note: null,
      scene_note: `Scene channel ${peak.scene === null ? "unavailable" : `${round(peak.scene * 100, 1)}% of the learned deviation scale`}.`,
      zone: null,
      zone_dwell_s: null,
      appearance: { color: peak.colour, shape: null, class_name: null },
    },
  };
}

function framesWithPreviews(session: StoredSession): Map<number, string> {
  const map = new Map<number, string>();
  for (const preview of session.previews) map.set(preview.frame, preview.annotated);
  return map;
}

/** Nearest retained preview frame at or before `frame`. */
function nearestPreview(session: StoredSession, frame: number): { preview: StoredPreview | null; offset: number } {
  let best: StoredPreview | null = null;
  for (const preview of session.previews) {
    if (preview.frame <= frame) {
      if (!best || preview.frame > best.frame) best = preview;
    }
  }
  if (!best && session.previews.length) best = session.previews[0];
  return { preview: best, offset: best ? frame - best.frame : 0 };
}

type StoredPreview = StoredSession["previews"][number];

function trackItem(aggregate: TrackAggregate, events: EventRow[]): TrackItem {
  const first = aggregate.observations[0];
  const last = aggregate.observations[aggregate.observations.length - 1];
  return {
    track_id: aggregate.trackId,
    appearance: { color: aggregate.colour, shape: null, class_name: null },
    frames: {
      first: aggregate.first,
      last: aggregate.last,
      summary_first: aggregate.first,
      summary_last: aggregate.last,
    },
    observed: {
      observations: aggregate.observations.length,
      anomalies: events.filter((event) => event.trackId === aggregate.trackId).length,
      levels: aggregate.levels,
      worst_level: aggregate.worst,
      duration_s: aggregate.seconds,
    },
    motion: {
      mean_speed_px_s: aggregate.meanSpeed,
      max_speed_px_s: aggregate.maxSpeed,
      path_length_px: aggregate.pathLength,
      straightness: aggregate.straightness,
      n_points: aggregate.observations.length,
      n_seconds: aggregate.seconds,
      summary_directions: aggregate.directions,
      max_fused_score: round(aggregate.maxScore ?? 0, 4),
      speed_source: "measured · in-browser engine",
    },
    timestamps: {
      first_ts: iso(new Date(first.ts * 1000).toISOString()),
      last_ts: iso(new Date(last.ts * 1000).toISOString()),
    },
  };
}

function sortTracks(tracks: TrackItem[], sort: string | undefined): TrackItem[] {
  const copy = [...tracks];
  switch (sort) {
    case "speed":
      return copy.sort((a, b) => (b.motion.max_speed_px_s ?? -1) - (a.motion.max_speed_px_s ?? -1));
    case "events":
    case "anomalies":
      return copy.sort(
        (a, b) => b.observed.anomalies - a.observed.anomalies || LEVEL_ORDER[b.observed.worst_level] - LEVEL_ORDER[a.observed.worst_level],
      );
    case "track":
      return copy.sort((a, b) => a.track_id - b.track_id);
    default:
      return copy.sort((a, b) => (a.frames.first ?? 0) - (b.frames.first ?? 0));
  }
}

async function requireSession(sessionId: string): Promise<StoredSession> {
  const session = await getSession(sessionId);
  if (!session) throw notFound("session");
  return session;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

interface JobRuntime {
  snapshot: JobSnapshot;
  controller: AbortController;
}

const jobs = new Map<string, JobRuntime>();

function blankJob(jobId: string, sessionId: string, source: JobSnapshot["source"]): JobSnapshot {
  const created = new Date().toISOString();
  return {
    job_id: jobId,
    session_id: sessionId,
    state: "queued",
    stage: "queued",
    source,
    progress: { processed: 0, total: null, percent: 0, measured: true },
    timings: { created_ts: created, started_ts: null, ended_ts: null, elapsed_s: null },
    error: null,
    result: null,
  };
}

async function resolveSourceBlob(source: { kind: "sample" | "upload"; ref: string }): Promise<{
  blob: Blob;
  label: string;
  bytes: number | null;
  synthetic: boolean;
}> {
  if (source.kind === "upload") {
    const upload = await getUpload(source.ref);
    if (!upload) throw notFound("upload");
    return { blob: upload.blob, label: upload.name, bytes: upload.bytes, synthetic: false };
  }
  const index = await sampleIndex();
  const entry = index.sources.find((item) => item.name === source.ref || item.path === source.ref);
  if (!entry) throw notFound("sample");
  const response = await fetch(sampleUrl(entry.name));
  if (!response.ok) throw new ApiError(404, "sample_unavailable", `The bundled sample ${entry.name} could not be fetched.`);
  return { blob: await response.blob(), label: entry.name, bytes: entry.bytes, synthetic: entry.synthetic };
}

async function runJob(jobId: string): Promise<void> {
  const runtime = jobs.get(jobId);
  if (!runtime) return;
  const { snapshot, controller } = runtime;
  snapshot.state = "running";
  snapshot.stage = "opening";
  snapshot.timings.started_ts = new Date().toISOString();
  try {
    const resolved = await resolveSourceBlob({ kind: snapshot.source.kind, ref: snapshot.source.ref });
    snapshot.stage = "processing";
    const session = await analyseVideo(resolved.blob, {
      label: resolved.label,
      kind: snapshot.source.kind,
      bytes: resolved.bytes,
      synthetic: resolved.synthetic,
      maxFrames: snapshot.source.max_frames,
      signal: controller.signal,
      onProgress: (percent, stage, framesDone) => {
        snapshot.progress.percent = percent;
        snapshot.stage = stage === "completed" ? "persisting" : stage;
        snapshot.progress.processed = framesDone;
      },
    });
    await putSession(session);
    snapshot.session_id = session.id;
    snapshot.progress.percent = 100;
    snapshot.progress.processed = session.processing.frames;
    snapshot.progress.total = session.processing.frames;
    snapshot.state = "completed";
    snapshot.stage = "completed";
    snapshot.timings.ended_ts = new Date().toISOString();
    snapshot.timings.elapsed_s = round(session.processing.wallS, 2);
    const { counts, observations } = sessionCounts(session);
    snapshot.result = {
      frames_processed: session.processing.frames,
      frame_width: session.processing.width ?? 0,
      frame_height: session.processing.height ?? 0,
      fps: session.processing.processFps,
      tracks: new Set(session.observations.map((row) => row.trackId)).size,
      observations,
      levels: counts,
      wall_s: round(session.processing.wallS, 2),
    };
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    snapshot.state = cancelled ? "cancelled" : "failed";
    snapshot.stage = cancelled ? "cancelled" : "failed";
    snapshot.error = cancelled
      ? { code: "cancelled", message: "The run was cancelled before it finished." }
      : {
          code: "analysis_failed",
          message: error instanceof Error ? error.message : "The in-browser analysis failed.",
        };
    snapshot.timings.ended_ts = new Date().toISOString();
  }
}

/* ------------------------------------------------------------------ */
/* Sample footage                                                      */
/* ------------------------------------------------------------------ */

let cachedSources: SourcesResponse | null = null;

function assetsBase(): string {
  return import.meta.env.BASE_URL || "/";
}

export function samplesBase(): string {
  return `${assetsBase().replace(/\/+$/, "")}/samples/index.json`;
}

/** Absolute asset URL for one bundled sample, honouring the deploy base path. */
export function sampleUrl(name: string): string {
  return `${assetsBase().replace(/\/+$/, "")}/samples/${encodeURIComponent(name)}`;
}

interface SampleIndexEntry {
  name: string;
  path: string;
  bytes: number;
  synthetic: boolean;
  kind: string;
  fps: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
}

async function sampleIndex(): Promise<{ sources: SampleIndexEntry[]; directory: string }> {
  const response = await fetch(samplesBase());
  if (!response.ok) {
    throw new ApiError(404, "samples_unavailable", "No bundled sample footage is published with this build.");
  }
  const payload = (await response.json()) as { sources?: SampleIndexEntry[]; directory?: string };
  return { sources: payload.sources ?? [], directory: payload.directory ?? "public/samples" };
}

async function sources(): Promise<SourcesResponse> {
  if (cachedSources) return cachedSources;
  const index = await sampleIndex();
  // The published index carries file facts; the browser measures the clip's
  // own dimensions and duration once, then the result is cached.
  const probed = (await getMeta<Record<string, { width: number | null; height: number | null; durationS: number | null }>>(
    "samples-probe",
  )) ?? {};
  for (const entry of index.sources) {
    // The published index is parsed from the MP4 container at build time, so
    // the list renders immediately; only an entry with no facts needs the
    // browser to decode it once.
    if (entry.width !== null && entry.height !== null) continue;
    if (probed[entry.name]) {
      entry.width = probed[entry.name].width;
      entry.height = probed[entry.name].height;
      entry.durationS = probed[entry.name].durationS;
      continue;
    }
    try {
      const response = await fetch(sampleUrl(entry.name));
      if (!response.ok) continue;
      const probe = await probeVideo(await response.blob());
      entry.width = probe.width;
      entry.height = probe.height;
      entry.durationS = probe.durationS;
      probed[entry.name] = { width: probe.width, height: probe.height, durationS: probe.durationS };
    } catch {
      // An unreadable clip stays listed with its measured facts missing.
    }
  }
  await setMeta("samples-probe", probed);
  const entries: SourceEntry[] = index.sources.map((entry) => ({
    name: entry.name,
    path: entry.path,
    bytes: entry.bytes,
    kind: entry.kind,
    synthetic: entry.synthetic,
    valid: entry.width !== null && entry.height !== null,
    error: entry.width === null ? "The browser could not decode this clip." : null,
    fps: entry.fps,
    frames: entry.frames,
    width: entry.width,
    height: entry.height,
    duration_s: entry.durationS,
  }));
  cachedSources = {
    directory: index.directory,
    count: entries.length,
    valid: entries.filter((entry) => entry.valid).length,
    invalid: entries.filter((entry) => !entry.valid).length,
    sources: entries,
  };
  return cachedSources;
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

async function readConfig(): Promise<EngineConfig> {
  const stored = await getMeta<Partial<EngineConfig>>(DEFAULT_CONFIG_PREFIX);
  const base = defaultConfig();
  if (!stored) return base;
  return { ...base, ...stored } as EngineConfig;
}

async function writeConfig(config: EngineConfig): Promise<void> {
  await setMeta(DEFAULT_CONFIG_PREFIX, config);
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

function evaluation(session: StoredSession): EvaluationResponse {
  const byKey = new Map<string, StoredObservation>();
  for (const row of session.observations) byKey.set(`${row.frame}:${row.trackId}`, row);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const labeled: { positive: boolean; score: number }[] = [];
  const labelCounts: Record<string, number> = { Normal: 0, Anomaly: 0 };
  for (const label of session.labels) {
    const row = byKey.get(`${label.frame_idx}:${label.track_id}`);
    if (!row) continue;
    const truth = label.label === "Anomaly";
    labelCounts[label.label] += 1;
    const predicted = row.level !== "Normal";
    labeled.push({ positive: truth, score: row.score });
    if (truth && predicted) tp += 1;
    else if (truth && !predicted) fn += 1;
    else if (!truth && predicted) fp += 1;
    else tn += 1;
  }
  const n = tp + fp + fn + tn;
  if (n === 0) {
    return {
      session: session.id,
      available: false,
      computable: false,
      metrics: null,
      reason: session.labels.length
        ? "None of the saved labels point at an observation in this session."
        : "No ground-truth labels have been saved for this session yet.",
      labeled_observations: 0,
      total_observations: session.observations.length,
      unlabeled_observations: session.observations.length,
      coverage: 0,
      label_counts: labelCounts,
      predicted_positive: session.observations.filter((row) => row.level !== "Normal").length,
      positive_rule: "predicted positive when the measured level is not Normal",
      roc: { available: false, auc: null, points: [], positives: 0, negatives: 0, excluded: 0, reason: "No matched labels." },
    };
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const fpr = fp + tn === 0 ? 0 : fp / (fp + tn);
  const positives = labeled.filter((row) => row.positive);
  const negatives = labeled.filter((row) => !row.positive);

  // Rank-based ROC: every threshold between distinct scores is a point.
  const rocPoints: RocPoint[] = [{ fpr: 0, tpr: 0 }];
  const thresholds = [...new Set(labeled.map((row) => row.score))].sort((a, b) => b - a);
  for (const threshold of thresholds) {
    const tpr =
      positives.length === 0 ? 0 : positives.filter((row) => row.score >= threshold).length / positives.length;
    const rate =
      negatives.length === 0 ? 0 : negatives.filter((row) => row.score >= threshold).length / negatives.length;
    rocPoints.push({ fpr: round(rate, 4), tpr: round(tpr, 4) });
  }
  rocPoints.push({ fpr: 1, tpr: 1 });
  const auc =
    positives.length === 0 || negatives.length === 0
      ? null
      : round(
          (() => {
            let wins = 0;
            for (const positive of positives) {
              for (const negative of negatives) {
                if (positive.score > negative.score) wins += 1;
                else if (positive.score === negative.score) wins += 0.5;
              }
            }
            return wins / (positives.length * negatives.length);
          })(),
          4,
        );

  return {
    session: session.id,
    available: true,
    computable: true,
    metrics: {
      tp,
      fp,
      fn,
      tn,
      precision: round(precision, 4),
      recall: round(recall, 4),
      f1: round(f1, 4),
      fpr: round(fpr, 4),
      accuracy: round((tp + tn) / n, 4),
      n_labeled: n,
      roc_auc: auc,
    },
    reason: null,
    labeled_observations: n,
    total_observations: session.observations.length,
    unlabeled_observations: session.observations.length - n,
    coverage: round(n / Math.max(1, session.observations.length), 4),
    label_counts: labelCounts,
    predicted_positive: tp + fp,
    positive_rule: "predicted positive when the measured level is not Normal",
    roc: {
      available: positives.length > 0 && negatives.length > 0,
      auc,
      points: rocPoints,
      positives: positives.length,
      negatives: negatives.length,
      excluded: 0,
      reason:
        positives.length === 0
          ? "Save at least one Anomaly label and one Normal label to rank the ROC."
          : negatives.length === 0
            ? "Save at least one Normal label as well, otherwise there is nothing to rank against."
            : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

function csv(header: string[], rows: (string | number | null)[][]): Blob {
  const escape = (value: string | number | null) => {
    if (value === null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => row.map(escape).join(",")).join("\n");
  return new Blob([`${header.join(",")}\n${body}\n`], { type: "text/csv;charset=utf-8" });
}

function reportMarkdown(session: StoredSession, summary: SessionSummary): Blob {
  const { counts, events } = sessionCounts(session);
  const tracks = trackAggregates(session);
  const lines = [
    `# Session report · ${session.id}`,
    "",
    `- Source: ${session.source.label} (${session.source.kind})`,
    `- Created: ${session.createdTs}`,
    `- Engine: ${session.engine}`,
    `- Frames analysed: ${session.processing.frames}`,
    `- Resolution: ${session.processing.width ?? "—"} × ${session.processing.height ?? "—"}`,
    `- Processing time: ${round(session.processing.wallS, 2)} s (${round(session.processing.processFps, 1)} frames/s)`,
    "",
    "## Levels",
    "",
    `| Level | Observations |`,
    `| --- | --- |`,
    `| Normal | ${counts.Normal} |`,
    `| Suspicious | ${counts.Suspicious} |`,
    `| Irregular | ${counts.Irregular} |`,
    "",
    `Tracks: ${tracks.length} · events: ${events.length} · observations: ${session.observations.length}`,
    "",
    "## Events",
    "",
    events.length
      ? "| Event | Frame | Track | Level | Score | Speed px/s |"
      : "No observation left the Normal band in this run.",
    ...(events.length ? ["| --- | --- | --- | --- | --- | --- |"] : []),
    ...events.map(
      (event) =>
        `| ${event.eventId} | ${event.frame} | T${event.trackId} | ${event.level} | ${round(event.score, 4)} | ${event.speed === null ? "—" : round(event.speed, 1)} |`,
    ),
    "",
    "## Method",
    "",
    "Frames are decoded in the browser, background subtraction finds changed regions,",
    "a nearest-centroid tracker keeps one identity per object and each measured speed is",
    "scored against the scene's own baseline. There is no object classifier: an object is",
    "described by its measured dominant colour, never guessed as a person or a vehicle.",
    "",
    `Ground-truth labels: ${session.labels.length} (${summary.labels.labels === session.labels.length ? "current" : "stale"}).`,
    "",
  ];
  return new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
}

/* ------------------------------------------------------------------ */
/* Public surface                                                      */
/* ------------------------------------------------------------------ */

export const localApi = {
  health: async (): Promise<Health> => ({
    status: "ok",
    version: "local",
    uptime_s: Math.round(performance.now() / 1000),
    backend: "local",
  }),

  system: async (): Promise<SystemStatus> => {
    const sessions = await listSessions();
    const bytes = sessions.reduce(
      (sum, session) => sum + session.observations.length * 96 + session.previews.length * 12_000,
      0,
    );
    return {
      version: "in-browser backend",
      python: "not available (static deployment)",
      python_implementation: "browser",
      platform: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      packages: { engine: "localVisionEngine", storage: "IndexedDB" },
      storage: {
        db: { path: "IndexedDB · neural-command", exists: true, bytes },
        samples: { path: "public/samples", exists: true, videos: 3, bytes: 0 },
        output: { path: "browser memory", exists: true, files: sessions.length, bytes: 0 },
      },
      runtime: { executable: "browser", pid: 0 },
      limits: {
        max_upload_bytes: 256 * 1024 * 1024,
        upload_ttl_s: 0,
        max_workers: 1,
        max_frames_cap: MAX_ANALYSIS_FRAMES,
      },
      formats: {
        extensions: [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"],
        mime_types: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo"],
      },
      configuration: {
        writable: true,
        persistence: "browser_indexeddb",
        resets_on_restart: false,
        paths_read_only: false,
      },
    };
  },

  sources,

  config: readConfig,
  updateConfig: async (patch: Record<string, unknown>): Promise<ConfigUpdateResponse> => {
    const current = await readConfig();
    const merged = { ...current, ...patch } as EngineConfig;
    await writeConfig(merged);
    return { config: merged, applied: Object.keys(patch), changed: true };
  },
  resetConfig: async (): Promise<ConfigResetResponse> => {
    const config = defaultConfig();
    await writeConfig(config);
    return { config, applied: ["*"], changed: true, reset_to_defaults: true };
  },

  sessions: async (params: { limit?: number; offset?: number } = {}): Promise<SessionList> => {
    const all = await listSessions();
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return {
      total: all.length,
      count: Math.max(0, Math.min(limit, all.length - offset)),
      limit,
      offset,
      sessions: all.slice(offset, offset + limit).map(toSessionItem),
    };
  },

  session: async (sessionId: string): Promise<SessionDetail> => {
    const session = await requireSession(sessionId);
    const item = toSessionItem(session);
    return {
      ...item,
      artifacts: {
        retained: true,
        trajectories: true,
        structured_evidence: true,
        scene_calibration: true,
        preview_frames: session.previews.length,
      },
      media: {
        preview_frames: session.previews.length,
        available: session.previews.length > 0,
        preview_stride: session.previews.length > 1 ? session.previews[1].frame - session.previews[0].frame : null,
      },
      labels: {
        labels: session.labels.length,
        evaluation_url: `/api/v1/sessions/${encodeURIComponent(session.id)}/evaluation`,
      },
      limitations:
        session.source.kind === "live"
          ? ["Live captures are stored in this browser only; clearing site data removes them."]
          : [],
    };
  },

  sessionSummary: async (sessionId: string): Promise<SessionSummary> => {
    const session = await requireSession(sessionId);
    const item = toSessionItem(session);
    const events = sessionEvents(session);
    const scores = events.filter((event) => event.score !== null).map((event) => event.score);
    const tracks = trackAggregates(session);
    const highest = events.reduce<EventRow | null>(
      (best, event) => (!best || event.score > best.score ? event : best),
      null,
    );
    return {
      ...item,
      level_share: levelShare(item.counts.levels),
      anomalies: {
        count: events.length,
        tracks_affected: new Set(events.map((event) => event.trackId)).size,
        score_min: scores.length ? round(Math.min(...scores), 4) : null,
        score_max: scores.length ? round(Math.max(...scores), 4) : null,
        score_mean: scores.length ? round(mean(scores) ?? 0, 4) : null,
        highest: highest
          ? {
              event_id: highest.eventId,
              frame: highest.frame,
              track_id: highest.trackId,
              level: highest.level,
              fused_score: round(highest.score, 4),
            }
          : null,
      },
      tracks: {
        count: tracks.length,
        with_anomalies: tracks.filter((track) => track.worst !== "Normal").length,
        with_irregular: tracks.filter((track) => track.worst === "Irregular").length,
      },
      temporal: {
        first_frame: item.frame_range.first,
        last_frame: item.frame_range.last,
        observed_seconds:
          session.observations.length > 1
            ? round(
                session.observations[session.observations.length - 1].ts - session.observations[0].ts,
              )
            : null,
      },
      labels: {
        labels: session.labels.length,
        evaluation_url: `/api/v1/sessions/${encodeURIComponent(session.id)}/evaluation`,
      },
    };
  },

  tracks: async (
    sessionId: string,
    params: { level?: string; min_events?: number; sort?: string; limit?: number; offset?: number } = {},
  ): Promise<TrackList> => {
    const session = await requireSession(sessionId);
    const events = sessionEvents(session);
    let items = trackAggregates(session).map((aggregate) => trackItem(aggregate, events));
    if (params.level) items = items.filter((track) => track.observed.worst_level === params.level);
    if (params.min_events !== undefined) {
      items = items.filter((track) => track.observed.anomalies >= (params.min_events as number));
    }
    items = sortTracks(items, params.sort);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    return {
      total: items.length,
      count: Math.max(0, Math.min(limit, items.length - offset)),
      limit,
      offset,
      tracks: items.slice(offset, offset + limit),
    };
  },

  track: async (sessionId: string, trackId: number): Promise<TrackDetail> => {
    const session = await requireSession(sessionId);
    const events = sessionEvents(session);
    const aggregate = trackAggregates(session).find((row) => row.trackId === trackId);
    if (!aggregate) throw notFound("track");
    const item = trackItem(aggregate, events);
    return {
      ...item,
      session: session.id,
      direction_profile: {
        samples: aggregate.observations.filter((row) => row.direction !== null).length,
        counts: aggregate.directionProfile,
        histogram: aggregate.directionProfile,
        dominant: aggregate.directions,
        source: "measured heading of the tracked centroid",
      },
      trajectory: { available: true, points: aggregate.observations.length, reason: null },
    };
  },

  trackTrajectory: async (sessionId: string, trackId: number): Promise<TrajectoryResponse> => {
    const session = await requireSession(sessionId);
    const aggregate = trackAggregates(session).find((row) => row.trackId === trackId);
    if (!aggregate) throw notFound("track");
    return {
      session: session.id,
      track_id: trackId,
      available: true,
      points: aggregate.observations.map((row) => ({
        frame: row.frame,
        x: round(row.centroid[0], 2),
        y: round(row.centroid[1], 2),
        level: row.level,
        speed_px_s: row.speed === null ? null : round(row.speed, 2),
        direction_deg: row.direction,
      })),
      reason: null,
      source: "in_process",
    };
  },

  trackObservations: async (
    sessionId: string,
    trackId: number,
    params: { limit?: number; offset?: number } = {},
  ): Promise<{ total: number; count: number; observations: ObservationItem[] }> => {
    const session = await requireSession(sessionId);
    const rows = session.observations
      .filter((row) => row.trackId === trackId)
      .sort((a, b) => a.frame - b.frame);
    if (rows.length === 0) throw notFound("track");
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    const page = rows.slice(offset, offset + limit);
    return {
      total: rows.length,
      count: page.length,
      observations: page.map((row, index) => {
        const event: EventRow = {
          eventId: offset + index + 1,
          trackId,
          frame: row.frame,
          firstFrame: row.frame,
          lastFrame: row.frame,
          level: row.level,
          score: row.score,
          speed: row.speed,
          direction: row.direction,
          ts: row.ts,
          observation: row,
        };
        return observationItem(session, event);
      }),
    };
  },

  trackFrames: async (
    sessionId: string,
    trackId: number,
    params: { limit?: number; offset?: number } = {},
  ): Promise<TrackFramesResponse> => {
    const session = await requireSession(sessionId);
    const rows = session.observations
      .filter((row) => row.trackId === trackId)
      .sort((a, b) => a.frame - b.frame);
    if (rows.length === 0) throw notFound("track");
    const previews = framesWithPreviews(session);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    const page = rows.slice(offset, offset + limit);
    return {
      session: session.id,
      track_id: trackId,
      total: rows.length,
      count: page.length,
      limit,
      offset,
      media_available: previews.size > 0,
      reason: previews.size === 0 ? "This session retained no preview frames." : null,
      frames: page.map((row) => ({
        frame: row.frame,
        ts_utc: new Date(Date.parse(session.startedTs) + row.ts * 1000).toISOString(),
        level: row.level,
        fused_score: round(row.score, 4),
        speed_px_s: row.speed === null ? null : round(row.speed, 2),
        preview_available: previews.has(row.frame),
        frame_url: previews.get(row.frame) ?? null,
      })),
    };
  },

  anomalies: async (
    sessionId: string,
    params: {
      severity?: string;
      track_id?: number;
      event_type?: string;
      min_score?: number;
      from_frame?: number;
      to_frame?: number;
      sort?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<AnomalyList> => {
    const session = await requireSession(sessionId);
    let events = sessionEvents(session);
    if (params.severity) events = events.filter((event) => event.level === params.severity);
    if (params.track_id !== undefined) events = events.filter((event) => event.trackId === params.track_id);
    if (params.min_score !== undefined) events = events.filter((event) => event.score >= (params.min_score as number));
    if (params.from_frame !== undefined) events = events.filter((event) => event.frame >= (params.from_frame as number));
    if (params.to_frame !== undefined) events = events.filter((event) => event.frame <= (params.to_frame as number));
    events =
      params.sort === "score"
        ? [...events].sort((a, b) => b.score - a.score)
        : [...events].sort((a, b) => a.frame - b.frame);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return {
      total: events.length,
      count: Math.max(0, Math.min(limit, events.length - offset)),
      limit,
      offset,
      severity: (params.severity as Level | undefined) ?? null,
      event_type: params.event_type ?? null,
      anomalies: events.slice(offset, offset + limit).map((event) => anomalyItem(session, event)),
    };
  },

  anomalyDetail: async (sessionId: string, eventId: number): Promise<AnomalyDetail> => {
    const session = await requireSession(sessionId);
    const event = sessionEvents(session).find((row) => row.eventId === eventId);
    if (!event) throw notFound("event");
    const aggregate = trackAggregates(session).find((row) => row.trackId === event.trackId);
    const preview = nearestPreview(session, event.frame);
    return {
      ...anomalyItem(session, event),
      track: aggregate
        ? {
            track_id: aggregate.trackId,
            color: aggregate.colour,
            shape: null,
            class_name: null,
            observations: aggregate.observations.length,
            anomalies: sessionEvents(session).filter((row) => row.trackId === aggregate.trackId).length,
            worst_level: aggregate.worst,
            first_frame: aggregate.first,
            last_frame: aggregate.last,
          }
        : null,
      frame_info: {
        index: event.frame,
        ts_utc: new Date(Date.parse(session.startedTs) + event.observation.ts * 1000).toISOString(),
        media_available: Boolean(preview.preview),
        frame_url: preview.preview ? preview.preview.annotated : null,
      },
      notes: [
        `Peak of a ${event.lastFrame - event.firstFrame + 1}-frame elevated window (frames ${event.firstFrame}–${event.lastFrame}).`,
        "Scores come from the in-browser engine: no object classifier and no ML model run in a static deployment.",
      ],
    };
  },

  scene: async (sessionId: string): Promise<SceneResponse> => {
    const session = await requireSession(sessionId);
    const speeds = session.observations
      .map((row) => row.speed)
      .filter((value): value is number => value !== null && value > 0);
    const sceneScores = session.observations
      .map((row) => row.scene)
      .filter((value): value is number => value !== null);
    const directions: Record<string, number> = {};
    for (const row of session.observations) {
      if (row.direction === null) continue;
      const key = compass(row.direction);
      directions[key] = (directions[key] ?? 0) + 1;
    }
    const perTrack = new Map<number, number>();
    for (const row of session.observations) {
      if (row.scene === null) continue;
      perTrack.set(row.trackId, Math.max(perTrack.get(row.trackId) ?? 0, row.scene));
    }
    return {
      session: session.id,
      source: "in-browser motion engine",
      calibration: {
        available: speeds.length > 0,
        ready: true,
        samples: speeds.length,
        tracks: new Set(session.observations.map((row) => row.trackId)).size,
        observed_seconds:
          session.observations.length > 1
            ? round(session.observations[session.observations.length - 1].ts - session.observations[0].ts)
            : null,
        reason: speeds.length > 0 ? null : "No settled speed was measured, so no baseline exists.",
        persisted: true,
        captured_ts: session.endedTs,
        snapshot_version: 1,
        parameters: { threshold_suspicious: DEFAULT_ANOMALY.suspicious, threshold_irregular: DEFAULT_ANOMALY.irregular },
      },
      speed_baseline: statSummary(speeds),
      directions: {
        samples: session.observations.filter((row) => row.direction !== null).length,
        counts: directions,
        histogram: directions,
        dominant: Object.entries(directions)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 2)
          .map(([key]) => key),
        source: "measured heading per observation",
      },
      deviations: {
        scene_score: {
          samples: sceneScores.length,
          mean: sceneScores.length ? round(mean(sceneScores) ?? 0, 4) : null,
          p50: sceneScores.length ? round(percentile(sceneScores, 0.5) ?? 0, 4) : null,
          max: sceneScores.length ? round(Math.max(...sceneScores), 4) : null,
          p90: sceneScores.length ? round(percentile(sceneScores, 0.9) ?? 0, 4) : null,
        },
        above_0_2: sceneScores.filter((value) => value > 0.2).length,
        above_0_3: sceneScores.filter((value) => value > 0.3).length,
        affected_tracks: perTrack.size,
        top_tracks: [...perTrack.entries()]
          .map(([track_id, max_scene_score]) => ({
            track_id,
            max_scene_score: round(max_scene_score, 4),
            observations: session.observations.filter((row) => row.trackId === track_id).length,
          }))
          .sort((a, b) => b.max_scene_score - a.max_scene_score)
          .slice(0, 5),
      },
      notes: [
        "The baseline is learned from this run's own measured speeds; a very short clip calibrates less reliably.",
        "No object classification is available in the browser, so colours are measured, not recognised.",
      ],
    };
  },

  media: async (sessionId: string): Promise<MediaResponse> => {
    const session = await requireSession(sessionId);
    return {
      session: session.id,
      available: session.previews.length > 0,
      preview_stride:
        session.previews.length > 1 ? session.previews[1].frame - session.previews[0].frame : null,
      preview_count: session.previews.length,
      source_resolution:
        session.processing.width && session.processing.height
          ? { width: session.processing.width, height: session.processing.height }
          : null,
      frames: session.previews.map((preview) => ({
        frame: preview.frame,
        ts_s: round(preview.tsS, 3),
        annotated_url: preview.annotated,
        original_url: preview.original,
      })),
      annotated_video: {
        available: false,
        reason: "A static deployment cannot re-encode video; the annotated preview frames are the retained evidence.",
      },
      notes: ["Previews are captured during analysis and stored in this browser."],
    };
  },

  objectEvidence: async (
    sessionId: string,
    params: { limit?: number; window?: number } = {},
  ): Promise<ObjectEvidenceResponse> => {
    const session = await requireSession(sessionId);
    const events = sessionEvents(session)
      .filter((event) => event.level !== "Normal")
      .sort((a, b) => b.score - a.score);
    const limit = params.limit ?? 8;
    const items = [];
    for (const event of events) {
      const preview = nearestPreview(session, event.frame);
      const crop = session.crops[`${preview.preview?.frame}:${event.trackId}`];
      if (!crop || !preview.preview) continue;
      items.push({
        track_id: event.trackId,
        event_id: event.eventId,
        requested_frame: event.frame,
        retained_frame: preview.preview.frame,
        frame_offset: preview.offset,
        level: event.level,
        fused_score: round(event.score, 4),
        speed_px_s: event.speed === null ? null : round(event.speed, 2),
        direction_deg: event.direction,
        summary: observationItem(session, event).summary,
        window_px: params.window ?? 112,
        centroid: { x: round(event.observation.centroid[0], 1), y: round(event.observation.centroid[1], 1) },
        crop_url: crop,
      });
      if (items.length >= limit) break;
    }
    return {
      session: session.id,
      available: items.length > 0,
      count: items.length,
      irregular_objects: new Set(events.filter((event) => event.level === "Irregular").map((event) => event.trackId)).size,
      ranked_objects: new Set(events.map((event) => event.trackId)).size,
      preview_frames: session.previews.length,
      preview_stride:
        session.previews.length > 1 ? session.previews[1].frame - session.previews[0].frame : null,
      window_rule: "square window centred on the measured centroid at the retained preview frame",
      items,
      source: "in-browser motion engine",
      note: "Crops come from the retained preview frames, so the frame offset is shown next to each object.",
    };
  },

  evaluation: async (sessionId: string): Promise<EvaluationResponse> => evaluation(await requireSession(sessionId)),

  labels: async (sessionId: string): Promise<LabelPayload> => {
    const session = await requireSession(sessionId);
    const counts: Record<string, number> = { Normal: 0, Anomaly: 0 };
    for (const label of session.labels) counts[label.label] += 1;
    return { session: session.id, count: session.labels.length, counts, labels: session.labels };
  },

  saveLabels: async (
    sessionId: string,
    body: {
      observations?: GroundTruthLabel[];
      tracks?: { track_id: number; label: "Normal" | "Anomaly" }[];
    },
  ): Promise<LabelPayload> => {
    const session = await requireSession(sessionId);
    const additions: GroundTruthLabel[] = [...(body.observations ?? [])];
    let expanded = 0;
    for (const track of body.tracks ?? []) {
      for (const row of session.observations.filter((row) => row.trackId === track.track_id)) {
        additions.push({ frame_idx: row.frame, track_id: row.trackId, label: track.label });
        expanded += 1;
      }
    }
    const seen = new Set<string>();
    const merged: GroundTruthLabel[] = [];
    for (const label of [...session.labels, ...additions]) {
      const key = `${label.frame_idx}:${label.track_id}`;
      if (seen.has(key)) {
        const index = merged.findIndex((row) => row.frame_idx === label.frame_idx && row.track_id === label.track_id);
        if (index >= 0) merged[index] = label;
        continue;
      }
      seen.add(key);
      merged.push(label);
    }
    session.labels = merged;
    await putSession(session);
    const counts: Record<string, number> = { Normal: 0, Anomaly: 0 };
    for (const label of merged) counts[label.label] += 1;
    return {
      session: session.id,
      count: merged.length,
      counts,
      labels: merged,
      saved: additions.length,
      expanded_from_tracks: expanded,
    };
  },

  clearLabels: async (sessionId: string): Promise<LabelPayload> => {
    const session = await requireSession(sessionId);
    const removed = session.labels.length;
    session.labels = [];
    await putSession(session);
    return { session: session.id, count: 0, counts: { Normal: 0, Anomaly: 0 }, labels: [], removed };
  },

  downloadExport: async (
    sessionId: string,
    kind: "events" | "tracks" | "report",
  ): Promise<{ blob: Blob; filename: string; rowCount: number | null; contentType: string | null }> => {
    const session = await requireSession(sessionId);
    if (kind === "report") {
      const summary = await localApi.sessionSummary(sessionId);
      return {
        blob: reportMarkdown(session, summary),
        filename: `${session.id}_report.md`,
        rowCount: null,
        contentType: "text/markdown;charset=utf-8",
      };
    }
    if (kind === "events") {
      const events = sessionEvents(session);
      const rows = events.map((event) => [
        event.eventId,
        event.frame,
        event.trackId,
        event.level,
        round(event.score, 4),
        event.speed === null ? null : round(event.speed, 2),
        event.direction,
        event.firstFrame,
        event.lastFrame,
      ]);
      return {
        blob: csv(["event_id", "frame", "track_id", "level", "fused_score", "speed_px_s", "direction_deg", "first_frame", "last_frame"], rows),
        filename: `${session.id}_events.csv`,
        rowCount: rows.length,
        contentType: "text/csv;charset=utf-8",
      };
    }
    const tracks = trackAggregates(session);
    const rows = tracks.map((track) => [
      track.trackId,
      track.colour,
      track.first,
      track.last,
      track.observations.length,
      track.levels.Irregular,
      track.levels.Suspicious,
      track.meanSpeed,
      track.maxSpeed,
      track.pathLength,
      track.straightness,
    ]);
    return {
      blob: csv(
        ["track_id", "colour", "first_frame", "last_frame", "observations", "irregular", "suspicious", "mean_speed_px_s", "max_speed_px_s", "path_length_px", "straightness"],
        rows,
      ),
      filename: `${session.id}_tracks.csv`,
      rowCount: rows.length,
      contentType: "text/csv;charset=utf-8",
    };
  },

  uploadVideo: async (
    file: File,
    options: { onProgress?: (percent: number) => void; signal?: AbortSignal } = {},
  ): Promise<UploadRecord> => {
    const { onProgress, signal } = options;
    const created = new Date().toISOString();
    const reader = file.stream().getReader();
    let read = 0;
    // Reading the stream reports bytes actually taken in, not a simulated bar.
    for (;;) {
      if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      read += value?.byteLength ?? 0;
      onProgress?.(Math.min(100, Math.round((100 * read) / Math.max(1, file.size))));
    }
    const probe = await probeVideo(file);
    const id = `upl_${created.replace(/[-:.TZ]/g, "").slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
    await putUpload({
      id,
      name: file.name,
      bytes: file.size,
      type: file.type || null,
      createdTs: created,
      blob: file,
      probe,
    });
    return {
      upload_id: id,
      filename: file.name,
      bytes: file.size,
      content_type: file.type || null,
      created_ts: created,
      video: {
        valid: true,
        error: null,
        fps: probe.fps,
        frames: probe.frames,
        width: probe.width,
        height: probe.height,
        duration_s: probe.durationS,
      },
    };
  },

  createJob: async (
    source: { kind: "sample" | "upload"; ref: string },
    options: { maxFrames?: number | null } = {},
  ): Promise<{ job: JobSnapshot }> => {
    const running = [...jobs.values()].find(
      (runtime) =>
        runtime.snapshot.source.ref === source.ref &&
        runtime.snapshot.source.kind === source.kind &&
        ["queued", "running", "cancellation_requested"].includes(runtime.snapshot.state),
    );
    if (running) {
      throw new ApiError(409, "job_duplicate", "That source is already being analysed.", {
        job_id: running.snapshot.job_id,
      });
    }
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const sessionId = `pending_${jobId}`;
    let label = source.ref;
    if (source.kind === "upload") label = (await getUpload(source.ref))?.name ?? source.ref;
    const snapshot = blankJob(jobId, sessionId, {
      kind: source.kind,
      ref: source.ref,
      label,
      max_frames: options.maxFrames ?? null,
    });
    jobs.set(jobId, { snapshot, controller: new AbortController() });
    void runJob(jobId);
    return { job: { ...snapshot } };
  },

  jobs: async (params: { status?: string; limit?: number; offset?: number } = {}): Promise<JobList> => {
    let all = [...jobs.values()].map((runtime) => runtime.snapshot);
    if (params.status) all = all.filter((job) => job.state === params.status);
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    return { total: all.length, count: Math.max(0, Math.min(limit, all.length - offset)), jobs: all.slice(offset, offset + limit) };
  },

  job: async (jobId: string): Promise<{ job: JobSnapshot }> => {
    const runtime = jobs.get(jobId);
    if (!runtime) throw notFound("job");
    return { job: { ...runtime.snapshot } };
  },

  cancelJob: async (jobId: string): Promise<{ job: JobSnapshot }> => {
    const runtime = jobs.get(jobId);
    if (!runtime) throw notFound("job");
    runtime.snapshot.state = "cancellation_requested";
    runtime.snapshot.stage = "cancelling";
    runtime.controller.abort();
    runtime.snapshot.state = "cancelled";
    runtime.snapshot.stage = "cancelled";
    runtime.snapshot.timings.ended_ts = new Date().toISOString();
    return { job: { ...runtime.snapshot } };
  },

  purgeAll: async (): Promise<PurgeResponse> => {
    const sessions = await listSessions();
    const counts = {
      sessions: sessions.length,
      events: sessions.reduce((sum, session) => sum + sessionEvents(session).length, 0),
      tracks: sessions.reduce((sum, session) => sum + new Set(session.observations.map((row) => row.trackId)).size, 0),
      points: sessions.reduce((sum, session) => sum + session.observations.length, 0),
      calibration: sessions.length,
      labels: sessions.reduce((sum, session) => sum + session.labels.length, 0),
      runs: jobs.size,
      artifacts: sessions.reduce((sum, session) => sum + session.previews.length, 0),
      uploads: 0,
      live_cancelled: 0,
      upload_bytes: 0,
      tables_cleared: 3,
      database_bytes: 0,
      config_reset: 1,
      config_changes: [],
    };
    const cleared = await clearAll();
    counts.sessions = cleared.sessions;
    counts.uploads = cleared.uploads;
    jobs.clear();
    cachedSources = null;
    return { purged: counts };
  },

  liveStart: async (): Promise<never> => {
    throw new ApiError(
      501,
      "live_unavailable",
      "Live frames are analysed in this tab; there is no server to create a live session on.",
    );
  },

  liveFrame: async (): Promise<never> => {
    throw new ApiError(501, "live_unavailable", "Live frames are analysed in this tab, not posted to a server.");
  },

  liveStop: async (): Promise<never> => {
    throw new ApiError(501, "live_unavailable", "Live frames are analysed in this tab, not posted to a server.");
  },

  liveCancel: async (): Promise<never> => {
    throw new ApiError(501, "live_unavailable", "Live frames are analysed in this tab, not posted to a server.");
  },
};
