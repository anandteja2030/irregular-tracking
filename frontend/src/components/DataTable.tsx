import type { ReactNode } from "react";

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: "start" | "center" | "end";
  /** Fixed/min column width, for example "120px" or "18ch". */
  width?: string;
  mono?: boolean;
  /** Drops the column below a breakpoint instead of squeezing the table. */
  hideBelow?: "md" | "sm";
}

export interface DataTableProps<T> {
  /** Names the table and its scroll region. */
  label: string;
  /** Optional longer caption for assistive technology. */
  caption?: string;
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** Makes rows focusable and activates them with Enter or Space. */
  onRowActivate?: (row: T, index: number) => void;
  /** Key of the active row; exposed through aria-current. */
  selectedKey?: string | number | null;
  loading?: boolean;
  loadingRows?: number;
  empty?: ReactNode;
  error?: ReactNode;
  density?: "default" | "compact";
  footer?: ReactNode;
  minWidth?: string;
  className?: string;
}

const ALIGN_CLASS = {
  start: "",
  center: "data-table__cell--center",
  end: "data-table__cell--end",
} as const;

/**
 * Typed, presentation-only table. Sorting, filtering and data loading stay
 * with the caller; this primitive owns structure, states and keyboard access.
 */
export function DataTable<T>({
  label,
  caption,
  columns,
  rows,
  rowKey,
  onRowActivate,
  selectedKey = null,
  loading = false,
  loadingRows = 5,
  empty,
  error,
  density = "default",
  footer,
  minWidth,
  className = "",
}: DataTableProps<T>) {
  const interactive = Boolean(onRowActivate);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>, row: T, index: number) {
    if (!onRowActivate) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      onRowActivate(row, index);
    }
  }

  let body: ReactNode;
  if (loading) {
    body = (
      <>
        <tr className="data-table__status">
          <td colSpan={columns.length}>
            <span className="sr-only">Loading {label}</span>
          </td>
        </tr>
        {Array.from({ length: loadingRows }, (_, rowIndex) => (
          <tr className="data-table__skeleton-row" key={`skeleton-${rowIndex}`} aria-hidden="true">
            {columns.map((column, columnIndex) => (
              <td key={column.id}>
                <span
                  className="data-table__skeleton"
                  style={{ width: `${72 - ((rowIndex + columnIndex) % 3) * 12}%` }}
                />
              </td>
            ))}
          </tr>
        ))}
      </>
    );
  } else if (error) {
    body = (
      <tr>
        <td className="data-table__state data-table__state--error" colSpan={columns.length}>
          {error}
        </td>
      </tr>
    );
  } else if (rows.length === 0) {
    body = (
      <tr>
        <td className="data-table__state" colSpan={columns.length}>
          {empty ?? <p>No rows to display.</p>}
        </td>
      </tr>
    );
  } else {
    body = rows.map((row, index) => {
      const key = rowKey(row, index);
      const active = selectedKey !== null && selectedKey === key;
      return (
        <tr
          key={key}
          className={`${interactive ? "is-selectable" : ""} ${active ? "is-active" : ""}`.trim()}
          tabIndex={interactive ? 0 : undefined}
          aria-current={active ? "true" : undefined}
          onClick={interactive ? () => onRowActivate?.(row, index) : undefined}
          onKeyDown={interactive ? (event) => handleKeyDown(event, row, index) : undefined}
        >
          {columns.map((column) => (
            <td
              key={column.id}
              className={[
                ALIGN_CLASS[column.align ?? "start"],
                column.mono ? "data-table__cell--mono" : "",
                column.hideBelow ? `data-table__col--hide-${column.hideBelow}` : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {column.cell(row, index)}
            </td>
          ))}
        </tr>
      );
    });
  }

  return (
    <div
      className={`data-table ${density === "compact" ? "data-table--compact" : ""} ${className}`.trim()}
    >
      <div
        className="data-table__scroll"
        role="region"
        aria-label={`${label} table`}
        tabIndex={0}
      >
        <table className="data-table__table" aria-busy={loading || undefined} style={{ minWidth }}>
          <caption className="sr-only">{caption ?? label}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  className={[
                    ALIGN_CLASS[column.align ?? "start"],
                    column.hideBelow ? `data-table__col--hide-${column.hideBelow}` : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {footer && <div className="data-table__footer">{footer}</div>}
    </div>
  );
}
