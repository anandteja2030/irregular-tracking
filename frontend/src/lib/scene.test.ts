import { describe, expect, it } from "vitest";
import {
  assessCalibration,
  densityGrid,
  directionRows,
  sceneScoredEvents,
  spatialPoints,
  zoneActivity,
} from "./scene";
import type { AnomalyItem, SceneResponse, TrajectoryPoint } from "./types";

const THRESHOLDS = {
  warmup_tracks: 2,
  tracks_seconds: 12,
  min_samples: 30,
  direction_bin_deg: 30,
};

function scene(overrides: Partial<SceneResponse> = {}): SceneResponse {
  return {
    session: "s",
    source: "run_calibration",
    calibration: {
      available: true,
      ready: true,
      samples: 120,
      tracks: 4,
      observed_seconds: 18,
      reason: null,
    },
    speed_baseline: {
      samples: 120,
      p10: 20,
      p50: 80,
      p90: 140,
      mean: 82,
      std: 21,
      min: null,
      max: null,
      moving_fraction: 0.9,
      source: "run_calibration",
    },
    directions: {
      samples: 120,
      counts: null,
      histogram: { E: 0.6, W: 0.3, N: 0.1 },
      dominant: ["E"],
      source: "run_calibration",
    },
    deviations: {
      scene_score: { samples: 120, mean: 0.02, p50: 0, max: 0.5 },
      above_0_2: 3,
      above_0_3: 2,
      affected_tracks: 1,
      top_tracks: [{ track_id: 1, max_scene_score: 0.5, observations: 20 }],
    },
    notes: [],
    ...overrides,
  };
}

function event(id: number, overrides: Partial<AnomalyItem> = {}): AnomalyItem {
  return {
    event_id: id,
    session: "s",
    frame: id * 10,
    ts_utc: "2026-01-01T00:00:00+00:00",
    track_id: id % 2,
    level: "Suspicious",
    scores: { fused: 0.5, rule: 0.2, ml: 0, scene: 0.2 },
    motion: { speed_px_s: 10, direction_deg: 90 },
    summary: "scene event",
    evidence: {
      available: true,
      source: "in_process_artifacts",
      rules: [],
      ml_note: null,
      scene_note: null,
      zone: "yard",
      zone_dwell_s: 4,
      appearance: null,
    },
    ...overrides,
  };
}

function point(frame: number, x: number | null, y: number | null): TrajectoryPoint {
  return {
    frame,
    x,
    y,
    level: "Normal",
    speed_px_s: 10,
    direction_deg: 0,
  };
}

