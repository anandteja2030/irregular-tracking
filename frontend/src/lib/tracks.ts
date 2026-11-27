/** Pure helpers for the Track Explorer.
 *
 * Everything here consumes API payloads unchanged: no coordinates or
 * observations are interpolated, and a missing value stays missing rather
 * than becoming zero.
 */
import type {
  Level,
  ObservationItem,
  TrackItem,
  TrajectoryPoint,
} from "./types";
import { formatNumber } from "./format";

export type TrackLevelFilter = "all" | "any" | "Irregular" | "Suspicious" | "Normal";
export type TrackSort = "anomalies" | "speed" | "track_id" | "first_frame";

export const LEVEL_FILTERS: { value: TrackLevelFilter; label: string }[] = [
  { value: "all", label: "All tracks" },
  { value: "any", label: "With anomalies" },
  { value: "Irregular", label: "Irregular tracks" },
  { value: "Suspicious", label: "Suspicious tracks" },
  { value: "Normal", label: "No anomalies" },
];

export const TRACK_SORTS: { value: TrackSort; label: string }[] = [
  { value: "anomalies", label: "Most events" },
  { value: "speed", label: "Fastest max speed" },
  { value: "track_id", label: "Track ID" },
  { value: "first_frame", label: "First appearance" },
];

export function formatTrackId(trackId: number): string {
  return `T${String(trackId).padStart(2, "0")}`;
}

export interface TrackAppearance {
  color: string | null;
  shape: string | null;
  class_name?: string | null;
}

