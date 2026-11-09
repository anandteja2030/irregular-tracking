import { describe, expect, it } from "vitest";
import {
  anomalyRules,
  anomalyTypeOptions,
  channelCounts,
  eventLevelCounts,
  eventsPerFrame,
  filterAnomalies,
  framePosition,
  repeatedTracks,
  ruleFrequencies,
  sortAnomalies,
  timelineBuckets,
  trackFrequencies,
} from "./anomalies";
import type { AnomalyItem, TrackItem } from "./types";

function event(id: number, overrides: Partial<AnomalyItem> = {}): AnomalyItem {
  return {
    event_id: id,
    session: "s",
    frame: id * 10,
    ts_utc: "2026-01-01T00:00:00+00:00",
    track_id: id % 2,
    level: id % 3 === 0 ? "Irregular" : "Suspicious",
    scores: { fused: 0.4 + id / 100, rule: 0.2, ml: 0, scene: null },
    motion: { speed_px_s: 12, direction_deg: 90 },
    summary: `fired rule [excessive_speed] for event ${id}`,
    evidence: {
      available: true,
      source: "in_process_artifacts",
      rules: [{ rule: "excessive_speed", severity: 1, description: "too fast" }],
      ml_note: null,
      scene_note: null,
      zone: null,
      zone_dwell_s: null,
      appearance: { color: "red", shape: "circle" },
    },
    ...overrides,
  };
}

const EVENTS = [
  event(1),
  event(2, {
    level: "Irregular",
    track_id: 3,
    frame: 42,
    evidence: {
      available: true,
      source: "in_process_artifacts",
      rules: [
        { rule: "sudden_acceleration", severity: 0.8, description: "accelerating" },
        { rule: "erratic_heading", severity: null },
      ],
      ml_note: "model note",
      scene_note: null,
      zone: null,
      zone_dwell_s: null,
      appearance: { color: "red", shape: "circle" },
    },
    summary: "two rules",
  }),
  event(3, {
    frame: 7,
    level: "Suspicious",
    summary: "legacy [direction_against_flow] row",
    evidence: {
      available: false,
      source: "not_persisted",
      rules: [],
      ml_note: null,
      scene_note: null,
      zone: null,
      zone_dwell_s: null,
      appearance: null,
    },
  }),
];

