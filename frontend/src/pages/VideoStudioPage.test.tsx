import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../App";
import { ApiHealthProvider } from "../app/ApiHealthProvider";

const OFFLINE = () => Promise.reject(new TypeError("failed to fetch"));

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
});