/** What the detector recognised, capitalised for display ("car" -> "Car"). */
export function classLabel(appearance: TrackAppearance | null | undefined): string | null {
  const raw = appearance?.class_name?.trim();
  if (!raw) return null;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Healthy label for an object: its class, or the colour-engine fallback. */
export function appearanceLabel(appearance: TrackAppearance | null | undefined): string {
  const detected = classLabel(appearance);
  if (detected) return detected;
  if (appearance?.color) {
    return `${appearance.color}${appearance.shape ? ` · ${appearance.shape}` : ""}`;
  }
  return "class not reported";
}

/** Correct indefinite article for a label: "an orange polygon", "a green circle". */
function article(label: string): string {
  return /^[aeiou]/i.test(label.trim()) ? "an" : "a";
}

/** The object in ordinary words: "a green circle", "a Car". */
export function objectKind(appearance: TrackAppearance | null | undefined): string {
  const detected = classLabel(appearance);
  if (detected) return `${article(detected)} ${detected}`;
  const colour = appearance?.color?.trim().toLowerCase() ?? "";
  const shape = appearance?.shape?.trim().toLowerCase() ?? "";
  if (colour && shape) return `${article(colour)} ${colour} ${shape}`;
  if (colour) return `${article(colour)} ${colour} object`;
  if (shape) return `${article(shape)} ${shape}`;
  return "an object the engine tracked without a colour or class label";
}

export interface TrackReading {
  /** One sentence saying what the tracked thing is and when it was visible. */
  identity: string;
  /** One sentence saying what it measurably did during the run. */
  behaviour: string;
}

function joinSentence(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A plain-language reading of one tracked object, built only from the measured
 * fields the API stored. Nothing is inferred beyond those values: a missing
 * measurement is left out of the sentence instead of being shown as zero. */
export function trackReading(track: TrackItem): TrackReading {
  const kind = objectKind(track.appearance);
  const first = track.frames.first;
  const last = track.frames.last;
  const span =
    first !== null && last !== null
      ? `from frame ${formatNumber(first)} to frame ${formatNumber(last)}`
      : "over a frame span that was not retained";
  const seconds =
    track.observed.duration_s === null
      ? ""
      : ` (${track.observed.duration_s.toFixed(1)} s on screen)`;
  const observations = `${formatNumber(track.observed.observations)} observation${
    track.observed.observations === 1 ? "" : "s"
  }`;

  const identity = `${formatTrackId(track.track_id)} is ${kind} the engine followed ${span}${seconds}, recorded in ${observations}.`;

  const parts: string[] = [];
  if (track.motion.mean_speed_px_s !== null) {
    parts.push(`averaged ${track.motion.mean_speed_px_s.toFixed(0)} px/s`);
  }
  if (track.motion.max_speed_px_s !== null) {
    parts.push(`peaked at ${track.motion.max_speed_px_s.toFixed(0)} px/s`);
  }
  if (track.motion.path_length_px !== null) {
    parts.push(`travelled ${formatNumber(Math.round(track.motion.path_length_px))} px of path`);
  }
  if (track.motion.summary_directions.length > 0) {
    parts.push(`moved ${track.motion.summary_directions.join(" and ")}`);
  }

  const behaviour =
    parts.length === 0
      ? "No speed, path or heading measurement was retained for this object, so its movement cannot be described here."
      : `It ${joinSentence(parts)}.`;

  return { identity, behaviour };
}

/** Query parameters accepted by GET /sessions/{id}/tracks. */
export function trackListParams(
  levelFilter: TrackLevelFilter,
  sort: TrackSort,
): { level?: string; sort: TrackSort } {
  return levelFilter === "all" ? { sort } : { level: levelFilter, sort };
}

function searchTokens(track: TrackItem): string[] {
  const tokens = [
    String(track.track_id),
    `t${track.track_id}`,
    formatTrackId(track.track_id).toLowerCase(),
    track.appearance.class_name ?? "",
    track.appearance.color ?? "",
    track.appearance.shape ?? "",
    ...track.motion.summary_directions,
  ];
  return tokens.filter(Boolean).map((token) => token.toLowerCase());
}

/** Every whitespace-separated term must match an id, colour, shape or heading. */
export function matchesTrackQuery(track: TrackItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const tokens = searchTokens(track);
  return terms.every((term) => tokens.some((token) => token.includes(term)));
}

export function filterTracks(tracks: TrackItem[], query: string): TrackItem[] {
  return query.trim() ? tracks.filter((track) => matchesTrackQuery(track, query)) : tracks;
}

export interface MotionSample {
  frame: number;
  tsUtc: string;
  level: Level;
  speed: number | null;
  direction: number | null;
}

export function motionSamples(observations: ObservationItem[]): MotionSample[] {
  return [...observations]
    .sort((a, b) => a.frame - b.frame || a.event_id - b.event_id)
    .map((row) => ({
      frame: row.frame,
      tsUtc: row.ts_utc,
      level: row.level,
      speed: row.motion.speed_px_s,
      direction: row.motion.direction_deg,
    }));
}

export interface DirectionSummary {
  thresholdDeg: number;
  samples: number;
  missing: number;
  changes: number;
  maxChangeDeg: number | null;
}

/** Shortest angular distance, so 359° → 1° counts as a 2° change. */
export function angularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/** Compares consecutive observations only; a missing heading breaks the chain
 * rather than being treated as a 0° heading. */
export function summarizeDirections(
  observations: ObservationItem[],
  thresholdDeg = 30,
): DirectionSummary {
  const rows = [...observations].sort(
    (a, b) => a.frame - b.frame || a.event_id - b.event_id,
  );
  let samples = 0;
  let missing = 0;
  let changes = 0;
  let maxChangeDeg: number | null = null;
  let previous: number | null = null;

  for (const row of rows) {
    const direction = row.motion.direction_deg;
    if (direction === null || !Number.isFinite(direction)) {
      missing += 1;
      previous = null;
      continue;
    }
    samples += 1;
    if (previous !== null) {
      const delta = angularDistance(previous, direction);
      if (delta > thresholdDeg) changes += 1;
      if (maxChangeDeg === null || delta > maxChangeDeg) maxChangeDeg = delta;
    }
    previous = direction;
  }

  return { thresholdDeg, samples, missing, changes, maxChangeDeg };
}

export function speedExtent(samples: MotionSample[]): number {
  let max = 0;
  for (const sample of samples) {
    if (sample.speed !== null && sample.speed > max) max = sample.speed;
  }
  return max;
}

export interface ValidTrajectoryPoint extends TrajectoryPoint {
  x: number;
  y: number;
}

export interface TrajectoryPaths {
  segments: ValidTrajectoryPoint[][];
  points: number;
  missing: number;
  /** Frame gaps inside the retained sequence: no synthetic bridge is drawn. */
  gaps: number;
}

/** Splits the path wherever a coordinate is null or the frame sequence skips. */
export function trajectoryPaths(points: TrajectoryPoint[]): TrajectoryPaths {
  const segments: ValidTrajectoryPoint[][] = [];
  let current: ValidTrajectoryPoint[] = [];
  let missing = 0;
  let gaps = 0;
  let previousFrame: number | null = null;

  for (const point of points) {
    if (point.x === null || point.y === null) {
      missing += 1;
      if (current.length) {
        segments.push(current);
        current = [];
      }
      previousFrame = null;
      continue;
    }
    if (previousFrame !== null && point.frame - previousFrame > 1 && current.length) {
      gaps += 1;
      segments.push(current);
      current = [];
    }
    current.push({ ...point, x: point.x, y: point.y });
    previousFrame = point.frame;
  }
  if (current.length) segments.push(current);

  return {
    segments,
    points: segments.reduce((sum, segment) => sum + segment.length, 0),
    missing,
    gaps,
  };
}

export function pointAtFrame(
  points: TrajectoryPoint[],
  frame: number | null,
): TrajectoryPoint | null {
  if (frame === null) return null;
  return points.find((point) => point.frame === frame) ?? null;
}

/** The last source frame that a retained preview stands for. Previews keep one
 * frame every `stride` source frames, so the preview at `frame` covers the
 * interval up to the next retained frame (or `frame + stride - 1` at the end).
 * Matching events to a preview by exact frame equality leaves almost every
 * preview empty; this window is what a preview actually shows. */
export function eventFrameWindow(
  frames: { frame: number }[],
  frame: number,
  stride: number,
): number {
  const next = frames
    .map((entry) => entry.frame)
    .filter((candidate) => candidate > frame)
    .sort((a, b) => a - b)[0];
  if (next !== undefined) return Math.max(frame, next - 1);
  return frame + Math.max(1, stride) - 1;
}

export function nearestFrame(frames: number[], target: number): number | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDistance = Math.abs(best - target);
  for (const frame of frames.slice(1)) {
    const distance = Math.abs(frame - target);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

export function formatUtc(ts: string | null | undefined): string {
  if (!ts) return "—";
  const iso = ts.replace("T", " ").replace("+00:00", "").replace("Z", "");
  return `${iso.slice(0, 19)} UTC`;
}

export function frameSeconds(frame: number | null, fps: number | null): string {
  if (frame === null || !fps || fps <= 0) return "—";
  return `${(frame / fps).toFixed(2)}s`;
}

/** Rule name for a real event; falls back to the persisted summary's rule
 * token and never invents one when neither carries it. */
export function eventTypeLabel(event: {
  summary: string;
  evidence?: { rules?: { rule: string }[] } | null;
}): string {
  const rules = event.evidence?.rules?.map((rule) => rule.rule).filter(Boolean) ?? [];
  if (rules.length > 0) return rules.join(" · ");
  const match = /\[([a-z_]+)\]/.exec(event.summary);
  return match ? match[1] : "unclassified";
}
