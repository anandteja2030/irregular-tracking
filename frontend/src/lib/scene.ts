/** Pure helpers for the Scene Intelligence surface.
 *
 * Everything here is derived from values the API already returns: calibration
 * evidence, persisted speed/direction aggregates, retained anomaly evidence
 * and retained centroid trajectories. No scene property is invented from a
 * missing field.
 */
import type {
  AnomalyItem,
  DirectionProfile,
  SceneResponse,
  TrajectoryPoint,
  ZoneRect,
} from "./types";

export interface LoadedSceneEvents {
  rows: AnomalyItem[];
  total: number;
  truncated: boolean;
}

export interface SceneTrajectoryTrack {
  trackId: number;
  points: TrajectoryPoint[];
  available: boolean;
  reason: string | null;
}

export interface SceneTrajectoryLoad {
  tracks: SceneTrajectoryTrack[];
  requested: number;
  totalTracks: number;
  failed: number;
}

export const OCTANTS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"] as const;
export type Octant = (typeof OCTANTS)[number];

export interface CalibrationThresholds {
  warmup_tracks: number;
  tracks_seconds: number;
  min_samples: number;
  direction_bin_deg: number;
}

export type CalibrationState = "ready" | "warming" | "historical" | "unavailable";

export interface CalibrationGate {
  key: "samples" | "tracks" | "seconds";
  label: string;
  actual: number | null;
  required: number;
  met: boolean;
  /** Actual / required, capped at 1 for presentation. Null when unavailable. */
  coverage: number | null;
}

export interface CalibrationAssessment {
  state: CalibrationState;
  title: string;
  /** The narrowest readiness gate, or null when unavailable. This is gate
   * coverage, explicitly not a statistical confidence. */
  coverage: number | null;
  gates: CalibrationGate[];
  limiting: CalibrationGate | null;
}

function gate(
  key: CalibrationGate["key"],
  label: string,
  actual: number | null,
  required: number,
): CalibrationGate {
  const coverage =
    actual === null || !Number.isFinite(required) || required <= 0
      ? null
      : Math.max(0, actual) / required;
  return {
    key,
    label,
    actual,
    required,
    met: coverage !== null && coverage >= 1,
    coverage: coverage === null ? null : Math.min(coverage, 1),
  };
}

/** Classify calibration without mistaking an unavailable artifact for a
 * failed run. `derived_observations` is the API's historical fallback. */
export function assessCalibration(
  scene: SceneResponse,
  thresholds: CalibrationThresholds | null | undefined,
): CalibrationAssessment {
  const calibration = scene.calibration;
  const gates = thresholds
    ? [
        gate("samples", "Movement samples", calibration.samples, thresholds.min_samples),
        gate("tracks", "Contributing tracks", calibration.tracks, thresholds.warmup_tracks),
        gate(
          "seconds",
          "Observed seconds",
          calibration.observed_seconds,
          thresholds.tracks_seconds,
        ),
      ]
    : [];
  const coverage =
    gates.length > 0 && gates.every((item) => item.coverage !== null)
      ? Math.min(...gates.map((item) => item.coverage as number))
      : null;
  const limiting =
    gates
      .filter((item) => !item.met)
      .sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0))[0] ??
    gates.slice().sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0))[0] ??
    null;

  if (!calibration.available) {
    const historical = scene.source === "derived_observations";
    return {
      state: historical ? "historical" : "unavailable",
      title: historical ? "Historical calibration unavailable" : "Calibration unavailable",
      coverage,
      gates,
      limiting,
    };
  }
  if (calibration.ready) {
    return {
      state: "ready",
      title: "Calibration ready",
      coverage,
      gates,
      limiting,
    };
  }
  return {
    state: "warming",
    title: "Calibration not ready",
    coverage,
    gates,
    limiting,
  };
}

export interface DirectionRow {
  octant: Octant;
  share: number;
  count: number | null;
  dominant: boolean;
}

/** All eight octants in compass order. A missing histogram entry means a zero
 * share; counts stay null when the API only retained shares. */
export function directionRows(profile: DirectionProfile | null): DirectionRow[] {
  if (!profile || Object.keys(profile.histogram).length === 0) return [];
  const dominant = new Set(profile.dominant);
  return OCTANTS.map((octant) => ({
    octant,
    share: profile.histogram[octant] ?? 0,
    count: profile.counts?.[octant] ?? null,
    dominant: dominant.has(octant),
  }));
}

export function directionSampleLabel(profile: DirectionProfile | null): string {
  if (!profile) return "No direction observations";
  if (profile.samples <= 0) return "No direction observations";
  return `${profile.samples.toLocaleString()} heading samples`;
}

