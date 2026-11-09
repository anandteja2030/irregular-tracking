/** Pure helpers for the Anomaly Intelligence Center.
 *
 * Events are consumed exactly as the API returns them. Position, order and
 * aggregates use persisted frames, timestamps and scores only; a null score
 * stays missing and is never treated as zero.
 */
import type { AnomalyItem, Level, TrackItem } from "./types";

export type EventSeverityFilter = "all" | "Suspicious" | "Irregular";

export type AnomalySort =
  | "frame_desc"
  | "frame_asc"
  | "score_desc"
  | "score_asc"
  | "track"
  | "event";

export const ANOMALY_SORTS: { value: AnomalySort; label: string }[] = [
  { value: "frame_desc", label: "Frame · newest first" },
  { value: "frame_asc", label: "Frame · oldest first" },
  { value: "score_desc", label: "Fused score · high to low" },
  { value: "score_asc", label: "Fused score · low to high" },
  { value: "track", label: "Track ID" },
  { value: "event", label: "Event ID" },
];

export interface AnomalyFilters {
  severity: EventSeverityFilter;
  trackId: number | null;
  eventType: string | null;
  query: string;
}

const RULE_TOKEN = /\[([a-z_]+)\]/i;

/** Rule names recorded for this event, falling back to the persisted summary
 * token. Missing structured evidence never becomes a guessed rule. */
export function anomalyRules(event: AnomalyItem): string[] {
  const rules = (event.evidence?.rules ?? [])
    .map((rule) => rule.rule)
    .filter((rule): rule is string => typeof rule === "string" && rule.length > 0);
  if (rules.length > 0) return [...new Set(rules)];
  const token = RULE_TOKEN.exec(event.summary)?.[1];
  return token ? [token] : [];
}

export function anomalyTypeLabel(event: AnomalyItem): string {
  const rules = anomalyRules(event);
  return rules.length > 0 ? rules.join(" · ") : "Unclassified";
}

export function anomalyTypeOptions(events: AnomalyItem[]): string[] {
  const types = new Set<string>();
  for (const event of events) {
    const rules = anomalyRules(event);
    if (rules.length === 0) {
      types.add("unclassified");
      continue;
    }
    for (const rule of rules) types.add(rule);
  }
  return [...types].sort((a, b) => a.localeCompare(b));
}

