import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const SESSION = "s-scene";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sessionItem = {
  session: SESSION,
  source: { label: "sample: anomaly_clip.mp4", kind: "sample", synthetic: false },
  processing: {
    frames_processed: 24,
    width: 1280,
    height: 720,
    fps: 10,
    wall_s: 2,
    max_frames: null,
    processing_fps: 12,
    video_duration_s: 2.4,
    started_ts: null,
    ended_ts: null,
    run_stats_available: true,
  },
  counts: {
    observations: 30,
    tracks: 2,
    anomalies: 3,
    levels: { Normal: 27, Suspicious: 2, Irregular: 1 },
    labels: 0,
  },
  frame_range: { first: 0, last: 24 },
  timestamps: {
    first_ts: "2026-01-01T00:00:00+00:00",
    last_ts: "2026-01-01T00:00:02.400000+00:00",
  },
  artifacts: {
    retained: true,
    trajectories: true,
    structured_evidence: true,
    scene_calibration: true,
    preview_frames: 5,
  },
  media: { preview_frames: 5, available: true, preview_stride: 6 },
  labels: { labels: 0, evaluation_url: `/api/v1/sessions/${SESSION}/evaluation` },
  limitations: [],
};

const readyScene = {
  session: SESSION,
  source: "run_calibration",
  calibration: {
    available: true,
    ready: true,
    samples: 120,
    tracks: 2,
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
    top_tracks: [
      { track_id: 1, max_scene_score: 0.5, observations: 20 },
      { track_id: 0, max_scene_score: 0, observations: 10 },
    ],
  },
  notes: ["Scene scores are persisted per observation."],
};

const TRACKS = [
  {
    track_id: 0,
    appearance: { color: "red", shape: "circle" },
    frames: { first: 0, last: 24, summary_first: 0, summary_last: 24 },
    observed: {
      observations: 10,
      anomalies: 1,
      levels: { Normal: 9, Suspicious: 1, Irregular: 0 },
      worst_level: "Suspicious",
      duration_s: 2.4,
    },
    motion: {
      mean_speed_px_s: 60,
      max_speed_px_s: 120,
      path_length_px: 240,
      straightness: 1,
      n_points: 10,
      n_seconds: 2.4,
      summary_directions: ["E"],
      max_fused_score: 0.5,
      speed_source: "track_summary",
    },
    timestamps: { first_ts: null, last_ts: null },
  },
  {
    track_id: 1,
    appearance: { color: "green", shape: "square" },
    frames: { first: 0, last: 24, summary_first: 0, summary_last: 24 },
    observed: {
      observations: 20,
      anomalies: 2,
      levels: { Normal: 18, Suspicious: 1, Irregular: 1 },
      worst_level: "Irregular",
      duration_s: 2.4,
    },
    motion: {
      mean_speed_px_s: 80,
      max_speed_px_s: 140,
      path_length_px: 300,
      straightness: 1,
      n_points: 20,
      n_seconds: 2.4,
      summary_directions: ["W"],
      max_fused_score: 0.8,
      speed_source: "track_summary",
    },
    timestamps: { first_ts: null, last_ts: null },
  },
];

function trajectory(trackId: number, y: number) {
  return {
    session: SESSION,
    track_id: trackId,
    available: true,
    points: Array.from({ length: 5 }, (_, index) => ({
      frame: index,
      x: 100 + index * 100,
      y: y + index * 5,
      level: "Normal",
      speed_px_s: 60,
      direction_deg: 0,
    })),
    reason: null,
  };
}

function event(
  id: number,
  trackId: number,
  level: string,
  sceneScore: number,
  zone: string | null,
  dwell: number | null,
  evidenceAvailable = true,
) {
  return {
    event_id: id,
    session: SESSION,
    frame: id * 5,
    ts_utc: "2026-01-01T00:00:00+00:00",
    track_id: trackId,
    level,
    scores: { fused: 0.6, rule: 0.2, ml: 0, scene: sceneScore },
    motion: { speed_px_s: 100, direction_deg: 0 },
    summary: `event ${id}`,
    evidence: {
      available: evidenceAvailable,
      source: evidenceAvailable ? "in_process_artifacts" : "not_persisted",
      rules: [],
      ml_note: null,
      scene_note: null,
      zone,
      zone_dwell_s: dwell,
      appearance: null,
    },
  };
}

const EVENTS = [
  event(101, 1, "Irregular", 0.5, "yard", 4.5),
  event(102, 0, "Suspicious", 0.2, "yard", 2.5),
  event(103, 0, "Suspicious", 0, null, null),
];

