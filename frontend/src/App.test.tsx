import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "./App";
import { ApiHealthProvider } from "./app/ApiHealthProvider";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

const OFFLINE = () => Promise.reject(new TypeError("failed to fetch"));

describe("application shell", () => {
  it("renders every workspace in the rail", () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeTruthy();
    for (const label of [
      "Command Overview",
      "Video Studio",
      "Track Explorer",
      "Anomaly Center",
      "Scene Intelligence",
      "Evaluation & Reports",
      "System Settings",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("degrades to an offline link state without inventing metrics", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    await waitFor(() => {
      expect(screen.getByText("Engine offline")).toBeTruthy();
    });
    const hero = screen.getByRole("heading", { level: 2 });
    expect(hero.textContent).toBe("Engine unreachable");
  });

  it("navigates between surfaces", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const studioLink = screen
      .getAllByRole("link")
      .find((element) => element.getAttribute("href") === "/video-studio");
    expect(studioLink).toBeTruthy();
    fireEvent.click(studioLink as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Video Studio");
    });
  });

  it("opens the command palette from the keyboard", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
    });
  });

  it("renders the unmapped-route surface", () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/does-not-exist");
    expect(screen.getByText("Nothing at this address")).toBeTruthy();
  });
});
