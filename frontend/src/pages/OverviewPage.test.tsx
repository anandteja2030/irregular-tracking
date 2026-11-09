import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const OFFLINE = () => Promise.reject(new TypeError("failed to fetch"));

function json(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const HEALTH = { status: "ok", version: "0.10.0", uptime_s: 3_900 };

const SYSTEM = {
  version: "0.10.0",
  python: "3.12.3",
  python_implementation: "CPython",
  platform: "Linux-test",
  packages: { numpy: "2.0.0", torch: "2.4.0" },
  storage: {
    db: { path: "/data/sessions.db", exists: true, bytes: 2_048 },
    samples: { path: "/samples", exists: true, videos: 3, bytes: 0 },
    output: { path: "/output", exists: true, files: 3, bytes: 0 },
  },
  runtime: { executable: "/usr/bin/python3", pid: 4_242 },
};

const SESSION_A = {
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

const SESSION_B = {
  ...SESSION_A,
  session: "sess_beta",
  source: { label: "clip_b.mp4", kind: "sample", synthetic: true },
  counts: { ...SESSION_A.counts, tracks: 4, anomalies: 0 },
};

const SOURCES = {
  directory: "/srv/samples",
  count: 3,
  valid: 2,
  invalid: 1,
  sources: [
    {
      name: "clip_a.mp4",
      path: "/srv/samples/clip_a.mp4",
      bytes: 1_048_576,
      kind: "video",
      synthetic: false,
      valid: true,
      error: null,
      fps: 25,
      frames: 900,
      width: 1280,
      height: 720,
      duration_s: 36,
    },
    {
      name: "clip_b.mp4",
      path: "/srv/samples/clip_b.mp4",
      bytes: 2_097_152,
      kind: "video",
      synthetic: true,
      valid: true,
      error: null,
      fps: 30,
      frames: 300,
      width: 640,
      height: 360,
      duration_s: 10,
    },
  ],
};

function onlineFetch() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/health")) return json(HEALTH);
    if (url.includes("/system")) return json(SYSTEM);
    if (url.includes("/sources")) return json(SOURCES);
    if (url.includes("/sessions"))
      return json({ total: 2, count: 2, limit: 100, offset: 0, sessions: [SESSION_A, SESSION_B] });
    return json({ total: 0, count: 0, jobs: [] });
  });
}

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

function vitalsGroup() {
  return screen.getByRole("group", { name: "System vitals" });
}

/** The card element for one vitals label. */
function vitalsCard(label: string): HTMLElement {
  const labelElement = within(vitalsGroup()).getByText(label);
  const card = labelElement.closest(".metric-card");
  if (!(card instanceof HTMLElement)) throw new Error(`no metric card for ${label}`);
  return card;
}

describe("command overview", () => {
  it("renders the engine deck from measured health", async () => {
    vi.stubGlobal("fetch", onlineFetch());
    renderOverview();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Engine reachable");
    });
    expect(screen.getByText("Operational")).toBeTruthy();
    // Uptime is rendered once in the deck caption and once as a measurement.
    expect(screen.getAllByText("1h 5m").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("v0.10.0")).toBeTruthy();
  });

  it("keeps every vitals measurement and hint intact", async () => {
    vi.stubGlobal("fetch", onlineFetch());
    renderOverview();

    await waitFor(() => expect(vitalsGroup().querySelectorAll(".metric-card")).toHaveLength(5));

    expect(vitalsCard("Uptime").textContent).toContain("1h 5m");
    expect(vitalsCard("Uptime").textContent).toContain("current process");
    expect(vitalsCard("Python").textContent).toContain("3.12.3");
    expect(vitalsCard("Python").textContent).toContain("CPython");
    expect(vitalsCard("Session store").textContent).toContain("2.00 KB");
    expect(vitalsCard("Session store").textContent).toContain("SQLite present");
    expect(vitalsCard("Sample sources").textContent).toContain("2");
    expect(vitalsCard("Sample sources").textContent).toContain("of 3");
    expect(vitalsCard("Sample sources").textContent).toContain("decodable clips");
    expect(vitalsCard("Sessions").textContent).toContain("2");
    expect(vitalsCard("Sessions").textContent).toContain("persisted runs");
    expect(vitalsGroup().querySelectorAll('[data-state="ready"]')).toHaveLength(5);
  });

  it("derives surface readiness from the selected session", async () => {
    vi.stubGlobal("fetch", onlineFetch());
    renderOverview();

    expect(await screen.findByText("12 tracks")).toBeTruthy();
    expect(screen.getByText("3 events")).toBeTruthy();
    expect(screen.getByText("No ground truth")).toBeTruthy();
    expect(screen.getByText("Sources linked")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("Config live")).toBeTruthy();
  });

  it("lists persisted sessions and real runtime facts", async () => {
    vi.stubGlobal("fetch", onlineFetch());
    renderOverview();

    await waitFor(() => {
      const sessionLinks = screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("href")?.startsWith("/tracks?session="));
      expect(sessionLinks).toHaveLength(2);
    });

    // Runtime facts and package inventory both come from /system, not fixtures.
    expect(screen.getByText("4242")).toBeTruthy();
    expect(screen.getByText("Linux-test")).toBeTruthy();
    expect(screen.getByText("numpy")).toBeTruthy();
    expect(screen.getByText("2 persisted runs")).toBeTruthy();
  });

  it("reloads the measured sources when refreshed", async () => {
    const fetchMock = onlineFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderOverview();

    await screen.findAllByText("1h 5m");
    const healthCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/health")).length;
    const before = healthCalls();

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(healthCalls()).toBeGreaterThan(before));
  });

  it("shows no invented readings when the engine is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderOverview();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Engine unreachable");
    });

    expect(vitalsGroup().querySelectorAll('[data-state="ready"]')).toHaveLength(0);
    for (const label of ["Uptime", "Python", "Session store", "Sample sources", "Sessions"]) {
      expect(vitalsCard(label).textContent).toContain("—");
    }
    expect(screen.getByText(/Runtime readings stay empty/)).toBeTruthy();
    // Nothing pretends to be a zero measurement.
    expect(within(vitalsGroup()).queryByText("0")).toBeNull();
  });
});
