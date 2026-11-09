import type { ReactNode } from "react";

/** Colour role for a metric. `neutral` keeps the value in primary ink. */
export type MetricTone = "neutral" | "accent" | "accent-2" | "ok" | "warn" | "bad";

export interface MetricCardProps {
  /** Always rendered: the metric keeps its identity while loading or empty. */
  label: string;
  value?: ReactNode;
  unit?: string;
  hint?: string;
  tone?: MetricTone;
  /** Optional 0–1 fill under the value; the bar is decorative. */
  meter?: number | null;
  loading?: boolean;
  /** When set, the card reports an unavailable measurement instead of a zero. */
  error?: string | null;
  className?: string;
}

const EMPTY = "—";

/**
 * A single measured value on a raised surface. Missing data is never rendered
 * as a zero: an absent value shows an em dash, a failure shows the reason.
 */
export function MetricCard({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
  meter,
  loading = false,
  error = null,
  className = "",
}: MetricCardProps) {
  const empty = value === undefined || value === null || value === "";
  const state = error ? "error" : loading ? "loading" : empty ? "empty" : "ready";
  const meterValue =
    typeof meter === "number" && Number.isFinite(meter)
      ? Math.min(1, Math.max(0, meter))
      : null;

  return (
    <div
      className={`metric-card ${className}`.trim()}
      data-tone={tone}
      data-state={state}
      aria-busy={loading || undefined}
    >
      <span className="metric-card__label mono">{label}</span>

      {state === "loading" ? (
        <span className="metric-card__skeleton" aria-hidden="true" />
      ) : (
        <span className="metric-card__value mono">
          {state === "ready" ? value : EMPTY}
          {state === "ready" && unit ? <span className="metric-card__unit">{unit}</span> : null}
        </span>
      )}

      {state === "error" ? (
        <span className="metric-card__error-text">{error}</span>
      ) : hint ? (
        <span className="metric-card__hint">{hint}</span>
      ) : null}

      {state === "ready" && meterValue !== null && (
        <span
          className="metric-card__meter"
          aria-hidden="true"
          style={{ width: `${meterValue * 100}%` }}
        />
      )}
    </div>
  );
}

export interface MetricGridProps {
  children: ReactNode;
  /** Fixed column count; omit to fit as many cards as the width allows. */
  columns?: 2 | 3 | 4 | 5 | 6;
  /** Group label announced by assistive technology. */
  label?: string;
  className?: string;
}

export function MetricGrid({ children, columns, label, className = "" }: MetricGridProps) {
  return (
    <div
      className={`metric-card-grid ${className}`.trim()}
      data-columns={columns}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