describe("scene intelligence helpers", () => {
  it("assesses readiness gates without inventing confidence", () => {
    const ready = assessCalibration(scene(), THRESHOLDS);
    expect(ready.state).toBe("ready");
    expect(ready.coverage).toBe(1);
    expect(ready.gates.map((gate) => gate.key)).toEqual(["samples", "tracks", "seconds"]);
    expect(ready.gates.every((gate) => gate.met)).toBe(true);

    const warming = assessCalibration(
      scene({
        calibration: {
          available: true,
          ready: false,
          samples: 12,
          tracks: 1,
          observed_seconds: 4,
          reason: null,
        },
      }),
      THRESHOLDS,
    );
    expect(warming.state).toBe("warming");
    expect(warming.title).toBe("Calibration not ready");
    expect(warming.limiting?.key).toBe("seconds");
    expect(warming.coverage).toBeCloseTo(1 / 3);

    const noThresholds = assessCalibration(scene(), null);
    expect(noThresholds.gates).toEqual([]);
    expect(noThresholds.coverage).toBeNull();
  });

  it("distinguishes historical unavailability from an unavailable artifact", () => {
    const historical = assessCalibration(
      scene({
        source: "derived_observations",
        calibration: {
          available: false,
          ready: null,
          samples: null,
          tracks: null,
          observed_seconds: null,
          reason: "Calibration is kept in memory and was not persisted.",
        },
      }),
      THRESHOLDS,
    );
    expect(historical.state).toBe("historical");
    expect(historical.title).toBe("Historical calibration unavailable");

    const unavailable = assessCalibration(
      scene({
        source: "other",
        calibration: {
          available: false,
          ready: null,
          samples: null,
          tracks: null,
          observed_seconds: null,
          reason: null,
        },
      }),
      THRESHOLDS,
    );
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.title).toBe("Calibration unavailable");
  });

  it("renders all eight direction octants and preserves missing counts", () => {
    const rows = directionRows(scene().directions);
    expect(rows.map((row) => row.octant)).toEqual([
      "E",
      "NE",
      "N",
      "NW",
      "W",
      "SW",
      "S",
      "SE",
    ]);
    expect(rows.find((row) => row.octant === "E")).toMatchObject({
      share: 0.6,
      dominant: true,
      count: null,
    });
    expect(rows.find((row) => row.octant === "SE")?.share).toBe(0);
    expect(directionRows(null)).toEqual([]);

    const withCounts = directionRows({
      ...scene().directions!,
      counts: { E: 60, W: 30 },
    });
    expect(withCounts.find((row) => row.octant === "W")?.count).toBe(30);
  });

  it("selects only positive persisted scene scores, strongest first", () => {
    const rows = sceneScoredEvents([
      event(1, { scores: { fused: 0.4, rule: 0, ml: 0, scene: null } }),
      event(2, { scores: { fused: 0.5, rule: 0, ml: 0, scene: 0.2 } }),
      event(3, { scores: { fused: 0.7, rule: 0, ml: 0, scene: 0.5 } }),
      event(4, { scores: { fused: 0.9, rule: 0, ml: 0, scene: 0 } }),
    ]);
    expect(rows.map((row) => row.event_id)).toEqual([3, 2]);
  });

  it("aggregates only retained zone evidence and keeps missing dwell missing", () => {
    const rows = zoneActivity([
      event(1, { evidence: { ...event(1).evidence, zone_dwell_s: 2 } }),
      event(2, {
        evidence: { ...event(2).evidence, zone: "gate", zone_dwell_s: 8 },
      }),
      event(3, {
        evidence: { ...event(3).evidence, zone_dwell_s: null },
      }),
      event(4, {
        evidence: { ...event(4).evidence, available: false, zone: "ghost" },
      }),
      event(5, {
        evidence: { ...event(5).evidence, zone: null, zone_dwell_s: null },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      zone: "yard",
      events: 2,
      tracks: 1,
      dwellSamples: 1,
      medianDwellS: 2,
      maxDwellS: 2,
      firstEventId: 1,
    });
    expect(rows[1]).toMatchObject({
      zone: "gate",
      events: 1,
      medianDwellS: 8,
    });
    expect(zoneActivity([event(9, { evidence: { ...event(9).evidence, zone_dwell_s: null } })]))
      .toEqual([
        expect.objectContaining({
          zone: "yard",
          dwellSamples: 0,
          medianDwellS: null,
          maxDwellS: null,
        }),
      ]);
  });

  it("builds a density grid from real, in-frame coordinates only", () => {
    const tracks = [
      {
        trackId: 0,
        points: [point(0, 10, 10), point(1, 15, 10), point(2, null, 20)],
      },
      {
        trackId: 1,
        points: [point(0, 90, 90), point(1, 101, 90), point(2, 95, 95)],
      },
    ];
    const flattened = spatialPoints(tracks, 100, 100);
    expect(flattened.points).toHaveLength(4);
    expect(flattened.excluded).toBe(1);

    const grid = densityGrid(flattened.points, 100, 100, 10);
    expect(grid.columns).toBe(10);
    expect(grid.rows).toBe(10);
    expect(grid.totalPoints).toBe(4);
    expect(grid.maxCount).toBe(2);
    expect(grid.touchedCells).toBe(2);
    expect(grid.peak).toMatchObject({ column: 1, row: 1, count: 2 });
  });

  it("does not divide by zero on an empty spatial frame", () => {
    const grid = densityGrid([], 100, 100, 8);
    expect(grid.maxCount).toBe(0);
    expect(grid.peak).toBeNull();
    expect(grid.cells).toHaveLength(64);
  });
});
