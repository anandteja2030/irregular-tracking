import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const OFFLINE = () => Promise.reject(new TypeError("failed to fetch"));
const MB = 1024 * 1024;
const JOB_KEY = "neural-command.job";

function json(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function renderStudio(path = "/video-studio") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

const SYSTEM = {
  version: "0.10.0",
  python: "3.12.3",
  python_implementation: "CPython",
  platform: "Linux-test",
  packages: {},
  storage: {
    db: { path: "/data/sessions.db", exists: true, bytes: 0 },
    samples: { path: "/samples", exists: true, videos: 0, bytes: 0 },
    output: { path: "/output", exists: true, files: 0, bytes: 0 },
  },
  runtime: { executable: "/usr/bin/python3", pid: 1 },
  limits: { max_upload_bytes: 4 * MB, upload_ttl_s: 3_600, max_workers: 2, max_frames_cap: 100 },
  formats: { extensions: [".mp4"], mime_types: ["video/mp4"] },
  configuration: {
    writable: true,
    persistence: "process_local",
    resets_on_restart: true,
    paths_read_only: true,
  },
};

const NO_SOURCES = { directory: "/samples", count: 0, valid: 0, invalid: 0, sources: [] };

const SESSION = {
  session: "sess_alpha",
  source: { label: "clip_a.mp4", kind: "sample", synthetic: false },
  processing: {
    frames_processed: 900,
    width: 1280,
    height: 720,
    fps: 25,
    wall_s: 12.5,
    max_frames: null,
    processing_fps: 72,
    video_duration_s: 36,
    started_ts: null,
    ended_ts: null,
    run_stats_available: true,
  },
  counts: {
    observations: 5_400,
    tracks: 12,
    anomalies: 3,
    levels: { Normal: 4_000, Suspicious: 1_200, Irregular: 200 },
    labels: 0,
  },
  frame_range: { first: 0, last: 899 },
  timestamps: { first_ts: null, last_ts: null },
};

const SUMMARY = {
  ...SESSION,
  level_share: { Normal: 0.74, Suspicious: 0.22, Irregular: 0.04 },
  anomalies: {
    count: 3,
    tracks_affected: 2,
    score_min: 0.61,
    score_max: 0.92,
    score_mean: 0.74,
    highest: null,
  },
  tracks: { count: 12, with_anomalies: 2, with_irregular: 1 },
  temporal: { first_frame: 0, last_frame: 899, observed_seconds: 125 },
  labels: { labels: 0, evaluation_url: "/evaluation" },
};

const JOB_RUNNING = {
  job_id: "job_1",
  session_id: "sess_new",
  state: "running",
  stage: "processing",
  source: { kind: "sample", ref: "clip_a.mp4", label: "clip_a.mp4", max_frames: 1_000 },
  progress: { processed: 250, total: 1_000, percent: 25, measured: true },
  timings: {
    created_ts: "2026-03-01T10:00:00+00:00",
    started_ts: "2026-03-01T10:00:01+00:00",
    ended_ts: null,
    elapsed_s: 4.2,
  },
  error: null,
  result: null,
};

const JOB_UNMEASURED = {
  ...JOB_RUNNING,
  progress: { processed: 180, total: null, percent: null, measured: false },
};

const JOB_DONE = {
  ...JOB_RUNNING,
  state: "completed",
  stage: "completed",
  progress: { processed: 900, total: 900, percent: 100, measured: true },
  timings: { ...JOB_RUNNING.timings, ended_ts: "2026-03-01T10:00:20+00:00", elapsed_s: 19.4 },
  result: {
    frames_processed: 900,
    frame_width: 1280,
    frame_height: 720,
    fps: 25,
    tracks: 12,
    observations: 5_400,
    levels: { Normal: 4_000, Suspicious: 1_200, Irregular: 200 },
    wall_s: 19.4,
  },
};

/** Any socket connect is inert: the console reads state from the REST snapshot. */
class SilentSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {}
  send() {}
  close() {}
}

function studioFetch(job: unknown, extra: (url: string) => Promise<Response> | null = (() => null)) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = extra(url);
    if (custom) return custom;
    if (url.includes("/jobs/job_1/cancel") && init?.method === "POST")
      return json({ job: { ...(job as object), state: "cancellation_requested" } });
    if (url.includes("/jobs/job_1")) return json({ job });
    if (url.includes("/sessions")) {
      return json({ total: 0, count: 0, limit: 100, offset: 0, sessions: [] });
    }
    if (url.includes("/sources")) return json(NO_SOURCES);
    if (url.includes("/system")) return json(SYSTEM);
    if (url.includes("/health")) return json({ status: "ok", version: "0.10.0", uptime_s: 10 });
    return json({ total: 0, count: 0, jobs: [] });
  });
}

