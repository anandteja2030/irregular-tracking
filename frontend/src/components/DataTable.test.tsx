import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "./DataTable";

interface Row {
  id: string;
  event: string;
  score: string;
}

const ROWS: Row[] = [
  { id: "e1", event: "Loitering", score: "0.82" },
  { id: "e2", event: "Direction change", score: "0.41" },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "event", header: "Event", cell: (row) => row.event },
  {
    id: "score",
    header: "Fused",
    align: "end",
    mono: true,
    hideBelow: "sm",
    cell: (row) => row.score,
  },
];

describe("DataTable", () => {
  it("renders a named table with typed columns and column modifiers", () => {
    render(<DataTable label="Anomaly events" columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} />);

    const table = screen.getByRole("table", { name: "Anomaly events" });
    expect(screen.getByRole("columnheader", { name: "Event" })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(table.querySelectorAll(".data-table__cell--mono")).toHaveLength(2);
    expect(table.querySelectorAll("thead .data-table__col--hide-sm")).toHaveLength(1);
    expect(table.querySelectorAll("tbody .data-table__col--hide-sm")).toHaveLength(2);
  });

  it("activates rows by mouse, Enter and Space", () => {
    const onRowActivate = vi.fn();
    render(
      <DataTable
        label="Anomaly events"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        onRowActivate={onRowActivate}
      />,
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].getAttribute("tabindex")).toBe("0");

    fireEvent.click(rows[0]);
    fireEvent.keyDown(rows[1], { key: "Enter" });
    fireEvent.keyDown(rows[1], { key: " " });

    expect(onRowActivate).toHaveBeenCalledTimes(3);
    expect(onRowActivate.mock.calls[0][0]).toEqual(ROWS[0]);
    expect(onRowActivate.mock.calls[1][0]).toEqual(ROWS[1]);
  });

  it("marks the active row without claiming grid semantics", () => {
    render(
      <DataTable
        label="Anomaly events"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        onRowActivate={() => undefined}
        selectedKey="e2"
      />,
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].getAttribute("aria-current")).toBeNull();
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(rows[1].className).toContain("is-active");
  });

  it("renders loading, empty and error states inside the table", () => {
    const { rerender, container } = render(
      <DataTable label="Anomaly events" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} loading />,
    );

    expect(screen.getByText("Loading Anomaly events")).toBeTruthy();
    expect(container.querySelectorAll(".data-table__skeleton").length).toBe(10);

    rerender(<DataTable label="Anomaly events" columns={COLUMNS} rows={[]} rowKey={(row) => row.id} />);
    expect(screen.getByText("No rows to display.")).toBeTruthy();

    rerender(
      <DataTable
        label="Anomaly events"
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        error="Ledger read failed."
      />,
    );
    expect(screen.getByText("Ledger read failed.").closest("td")?.className).toContain(
      "data-table__state--error",
    );
  });

  it("renders an optional footer alongside the rows", () => {
    render(
      <DataTable
        label="Anomaly events"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        density="compact"
        minWidth="640px"
        footer={<span>2 of 2 events</span>}
      />,
    );

    expect(screen.getByText("2 of 2 events")).toBeTruthy();
    expect(screen.getByRole("table").style.minWidth).toBe("640px");
  });
});