const CONFIG = {
  video: { frame_width: null, frame_height: null, process_fps: null },
  preprocess: {
    gaussian_blur_ksize: 5,
    fill_small_blobs_px: 0,
    morph_kernel_size: 3,
  },
  shape: {
    epsilon_factor: 0.02,
    min_rotation_lock_aspect: 1.2,
    circularity_target: 0.8,
  },
  tracking: {
    max_age: 20,
    min_hits: 3,
    iou_gate: 0.3,
    position_gate_px: 80,
    kalman_process_noise: 1,
    kalman_measurement_noise: 1,
  },
  calibration: {
    warmup_tracks: 2,
    tracks_seconds: 12,
    min_samples: 30,
    direction_bin_deg: 30,
  },
  anomaly: {
    contamination: 0.05,
    per_object_window: 30,
    scene_cluster_k_min: 2,
    scene_cluster_k_max: 6,
    threshold_suspicious: 0.4,
    threshold_irregular: 0.7,
    weights: { rule: 0.5, ml: 0.3, scene: 0.2 },
    rule: {
      speed_pctl_fast: 95,
      speed_pctl_slow: 5,
      max_z: 3,
      loiter_seconds: 3,
      direction_dev_deg: 45,
    },
  },
  zone: {
    enabled: true,
    zones: [{ name: "yard", x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 }],
    dwell_seconds: 3,
  },
  dashboard: { page_title: "Neural Command" },
  paths: { samples: "", output: "", db: "", read_only: true },
};

function pageResponse(rows: unknown[], total = rows.length) {
  return {
    total,
    count: rows.length,
    limit: 500,
    offset: 0,
    severity: null,
    event_type: null,
    anomalies: rows,
  };
}

