import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const SESSION = "s-test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sessionItem = {
  session: SESSION,
  source: { label: "sample: test.mp4", kind: "sample", synthetic: false },
  processing: {
    frames_processed: 40,
    width: 640,
    height: 360,
    fps: 10,
    wall_s: 1,
    max_frames: null,
    processing_fps: 40,
    video_duration_s: 4,
    started_ts: null,
    ended_ts: null,
    run_stats_available: true,
  },
  counts: {
    observations: 20,
    tracks: 2,
    anomalies: 2,
    levels: { Normal: 18, Suspicious: 2, Irregular: 0 },
    labels: 0,
  },
  frame_range: { first: 0, last: 39 },
  timestamps: { first_ts: "2026-01-01T00:00:00+00:00", last_ts: "2026-01-01T00:00:04+00:00" },
};

function track(trackId: number, color: string) {
  return {
    track_id: trackId,
    appearance: { color, shape: "circle" },
    frames: { first: 0, last: 39, summary_first: 0, summary_last: 39 },
    observed: {
      observations: 20,
      anomalies: trackId === 3 ? 2 : 0,
      levels: { Normal: 18, Suspicious: 2, Irregular: 0 },
      worst_level: trackId === 3 ? "Suspicious" : "Normal",
      duration_s: 4,
    },
    motion: {
      mean_speed_px_s: 60,
      max_speed_px_s: 120,
      path_length_px: 240,
      straightness: 1,
      n_points: 20,
      n_seconds: 4,
      summary_directions: ["W"],
      max_fused_score: trackId === 3 ? 0.45 : 0,
      speed_source: "track_summary",
    },
    timestamps: {
      first_ts: "2026-01-01T00:00:00+00:00",
      last_ts: "2026-01-01T00:00:04+00:00",
    },
  };
}

const TRACKS = [track(3, "red"), track(0, "green")];

function detail(trackId: number) {
  return {
    ...(TRACKS.find((item) => item.track_id === trackId) ?? TRACKS[0]),
    session: SESSION,
    direction_profile: {
      samples: 20,
      counts: { W: 20 },
      histogram: { W: 1 },
      dominant: ["W"],
      source: "derived_event_observations",
    },
    trajectory: { available: trackId === 3, points: 20, reason: null },
  };
}

const OBSERVATIONS = Array.from({ length: 20 }, (_, index) => ({
  event_id: index + 1,
  session: SESSION,
  frame: index,
  ts_utc: "2026-01-01T00:00:00+00:00",
  track_id: 3,
  level: index === 12 || index === 13 ? "Suspicious" : "Normal",
  scores: {
    fused: index === 12 || index === 13 ? 0.45 : 0,
    rule: 0,
    ml: 0,
    scene: 0,
  },
  motion: {
    speed_px_s: index % 5 === 0 ? null : 60,
    direction_deg: index % 2 === 0 ? 180 : 175,
  },
  summary: index === 12 || index === 13 ? "fired rule [sudden_acceleration]" : "",
}));

const ANOMALIES = [12, 13].map((frame, index) => ({
  ...OBSERVATIONS[frame],
  event_id: 100 + index,
  evidence: {
    available: true,
    source: "in_process_artifacts",
    rules: [{ rule: "sudden_acceleration", severity: 1, description: "accelerating" }],
    ml_note: null,
    scene_note: null,
    zone: null,
    zone_dwell_s: 0,
    appearance: { color: "red", shape: "circle" },
  },
}));

const MEDIA = {
  session: SESSION,
  available: true,
  preview_stride: 6,
  preview_count: 4,
  source_resolution: { width: 640, height: 360 },
  frames: [0, 6, 12, 18].map((frame) => ({
    frame,
    ts_s: frame / 10,
    annotated_url: `/api/v1/sessions/${SESSION}/frames/${frame}?kind=annotated`,
    original_url: `/api/v1/sessions/${SESSION}/frames/${frame}?kind=original`,
  })),
  annotated_video: { available: false, reason: "No annotated video is produced." },
  notes: ["Preview frames are held in this API process."],
};

const TRAJECTORY = {
  session: SESSION,
  track_id: 3,
  available: true,
  reason: null,
  points: Array.from({ length: 20 }, (_, frame) => ({
    frame,
    x: 600 - frame * 10,
    y: 200,
    level: frame === 12 || frame === 13 ? "Suspicious" : "Normal",
    speed_px_s: 60,
    direction_deg: 180,
  })),
};

