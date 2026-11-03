import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const SESSION = "s-anomaly";

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
    frames_processed: 25,
    width: 640,
    height: 360,
    fps: 10,
    wall_s: 1,
    max_frames: null,
    processing_fps: 25,
    video_duration_s: 2.5,
    started_ts: null,
    ended_ts: null,
    run_stats_available: true,
  },
  counts: {
    observations: 30,
    tracks: 3,
    anomalies: 25,
    levels: { Normal: 5, Suspicious: 15, Irregular: 10 },
    labels: 0,
  },
  frame_range: { first: 0, last: 24 },
  timestamps: {
    first_ts: "2026-01-01T00:00:00+00:00",
    last_ts: "2026-01-01T00:00:02.400000+00:00",
  },
};

const SUMMARY = {
  ...sessionItem,
  level_share: { Normal: 0.1667, Suspicious: 0.5, Irregular: 0.3333 },
  anomalies: {
    count: 25,
    tracks_affected: 2,
    score_min: 0.31,
    score_max: 0.98,
    score_mean: 0.62,
    highest: { event_id: 25, frame: 24, track_id: 1, level: "Irregular", fused_score: 0.98 },
  },
  tracks: { count: 3, with_anomalies: 2, with_irregular: 1 },
  temporal: { first_frame: 0, last_frame: 24, observed_seconds: 2.5 },
  labels: { labels: 0, evaluation_url: `/api/v1/sessions/${SESSION}/evaluation` },
};

function track(id: number, anomalies: number, irregular = 0) {
  return {
    track_id: id,
    appearance: { color: id === 0 ? "red" : "green", shape: "circle" },
    frames: { first: 0, last: 24, summary_first: 0, summary_last: 24 },
    observed: {
      observations: 10,
      anomalies,
      levels: { Normal: 10 - anomalies, Suspicious: anomalies - irregular, Irregular: irregular },
      worst_level: irregular > 0 ? "Irregular" : anomalies > 0 ? "Suspicious" : "Normal",
      duration_s: 2.5,
    },
    motion: {
      mean_speed_px_s: 60,
      max_speed_px_s: 120,
      path_length_px: 240,
      straightness: 1,
      n_points: 10,
      n_seconds: 2.5,
      summary_directions: ["W"],
      max_fused_score: 0.9,
      speed_source: "track_summary",
    },
    timestamps: { first_ts: null, last_ts: null },
  };
}

const TRACKS = [track(0, 20, 9), track(1, 5, 1), track(2, 0)];

function event(id: number) {
  const frame = id - 1;
  const evidence =
    id === 24
      ? {
          available: false,
          source: "not_persisted",
          rules: [],
          ml_note: null,
          scene_note: null,
          zone: null,
          zone_dwell_s: null,
          appearance: null,
        }
      : {
          available: true,
          source: "in_process_artifacts",
          rules:
            id === 23
              ? []
              : [
                  {
                    rule: id % 2 === 0 ? "excessive_speed" : "sudden_acceleration",
                    severity: id % 2 === 0 ? 1 : 0.6,
                    description: "recorded trigger",
                  },
                ],
          ml_note: id === 23 ? null : "recorded model note",
          scene_note: null,
          zone: null,
          zone_dwell_s: null,
          appearance: { color: "red", shape: "circle" },
        };
  return {
    event_id: id,
    session: SESSION,
    frame,
    ts_utc: "2026-01-01T00:00:00+00:00",
    track_id: id % 2,
    level: id % 3 === 0 ? "Irregular" : "Suspicious",
    scores: {
      fused: id === 25 ? 0.98 : 0.4,
      rule: 0.3,
      ml: 0.2,
      scene: null,
    },
    motion: { speed_px_s: 75, direction_deg: 180 },
    summary: `fired rule [${id % 2 === 0 ? "excessive_speed" : "sudden_acceleration"}]`,
    evidence,
  };
}

const EVENTS = Array.from({ length: 25 }, (_, index) => event(index + 1));

