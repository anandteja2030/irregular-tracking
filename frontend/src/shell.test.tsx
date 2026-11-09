import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "./App";
import { ApiHealthProvider } from "./app/ApiHealthProvider";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Vitest stubs CSS module imports, so read the stylesheets directly to assert on
// the responsive and motion contracts the shell promises.
const readSheet = (name: string) =>
  readFileSync(resolve(process.cwd(), "src/styles", name), "utf8");

const shellCss = readSheet("shell.css");
const componentsCss = readSheet("components.css");

const OFFLINE = () => Promise.reject(new TypeError("failed to fetch"));

function renderAt(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ApiHealthProvider>
        <AppRoutes />
      </ApiHealthProvider>
    </MemoryRouter>,
  );
}

/** The shell bar itself: page headers also render <header>, so query the
 * element rather than assuming a single banner landmark in the tree. */
function topBar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>(".topbar");
  if (!bar) throw new Error("top bar not rendered");
  return bar;
}

function openPaletteFromKeyboard() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  return screen.getByRole("dialog", { name: "Command palette" });
}

describe("shell navigation", () => {
  it("exposes every destination with an explicit accessible name", () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");

    expect(links).toHaveLength(7);
    const expected = [
      ["Command Overview", "/"],
      ["Video Studio", "/video-studio"],
      ["Track Explorer", "/tracks"],
      ["Anomaly Center", "/anomalies"],
      ["Scene Intelligence", "/scene"],
      ["Evaluation & Reports", "/evaluation"],
      ["System Settings", "/settings"],
    ] as const;

    expected.forEach(([name, href], index) => {
      // aria-label is what keeps the name intact once CSS folds the rail to icons.
      expect(links[index].getAttribute("aria-label")).toBe(name);
      expect(links[index].getAttribute("href")).toBe(href);
    });
  });

  it("marks the current surface and moves the marker after navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const overview = within(nav).getByRole("link", { name: "Command Overview" });
    expect(overview.getAttribute("aria-current")).toBe("page");

    fireEvent.click(within(nav).getByRole("link", { name: "Anomaly Center" }));

    await waitFor(() => {
      expect(
        within(nav).getByRole("link", { name: "Anomaly Center" }).getAttribute("aria-current"),
      ).toBe("page");
    });
    expect(overview.getAttribute("aria-current")).toBeNull();
  });

  it("keeps a named palette trigger in the top bar at every width", () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const banner = topBar();
    const trigger = within(banner).getByRole("button", { name: "Open command palette" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    // The visible word is decorative; the name must not depend on CSS hiding it.
    expect(trigger.getAttribute("aria-label")).toBe("Open command palette");
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("Meta+K Control+K");
  });

  it("labels the session switcher and exposes its loading state", () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const banner = topBar();
    const select = within(banner).getByLabelText("Active analysis session") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.disabled).toBe(true);
    expect(within(banner).getByText("Session")).toBeTruthy();
  });

  it("provides a skip link that targets the scrollable workspace", () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const skip = screen.getByRole("link", { name: "Skip to workspace" });
    expect(skip.getAttribute("href")).toBe("#workspace");

    const main = screen.getByRole("main");
    expect(main.id).toBe("workspace");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });
});

describe("shell stylesheet contract", () => {
  it("never hides the palette trigger at any width", () => {
    // Only the trigger's word and keycap may fold away; the button stays.
    expect(shellCss).not.toMatch(/\.palette-trigger\s*\{[^}]*display:\s*none/);
    expect(componentsCss).not.toMatch(/\.palette-trigger\s*\{[^}]*display:\s*none/);
  });

  it("owns the shell breakpoints in one place", () => {
    for (const width of ["1180px", "900px", "720px"]) {
      expect(shellCss).toContain(`max-width: ${width}`);
    }
  });

  it("avoids full-surface blur and the 90px ambient blur", () => {
    expect(shellCss).not.toMatch(/backdrop-filter\s*:/);
    expect(shellCss).not.toMatch(/blur\(90px\)/);
  });

  it("keeps 44px minimums on shell controls", () => {
    expect(shellCss).toMatch(/\.nav-item \{[^}]*min-height: 44px/);
    expect(shellCss).toContain("@media (pointer: coarse)");
    expect(componentsCss).toMatch(/\.palette__item \{[^}]*min-height: 46px/);
  });

  it("honours reduced motion for shell and palette motion", () => {
    expect(shellCss).toContain("prefers-reduced-motion: reduce");
    expect(componentsCss).toMatch(/prefers-reduced-motion: reduce[\s\S]*transition: none/);
  });
});

describe("command palette", () => {
  it("opens from the top-bar trigger and focuses the search field", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });

    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe("palette-results");
  });

  it("exposes the highlighted option through aria-activedescendant", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const dialog = openPaletteFromKeyboard();
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-overview");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-studio");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-overview");

    const selected = within(dialog)
      .getAllByRole("option")
      .filter((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("palette-option-overview");
  });

  it("activates the highlighted surface with Enter and closes", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const dialog = openPaletteFromKeyboard();
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Video Studio");
  });

  it("traps Tab inside the panel and keeps Escape inside the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const dialog = openPaletteFromKeyboard();
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });
    const close = within(dialog).getByRole("button", { name: "Close command palette" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("restores focus to the control that opened it", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const trigger = screen.getByRole("button", { name: "Open command palette" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("closes on backdrop press and matches typed queries", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    const { container } = renderAt("/");

    const dialog = openPaletteFromKeyboard();
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });

    fireEvent.change(input, { target: { value: "sett" } });
    const options = within(dialog).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("System Settings");

    const overlay = container.querySelector(".overlay") as HTMLElement;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("announces an empty result set without leaving a dangling cursor", async () => {
    vi.stubGlobal("fetch", vi.fn(OFFLINE));
    renderAt("/");

    const dialog = openPaletteFromKeyboard();
    const input = within(dialog).getByRole("combobox", { name: "Search surfaces" });

    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(within(dialog).getByText("No surface matches that query.")).toBeTruthy();
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    // Still open: Enter on an empty list must not navigate or close.
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });
});