function mockFetch(overrides: Partial<Record<string, Response>> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/health")) {
      return Promise.resolve(json({ status: "ok", version: "1.0.0", uptime_s: 1 }));
    }
    if (url.includes("/sessions?limit=100")) {
      return Promise.resolve(
        json({ total: 1, count: 1, limit: 100, offset: 0, sessions: [sessionItem] }),
      );
    }
    if (url.includes(`/sessions/${SESSION}/tracks?`)) {
      if (overrides.tracks) return Promise.resolve(overrides.tracks);
      if (url.includes("level=Irregular")) {
        return Promise.resolve(
          json({ total: 1, count: 1, limit: 200, offset: 0, tracks: [track(3, "red")] }),
        );
      }
      return Promise.resolve(
        json({ total: 2, count: 2, limit: 200, offset: 0, tracks: TRACKS }),
      );
    }
    if (url.includes(`/sessions/${SESSION}/tracks/`) && url.includes("/trajectory")) {
      return Promise.resolve(
        overrides.trajectory ??
          json(
            String(url).includes("/tracks/0/")
              ? {
                  session: SESSION,
                  track_id: 0,
                  available: false,
                  points: [],
                  reason: "Centroid positions are not persisted for this session.",
                }
              : TRAJECTORY,
          ),
      );
    }
    if (url.includes(`/sessions/${SESSION}/tracks/`) && url.includes("/frames")) {
      const trackId = url.includes("/tracks/0/") ? 0 : 3;
      return Promise.resolve(
        json({
          session: SESSION,
          track_id: trackId,
          total: 20,
          count: 20,
          limit: 500,
          offset: 0,
          media_available: true,
          reason: null,
          frames: Array.from({ length: 20 }, (_, frame) => ({
            frame,
            ts_utc: "2026-01-01T00:00:00+00:00",
            level: "Normal",
            fused_score: 0,
            speed_px_s: 60,
            preview_available: [0, 6, 12, 18].includes(frame),
            frame_url: [0, 6, 12, 18].includes(frame)
              ? `/api/v1/sessions/${SESSION}/frames/${frame}?kind=annotated`
              : null,
          })),
        }),
      );
    }
    if (url.includes(`/sessions/${SESSION}/tracks/`) && url.includes("/observations")) {
      return Promise.resolve(
        json({ total: 20, count: 20, limit: 500, offset: 0, observations: OBSERVATIONS }),
      );
    }
    if (url.includes(`/sessions/${SESSION}/tracks/0`) && !url.includes("?")) {
      return Promise.resolve(json(detail(0)));
    }
    if (url.includes(`/sessions/${SESSION}/tracks/3`) && !url.includes("/observations") && !url.includes("/trajectory")) {
      return Promise.resolve(json(detail(3)));
    }
    if (url.includes(`/sessions/${SESSION}/anomalies?`)) {
      const empty = url.includes("track_id=0");
      return Promise.resolve(
        json({
          total: empty ? 0 : 2,
          count: empty ? 0 : 2,
          limit: 200,
          offset: 0,
          severity: null,
          event_type: null,
          anomalies: empty ? [] : ANOMALIES,
        }),
      );
    }
    if (url.includes(`/sessions/${SESSION}/media`)) {
      return Promise.resolve(json(MEDIA));
    }
    return Promise.reject(new Error(`Unhandled fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderExplorer(path = `/tracks?session=${SESSION}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

describe("track explorer", () => {
  it("loads real tracks, switches selection and searches", async () => {
    mockFetch();
    renderExplorer();

    const t3 = await screen.findByRole("button", { name: /Track T03, 20 observations/ });
    expect(screen.getByRole("button", { name: /Track T00, 20 observations/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("T03 · measured lifecycle and motion")).toBeTruthy());
    expect((await screen.findAllByText(/sudden_acceleration/)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Track T00, 20 observations/ }));
    await waitFor(() => expect(screen.getByText("T00 · measured lifecycle and motion")).toBeTruthy());
    expect(screen.getAllByText(/No elevated events/).length).toBeGreaterThan(0);

    fireEvent.click(t3);
    fireEvent.change(screen.getByLabelText("Search tracks"), { target: { value: "green" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Track T03/ })).toBeNull());
    expect(screen.getByRole("button", { name: /Track T00/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search tracks"), { target: { value: "nope" } });
    expect((await screen.findAllByText("No track matches")).length).toBeGreaterThan(0);
  });

  it("uses the server level filter and reports a failed track index", async () => {
    const fetchMock = mockFetch();
    renderExplorer();
    await screen.findByRole("button", { name: /Track T03/ });

    fireEvent.change(screen.getByLabelText("Filter tracks by level"), {
      target: { value: "Irregular" },
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("level=Irregular"))).toBe(true);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Track T00/ })).toBeNull());

    mockFetch({
      tracks: json(
        { error: { code: "internal", message: "Track index failed." } },
        500,
      ),
    });
    fireEvent.change(screen.getByLabelText("Sort tracks"), { target: { value: "speed" } });
    expect(await screen.findByText("Track index unavailable")).toBeTruthy();
  });

  it("renders one honest empty state when the session has no tracks", async () => {
    mockFetch({
      tracks: json({ total: 0, count: 0, limit: 200, offset: 0, tracks: [] }),
    });
    renderExplorer();

    expect(await screen.findByText("No tracked objects")).toBeTruthy();
    expect(screen.queryByText("Track index")).toBeNull();
    expect(screen.getByText(/no trajectories, observations or events/)).toBeTruthy();
  });

  it("honors an anomaly deep link to a track and frame", async () => {
    mockFetch();
    renderExplorer(`/tracks?session=${SESSION}&track=0&frame=18`);

    await screen.findByRole("button", { name: /Track T00/ });
    await screen.findByText("T00 · measured lifecycle and motion");
    await waitFor(() => expect(screen.getAllByText("F00018").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /Track T00/ }).className).toContain(
      "is-active",
    );
    expect(screen.queryByText(/not in this session's retained preview set/)).toBeNull();
  });

  it("jumps to a retained anomaly frame and is honest when it is not retained", async () => {
    mockFetch();
    renderExplorer();

    await screen.findByRole("button", { name: /Track T03/ });
    await screen.findByText("T03 · measured lifecycle and motion");

    fireEvent.click(
      await screen.findByRole("button", {
        name: /Inspect frame 12, Suspicious event on track T03/,
      }),
    );
    await waitFor(() => expect(screen.getAllByText("F00012").length).toBeGreaterThan(0));
    expect(screen.queryByText(/not in this session's retained preview set/)).toBeNull();
    expect(
      screen.getByRole("img", { name: /Persisted centroid path for track T03/ }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect frame 13, Suspicious event on track T03/,
      }),
    );
    expect(
      await screen.findByText(/not in this session's retained preview set/),
    ).toBeTruthy();
  });
});
