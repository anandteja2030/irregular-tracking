import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "./ApiHealthProvider";

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

describe("session selection", () => {
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
