import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricCard, MetricGrid } from "./MetricCard";

describe("MetricCard", () => {
  it("renders a measured value with its unit, hint, tone and meter", () => {
    const { container } = render(
      <MetricCard
        label="Observations"
        value="1,248"
        unit="obs"
        hint="persisted"
        tone="ok"
        meter={0.42}
      />,
    );

    expect(screen.getByText("Observations")).toBeTruthy();
    expect(screen.getByText("1,248")).toBeTruthy();
    expect(screen.getByText("obs")).toBeTruthy();
    expect(screen.getByText("persisted")).toBeTruthy();

    const card = container.querySelector(".metric-card") as HTMLElement;
    expect(card.getAttribute("data-tone")).toBe("ok");
    expect(card.getAttribute("data-state")).toBe("ready");

    const meter = container.querySelector(".metric-card__meter") as HTMLElement;
    expect(meter.style.width).toBe("42%");
  });

  it("never invents a zero for a missing or failed measurement", () => {
    const { container, rerender } = render(<MetricCard label="Fused score" />);

    expect((container.querySelector(".metric-card") as HTMLElement).getAttribute("data-state")).toBe(
      "empty",
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(container.querySelector(".metric-card__meter")).toBeNull();

    rerender(<MetricCard label="Fused score" error="Session summary unavailable" />);

    expect((container.querySelector(".metric-card") as HTMLElement).getAttribute("data-state")).toBe(
      "error",
    );
    expect(screen.getByText("Session summary unavailable")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("keeps the label and hides the value while loading", () => {
    const { container } = render(<MetricCard label="Tracks" value="12" loading />);
    const card = container.querySelector(".metric-card") as HTMLElement;

    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Tracks")).toBeTruthy();
    expect(screen.queryByText("12")).toBeNull();
    expect(container.querySelector(".metric-card__skeleton")).toBeTruthy();
  });

  it("clamps the meter and exposes a labelled grid", () => {
    const { container } = render(
      <MetricGrid label="Session metrics" columns={3}>
        <MetricCard label="Objects" value="1" meter={1.8} />
        <MetricCard label="Events" value="2" meter={-2} />
      </MetricGrid>,
    );

    expect(screen.getByRole("group", { name: "Session metrics" })).toBeTruthy();
    expect(
      (container.querySelector(".metric-card-grid") as HTMLElement).getAttribute("data-columns"),
    ).toBe("3");

    const meters = container.querySelectorAll<HTMLElement>(".metric-card__meter");
    expect(meters[0].style.width).toBe("100%");
    expect(meters[1].style.width).toBe("0%");
  });
});