describe("anomaly event helpers", () => {
  it("filters by severity, track, type and search terms", () => {
    expect(filterAnomalies(EVENTS, { severity: "Irregular", trackId: null, eventType: null, query: "" })).toHaveLength(1);
    expect(filterAnomalies(EVENTS, { severity: "all", trackId: 3, eventType: null, query: "" }).map((row) => row.event_id)).toEqual([2]);
    expect(filterAnomalies(EVENTS, { severity: "all", trackId: 1, eventType: null, query: "" }).map((row) => row.event_id)).toEqual([1, 3]);
    expect(filterAnomalies(EVENTS, { severity: "all", trackId: null, eventType: "erratic_heading", query: "" }).map((row) => row.event_id)).toEqual([2]);
    expect(filterAnomalies(EVENTS, { severity: "all", trackId: null, eventType: "direction_against_flow", query: "" }).map((row) => row.event_id)).toEqual([3]);
    expect(filterAnomalies(EVENTS, { severity: "all", trackId: null, eventType: null, query: "T03 42" }).map((row) => row.event_id)).toEqual([2]);
    expect(filterAnomalies(EVENTS, { severity: "all", trackId: null, eventType: null, query: "f00007" }).map((row) => row.event_id)).toEqual([3]);
  });

  it("extracts only recorded rule tokens and lists real type options", () => {
    expect(anomalyRules(EVENTS[0])).toEqual(["excessive_speed"]);
    expect(anomalyRules(EVENTS[2])).toEqual(["direction_against_flow"]);
    expect(anomalyTypeOptions(EVENTS)).toEqual([
      "direction_against_flow",
      "erratic_heading",
      "excessive_speed",
      "sudden_acceleration",
    ]);
    expect(
      anomalyTypeOptions([event(9, { summary: "no token", evidence: { ...EVENTS[0].evidence, rules: [] } })]),
    ).toEqual(["unclassified"]);
  });

  it("sorts by frame, score, track and event without mutating input", () => {
    const original = EVENTS.map((row) => row.event_id);
    expect(sortAnomalies(EVENTS, "frame_asc").map((row) => row.frame)).toEqual([7, 10, 42]);
    expect(sortAnomalies(EVENTS, "frame_desc").map((row) => row.frame)).toEqual([42, 10, 7]);
    expect(sortAnomalies(EVENTS, "score_desc")[0].event_id).toBe(3);
    expect(sortAnomalies(EVENTS, "track").map((row) => row.track_id)).toEqual([1, 1, 3]);
    expect(sortAnomalies(EVENTS, "event").map((row) => row.event_id)).toEqual([1, 2, 3]);
    expect(EVENTS.map((row) => row.event_id)).toEqual(original);
  });

  it("counts severity, channels and retained rule triggers honestly", () => {
    expect(eventLevelCounts(EVENTS)).toEqual({ Suspicious: 2, Irregular: 1, total: 3 });
    const channels = channelCounts([
      ...EVENTS,
      event(4, { scores: { fused: null, rule: null, ml: null, scene: null } }),
    ]);
    expect(channels.rule).toBe(3);
    expect(channels.ml).toBe(0);
    expect(channels.scene).toBe(0);
    expect(channels.missingRule).toBe(1);
    expect(channels.missingMl).toBe(1);
    expect(channels.missingScene).toBe(4);

    const rules = ruleFrequencies(EVENTS);
    expect(rules[0]).toEqual({ rule: "erratic_heading", events: 1, maxSeverity: null });
    expect(rules.map((row) => row.rule)).toContain("excessive_speed");
    expect(rules.find((row) => row.rule === "excessive_speed")?.maxSeverity).toBe(1);
  });

  it("builds exact timeline buckets and positions from real frames", () => {
    const buckets = timelineBuckets(EVENTS, 0, 49, 5);
    expect(buckets.map((bucket) => [bucket.start, bucket.end])).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
      [30, 39],
      [40, 49],
    ]);
    expect(buckets.map((bucket) => bucket.total)).toEqual([1, 1, 0, 0, 1]);
    expect(buckets[0].firstEventId).toBe(3);
    expect(buckets[4].firstEventId).toBe(2);
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(EVENTS.length);

    expect(framePosition(0, 0, 50)).toBe(0);
    expect(framePosition(25, 0, 50)).toBe(50);
    expect(framePosition(99, 0, 50)).toBe(100);
    expect(framePosition(7, 7, 7)).toBe(50);
    expect(eventsPerFrame(3, 0, 49)).toBeCloseTo(0.06);
    expect(eventsPerFrame(3, null, 49)).toBeNull();
  });

  it("groups event frequency by track and respects persisted track counts", () => {
    const frequencies = trackFrequencies(EVENTS);
    expect(frequencies).toEqual([
      { trackId: 1, events: 2, Suspicious: 2, Irregular: 0, firstFrame: 7, lastFrame: 10 },
      { trackId: 3, events: 1, Suspicious: 0, Irregular: 1, firstFrame: 42, lastFrame: 42 },
    ]);

    const track = (id: number, anomalies: number): TrackItem => ({
      track_id: id,
      appearance: { color: "green", shape: "circle" },
      frames: { first: 0, last: 10, summary_first: 0, summary_last: 10 },
      observed: {
        observations: 10,
        anomalies,
        levels: { Normal: 10 - anomalies, Suspicious: anomalies, Irregular: 0 },
        worst_level: anomalies ? "Suspicious" : "Normal",
        duration_s: 1,
      },
      motion: {
        mean_speed_px_s: 1,
        max_speed_px_s: 1,
        path_length_px: 1,
        straightness: 1,
        n_points: 1,
        n_seconds: 1,
        summary_directions: [],
        max_fused_score: 0,
        speed_source: "track_summary",
      },
      timestamps: { first_ts: null, last_ts: null },
    });
    expect(repeatedTracks([track(0, 4), track(1, 1), track(2, 8)]).map((row) => row.track_id)).toEqual([2, 0]);
  });
});
