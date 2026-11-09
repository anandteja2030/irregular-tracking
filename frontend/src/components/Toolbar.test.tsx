import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterBar, Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("groups its controls under an accessible name and keeps trailing actions", () => {
    render(
      <Toolbar label="Ledger tools" actions={<button type="button">Reset</button>}>
        <button type="button">Sort</button>
        <button type="button">Filter</button>
      </Toolbar>,
    );

    expect(screen.getByRole("group", { name: "Ledger tools" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  });
});

describe("FilterBar", () => {
  it("announces the result summary politely", () => {
    render(
      <FilterBar label="Tracks" summary="12 of 40 objects">
        <input aria-label="Search tracks" />
      </FilterBar>,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("12 of 40 objects");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("group", { name: "Tracks" })).toBeTruthy();
  });

  it("clears filters through a keyboard-reachable button and honours the disabled state", () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <FilterBar summary="3 matching" onClear={onClear}>
        <input aria-label="Search events" />
      </FilterBar>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(
      <FilterBar summary="All rows" onClear={onClear} clearDisabled>
        <input aria-label="Search events" />
      </FilterBar>,
    );

    expect(screen.getByRole("button", { name: "Clear filters" })).toHaveProperty("disabled", true);
  });

  it("marks an in-flight refetch without hiding the controls", () => {
    render(
      <FilterBar busy summary="Reading">
        <input aria-label="Search" />
      </FilterBar>,
    );

    expect(screen.getByRole("group", { name: "Filters" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByLabelText("Search")).toBeTruthy();
  });
});
