import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionHeader } from "./SectionHeader";

describe("SectionHeader", () => {
  it("renders a second-level heading with qualifier, description and actions", () => {
    render(
      <SectionHeader
        id="signals-title"
        title="Signals"
        meta="Live sources"
        description="Read from the running engine, never estimated."
        actions={<button type="button">Refresh</button>}
      />,
    );

    const heading = screen.getByRole("heading", { name: "Signals", level: 2 });
    expect(heading.getAttribute("id")).toBe("signals-title");
    expect(screen.getByText("Live sources")).toBeTruthy();
    expect(screen.getByText(/never estimated/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("supports a lower heading level for nested sections", () => {
    render(<SectionHeader title="Fusion bands" level={3} />);

    expect(screen.getByRole("heading", { name: "Fusion bands", level: 3 })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});
