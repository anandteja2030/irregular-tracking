/** Dependency-free SVG chart primitives.
 *
 * Every chart here draws only values it was given: no smoothing, no invented
 * points and no normalisation that hides a missing sample. They are sized by
 * their container and expose an accessible label, so a screen reader gets the
 * measured summary even though the marks are visual.
 */
import type { ReactNode } from "react";
import type { Level, LevelCounts } from "../lib/types";
import { formatNumber } from "../lib/format";

export const LEVEL_COLOURS: Record<Level, string> = {
  Normal: "var(--chart-1)",
  Suspicious: "var(--chart-4)",
  Irregular: "var(--chart-5)",
};

export const LEVEL_ORDER: Level[] = ["Normal", "Suspicious", "Irregular"];

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

/** Ring chart with a measured total in the middle and a labelled legend. */
export function DonutChart({
  segments,
  centerValue,
  centerLabel,
  size = 164,
  thickness = 16,
  ariaLabel,
}: {
  segments: DonutSegment[];
  centerValue?: string;
  centerLabel?: string;
  size?: number;
  thickness?: number;
  ariaLabel?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="donut">
      <div className="donut__ring" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={
            ariaLabel ??
            segments.map((segment) => `${segment.label}: ${segment.value}`).join(", ")
          }
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--chart-track)"
            strokeWidth={thickness}
          />
          {total > 0 &&
            segments.map((segment) => {
              const value = Math.max(0, segment.value);
              const length = (value / total) * circumference;
              const dash = `${length} ${Math.max(0, circumference - length)}`;
              const element = (
                <circle
                  key={segment.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={segment.color}
                  strokeWidth={thickness}
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  strokeLinecap={length > 1 ? "butt" : "round"}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                >
                  <title>{`${segment.label}: ${formatNumber(value)}`}</title>
                </circle>
              );
              offset += length;
              return element;
            })}
        </svg>
        <div className="donut__center">
          <span className="donut__value mono">{centerValue ?? formatNumber(total)}</span>
          {centerLabel && <span className="donut__label">{centerLabel}</span>}
        </div>
      </div>
      <ul className="donut__legend">
        {segments.map((segment) => {
          const share = total > 0 ? (segment.value / total) * 100 : null;
          return (
            <li key={segment.label}>
              <span className="donut__swatch" style={{ background: segment.color }} />
              <span className="donut__legend-label">{segment.label}</span>
              <span className="donut__legend-value mono">
                {formatNumber(segment.value)}
                <span className="dim">
                  {share === null ? "" : ` · ${share.toFixed(0)}%`}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LevelDonut({
  levels,
  centerLabel = "observations",
  size,
}: {
  levels: LevelCounts;
  centerLabel?: string;
  size?: number;
}) {
  const total = LEVEL_ORDER.reduce((sum, level) => sum + (levels[level] ?? 0), 0);
  return (
    <DonutChart
      size={size}
      centerValue={formatNumber(total)}
      centerLabel={centerLabel}
      ariaLabel={LEVEL_ORDER.map((level) => `${level}: ${formatNumber(levels[level] ?? 0)}`).join(", ")}
      segments={LEVEL_ORDER.map((level) => ({
        label: level,
        value: levels[level] ?? 0,
        color: LEVEL_COLOURS[level],
      }))}
    />
  );
}

/** One 100% bar whose segments are the measured level shares. */
export function StackedLevelBar({
  levels,
  height = 10,
  showEmpty = true,
}: {
  levels: LevelCounts;
  height?: number;
  showEmpty?: boolean;
}) {
  const total = LEVEL_ORDER.reduce((sum, level) => sum + (levels[level] ?? 0), 0);
  if (total <= 0 && !showEmpty) return null;
  return (
    <div
      className="stacked-levels"
      style={{ height }}
      role="img"
      aria-label={
        total > 0
          ? LEVEL_ORDER.map((level) => `${level} ${formatNumber(levels[level] ?? 0)}`).join(", ")
          : "No observations"
      }
    >
      {total > 0 ? (
        LEVEL_ORDER.map((level) => {
          const value = levels[level] ?? 0;
          if (value <= 0) return null;
          return (
            <span
              key={level}
              className={`stacked-levels__segment level-fill--${level.toLowerCase()}`}
              style={{ width: `${(value / total) * 100}%` }}
              title={`${level}: ${formatNumber(value)}`}
            />
          );
        })
      ) : (
        <span className="stacked-levels__empty" />
      )}
    </div>
  );
}

export interface BarRow {
  label: string;
  value: number;
  color?: string;
  hint?: string;
  key?: string;
}

/** Horizontal bars with a label, a measured track and a numeric value. */
export function BarList({
  rows,
  max,
  formatValue = (value: number) => formatNumber(value),
  emptyLabel = "No measured values",
  ariaLabel,
}: {
  rows: BarRow[];
  max?: number;
  formatValue?: (value: number) => string;
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const ceiling = max ?? Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) {
    return <p className="chart-empty">{emptyLabel}</p>;
  }
  return (
    <ul className="bar-list" aria-label={ariaLabel}>
      {rows.map((row, index) => (
        <li className="bar-list__row" key={row.key ?? `${row.label}-${index}`}>
          <span className="bar-list__label" title={row.label}>
            {row.label}
          </span>
          <span className="bar-list__track">
            <span
              className="bar-list__fill"
              style={{
                width: `${Math.max(1.5, Math.min(1, row.value / ceiling) * 100)}%`,
                background: row.color ?? "var(--chart-1)",
              }}
            />
          </span>
          <span className="bar-list__value mono">{formatValue(row.value)}</span>
          {row.hint && <span className="bar-list__hint">{row.hint}</span>}
        </li>
      ))}
    </ul>
  );
}

export interface ChartBin {
  label: string;
  value: number;
}

/** Column chart for a histogram or a small categorical series. */
export function ColumnChart({
  bins,
  height = 128,
  color = "var(--chart-1)",
  ariaLabel,
  valueFormat = (value: number) => formatNumber(value),
}: {
  bins: ChartBin[];
  height?: number;
  color?: string;
  ariaLabel?: string;
  valueFormat?: (value: number) => string;
}) {
  const width = 320;
  const padX = 8;
  const padTop = 12;
  const padBottom = 20;
  const peak = Math.max(1, ...bins.map((bin) => bin.value));
  const usable = width - padX * 2;
  const slot = bins.length > 0 ? usable / bins.length : usable;
  const barWidth = Math.max(2, slot * 0.68);
  const plotHeight = height - padTop - padBottom;
  if (bins.length === 0) {
    return <p className="chart-empty">No measured values to chart</p>;
  }
  return (
    <div className="column-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          ariaLabel ?? bins.map((bin) => `${bin.label}: ${valueFormat(bin.value)}`).join(", ")
        }
      >
        {[0, 0.5, 1].map((share) => (
          <line
            key={share}
            x1={padX}
            x2={width - padX}
            y1={padTop + share * plotHeight}
            y2={padTop + share * plotHeight}
            className="column-chart__grid"
          />
        ))}
        {bins.map((bin, index) => {
          const barHeight = (bin.value / peak) * plotHeight;
          const x = padX + index * slot + (slot - barWidth) / 2;
          return (
            <g key={`${bin.label}-${index}`}>
              <rect
                x={x}
                y={padTop + plotHeight - barHeight}
                width={barWidth}
                height={Math.max(bin.value > 0 ? 1.5 : 0, barHeight)}
                rx={2}
                fill={color}
                opacity={bin.value > 0 ? 0.9 : 0}
              >
                <title>{`${bin.label}: ${valueFormat(bin.value)}`}</title>
              </rect>
            </g>
          );
        })}
        <text x={padX} y={height - 5} className="column-chart__axis">
          {bins[0].label}
        </text>
        <text
          x={width - padX}
          y={height - 5}
          textAnchor="end"
          className="column-chart__axis"
        >
          {bins[bins.length - 1].label}
        </text>
        <text x={padX} y={padTop - 3} className="column-chart__axis">
          {valueFormat(peak)}
        </text>
      </svg>
    </div>
  );
}

/** A single measured series; nulls break the line rather than reading as 0. */
export function Sparkline({
  values,
  height = 52,
  color = "var(--chart-1)",
  ariaLabel,
  fill = true,
}: {
  values: (number | null)[];
  height?: number;
  color?: string;
  ariaLabel?: string;
  fill?: boolean;
}) {
  const width = 240;
  const pad = 4;
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) {
    return <p className="chart-empty">No measured series</p>;
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  let path = "";
  let lastX: number | null = null;
  let firstX: number | null = null;
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      lastX = null;
      return;
    }
    const x = pad + index * step;
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    path += `${lastX === null ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
    if (firstX === null) firstX = x;
    lastX = x;
  });
  const area =
    fill && firstX !== null && lastX !== null
      ? `${path}L${(lastX as number).toFixed(1)} ${height - pad}L${(firstX as number).toFixed(1)} ${height - pad} Z`
      : "";
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={
        ariaLabel ?? `Series from ${formatNumber(min, 1)} to ${formatNumber(max, 1)}`
      }
    >
      {area && <path d={area} fill={color} opacity={0.12} />}
      <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
    </svg>
  );
}

export interface ScatterPoint {
  x: number;
  y: number;
  label: string;
  color: string;
  size?: number;
}

/** Scatter plot of two measured per-object values with level-coloured dots. */
export function ScatterPlot({
  points,
  xLabel,
  yLabel,
  height = 220,
  ariaLabel,
}: {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  height?: number;
  ariaLabel?: string;
}) {
  const width = 420;
  const padLeft = 38;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 30;
  if (points.length === 0) {
    return <p className="chart-empty">No per-object values to compare</p>;
  }
  const xMax = Math.max(1, ...points.map((point) => point.x));
  const yMax = Math.max(0.1, ...points.map((point) => point.y));
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const px = (value: number) => padLeft + (value / xMax) * plotW;
  const py = (value: number) => padTop + plotH - (value / yMax) * plotH;
  return (
    <div className="scatter">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          ariaLabel ??
          `${points.length} objects plotted by ${xLabel} and ${yLabel}`
        }
      >
        {[0, 0.25, 0.5, 0.75, 1].map((share) => (
          <line
            key={`grid-${share}`}
            x1={padLeft}
            x2={width - padRight}
            y1={padTop + share * plotH}
            y2={padTop + share * plotH}
            className="scatter__grid"
          />
        ))}
        <line
          x1={padLeft}
          x2={padLeft}
          y1={padTop}
          y2={padTop + plotH}
          className="scatter__axis"
        />
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={padTop + plotH}
          y2={padTop + plotH}
          className="scatter__axis"
        />
        {points.map((point, index) => (
          <circle
            key={`${point.label}-${index}`}
            cx={px(point.x)}
            cy={py(point.y)}
            r={point.size ?? 4.5}
            fill={point.color}
            fillOpacity={0.82}
            stroke="var(--surface-canvas)"
            strokeWidth={1}
          >
            <title>{`${point.label} — ${xLabel} ${point.x.toFixed(0)}, ${yLabel} ${point.y.toFixed(2)}`}</title>
          </circle>
        ))}
        <text x={padLeft - 4} y={padTop + 4} textAnchor="end" className="scatter__tick">
          {yMax.toFixed(2)}
        </text>
        <text
          x={padLeft - 4}
          y={padTop + plotH}
          textAnchor="end"
          className="scatter__tick"
        >
          0
        </text>
        <text x={padLeft} y={height - 8} className="scatter__tick">
          0
        </text>
        <text
          x={width - padRight}
          y={height - 8}
          textAnchor="end"
          className="scatter__tick"
        >
          {formatNumber(xMax, 0)}
        </text>
        <text x={width - padRight} y={padTop - 2} textAnchor="end" className="scatter__label">
          {yLabel} ↑
        </text>
        <text x={padLeft} y={height - 20} className="scatter__label">
          {xLabel} →
        </text>
      </svg>
    </div>
  );
}

/** A tiny measured path, used to show several objects at once. */
export function MiniTrail({
  points,
  color = "var(--chart-1)",
  width = 150,
  height = 64,
  label,
  box,
}: {
  points: [number, number][];
  color?: string;
  width?: number;
  height?: number;
  label?: string;
  box?: [number, number, number, number];
}) {
  const pad = 5;
  if (points.length === 0) {
    return <div className="mini-trail mini-trail--empty" aria-hidden="true" />;
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const sx = (value: number) => pad + ((value - minX) / spanX) * (width - pad * 2);
  const sy = (value: number) => pad + ((value - minY) / spanY) * (height - pad * 2);
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${sx(point[0]).toFixed(1)} ${sy(point[1]).toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  return (
    <svg
      className="mini-trail"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? `Path with ${points.length} measured points`}
    >
      <rect x={0.5} y={0.5} width={width - 1} height={height - 1} rx={6} className="mini-trail__frame" />
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeOpacity={0.85} />
      <circle cx={sx(points[0][0])} cy={sy(points[0][1])} r={2} fill={color} opacity={0.5} />
      <circle cx={sx(last[0])} cy={sy(last[1])} r={3} fill={color} />
      {box && (
        <text x={width - 6} y={height - 5} textAnchor="end" className="mini-trail__meta">
          {`${Math.round(box[2])}×${Math.round(box[3])}`}
        </text>
      )}
    </svg>
  );
}

export function ChartNote({ children }: { children: ReactNode }) {
  return <p className="chart-note">{children}</p>;
}

export function LevelLegend() {
  return (
    <span className="level-legend">
      {LEVEL_ORDER.map((level) => (
        <span key={level}>
          <i style={{ background: LEVEL_COLOURS[level] }} />
          {level}
        </span>
      ))}
    </span>
  );
}