function consolePanel(): HTMLElement {
  const panel = document.querySelector(".studio-console");
  if (!(panel instanceof HTMLElement)) throw new Error("console panel not rendered");
  return panel;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("video studio intake", () => {
  it("shows the upload surface and an honest idle console", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderStudio();

    expect(screen.getByLabelText("Video file")).toBeTruthy();
    expect(screen.getByText("No analysis in flight")).toBeTruthy();
    expect(screen.getByRole("button", { name: /choose file/i })).toBeTruthy();
  });

  it("rejects an unsupported file before anything is uploaded", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderStudio();

    const input = screen.getByLabelText("Video file") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
    });

    await waitFor(() => expect(screen.getByText("Upload rejected")).toBeTruthy());
    expect(screen.getByText(/Unsupported format/)).toBeTruthy();
  });

  it("blocks an empty clip with a specific reason", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderStudio();

    fireEvent.change(screen.getByLabelText("Video file"), {
      target: { files: [new File([], "empty.mp4", { type: "video/mp4" })] },
    });

    await waitFor(() => expect(screen.getByText(/nothing to analyse/)).toBeTruthy());
  });

  it("uses the current /system upload cap and extension list", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) return json({ status: "ok", version: "0.10.0", uptime_s: 10 });
      if (url.endsWith("/system")) return json(SYSTEM);
      if (url.endsWith("/sources")) return json(NO_SOURCES);
      if (url.includes("/sessions"))
        return json({ total: 0, count: 0, limit: 100, offset: 0, sessions: [] });
      return json({ total: 0, count: 0, jobs: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    expect(await screen.findByText(/4\.00 MB/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Video file"), {
      target: { files: [new File([new Uint8Array(5 * MB)], "big.mp4", { type: "video/mp4" })] },
    });
    expect(await screen.findByText(/current cap is 4\.0 MB/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Video file"), {
      target: { files: [new File(["clip"], "clip.mov", { type: "video/quicktime" })] },
    });
    expect(await screen.findByText(/Unsupported format "\.mov"/)).toBeTruthy();
  });
});

describe("video studio workflow", () => {
  it("reports only the intake, job and selection state it actually has", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderStudio();

    const flow = screen.getByRole("list", { name: "Studio workflow" });
    const steps = within(flow).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.getAttribute("data-state"))).toEqual([
      "idle",
      "idle",
      "idle",
    ]);
    expect(steps[0].textContent).toContain("Intake");
    expect(steps[1].textContent).toContain("Analysis");
    expect(steps[2].textContent).toContain("Investigation");
    expect(steps[1].textContent).toContain("No job started");
    expect(steps[2].textContent).toContain("No session selected");
    expect(within(flow).getAllByText("pending")).toHaveLength(3);
  });

  it("promotes the running job stage and real frame progress", async () => {
    window.sessionStorage.setItem(JOB_KEY, "job_1");
    vi.stubGlobal("fetch", studioFetch(JOB_RUNNING));
    vi.stubGlobal("WebSocket", SilentSocket);
    renderStudio();

    const bar = await within(consolePanel()).findByRole("progressbar", {
      name: "Frames processed",
    });
    expect(within(consolePanel()).getByText("Processing frames")).toBeTruthy();
    expect(bar.getAttribute("aria-valuenow")).toBe("250");
    expect(bar.getAttribute("aria-valuemax")).toBe("1000");
    expect(bar.getAttribute("aria-valuetext")).toBe("250 / 1,000 frames");
    expect(within(consolePanel()).getByText("25.0%")).toBeTruthy();

    const flow = screen.getByRole("list", { name: "Studio workflow" });
    const steps = within(flow).getAllByRole("listitem");
    expect(steps[0].getAttribute("data-state")).toBe("done");
    expect(steps[1].getAttribute("data-state")).toBe("active");
    expect(steps[1].getAttribute("aria-current")).toBe("step");
    expect(steps[1].textContent).toContain("in progress");
  });

  it("never invents a percentage when the container reports no total", async () => {
    window.sessionStorage.setItem(JOB_KEY, "job_1");
    vi.stubGlobal("fetch", studioFetch(JOB_UNMEASURED));
    vi.stubGlobal("WebSocket", SilentSocket);
    renderStudio();

    const bar = await within(consolePanel()).findByRole("progressbar", {
      name: "Frames processed",
    });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-valuetext")).toBe("180 frames · total unreported");
    expect(within(consolePanel()).getAllByText("—").length).toBeGreaterThan(0);
    expect(
      within(consolePanel()).getByText(/only the processed count is known/),
    ).toBeTruthy();
  });

  it("cancels a live run through the existing job API", async () => {
    window.sessionStorage.setItem(JOB_KEY, "job_1");
    const fetchMock = studioFetch(JOB_RUNNING);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", SilentSocket);
    renderStudio();

    const cancel = await within(consolePanel()).findByRole("button", {
      name: "Cancel analysis",
    });
    fireEvent.click(cancel);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/jobs/job_1/cancel"),
      );
      expect(call).toBeTruthy();
      expect((call?.[1] as RequestInit | undefined)?.method).toBe("POST");
    });
  });

  it("surfaces the completed result with its measured output", async () => {
    window.sessionStorage.setItem(JOB_KEY, "job_1");
    vi.stubGlobal("fetch", studioFetch(JOB_DONE));
    vi.stubGlobal("WebSocket", SilentSocket);
    renderStudio();

    expect(await screen.findByText("Analysis complete")).toBeTruthy();
    expect(consolePanel().textContent).toContain("900 frames");
    expect(consolePanel().textContent).toContain("12 tracks");
    expect(consolePanel().textContent).toContain("19s processing");
    expect(within(consolePanel()).getByRole("button", { name: "Open session" })).toBeTruthy();
  });
});