/** Elevated events carrying a positive persisted scene score, strongest first.
 * The API's complete event set is loaded by the page before this runs. */
export function sceneScoredEvents(events: AnomalyItem[]): AnomalyItem[] {
  return events
    .filter((event) => event.scores.scene !== null && event.scores.scene > 0)
    .sort(
      (a, b) =>
        (b.scores.scene ?? 0) - (a.scores.scene ?? 0) ||
        (b.scores.fused ?? 0) - (a.scores.fused ?? 0) ||
        a.event_id - b.event_id,
    );
}

export interface ZoneActivityRow {
  zone: string;
  events: number;
  tracks: number;
  dwellSamples: number;
  medianDwellS: number | null;
  maxDwellS: number | null;
  firstEventId: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Zone rows are built only from retained structured evidence attached to
 * elevated events. Configuration alone is never counted as activity. */
export function zoneActivity(events: AnomalyItem[]): ZoneActivityRow[] {
  const zones = new Map<
    string,
    { events: number; tracks: Set<number>; dwells: number[]; firstEventId: number }
  >();
  for (const event of events) {
    if (!event.evidence.available) continue;
    const zone = event.evidence.zone?.trim();
    if (!zone) continue;
    const current = zones.get(zone) ?? {
      events: 0,
      tracks: new Set<number>(),
      dwells: [],
      firstEventId: event.event_id,
    };
    current.events += 1;
    current.tracks.add(event.track_id);
    if (
      event.evidence.zone_dwell_s !== null &&
      Number.isFinite(event.evidence.zone_dwell_s)
    ) {
      current.dwells.push(event.evidence.zone_dwell_s);
    }
    if (event.event_id < current.firstEventId) current.firstEventId = event.event_id;
    zones.set(zone, current);
  }
  return [...zones.entries()]
    .map(([zone, value]) => ({
      zone,
      events: value.events,
      tracks: value.tracks.size,
      dwellSamples: value.dwells.length,
      medianDwellS: median(value.dwells),
      maxDwellS: value.dwells.length > 0 ? Math.max(...value.dwells) : null,
      firstEventId: value.firstEventId,
    }))
    .sort((a, b) => b.events - a.events || a.zone.localeCompare(b.zone));
}

export interface SpatialPoint {
  trackId: number;
  frame: number;
  x: number;
  y: number;
  level: TrajectoryPoint["level"];
}

/** Flatten retained trajectory responses into drawable points. Coordinates
 * must be finite and inside the recorded source frame. */
export function spatialPoints(
  tracks: { trackId: number; points: TrajectoryPoint[] }[],
  width: number,
  height: number,
): { points: SpatialPoint[]; excluded: number } {
  const points: SpatialPoint[] = [];
  let excluded = 0;
  for (const track of tracks) {
    for (const point of track.points) {
      if (point.x === null || point.y === null) continue;
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > width ||
        point.y > height
      ) {
        excluded += 1;
        continue;
      }
      points.push({
        trackId: track.trackId,
        frame: point.frame,
        x: point.x,
        y: point.y,
        level: point.level,
      });
    }
  }
  return { points, excluded };
}

export interface DensityCell {
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface DensityGrid {
  columns: number;
  rows: number;
  cells: DensityCell[];
  maxCount: number;
  touchedCells: number;
  totalPoints: number;
  peak: DensityCell | null;
}

/** Bin retained point counts into a fixed grid over the actual source frame.
 * This is point density, not dwell time, occupancy or optical flow. */
export function densityGrid(
  points: SpatialPoint[],
  width: number,
  height: number,
  columns = 24,
): DensityGrid {
  const cols = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.round((cols * height) / Math.max(width, 1)));
  const cells: DensityCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      cells.push({
        column,
        row,
        x: (column * width) / cols,
        y: (row * height) / rows,
        width: width / cols,
        height: height / rows,
        count: 0,
      });
    }
  }

  for (const point of points) {
    const column = Math.min(cols - 1, Math.max(0, Math.floor((point.x / width) * cols)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((point.y / height) * rows)));
    cells[row * cols + column].count += 1;
  }

  const maxCount = Math.max(0, ...cells.map((cell) => cell.count));
  const peak =
    cells
      .filter((cell) => cell.count === maxCount && cell.count > 0)
      .sort((a, b) => a.row - b.row || a.column - b.column)[0] ?? null;
  return {
    columns: cols,
    rows,
    cells,
    maxCount,
    touchedCells: cells.filter((cell) => cell.count > 0).length,
    totalPoints: points.length,
    peak,
  };
}

export function zoneLabel(zone: ZoneRect): string {
  return zone.name || "unnamed-zone";
}