function mockFetch(overrides: Partial<Record<"scene" | "session" | "tracks" | "events", Response>> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/health")) {
      return Promise.resolve(json({ status: "ok", version: "1.0.0", uptime_s: 1 }));
    }
    if (url.includes("/sessions?limit=100")) {
      return Promise.resolve(json({ total: 1, count: 1, limit: 100, offset: 0, sessions: [sessionItem] }));
    }
    if (new RegExp(`/sessions/${SESSION}$`).test(url)) {
      return Promise.resolve(overrides.session ?? json(sessionItem));
    }
    if (url.endsWith(`/sessions/${SESSION}/scene`)) {
      return Promise.resolve(overrides.scene ?? json(readyScene));
    }
    if (url.includes(`/sessions/${SESSION}/tracks?`)) {
      return Promise.resolve(
        overrides.tracks ??
          json({ total: TRACKS.length, count: TRACKS.length, limit: 200, offset: 0, tracks: TRACKS }),
      );
    }
    const trajectoryMatch = url.match(new RegExp(`/sessions/${SESSION}/tracks/(\\d+)/trajectory$`));
    if (trajectoryMatch) {
      const trackId = Number(trajectoryMatch[1]);
      return Promise.resolve(json(trajectory(trackId, trackId === 0 ? 200 : 400)));
    }
    if (url.includes(`/sessions/${SESSION}/anomalies?`)) {
      return Promise.resolve(overrides.events ?? json(pageResponse(EVENTS)));
    }
    if (url.includes("/config")) {
      return Promise.resolve(json(CONFIG));
    }
    return Promise.reject(new Error(`Unhandled fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/scene?session=${SESSION}`]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

describe("scene intelligence page", () => {
  it("shows calibration evidence, movement, retained density and scene navigation", async () => {
    mockFetch();
    renderPage();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveProperty(
      "textContent",
      "Scene Intelligence",
    );
    expect(await screen.findByText("Calibration ready")).toBeTruthy();
    expect(screen.getByText("Not exposed")).toBeTruthy();
    expect(screen.getByText("Readiness coverage")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    expect(document.querySelector(".scene-dominant__chip")?.textContent).toBe("E");
    expect(await screen.findByText("80.0 px/s")).toBeTruthy();
    expect(screen.getByText(/Percentile envelope only/)).toBeTruthy();

    const map = await screen.findByRole("img", { name: /Retained centroid density/ });
    expect(map).toBeTruthy();
    expect(screen.getByText(/Counts of retained centroid points per 24×14 frame cell/)).toBeTruthy();

    const trackLink = await screen.findByRole("link", { name: /T01.*points/ });
    expect(trackLink.getAttribute("href")).toContain(`session=${SESSION}`);
    expect(trackLink.getAttribute("href")).toContain("track=1");

    expect(await screen.findByText("Scene-sensitive events")).toBeTruthy();
    const eventLinks = screen.getAllByRole("link", { name: /E101/ });
    expect(eventLinks.length).toBeGreaterThan(0);
    expect(eventLinks[0].getAttribute("href")).toContain(`session=${SESSION}`);
    expect(eventLinks[0].getAttribute("href")).toContain("event=101");
    expect(screen.getAllByRole("link", { name: /T01/ }).length).toBeGreaterThan(0);

    const zonePanel = screen.getByText("Zone evidence").closest(".panel");
    expect(zonePanel).toBeTruthy();
    expect(within(zonePanel as HTMLElement).getByText("3.50 s")).toBeTruthy();
    expect(within(zonePanel as HTMLElement).getByText("4.50 s")).toBeTruthy();
    expect(within(zonePanel as HTMLElement).getByRole("link", { name: /E101/ })).toBeTruthy();
  });

  it("labels historical calibration as unavailable, not failed", async () => {
    const historic = {
      ...readyScene,
      source: "derived_observations",
      calibration: {
        available: false,
        ready: null,
        samples: null,
        tracks: null,
        observed_seconds: null,
        reason:
          "The learned calibration baseline is kept in memory and is not written to SQLite.",
      },
      speed_baseline: {
        ...readyScene.speed_baseline,
        source: "derived_event_observations",
        min: 0,
        max: 160,
      },
      directions: {
        ...readyScene.directions,
        source: "derived_event_observations",
        counts: { E: 72, W: 36, N: 12 },
      },
    };
    mockFetch({
      scene: json(historic),
      session: json({
        ...sessionItem,
        artifacts: {
          ...sessionItem.artifacts,
          trajectories: false,
          structured_evidence: false,
          scene_calibration: false,
          preview_frames: 0,
        },
        limitations: [
          "Centroid positions are not persisted in SQLite. A full trajectory is only available for sessions analysed by this API process.",
        ],
      }),
      events: json(
        pageResponse([
          event(201, 1, "Irregular", 0.5, null, null, false),
          event(202, 0, "Suspicious", 0.2, null, null, false),
        ]),
      ),
    });
    renderPage();

    expect(await screen.findByText("Historical calibration unavailable")).toBeTruthy();
    expect(screen.getByText(/kept in memory/)).toBeTruthy();
    expect(screen.getAllByText(/not a failed calibration/).length).toBeGreaterThan(0);
    expect(screen.getByText("Movement intelligence")).toBeTruthy();
    expect(await screen.findByText("Trajectory coordinates not persisted")).toBeTruthy();
    expect(screen.getByText("Zone evidence not retained")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Retained centroid density/ })).toBeNull();
  });

  it("shows a full scene API error without fabricating a fallback baseline", async () => {
    mockFetch({
      scene: json({ error: { code: "internal", message: "Scene read failed." } }, 500),
    });
    renderPage();

    expect(await screen.findByText("Scene intelligence unavailable")).toBeTruthy();
    expect(screen.getByText("Scene read failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry request/ })).toBeTruthy();
    expect(screen.getByText(/No fallback baseline/)).toBeTruthy();
    expect(screen.queryByText("Calibration ready")).toBeNull();
  });

  it("renders empty movement, spatial and event states without invented values", async () => {
    const emptyScene = {
      ...readyScene,
      calibration: {
        available: false,
        ready: null,
        samples: null,
        tracks: null,
        observed_seconds: null,
        reason: "No samples were persisted.",
      },
      source: "derived_observations",
      speed_baseline: null,
      directions: null,
      deviations: {
        scene_score: { samples: 0, mean: null, p50: null, max: null },
        above_0_2: 0,
        above_0_3: 0,
        affected_tracks: 0,
        top_tracks: [],
      },
      notes: [],
    };
    mockFetch({
      scene: json(emptyScene),
      tracks: json({ total: 0, count: 0, limit: 200, offset: 0, tracks: [] }),
      events: json(pageResponse([], 0)),
      session: json({
        ...sessionItem,
        counts: {
          observations: 0,
          tracks: 0,
          anomalies: 0,
          levels: { Normal: 0, Suspicious: 0, Irregular: 0 },
          labels: 0,
        },
        artifacts: {
          ...sessionItem.artifacts,
          trajectories: false,
          structured_evidence: false,
          scene_calibration: false,
          preview_frames: 0,
        },
      }),
    });
    renderPage();

    expect(await screen.findByText("No speed observations")).toBeTruthy();
    expect(screen.getAllByText("No direction observations").length).toBeGreaterThan(0);
    expect(await screen.findByText("No elevated events")).toBeTruthy();
    expect(screen.getByText("Zone evidence not retained")).toBeTruthy();
    expect(screen.getByText("No track deviations")).toBeTruthy();
  });

  it("presents readiness coverage and every met gate for a ready calibration", async () => {
    mockFetch();
    renderPage();

    await screen.findByText("Calibration ready");
    const hero = document.querySelector(".calibration-hero") as HTMLElement;
    expect(hero.dataset.state).toBe("ready");
    expect(within(hero).getByText("Readiness coverage")).toBeTruthy();
    expect(within(hero).getByText("100%")).toBeTruthy();
    expect(within(hero).getByText("Readiness gates met · 120 samples")).toBeTruthy();
    expect(within(hero).getByText("Ready")).toBeTruthy();

    const gates = document.querySelectorAll(".scene-gate");
    expect(gates.length).toBe(3);
    expect([...gates].every((gate) => gate.classList.contains("is-met"))).toBe(true);
    expect([...gates].every((gate) => gate.getAttribute("data-met") === "true")).toBe(true);
    expect(screen.getAllByText("met").length).toBe(3);

    // The three evidence cards keep the persisted values, not a recomputation.
    expect(document.querySelectorAll(".scene-evidence .metric-card").length).toBe(3);
    expect(document.querySelector(".scene-evidence .metric-card__value")?.textContent).toBe("120");
    expect(screen.getByText("18.0 s")).toBeTruthy();
  });

  it("names the limiting gate on a not-ready calibration and keeps it distinct from a failure", async () => {
    mockFetch({
      scene: json({
        ...readyScene,
        calibration: {
          ...readyScene.calibration,
          ready: false,
          samples: 12,
          tracks: 1,
          observed_seconds: 3,
        },
      }),
    });
    renderPage();

    expect(await screen.findByText("Calibration not ready")).toBeTruthy();
    const hero = document.querySelector(".calibration-hero") as HTMLElement;
    expect(hero.dataset.state).toBe("warming");
    expect(within(hero).getByText("25%")).toBeTruthy();
    expect(within(hero).getByText("Limiting gate · Observed seconds")).toBeTruthy();
    expect(within(hero).getByText("Not ready")).toBeTruthy();
    expect(within(hero).getByText("Readiness gates not met · 12 samples")).toBeTruthy();

    const gates = document.querySelectorAll(".scene-gate");
    expect(gates.length).toBe(3);
    expect([...gates].every((gate) => !gate.classList.contains("is-met"))).toBe(true);
    expect(screen.getAllByText("below gate").length).toBe(3);
    expect(screen.getByText(/is the limiting gate/)).toBeTruthy();
    expect(screen.queryByText(/calibration failure/)).toBeTruthy();
  });

  it("draws the direction rose and speed cards from persisted aggregates", async () => {
    mockFetch();
    renderPage();

    const rose = await screen.findByRole("img", {
      name: /Direction distribution, dominant flow E, 3 of 8 octants observed/,
    });
    expect(rose).toBeTruthy();
    expect(document.querySelectorAll(".direction-rose__spoke").length).toBe(8);
    expect(document.querySelectorAll(".direction-rose__spoke.is-dominant").length).toBe(1);
    expect(document.querySelectorAll(".direction-rose__label").length).toBe(8);
    expect(document.querySelector(".direction-rose__core")?.textContent).toBe("E");
    expect(document.querySelector(".direction-rose__core-value")?.textContent).toBe("60.0%");

    expect(screen.getByText("Median speed")).toBeTruthy();
    expect(screen.getByText("80.0 px/s")).toBeTruthy();
    expect(screen.getByText("82.0 ± 21.0 px/s")).toBeTruthy();
    expect(screen.getByText("Moving share")).toBeTruthy();
    expect(screen.getByText("90.0%", { selector: ".metric-card__value" })).toBeTruthy();
    expect(document.querySelector(".scene-envelope__band")).toBeTruthy();
    // min/max are null in this payload, so no observed-edge markers are drawn.
    expect(document.querySelectorAll(".scene-envelope__edge").length).toBe(0);
  });

  it("renders retained paths with chart accents and the source-resolution disclosure", async () => {
    mockFetch();
    renderPage();

    await screen.findByRole("img", { name: /Retained centroid density/ });
    expect(document.querySelectorAll(".scene-map__path.scene-accent--1").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".scene-map__path.scene-accent--2").length).toBeGreaterThan(0);
    expect(screen.getByText("Retained track paths")).toBeTruthy();
    expect(
      document.querySelectorAll(".scene-track-legend__swatch.scene-accent--2").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/1,280×720 px/)).toBeTruthy();
    expect(document.querySelectorAll(".scene-map__reticle").length).toBe(4);

    const zonePanel = screen.getByText("Zone evidence").closest(".panel") as HTMLElement;
    expect(within(zonePanel).getByText("3.50 s")).toBeTruthy();
    expect(within(zonePanel).getByText("4.50 s")).toBeTruthy();
    expect(within(zonePanel).getByRole("link", { name: /E101/ }).getAttribute("href")).toBe(
      `/anomalies?session=${SESSION}&event=101`,
    );
    expect(document.querySelectorAll(".table--scene-zones .scene-dwell").length).toBe(2);
  });
});
