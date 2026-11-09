import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./StatusPill";

describe("StatusPill", () => {
  it("renders a labelled pill with its tone and dot", () => {
    const { container } = render(
      <StatusPill tone="ok" dot>
        Live
      </StatusPill>,
    );

    const pill = container.querySelector(".status-pill") as HTMLElement;
    expect(pill.getAttribute("data-tone")).toBe("ok");
    expect(pill.textContent).toBe("Live");
    expect(container.querySelector(".status-pill__dot")).toBeTruthy();
  });

  it("is silent by default and becomes a status region only when asked", () => {
    const { rerender } = render(<StatusPill tone="warn">Busy</StatusPill>);
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <StatusPill tone="warn" live>
        Busy
      </StatusPill>,
    );
    expect(screen.getByRole("status").textContent).toBe("Busy");
  });

  it("keeps decorative icons out of the accessible name and supports a compact size", () => {
    const { container } = render(
      <StatusPill icon={<svg data-testid="glyph" />} size="sm" title="Engine reachable">
        Online
      </StatusPill>,
    );

    const icon = container.querySelector(".status-pill__icon") as HTMLElement;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Online")).toBeTruthy();
    expect(container.querySelector(".status-pill")?.className).toContain("status-pill--sm");
    expect((container.querySelector(".status-pill") as HTMLElement).getAttribute("title")).toBe(
      "Engine reachable",
    );
  });
});
