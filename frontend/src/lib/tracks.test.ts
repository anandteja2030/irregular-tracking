import { describe, expect, it } from "vitest";
import {
  angularDistance,
  eventTypeLabel,
  filterTracks,
  matchesTrackQuery,
  motionSamples,
  nearestFrame,
  pointAtFrame,
  summarizeDirections,
  trackListParams,
  trajectoryPaths,
} from "./tracks";
import type { ObservationItem, TrackItem, TrajectoryPoint } from "./types";

function track(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    track_id: 3,
    appearance: { color: "red", shape: "circle" },
    frames: { first: 10, last: 40, summary_first: 10, summary_last: 40 },
    observed: {
      observations: 30,
      anomalies: 4,
      levels: { Normal: 26, Suspicious: 3, Irregular: 1 },
      worst_level: "Irregular",
      duration_s: 1.2,
    },
    motion: {
      mean_speed_px_s: 80,
      max_speed_px_s: 240,
      path_length_px: 100,
      straightness: 0.9,
      n_points: 30,
      n_seconds: 1.2,
      summary_directions: ["W", "NW"],
      max_fused_score: 0.8,
      speed_source: "track_summary",
    },
    timestamps: { first_ts: "2026-01-01T00:00:00+00:00", last_ts: null },
    ...overrides,
  };
}

function observation(
  frame: number,
  speed: number | null,
  direction: number | null,
  level: ObservationItem["level"] = "Normal",
): ObservationItem {
  return {
    event_id: frame,
    session: "s",
    frame,
    ts_utc: "2026-01-01T00:00:00+00:00",
    track_id: 3,
    level,
    scores: { fused: 0, rule: 0, ml: 0, scene: 0 },
    motion: { speed_px_s: speed, direction_deg: direction },
    summary: "",
  };
}

function point(frame: number, x: number | null, y: number | null): TrajectoryPoint {
  return { frame, x, y, level: "Normal", speed_px_s: 1, direction_deg: 0 };
}

describe("track filters", () => {
  it("maps the level filter to the API contract", () => {
    expect(trackListParams("all", "anomalies")).toEqual({ sort: "anomalies" });
    expect(trackListParams("any", "speed")).toEqual({ level: "any", sort: "speed" });
    expect(trackListParams("Normal", "track_id")).toEqual({
      level: "Normal",
      sort: "track_id",
    });
  });

  it("searches ids, colours, shapes and headings together", () => {
    const item = track();
    expect(matchesTrackQuery(item, "t03")).toBe(true);
    expect(matchesTrackQuery(item, "3")).toBe(true);
    expect(matchesTrackQuery(item, "red circle")).toBe(true);
    expect(matchesTrackQuery(item, "nw")).toBe(true);
    expect(matchesTrackQuery(item, "green")).toBe(false);
    expect(filterTracks([item, track({ track_id: 0, appearance: { color: "green", shape: null } })], "green")).toHaveLength(1);
  });
});

describe("direction summary", () => {
  it("uses the shortest angular distance and breaks on missing headings", () => {
    expect(angularDistance(355, 5)).toBe(10);
    expect(angularDistance(10, 200)).toBe(170);

    const summary = summarizeDirections([
      observation(0, 0, 0),
      observation(1, 0, 20),
      observation(2, 0, 90),
      observation(3, 0, null),
      observation(4, 0, 90),
      observation(5, 0, 95),
    ]);
    expect(summary.samples).toBe(5);
    expect(summary.missing).toBe(1);
    expect(summary.changes).toBe(1);
    expect(summary.maxChangeDeg).toBe(70);
  });

  it("keeps zero speed distinct from a missing speed", () => {
    const samples = motionSamples([
      observation(2, null, 180, "Suspicious"),
      observation(1, 0, 0),
    ]);
    expect(samples.map((sample) => sample.frame)).toEqual([1, 2]);
    expect(samples[0].speed).toBe(0);
    expect(samples[1].speed).toBeNull();
  });
});

describe("trajectory assembly", () => {
  it("splits at null coordinates and frame gaps without bridging them", () => {
    const paths = trajectoryPaths([
      point(0, 10, 10),
      point(1, 12, 10),
      point(2, null, 10),
      point(3, 16, 10),
      point(6, 20, 10),
      point(7, 22, 10),
    ]);
    expect(paths.points).toBe(5);
    expect(paths.missing).toBe(1);
    expect(paths.gaps).toBe(1);
    expect(paths.segments.map((segment) => segment.length)).toEqual([2, 1, 2]);
  });

  it("finds exact points and the nearest retained frame", () => {
    const points = [point(0, 1, 1), point(6, 2, 2)];
    expect(pointAtFrame(points, 6)?.x).toBe(2);
    expect(pointAtFrame(points, 4)).toBeNull();
    expect(nearestFrame([0, 6, 12], 7)).toBe(6);
    expect(nearestFrame([], 7)).toBeNull();
  });
});

describe("event type", () => {
  it("prefers retained evidence and otherwise reads the persisted summary", () => {
    expect(
      eventTypeLabel({
        summary: "fired rule [excessive_speed] (100% severity)",
        evidence: { rules: [{ rule: "direction_against_flow" }] },
      }),
    ).toBe("direction_against_flow");
    expect(
      eventTypeLabel({ summary: "fired rule [loitering] (80% severity)" }),
    ).toBe("loitering");
    expect(eventTypeLabel({ summary: "fused score elevated" })).toBe("unclassified");
  });
});
