import type { ReactNode } from "react";

export interface ToolbarProps {
  /** Accessible name for the group of controls. */
  label: string;
  children: ReactNode;
  /** Trailing controls, pushed to the far edge. */
  actions?: ReactNode;
  className?: string;
}

/**
 * A horizontal cluster of related controls. It is a labelled group rather than
 * an ARIA toolbar, because it stays in the normal tab order and needs no
 * roving focus to be keyboard operable.
 */
export function Toolbar({ label, children, actions, className = "" }: ToolbarProps) {
  return (
    <div className={`toolbar ${className}`.trim()} role="group" aria-label={label}>
      <div className="toolbar__cluster">{children}</div>
      {actions && <div className="toolbar__actions">{actions}</div>}
    </div>
  );
}

export interface FilterBarProps {
  label?: string;
  children: ReactNode;
  /** Live result readout, for example "12 of 40 objects". */
  summary?: ReactNode;
  onClear?: () => void;
  clearLabel?: string;
  clearDisabled?: boolean;
  /** Marks an in-flight refetch without hiding the current filters. */
  busy?: boolean;
  className?: string;
}

/** Filter controls plus a polite result summary and an optional reset action. */
export function FilterBar({
  label = "Filters",
  children,
  summary,
  onClear,
  clearLabel = "Clear filters",
  clearDisabled = false,
  busy = false,
  className = "",
}: FilterBarProps) {
  return (
    <div
      className={`filter-bar ${className}`.trim()}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
    >
      <div className="filter-bar__fields">{children}</div>
      {(summary || onClear) && (
        <div className="filter-bar__actions">
          {summary && (
            <p className="filter-bar__summary mono" role="status" aria-live="polite">
              {summary}
            </p>
          )}
          {onClear && (
            <button
              type="button"
              className="btn btn--quiet filter-bar__clear"
              onClick={onClear}
              disabled={clearDisabled}
            >
              {clearLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
