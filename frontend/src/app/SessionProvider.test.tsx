import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "./ApiHealthProvider";
import { SessionProvider, useSession } from "./SessionProvider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function session(sessionId: string, label: string) {
  return {
    session: sessionId,
    source: { label, kind: "sample", synthetic: true },
    processing: {
      frames_processed: 30,
      width: 1280,
      height: 720,
      fps: 30,
      wall_s: 1.4,
      max_frames: 30,
      processing_fps: 21,
      video_duration_s: 1,
      started_ts: null,
      ended_ts: null,
      run_stats_available: true,
    },
    counts: {
      observations: 30,
      tracks: 2,
      anomalies: 3,
      levels: { Normal: 27, Suspicious: 3, Irregular: 0 },
      labels: 0,
    },
    frame_range: { first: 0, last: 29 },
    timestamps: { first_ts: null, last_ts: null },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function SelectionHarness() {
  const { select, reload, selectedId } = useSession();
  return (
    <>
      <button type="button" onClick={() => select("run_b")}>
        Select run B
      </button>
      <button type="button" onClick={reload}>
        Reload sessions
      </button>
      <output data-testid="selected">{selectedId ?? "none"}</output>
      <LocationProbe />
    </>
  );
}

const SESSIONS = [session("run_a", "sample: a.mp4"), session("run_b", "upload: b.mp4")];

function mockSessions() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/sessions?")) {
      return jsonResponse({
        total: 2,
        count: 2,
        limit: 100,
        offset: 0,
        sessions: SESSIONS,
      });
    }
    if (url.includes("/tracks")) {
      return jsonResponse({ total: 0, count: 0, limit: 200, offset: 0, tracks: [] });
    }
    return jsonResponse({ error: { code: "http_404", message: "Not Found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("session selection", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("lists persisted runs and refetches the workspace for the chosen one", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions?")) {
        return jsonResponse({
          total: 2,
          count: 2,
          limit: 100,
          offset: 0,
          sessions: [session("run_a", "sample: a.mp4"), session("run_b", "upload: b.mp4")],
        });
      }
      if (/\/sessions\/[^/]+\/tracks$/.test(url)) {
        return jsonResponse({ total: 0, count: 0, limit: 60, offset: 0, tracks: [] });
      }
      return jsonResponse({ error: { code: "http_404", message: "Not Found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/tracks"]}>
        <ApiHealthProvider>
          <AppRoutes />
        </ApiHealthProvider>
      </MemoryRouter>,
    );

    const select = (await screen.findByLabelText("Active analysis session")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.value).toBe("run_a");

    fireEvent.change(select, { target: { value: "run_b" } });

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.startsWith("/api/v1/sessions/run_b/tracks"))).toBe(true);
    });
  });

  it("drops track, event and frame parameters when the session changes", async () => {
    mockSessions();
    render(
      <MemoryRouter
        initialEntries={["/tracks?session=run_a&track=3&event=99&frame=18"]}
      >
        <ApiHealthProvider>
          <AppRoutes />
          <LocationProbe />
        </ApiHealthProvider>
      </MemoryRouter>,
    );

    const select = (await screen.findByLabelText("Active analysis session")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: "run_b" } });

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("?session=run_b"),
    );
  });

  it("keeps a just-completed selection while the session list catches up", async () => {
    const sessions = [session("run_a", "sample: a.mp4")];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions?")) {
        return jsonResponse({
          total: sessions.length,
          count: sessions.length,
          limit: 100,
          offset: 0,
          sessions,
        });
      }
      if (url.includes("/tracks")) {
        return jsonResponse({ total: 0, count: 0, limit: 200, offset: 0, tracks: [] });
      }
      return jsonResponse({ error: { code: "http_404", message: "Not Found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/tracks?session=run_a"]}>
        <SessionProvider>
          <SelectionHarness />
        </SessionProvider>
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "Select run B" });
    fireEvent.click(screen.getByRole("button", { name: "Select run B" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("?session=run_b"),
    );

    sessions.push(session("run_b", "upload: b.mp4"));
    fireEvent.click(screen.getByRole("button", { name: "Reload sessions" }));
    await waitFor(() =>
      expect(screen.getByTestId("selected").textContent).toBe("run_b"),
    );
    expect(screen.getByTestId("location").textContent).toBe("?session=run_b");
  });

  it("repairs an unknown session link to the selected fallback", async () => {
    mockSessions();
    render(
      <MemoryRouter
        initialEntries={["/tracks?session=missing&track=3&event=99&frame=18"]}
      >
        <ApiHealthProvider>
          <AppRoutes />
          <LocationProbe />
        </ApiHealthProvider>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("?session=run_a"),
    );
    expect(
      (screen.getByLabelText("Active analysis session") as HTMLSelectElement).value,
    ).toBe("run_a");
  });

  it("keeps the empty-state copy when the store has no runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/sessions?")
          ? jsonResponse({ total: 0, count: 0, limit: 100, offset: 0, sessions: [] })
          : jsonResponse({ error: { code: "http_404", message: "Not Found" } }, 404),
      ),
    );

    render(
      <MemoryRouter initialEntries={["/tracks"]}>
        <ApiHealthProvider>
          <AppRoutes />
        </ApiHealthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("No persisted session to explore")).toBeTruthy();
  });
});
