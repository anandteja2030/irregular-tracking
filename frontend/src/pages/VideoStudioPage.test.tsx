import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const OFFLINE = () => Promise.reject(new TypeError("failed to fetch"));
const MB = 1024 * 1024;

function json(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function renderStudio() {
  return render(
    <MemoryRouter initialEntries={["/video-studio"]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

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
      if (url.endsWith("/system")) {
        return json({
          version: "0.10.0",
          python: "3.12.3",
          python_implementation: "CPython",
          platform: "Linux-test",
          packages: {},
          storage: {
            db: { path: "/db", exists: true, bytes: 0 },
            samples: { path: "/samples", exists: true, videos: 0, bytes: 0 },
            output: { path: "/output", exists: true, files: 0, bytes: 0 },
          },
          runtime: { executable: "/python", pid: 1 },
          limits: { max_upload_bytes: 4 * MB, upload_ttl_s: 3600, max_workers: 2, max_frames_cap: 100 },
          formats: { extensions: [".mp4"], mime_types: ["video/mp4"] },
          configuration: { writable: true, persistence: "process_local", resets_on_restart: true, paths_read_only: true },
        });
      }
      if (url.endsWith("/sources")) {
        return json({ directory: "/samples", count: 0, valid: 0, invalid: 0, sources: [] });
      }
      if (url.endsWith("/sessions")) return json({ total: 0, count: 0, limit: 8, offset: 0, sessions: [] });
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
