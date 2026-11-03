import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";
import type { EngineConfig, SystemStatus } from "../lib/types";

const CONFIG: EngineConfig = {
  video: { frame_width: 640, frame_height: 480, process_fps: 15 },
  preprocess: { gaussian_blur_ksize: 5, fill_small_blobs_px: 40, morph_kernel_size: 3 },
  shape: { epsilon_factor: 0.02, min_rotation_lock_aspect: 0.7, circularity_target: 0.4 },
  tracking: {
    max_age: 30,
    min_hits: 3,
    iou_gate: 0.3,
    position_gate_px: 80,
    kalman_process_noise: 0.03,
    kalman_measurement_noise: 0.5,
  },
  calibration: { warmup_tracks: 3, tracks_seconds: 20, min_samples: 20, direction_bin_deg: 45 },
  anomaly: {
    contamination: 0.05,
    per_object_window: 50,
    scene_cluster_k_min: 2,
    scene_cluster_k_max: 6,
    threshold_suspicious: 0.55,
    threshold_irregular: 0.75,
    weights: { rule: 0.5, ml: 0.3, scene: 0.2 },
    rule: {
      speed_pctl_fast: 0.9,
      speed_pctl_slow: 0.1,
      max_z: 3,
      loiter_seconds: 4,
      direction_dev_deg: 60,
    },
  },
  zone: { enabled: false, zones: [], dwell_seconds: 3 },
  dashboard: { page_title: "NEURAL COMMAND" },
  paths: { samples: "/srv/neural/samples", output: "/srv/neural/output", db: "/srv/neural/db.sqlite", read_only: true },
};

const SYSTEM: SystemStatus = {
  version: "0.10.0",
  python: "3.12.3",
  python_implementation: "CPython",
  platform: "Linux-test",
  packages: { fastapi: "0.162.0", numpy: "2.5.2", opencv: null },
  storage: {
    db: { path: "/srv/neural/db.sqlite", exists: true, bytes: 4096 },
    samples: { path: "/srv/neural/samples", exists: true, videos: 1, bytes: 2048 },
    output: { path: "/srv/neural/output", exists: true, files: 2, bytes: 8192 },
  },
  runtime: { executable: "/usr/bin/python3", pid: 4242 },
  limits: { max_upload_bytes: 16 * 1024 * 1024, upload_ttl_s: 86_400, max_workers: 2, max_frames_cap: 9000 },
  formats: { extensions: [".mp4", ".mov"], mime_types: ["video/mp4", "video/quicktime"] },
  configuration: { writable: true, persistence: "process_local", resets_on_restart: true, paths_read_only: true },
};