describe("video studio results", () => {
  function resultsFetch() {
    return studioFetch(null, (url) => {
      if (url.includes("/sessions/sess_alpha/summary")) return json(SUMMARY);
      if (url.includes("/sessions/sess_alpha/anomalies"))
        return json({
          total: 3,
          count: 0,
          limit: 200,
          offset: 0,
          severity: null,
          event_type: null,
          anomalies: [],
        });
      if (url.includes("/sessions/sess_alpha/media"))
        return json({
          session: "sess_alpha",
          available: false,
          preview_stride: null,
          preview_count: 0,
          source_resolution: null,
          frames: [],
          annotated_video: {
            available: false,
            reason: "No annotated video is produced by this engine build.",
          },
          notes: [],
        });
      if (url.includes("/sessions/sess_alpha"))
        return json({
          ...SESSION,
          artifacts: {
            retained: true,
            trajectories: true,
            structured_evidence: false,
            scene_calibration: true,
            preview_frames: 0,
          },
          media: { preview_frames: 0, available: false, preview_stride: null },
          labels: { labels: 0, evaluation_url: "/evaluation" },
          limitations: [],
        });
      if (url.includes("/sessions"))
        return json({ total: 1, count: 1, limit: 100, offset: 0, sessions: [SESSION] });
      return null;
    });
  }

  it("renders persisted aggregates as metric cards, not estimates", async () => {
    vi.stubGlobal("fetch", resultsFetch());
    vi.stubGlobal("WebSocket", SilentSocket);
    renderStudio("/video-studio?session=sess_alpha");

    const group = await screen.findByRole("group", { name: "Severity distribution" });
    const cards = group.querySelectorAll(".metric-card");
    expect(cards).toHaveLength(4);
    const text = group.textContent ?? "";
    expect(text).toContain("4,000");
    expect(text).toContain("1,200");
    expect(text).toContain("200");
    expect(text).toContain("12");
    expect(group.querySelectorAll('[data-state="ready"]')).toHaveLength(4);
    expect(screen.getByText("2m 05s")).toBeTruthy();
  });

  it("keeps the investigation in a scoped cinematic viewport", async () => {
    vi.stubGlobal("fetch", resultsFetch());
    vi.stubGlobal("WebSocket", SilentSocket);
    renderStudio("/video-studio?session=sess_alpha");

    await screen.findByRole("group", { name: "Severity distribution" });
    const viewport = document.querySelector(".studio-viewport");
    expect(viewport).toBeTruthy();
    expect(viewport?.querySelector(".investigator")).toBeTruthy();
    expect(
      within(viewport as HTMLElement).getByText("No preview frames are retained"),
    ).toBeTruthy();
    // The shared investigator styles are untouched outside this wrapper.
    expect(document.querySelector(".grid-2 .studio-viewport")).toBeNull();
  });
});