function searchTokens(event: AnomalyItem): string[] {
  const padded = String(event.frame).padStart(5, "0");
  return [
    String(event.event_id),
    `e${event.event_id}`,
    `#${event.event_id}`,
    String(event.frame),
    `f${event.frame}`,
    `f${padded}`,
    String(event.track_id),
    `t${event.track_id}`,
    `t${String(event.track_id).padStart(2, "0")}`,
    event.level,
    event.ts_utc,
    event.summary,
    ...anomalyRules(event),
    event.scores.fused === null ? "—" : event.scores.fused.toFixed(2),
  ]
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

/** Every whitespace-separated term must match an event id, frame, track,
 * level, rule, timestamp, fused score or persisted explanation. */
export function matchesAnomalyQuery(event: AnomalyItem, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const tokens = searchTokens(event);
  return terms.every((term) => tokens.some((token) => token.includes(term)));
}

export function filterAnomalies(
  events: AnomalyItem[],
  filters: AnomalyFilters,
): AnomalyItem[] {
  return events.filter((event) => {
    if (filters.severity !== "all" && event.level !== filters.severity) return false;
    if (filters.trackId !== null && event.track_id !== filters.trackId) return false;
    if (filters.eventType !== null) {
      const rules = anomalyRules(event);
      const key = rules.length > 0 ? rules : ["unclassified"];
      if (!key.includes(filters.eventType)) return false;
    }
    return matchesAnomalyQuery(event, filters.query);
  });
}

function compareNullable(
  a: number | null,
  b: number | null,
  direction: 1 | -1,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * direction;
}

export function sortAnomalies(
  events: AnomalyItem[],
  sort: AnomalySort,
): AnomalyItem[] {
  const rows = [...events];
  rows.sort((a, b) => {
    switch (sort) {
      case "frame_desc":
        return b.frame - a.frame || b.event_id - a.event_id;
      case "frame_asc":
        return a.frame - b.frame || a.event_id - b.event_id;
      case "score_desc": {
        const score = compareNullable(a.scores.fused, b.scores.fused, -1);
        return score || a.event_id - b.event_id;
      }
      case "score_asc": {
        const score = compareNullable(a.scores.fused, b.scores.fused, 1);
        return score || a.event_id - b.event_id;
      }
      case "track":
        return a.track_id - b.track_id || a.frame - b.frame || a.event_id - b.event_id;
      case "event":
      default:
        return a.event_id - b.event_id;
    }
  });
  return rows;
}

export interface EventLevelCounts {
  Suspicious: number;
  Irregular: number;
  total: number;
}

export function eventLevelCounts(events: AnomalyItem[]): EventLevelCounts {
  const counts: EventLevelCounts = { Suspicious: 0, Irregular: 0, total: 0 };
  for (const event of events) {
    counts.total += 1;
    if (event.level === "Suspicious") counts.Suspicious += 1;
    if (event.level === "Irregular") counts.Irregular += 1;
  }
  return counts;
}

export function eventTrackIds(events: AnomalyItem[]): number[] {
  return [...new Set(events.map((event) => event.track_id))].sort((a, b) => a - b);
}

export function eventSpan(events: AnomalyItem[]): { first: number | null; last: number | null } {
  if (events.length === 0) return { first: null, last: null };
  let first = events[0].frame;
  let last = events[0].frame;
  for (const event of events) {
    if (event.frame < first) first = event.frame;
    if (event.frame > last) last = event.frame;
  }
  return { first, last };
}

export interface ChannelCounts {
  rule: number;
  ml: number;
  scene: number;
  fused: number;
  missingRule: number;
  missingMl: number;
  missingScene: number;
}

/** Counts of events whose channel score is genuinely above zero, plus how
 * many events carry no value at all for that channel. */
export function channelCounts(events: AnomalyItem[]): ChannelCounts {
  const counts: ChannelCounts = {
    rule: 0,
    ml: 0,
    scene: 0,
    fused: 0,
    missingRule: 0,
    missingMl: 0,
    missingScene: 0,
  };
  for (const event of events) {
    const { fused, rule, ml, scene } = event.scores;
    if (fused === null) {
      /* fused is optional on the wire; absence is not a zero */
    } else if (fused > 0) counts.fused += 1;
    if (rule === null) counts.missingRule += 1;
    else if (rule > 0) counts.rule += 1;
    if (ml === null) counts.missingMl += 1;
    else if (ml > 0) counts.ml += 1;
    if (scene === null) counts.missingScene += 1;
    else if (scene > 0) counts.scene += 1;
  }
  return counts;
}

export interface RuleFrequency {
  rule: string;
  events: number;
  maxSeverity: number | null;
}

/** Rule triggers counted from retained evidence. Events without structured
 * evidence do not contribute a guessed trigger. */
export function ruleFrequencies(events: AnomalyItem[]): RuleFrequency[] {
  const rules = new Map<string, { events: number; maxSeverity: number | null }>();
  for (const event of events) {
    if (!event.evidence?.available) continue;
    const seen = new Set<string>();
    for (const rule of event.evidence.rules ?? []) {
      if (!rule.rule || seen.has(rule.rule)) continue;
      seen.add(rule.rule);
      const current = rules.get(rule.rule) ?? { events: 0, maxSeverity: null };
      current.events += 1;
      const severity = typeof rule.severity === "number" ? rule.severity : null;
      if (severity !== null && (current.maxSeverity === null || severity > current.maxSeverity)) {
        current.maxSeverity = severity;
      }
      rules.set(rule.rule, current);
    }
  }
  return [...rules.entries()]
    .map(([rule, value]) => ({ rule, ...value }))
    .sort((a, b) => b.events - a.events || a.rule.localeCompare(b.rule));
}

export interface TrackEventFrequency {
  trackId: number;
  events: number;
  Suspicious: number;
  Irregular: number;
  firstFrame: number;
  lastFrame: number;
}

export function trackFrequencies(events: AnomalyItem[]): TrackEventFrequency[] {
  const tracks = new Map<number, TrackEventFrequency>();
  for (const event of events) {
    const current = tracks.get(event.track_id) ?? {
      trackId: event.track_id,
      events: 0,
      Suspicious: 0,
      Irregular: 0,
      firstFrame: event.frame,
      lastFrame: event.frame,
    };
    current.events += 1;
    if (event.level === "Suspicious") current.Suspicious += 1;
    if (event.level === "Irregular") current.Irregular += 1;
    if (event.frame < current.firstFrame) current.firstFrame = event.frame;
    if (event.frame > current.lastFrame) current.lastFrame = event.frame;
    tracks.set(event.track_id, current);
  }
  return [...tracks.values()].sort(
    (a, b) => b.events - a.events || a.trackId - b.trackId,
  );
}

/** Track aggregates from GET /tracks are authoritative; this only picks the
 * objects that actually carry more than one elevated event. */
export function repeatedTracks(tracks: TrackItem[]): TrackItem[] {
  return tracks
    .filter((track) => track.observed.anomalies > 1)
    .sort(
      (a, b) =>
        b.observed.anomalies - a.observed.anomalies || a.track_id - b.track_id,
    );
}

export interface TimelineBucket {
  index: number;
  start: number;
  end: number;
  total: number;
  Suspicious: number;
  Irregular: number;
  firstEventId: number | null;
}

/** Equal-width frame buckets spanning the actual run. Every event lands in
 * exactly one bucket based on its persisted frame. */
export function timelineBuckets(
  events: AnomalyItem[],
  firstFrame: number,
  lastFrame: number,
  binCount = 24,
): TimelineBucket[] {
  const bins = Math.max(1, Math.floor(binCount));
  const start = Math.min(firstFrame, lastFrame);
  const end = Math.max(firstFrame, lastFrame);
  const span = Math.max(1, end - start + 1);
  const buckets: TimelineBucket[] = Array.from({ length: bins }, (_, index) => {
    const bucketStart = start + Math.floor((index * span) / bins);
    const nextStart = start + Math.floor(((index + 1) * span) / bins);
    return {
      index,
      start: bucketStart,
      end: Math.max(bucketStart, nextStart - 1),
      total: 0,
      Suspicious: 0,
      Irregular: 0,
      firstEventId: null,
    };
  });

  for (const event of [...events].sort((a, b) => a.frame - b.frame || a.event_id - b.event_id)) {
    const index = Math.min(bins - 1, Math.floor(((event.frame - start) / span) * bins));
    const bucket = buckets[Math.max(0, index)];
    bucket.total += 1;
    if (event.level === "Suspicious") bucket.Suspicious += 1;
    if (event.level === "Irregular") bucket.Irregular += 1;
    if (bucket.firstEventId === null) bucket.firstEventId = event.event_id;
  }
  return buckets;
}

/** Horizontal position of a real frame inside the run, clamped to the axis. */
export function framePosition(
  frame: number,
  firstFrame: number,
  lastFrame: number,
): number {
  if (lastFrame <= firstFrame) return 50;
  const ratio = (frame - firstFrame) / (lastFrame - firstFrame);
  return Math.max(0, Math.min(100, ratio * 100));
}

export function eventsPerFrame(
  eventCount: number,
  firstFrame: number | null,
  lastFrame: number | null,
): number | null {
  if (firstFrame === null || lastFrame === null || lastFrame < firstFrame) return null;
  return eventCount / (lastFrame - firstFrame + 1);
}

export const EVENT_LEVELS: Level[] = ["Suspicious", "Irregular"];