function detail(id: number) {
  const base = EVENTS.find((row) => row.event_id === id) ?? EVENTS[0];
  return {
    ...base,
    track: id === 24 ? null : {
      track_id: base.track_id,
      color: "red",
      shape: "circle",
      observations: 10,
      anomalies: 8,
      worst_level: "Irregular",
      first_frame: 0,
      last_frame: 24,
    },
    frame_info: {
      index: base.frame,
      ts_utc: base.ts_utc,
      media_available: true,
      frame_url: `/api/v1/sessions/${SESSION}/frames/${base.frame}?kind=annotated`,
    },
    notes: ["Structured evidence is retained in memory for this session."],
  };
}

const MEDIA = {
  session: SESSION,
  available: true,
  preview_stride: 6,
  preview_count: 5,
  source_resolution: { width: 640, height: 360 },
  frames: [0, 6, 12, 18, 24].map((frame) => ({
    frame,
    ts_s: frame / 10,
    annotated_url: `/api/v1/sessions/${SESSION}/frames/${frame}?kind=annotated`,
    original_url: `/api/v1/sessions/${SESSION}/frames/${frame}?kind=original`,
  })),
  annotated_video: { available: false, reason: "No annotated video is produced." },
  notes: ["Preview frames are held in this API process."],
};

function config() {
  return {
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
  };
}

