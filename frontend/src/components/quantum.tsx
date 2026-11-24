/** Quantum intelligence layer.
 *
 * Shared surfaces used by every dashboard section: a measured hero, a
 * multi-object trajectory constellation, a roster that names every tracked
 * object, and an explanation of what Normal / Suspicious / Irregular mean in
 * this engine. Every number and coordinate comes from props; nothing here
 * invents a point, a score or a level.
 */
import type { ReactNode } from "react";
import type { Level, LevelCounts } from "../lib/types";
import { formatNumber } from "../lib/format";
import { LEVEL_COLOURS, LEVEL_ORDER } from "./charts";
import { LevelBadge } from "./SessionBits";

const LEVEL_INDEX: Record<Level, number> = {
  Normal: 0,
  Suspicious: 1,
  Irregular: 2,
};

export interface QuantumMetric {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "accent" | "normal" | "warn" | "bad";
}

/** The command hero: a live core, the section thesis and measured readouts. */
export function QuantumHero({
  kicker = "Quantum intelligence core",
  title,
  description,
  metrics,
  status,
  children,
}: {
  kicker?: string;
  title: ReactNode;
  description: ReactNode;
  metrics?: QuantumMetric[];
  status?: string;
  children?: ReactNode;
}) {
  return (
    <section className="quantum-hero" aria-label="Quantum intelligence summary">
      <span className="quantum-hero__rail" aria-hidden="true" />

      <div className="quantum-hero__copy">
        <span className="quantum-kicker">
          <span className="quantum-kicker__spark" aria-hidden="true" />
          {kicker}
        </span>
        <h2 className="quantum-hero__title">{title}</h2>
        <p className="quantum-hero__lede">{description}</p>
        {metrics && metrics.length > 0 && (
          <dl className="quantum-hero__metrics">
            {metrics.map((metric) => (
              <div
                key={metric.label}
                className={`quantum-metric quantum-metric--${metric.tone ?? "neutral"}`}
              >
                <dt>{metric.label}</dt>
                <dd className="mono">{metric.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </div>

      <div className="quantum-hero__side">
        <span className="quantum-status mono">
          <span className="quantum-status__dot" aria-hidden="true" />
          {status ?? "Engine signal locked"}
        </span>
      </div>
    </section>
  );
}

/** Three-level explanation with the real counts and thresholds of this run. */
export function LevelPlaybook({
  levels,
  thresholds,
  compact = false,
}: {
  levels?: LevelCounts | null;
  thresholds?: { suspicious?: number | null; irregular?: number | null };
  compact?: boolean;
}) {
  const total = levels
    ? LEVEL_ORDER.reduce((sum, level) => sum + (levels[level] ?? 0), 0)
    : 0;
  const cards: {
    level: Level;
    code: string;
    title: string;
    meaning: string;
  }[] = [
    {
      level: "Normal",
      code: "N-00",
      title: "Regular object",
      meaning: "Every observation stayed below the suspicious threshold.",
    },
    {
      level: "Suspicious",
      code: "S-01",
      title: "Suspicious object",
      meaning: "At least one observation crossed suspicious; none crossed irregular.",
    },
    {
      level: "Irregular",
      code: "I-02",
      title: "Irregular object",
      meaning: "At least one observation crossed the irregular threshold.",
    },
  ];

  return (
    <div className={`level-playbook ${compact ? "level-playbook--compact" : ""}`.trim()}>
      {cards.map((card) => {
        const count = levels?.[card.level] ?? null;
        const share = total > 0 && count !== null ? (count / total) * 100 : null;
        const threshold =
          card.level === "Suspicious"
            ? thresholds?.suspicious
            : card.level === "Irregular"
              ? thresholds?.irregular
              : null;
        return (
          <article
            key={card.level}
            className={`level-card level-card--${card.level.toLowerCase()}`}
            style={{ ["--level-colour" as string]: LEVEL_COLOURS[card.level] }}
          >
            <header className="level-card__head">
              <span className="level-card__code mono">{card.code}</span>
              <LevelBadge level={card.level} />
            </header>
            <h3 className="level-card__title">{card.title}</h3>
            <p className="level-card__meaning">{card.meaning}</p>
            <footer className="level-card__foot">
              <span className="level-card__count mono">
                {count === null ? "—" : formatNumber(count)}
                <span className="dim"> obs</span>
              </span>
              <span className="level-card__share mono">
                {share === null ? "no observations" : `${share.toFixed(1)}% of run`}
              </span>
            </footer>
            {threshold !== null && threshold !== undefined && (
              <span className="level-card__threshold mono">
                threshold ≥ {threshold.toFixed(2)}
              </span>
            )}
            <span className="level-card__beam" aria-hidden="true" />
          </article>
        );
      })}
    </div>
  );
}

export interface ConstellationPoint {
  x: number | null;
  y: number | null;
  level?: Level | string | null;
}

export interface ConstellationObject {
  trackId: number;
  level: Level;
  observations: number;
  events: number;
  points: ConstellationPoint[];
  available: boolean;
}

const shortId = (trackId: number) => `T${String(trackId).padStart(2, "0")}`;

/** All tracked objects drawn together in one measured spatial field. */
export function ObjectConstellation({
  objects,
  width,
  height,
  activeId,
  onPick,
}: {
  objects: ConstellationObject[];
  width: number;
  height: number;
  activeId: number | null;
  onPick?: (trackId: number) => void;
}) {
  const plotW = 620;
  const plotH = Math.round(plotW * (height / Math.max(1, width)));
  const pad = 14;
  const sx = (value: number) =>
    pad + Math.max(0, Math.min(1, value / Math.max(1, width))) * (plotW - pad * 2);
  const sy = (value: number) =>
    pad + Math.max(0, Math.min(1, value / Math.max(1, height))) * (plotH - pad * 2);
  const withPaths = objects.filter((object) =>
    object.points.some((point) => point.x !== null && point.y !== null),
  );
  const totalPoints = withPaths.reduce(
    (sum, object) =>
      sum + object.points.filter((point) => point.x !== null && point.y !== null).length,
    0,
  );

  return (
    <div className="constellation">
      <div className="constellation__stage">
        <svg
          viewBox={`0 0 ${plotW} ${plotH}`}
          role="img"
          aria-label={`${withPaths.length} tracked objects drawn in source coordinates, ${totalPoints} measured points`}
        >
          <defs>
            <radialGradient id="constellation-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="constellation-field" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--accent-2)" stopOpacity="0.1" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <rect
            x={0.5}
            y={0.5}
            width={plotW - 1}
            height={plotH - 1}
            rx={10}
            fill="url(#constellation-field)"
            stroke="var(--hairline-2)"
          />
          <ellipse
            cx={plotW / 2}
            cy={plotH / 2}
            rx={plotW * 0.34}
            ry={plotH * 0.38}
            fill="url(#constellation-glow)"
          />
          {[0.25, 0.5, 0.75].map((share) => (
            <g key={share}>
              <line
                x1={pad}
                x2={plotW - pad}
                y1={pad + (plotH - pad * 2) * share}
                y2={pad + (plotH - pad * 2) * share}
                className="constellation__grid"
              />
              <line
                y1={pad}
                y2={plotH - pad}
                x1={pad + (plotW - pad * 2) * share}
                x2={pad + (plotW - pad * 2) * share}
                className="constellation__grid"
              />
            </g>
          ))}
          {withPaths.map((object) => {
            const colour = LEVEL_COLOURS[object.level];
            const measured = object.points.filter(
              (point): point is { x: number; y: number; level?: Level | string | null } =>
                point.x !== null && point.y !== null,
            );
            if (measured.length === 0) return null;
            const path = measured
              .map(
                (point, index) =>
                  `${index === 0 ? "M" : "L"}${sx(point.x).toFixed(1)} ${sy(point.y).toFixed(1)}`,
              )
              .join(" ");
            const first = measured[0];
            const last = measured[measured.length - 1];
            const active = object.trackId === activeId;
            return (
              <g
                key={object.trackId}
                className={`constellation__track ${active ? "is-active" : ""}`.trim()}
                onClick={() => onPick?.(object.trackId)}
                role={onPick ? "button" : undefined}
                tabIndex={onPick ? 0 : undefined}
                onKeyDown={(event) => {
                  if (!onPick) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onPick(object.trackId);
                  }
                }}
              >
                <title>{`${shortId(object.trackId)} · ${object.level} · ${formatNumber(object.events)} events`}</title>
                <path
                  d={path}
                  fill="none"
                  stroke={colour}
                  strokeWidth={active ? 3 : 1.7}
                  strokeOpacity={active ? 1 : 0.68}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle cx={sx(first.x)} cy={sy(first.y)} r={2.2} fill={colour} opacity={0.5} />
                <circle
                  cx={sx(last.x)}
                  cy={sy(last.y)}
                  r={active ? 6 : 3.6}
                  fill={colour}
                  stroke="var(--surface-canvas)"
                  strokeWidth={1.4}
                />
                <text
                  x={Math.min(plotW - 6, sx(last.x) + 8)}
                  y={Math.max(12, sy(last.y) - 7)}
                  className="constellation__label mono"
                  fill={colour}
                >
                  {shortId(object.trackId)}
                </text>
              </g>
            );
          })}
          {withPaths.length === 0 && (
            <text
              x={plotW / 2}
              y={plotH / 2}
              textAnchor="middle"
              className="constellation__empty"
            >
              No retained centroid coordinates for these objects
            </text>
          )}
          <text x={pad} y={plotH - 4} className="constellation__axis mono">
            0,0 · source frame
          </text>
          <text x={plotW - pad} y={plotH - 4} textAnchor="end" className="constellation__axis mono">
            {width} × {height} px
          </text>
        </svg>
        <div className="constellation__scan" aria-hidden="true" />
      </div>
      <div className="constellation__legend">
        {LEVEL_ORDER.map((level) => (
          <span key={level} className="constellation__legend-item">
            <i style={{ background: LEVEL_COLOURS[level] }} />
            {level}
            <span className="dim mono">
              {objects.filter((object) => object.level === level).length}
            </span>
          </span>
        ))}
        <span className="constellation__legend-note">
          {formatNumber(totalPoints)} measured centroids · {withPaths.length} of{" "}
          {objects.length} objects carry a retained path
        </span>
      </div>
    </div>
  );
}

export interface RosterObject {
  trackId: number;
  level: Level;
  observations: number;
  anomalies: number;
  levels: LevelCounts;
  maxSpeed: number | null;
  meanSpeed: number | null;
  firstFrame: number | null;
  lastFrame: number | null;
  colour: string | null;
  shape: string | null;
  className: string | null;
  durationS: number | null;
}

/** Every object named, ranked and coloured — nothing hidden behind a filter. */
export function FleetRoster({
  objects,
  activeId,
  onPick,
  limit = 24,
}: {
  objects: RosterObject[];
  activeId: number | null;
  onPick: (trackId: number) => void;
  limit?: number;
}) {
  const shown = objects.slice(0, limit);
  return (
    <div className="fleet-roster">
      {objects.length > limit && (
        <p className="fleet-roster__notice mono">
          Showing {limit} of {objects.length} objects — sort or filter the index to inspect the rest.
        </p>
      )}
      <div className="fleet-roster__grid">
        {shown.map((object) => {
          const active = object.trackId === activeId;
          const total = Math.max(1, object.observations);
          return (
            <button
              key={object.trackId}
              type="button"
              className={`fleet-card fleet-card--${object.level.toLowerCase()} ${
                active ? "is-active" : ""
              }`.trim()}
              onClick={() => onPick(object.trackId)}
              aria-pressed={active}
              aria-label={`Inspect ${shortId(object.trackId)}, ${object.level}, ${object.anomalies} events`}
            >
              <span className="fleet-card__top">
                <span className="fleet-card__id mono">{shortId(object.trackId)}</span>
                <LevelBadge level={object.level} />
              </span>
              <span className="fleet-card__meta mono">
                {formatNumber(object.observations)} obs · F{object.firstFrame ?? "—"}–
                F{object.lastFrame ?? "—"}
              </span>
              <span className="fleet-card__appearance">
                {object.className ??
                  `${object.colour ?? "class n/r"}${object.shape ? ` · ${object.shape}` : ""}`}
              </span>
              <span className="fleet-card__bars" aria-hidden="true">
                {LEVEL_ORDER.map((level) => {
                  const share = (object.levels[level] ?? 0) / total;
                  return share > 0 ? (
                    <i
                      key={level}
                      style={{
                        width: `${Math.max(1.5, share * 100)}%`,
                        background: LEVEL_COLOURS[level],
                      }}
                    />
                  ) : null;
                })}
              </span>
              <span className="fleet-card__stats">
                <span>
                  <b className="mono">{formatNumber(object.anomalies)}</b> events
                </span>
                <span>
                  <b className="mono">
                    {object.maxSpeed === null ? "—" : `${object.maxSpeed.toFixed(0)}`}
                  </b>{" "}
                  px/s peak
                </span>
              </span>
              <span className="fleet-card__index mono" aria-hidden="true">
                {LEVEL_INDEX[object.level]}/2
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Pipeline explanation with the engine stages in order. */
export function QuantumFlow({
  steps,
  ariaLabel = "Analysis pipeline",
}: {
  steps?: { code: string; title: string }[];
  ariaLabel?: string;
}) {
  const defaultSteps = [
    { code: "01", title: "Capture" },
    { code: "02", title: "Detect" },
    { code: "03", title: "Track" },
    { code: "04", title: "Fuse" },
    { code: "05", title: "Explain" },
  ];
  const rows = steps ?? defaultSteps;
  return (
    <ol className="quantum-flow" aria-label={ariaLabel}>
      {rows.map((step, index) => (
        <li className="quantum-flow__step" key={step.code}>
          <span className="quantum-flow__node mono">{step.code}</span>
          <div>
            <span className="quantum-flow__title">{step.title}</span>
          </div>
          {index < rows.length - 1 && <span className="quantum-flow__link" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

/** Small header used inside quantum panels. */
export function QuantumPanelIntro({ children }: { children: ReactNode }) {
  return <p className="quantum-panel-intro">{children}</p>;
}