const HEALTH = { status: "ok", version: "0.10.0", uptime_s: 1234 };
const SOURCES = {
  directory: "/srv/neural/samples",
  count: 1,
  valid: 1,
  invalid: 0,
  sources: [
    {
      name: "anomaly_clip.mp4",
      path: "/srv/neural/samples/anomaly_clip.mp4",
      bytes: 2048,
      kind: "video",
      synthetic: false,
      valid: true,
      error: null,
      fps: 24,
      frames: 240,
      width: 640,
      height: 480,
      duration_s: 10,
    },
  ],
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function errorEnvelope(message: string, detail?: unknown) {
  return { error: { code: "config_invalid", message, detail } };
}

function renderSettings(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

function baseFetch(overrides: { jobCounts?: Record<string, number>; put?: (body: unknown) => Promise<Response> } = {}) {
  const putBodies: unknown[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) return json(HEALTH);
    if (url.endsWith("/system")) return json(SYSTEM);
    if (url.endsWith("/sources")) return json(SOURCES);
    if (url.endsWith("/jobs") || url.includes("/jobs?")) {
      const status = new URL(url, "http://local").searchParams.get("status") ?? "";
      const total = overrides.jobCounts?.[status] ?? 0;
      return json({ total, count: 0, jobs: [] });
    }
    if (url.endsWith("/sessions")) return json({ total: 0, count: 0, limit: 8, offset: 0, sessions: [] });
    if (url.endsWith("/config/reset")) {
      return json({ config: CONFIG, applied: ["video", "tracking"], changed: true, reset_to_defaults: true });
    }
    if (url.endsWith("/config") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as unknown;
      putBodies.push(body);
      if (overrides.put) return overrides.put(body);
      return json({ config: CONFIG, applied: ["tracking.max_age"], changed: true });
    }
    if (url.endsWith("/config")) return json(CONFIG);
    return json({});
  });
  return { fetchMock, putBodies };
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

describe("system settings", () => {
  it("shows a clear loading state while the configuration document is pending", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { fetchMock } = baseFetch();
    const slowFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/config") && !init?.method) return pending;
      return fetchMock(input, init);
    });
    renderSettings(slowFetch);

    expect(await screen.findByText("Loading engine configuration")).toBeTruthy();
    release(new Response(JSON.stringify(CONFIG), { status: 200 }));
    expect(await screen.findByDisplayValue("640")).toBeTruthy();
  });

  it("loads live health, limits, formats, configuration metadata and sources", async () => {
    const { fetchMock } = baseFetch();
    renderSettings(fetchMock);

    expect(await screen.findByDisplayValue("640")).toBeTruthy();
    expect(screen.getByText("API online")).toBeTruthy();
    expect(screen.getByText("ok · version 0.10.0")).toBeTruthy();
    expect(screen.getByText("16.0 MB")).toBeTruthy();
    expect(screen.getByText("24h 00m")).toBeTruthy();
    expect(screen.getByText(".mp4")).toBeTruthy();
    expect(screen.getByText(".mov")).toBeTruthy();
    expect(screen.getByText("process local · resets on restart")).toBeTruthy();
    expect(screen.getByText("anomaly_clip.mp4")).toBeTruthy();
    expect(screen.getByText("valid")).toBeTruthy();
    expect(screen.getByText("Process-local configuration")).toBeTruthy();
  });

  it("validates a bad edit before sending it and saves only changed sections", async () => {
    const { fetchMock, putBodies } = baseFetch();
    renderSettings(fetchMock);
    const maxAge = (await screen.findByLabelText("Max age")) as HTMLInputElement;

    fireEvent.change(maxAge, { target: { value: "-1" } });
    expect(screen.getByText(/Max age must be at least 0/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(maxAge, { target: { value: "45" } });
    expect(screen.queryByText(/Max age must be at least 0/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(putBodies[0]).toEqual({
      tracking: {
        max_age: 45,
        min_hits: 3,
        iou_gate: 0.3,
        position_gate_px: 80,
        kalman_process_noise: 0.03,
        kalman_measurement_noise: 0.5,
      },
    });
    expect(await screen.findByText("Configuration applied")).toBeTruthy();
  });

  it("shows backend field details when a save is rejected", async () => {
    const { fetchMock } = baseFetch({
      put: () =>
        json(
          errorEnvelope("The configuration is invalid.", [
            { loc: ["tracking", "max_age"], msg: "Input should be greater than or equal to 0" },
          ]),
          422,
        ),
    });
    renderSettings(fetchMock);
    const maxAge = (await screen.findByLabelText("Max age")) as HTMLInputElement;
    fireEvent.change(maxAge, { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Configuration rejected")).toBeTruthy();
    expect(screen.getByText(/tracking.max_age: Input should/)).toBeTruthy();
  });

  it("requires confirmation before resetting every section", async () => {
    const { fetchMock } = baseFetch();
    renderSettings(fetchMock);
    await screen.findByDisplayValue("640");

    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(screen.getByText("Reset every section to shipped defaults?")).toBeTruthy();
    expect(screen.queryByText("Defaults restored")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
    expect(await screen.findByText("Defaults restored")).toBeTruthy();
    const resetCall = (fetchMock.mock.calls as [RequestInfo | URL, RequestInit?][]).find(([input]) =>
      String(input).endsWith("/config/reset"),
    );
    expect(resetCall?.[1]?.method).toBe("POST");
  });

  it("blocks writes while an analysis job is active", async () => {
    const { fetchMock } = baseFetch({ jobCounts: { running: 1 } });
    renderSettings(fetchMock);

    expect(await screen.findByText("Configuration writes paused")).toBeTruthy();
    const maxAge = (await screen.findByLabelText("Max age")) as HTMLInputElement;
    fireEvent.change(maxAge, { target: { value: "45" } });
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset defaults" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows clear health and configuration errors when the API is down", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("failed to fetch"))));
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <ApiHealthProvider>
          <AppRoutes />
        </ApiHealthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("API health check failed")).toBeTruthy();
    expect(screen.getByText("API offline")).toBeTruthy();
    expect(screen.getByText("Configuration unavailable")).toBeTruthy();
    expect(screen.getByText("Job queue unavailable")).toBeTruthy();
  });

  it("explains absent limits instead of inventing a cap", async () => {
    const systemWithoutLimits: Partial<SystemStatus> = { ...SYSTEM };
    delete systemWithoutLimits.limits;
    delete systemWithoutLimits.formats;
    const { fetchMock } = baseFetch();
    const withMissing = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/system") ? json(systemWithoutLimits) : fetchMock(input, init),
    );
    renderSettings(withMissing);

    expect(await screen.findByText("Limits not exposed")).toBeTruthy();
    expect(screen.getByText(/does not report upload limits/)).toBeTruthy();
  });

  it("keeps the editor reachable at a narrow viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const { fetchMock } = baseFetch();
    renderSettings(fetchMock);

    expect(await screen.findByLabelText("Frame width")).toBeTruthy();
    expect(screen.getByText("Upload & job limits")).toBeTruthy();
    expect(document.querySelector(".settings-layout")).toBeTruthy();
    expect(document.querySelector(".settings-savebar")).toBeTruthy();
  });
});