function mockFetch(overrides: Partial<Record<string, Response>> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/health")) {
      return Promise.resolve(json({ status: "ok", version: "1.0.0", uptime_s: 1 }));
    }
    if (url.includes("/sessions?limit=100")) {
      return Promise.resolve(json({ total: 1, count: 1, limit: 100, offset: 0, sessions: [sessionItem] }));
    }
    if (url.includes(`/sessions/${SESSION}/summary`)) {
      return Promise.resolve(overrides.summary ?? json(SUMMARY));
    }
    if (url.includes(`/sessions/${SESSION}/tracks?`)) {
      return Promise.resolve(
        overrides.tracks ?? json({ total: 3, count: 3, limit: 200, offset: 0, tracks: TRACKS }),
      );
    }
    if (url.includes(`/sessions/${SESSION}/anomalies?`)) {
      if (overrides.events) return Promise.resolve(overrides.events);
      return Promise.resolve(
        json({
          total: EVENTS.length,
          count: EVENTS.length,
          limit: 500,
          offset: 0,
          severity: null,
          event_type: null,
          anomalies: EVENTS,
        }),
      );
    }
    if (url.match(new RegExp(`/sessions/${SESSION}/anomalies/\\d+`))) {
      const id = Number(url.split("/").pop());
      return Promise.resolve(
        overrides.detail ?? json(detail(id)),
      );
    }
    if (url.includes(`/sessions/${SESSION}/media`)) {
      return Promise.resolve(json(MEDIA));
    }
    if (url.includes("/config")) {
      return Promise.resolve(json(config()));
    }
    return Promise.reject(new Error(`Unhandled fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCenter(path = `/anomalies?session=${SESSION}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

function pagerText(text: string) {
  return screen.findByText((_, node) => {
    if (!node?.classList.contains("pager__readout")) return false;
    return node.textContent?.replace(/\s+/g, " ").trim() === text;
  });
}

function evidenceText(): string {
  return document.querySelector(".event-evidence")?.textContent ?? "";
}

describe("anomaly intelligence center", () => {
  it("loads persisted intelligence, paginates and filters the ledger", async () => {
    mockFetch();
    renderCenter();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveProperty(
      "textContent",
      "Anomaly Intelligence Center",
    );
    expect(await screen.findByText("25")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(await pagerText("1–20 / 25 events")).toBeTruthy();
    expect(await screen.findByRole("link", { name: /T00/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await pagerText("21–25 / 25 events")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Irregular" }));
    await waitFor(() => expect(screen.getByText(/matching/)).toBeTruthy());
    expect(screen.getByText(/8 matching/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter anomaly events by track"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Filter anomaly events by type"), {
      target: { value: "excessive_speed" },
    });
    fireEvent.change(screen.getByLabelText("Search anomaly events"), {
      target: { value: "e21" },
    });
    await waitFor(() => expect(screen.getByText(/No events match these filters/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Search anomaly events"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter anomaly events by type"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Filter anomaly events by track"), {
      target: { value: "all" },
    });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await pagerText("1–20 / 25 events")).toBeTruthy();
  });

  it("selects a timeline mark and keeps session context in track navigation", async () => {
    mockFetch();
    renderCenter();

    const mark = await screen.findByRole("button", {
      name: /Select event 25, frame 24, Suspicious, track 1/,
    });
    fireEvent.click(mark);

    expect(await screen.findByText("Persisted event, scores and retained evidence")).toBeTruthy();
    expect(await screen.findByText("recorded model note")).toBeTruthy();
    const frameLink = screen.getByRole("link", { name: /Open frame in Track Explorer/ });
    expect(frameLink.getAttribute("href")).toContain(`session=${SESSION}`);
    expect(frameLink.getAttribute("href")).toContain("track=1");
    expect(frameLink.getAttribute("href")).toContain("frame=24");
    expect(screen.getByRole("link", { name: /Open T01 in Track Explorer/ })).toBeTruthy();
    expect(screen.getAllByText(/F00024/).length).toBeGreaterThan(0);
  });

  it("distinguishes missing evidence from retained evidence with no trigger", async () => {
    mockFetch();
    renderCenter();

    await pagerText("1–20 / 25 events");
    fireEvent.click(screen.getByRole("button", { name: "Open investigation for event 24" }));
    expect(await screen.findByText("Rule-level evidence is missing for this session")).toBeTruthy();
    await waitFor(() => expect(evidenceText()).toContain("not evidence that no rule fired"));

    fireEvent.click(screen.getByRole("button", { name: "Open investigation for event 23" }));
    await waitFor(() => expect(evidenceText()).toContain("no rule trigger was recorded"));
    expect(evidenceText()).toContain("No rule, ML note or scene note was recorded");
  });

  it("opens the event addressed by a scene deep link", async () => {
    mockFetch();
    renderCenter(`/anomalies?session=${SESSION}&event=24`);

    expect(await screen.findByText("Rule-level evidence is missing for this session")).toBeTruthy();
    const detail = document.querySelector(".anomaly-investigation");
    expect(detail?.textContent).toContain("E24");
  });

  it("keeps the ledger error isolated and surfaces an API failure", async () => {
    mockFetch({
      events: json({ error: { code: "internal", message: "Ledger unavailable." } }, 500),
    });
    renderCenter();

    expect(await screen.findByText("Anomaly event ledger unavailable")).toBeTruthy();
    expect(screen.getAllByText("Ledger unavailable.").length).toBeGreaterThan(0);
    expect(await screen.findByText("Event timeline unavailable")).toBeTruthy();
    expect(screen.getByText("Channel contributions unavailable")).toBeTruthy();
    expect(
      screen.getByText(/Frame event evidence is unavailable because/),
    ).toBeTruthy();
  });

  it("renders honest empty totals when the session has no elevated events", async () => {
    mockFetch({
      summary: json({
        ...SUMMARY,
        counts: { ...SUMMARY.counts, anomalies: 0, levels: { Normal: 30, Suspicious: 0, Irregular: 0 } },
        anomalies: { ...SUMMARY.anomalies, count: 0, tracks_affected: 0, score_min: null, score_max: null, score_mean: null, highest: null },
        tracks: { count: 3, with_anomalies: 0, with_irregular: 0 },
      }),
      tracks: json({
        total: 3,
        count: 3,
        limit: 200,
        offset: 0,
        tracks: [track(0, 0), track(1, 0), track(2, 0)],
      }),
      events: json({
        total: 0,
        count: 0,
        limit: 500,
        offset: 0,
        severity: null,
        event_type: null,
        anomalies: [],
      }),
    });
    renderCenter();

    expect(await screen.findByText("No elevated events in this run")).toBeTruthy();
    expect(screen.getByText("No repeated track events")).toBeTruthy();
    expect(screen.getByText(/No events to plot/)).toBeTruthy();
  });
});
