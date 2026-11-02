/** Shapes returned by the existing FastAPI service.
 *
 * These mirror the live JSON exactly; nothing is added that the backend does
 * not already send. Optional values are genuinely nullable on the wire.
 */

export interface Health {
  status: string;
  version: string;
  uptime_s: number;
}

export interface StorageEntry {
  path: string;
  exists: boolean;
  bytes?: number;
  videos?: number;
  files?: number;
}

export interface SystemStatus {
  version: string;
  python: string;
  python_implementation: string;
  platform: string;
  packages: Record<string, string | null>;
  storage: {
    db: StorageEntry;
    samples: StorageEntry;
    output: StorageEntry;
  };
  runtime: {
    executable: string;
    pid: number;
  };
}

export interface SourceEntry {
  name: string;
  path: string;
  bytes: number;
  kind: string;
  synthetic: boolean;
  valid: boolean;
  error: string | null;
  fps: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
}

export interface SourcesResponse {
  directory: string;
  count: number;
  valid: number;
  invalid: number;
  sources: SourceEntry[];
}

export interface ZoneRect {
  name: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface AnomalyConfig {
  contamination: number;
  per_object_window: number;
  scene_cluster_k_min: number;
  scene_cluster_k_max: number;
  threshold_suspicious: number;
  threshold_irregular: number;
  weights: { rule: number; ml: number; scene: number };
  rule: {
    speed_pctl_fast: number;
    speed_pctl_slow: number;
    max_z: number;
    loiter_seconds: number;
    direction_dev_deg: number;
  };
}

export interface EngineConfig {
  video: {
    frame_width: number | null;
    frame_height: number | null;
    process_fps: number | null;
  };
  preprocess: {
    gaussian_blur_ksize: number;
    fill_small_blobs_px: number;
    morph_kernel_size: number;
  };
  shape: {
    epsilon_factor: number;
    min_rotation_lock_aspect: number;
    circularity_target: number;
  };
  tracking: {
    max_age: number;
    min_hits: number;
    iou_gate: number;
    position_gate_px: number;
    kalman_process_noise: number;
    kalman_measurement_noise: number;
  };
  calibration: {
    warmup_tracks: number;
    tracks_seconds: number;
    min_samples: number;
    direction_bin_deg: number;
  };
  anomaly: AnomalyConfig;
  zone: {
    enabled: boolean;
    zones: ZoneRect[];
    dwell_seconds: number;
  };
  dashboard: { page_title: string };
  paths: {
    samples: string;
    output: string;
    db: string;
    read_only: boolean;
  };
  [section: string]: unknown;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

/* ------------------------------------------------------------------ *
 * Session intelligence (read-only). Mirrors /sessions and its children.
 * ------------------------------------------------------------------ */

export type Level = "Normal" | "Suspicious" | "Irregular";

export interface LevelCounts {
  Normal: number;
  Suspicious: number;
  Irregular: number;
}

export interface SessionSource {
  label: string | null;
  kind: string | null;
  synthetic: boolean;
}

export interface SessionProcessing {
  frames_processed: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  wall_s: number | null;
  max_frames: number | null;
  processing_fps: number | null;
  video_duration_s: number | null;
  started_ts: string | null;
  ended_ts: string | null;
  run_stats_available: boolean;
}

export interface SessionCounts {
  observations: number;
  tracks: number;
  anomalies: number;
  levels: LevelCounts;
  labels: number;
}

export interface SessionItem {
  session: string;
  source: SessionSource;
  processing: SessionProcessing;
  counts: SessionCounts;
  frame_range: { first: number | null; last: number | null };
  timestamps: { first_ts: string | null; last_ts: string | null };
}

export interface SessionList {
  total: number;
  count: number;
  limit: number;
  offset: number;
  sessions: SessionItem[];
}

export interface SessionSummary extends SessionItem {
  level_share: LevelShare;
  anomalies: {
    count: number;
    tracks_affected: number;
    score_min: number | null;
    score_max: number | null;
    score_mean: number | null;
    highest: {
      event_id: number;
      frame: number;
      track_id: number;
      level: Level;
      fused_score: number | null;
    } | null;
  };
  tracks: { count: number; with_anomalies: number; with_irregular: number };
  temporal: {
    first_frame: number | null;
    last_frame: number | null;
    observed_seconds: number | null;
  };
  labels: { labels: number; evaluation_url: string };
}

export interface LevelShare {
  Normal: number;
  Suspicious: number;
  Irregular: number;
}

export interface TrackItem {
  track_id: number;
  appearance: { color: string | null; shape: string | null };
  frames: {
    first: number | null;
    last: number | null;
    summary_first: number | null;
    summary_last: number | null;
  };
  observed: {
    observations: number;
    anomalies: number;
    levels: LevelCounts;
    worst_level: Level;
    duration_s: number | null;
  };
  motion: {
    mean_speed_px_s: number | null;
    max_speed_px_s: number | null;
    path_length_px: number | null;
    straightness: number | null;
    n_points: number | null;
    n_seconds: number | null;
    summary_directions: string[];
    max_fused_score: number | null;
    speed_source: string;
  };
  timestamps: { first_ts: string | null; last_ts: string | null };
}

export interface TrackList {
  total: number;
  count: number;
  limit: number;
  offset: number;
  tracks: TrackItem[];
}

export interface DirectionProfile {
  samples: number;
  counts: Record<string, number> | null;
  histogram: Record<string, number>;
  dominant: string[];
  source: string;
}

export interface TrackDetail extends TrackItem {
  session: string;
  direction_profile: DirectionProfile;
  trajectory: { available: boolean; points: number; reason: string | null };
}

export interface TrajectoryPoint {
  frame: number;
  x: number | null;
  y: number | null;
  level: Level | null;
  speed_px_s: number | null;
  direction_deg: number | null;
}

export interface TrajectoryResponse {
  session: string;
  track_id: number;
  available: boolean;
  points: TrajectoryPoint[];
  reason: string | null;
}

export interface ObservationItem {
  event_id: number;
  session: string;
  frame: number;
  ts_utc: string;
  track_id: number;
  level: Level;
  scores: {
    fused: number | null;
    rule: number | null;
    ml: number | null;
    scene: number | null;
  };
  motion: { speed_px_s: number | null; direction_deg: number | null };
  summary: string;
}

export interface AnomalyList {
  total: number;
  count: number;
  limit: number;
  offset: number;
  severity: Level | null;
  event_type: string | null;
  anomalies: ObservationItem[];
}

export interface StatSummary {
  samples: number;
  p10: number;
  p50: number;
  p90?: number;
  mean: number;
  std?: number;
  min?: number;
  max?: number;
  moving_fraction?: number;
  source?: string;
}

export interface SceneResponse {
  session: string;
  source: string;
  calibration: {
    available: boolean;
    ready: boolean | null;
    samples: number | null;
    tracks: number | null;
    observed_seconds: number | null;
    reason: string;
    [key: string]: unknown;
  };
  speed_baseline: StatSummary;
  directions: {
    samples: number;
    counts: Record<string, number> | null;
    histogram: Record<string, number>;
    dominant: string[];
    source: string;
  };
  deviations: {
    scene_score: {
      samples: number;
      mean: number;
      p50: number;
      max: number;
      p90?: number;
    };
    above_0_2: number;
    above_0_3: number;
    affected_tracks: number;
    top_tracks: { track_id: number; max_scene_score: number; observations: number }[];
  };
  notes: string[];
}

export interface EvaluationResponse {
  session: string;
  available: boolean;
  computable: boolean;
  metrics: Record<string, number | null> | null;
  reason: string;
  labeled_observations: number;
  total_observations: number;
  unlabeled_observations: number;
  coverage: number;
  label_counts: { Normal: number; Anomaly: number };
  predicted_positive: number;
  positive_rule: string;
}
