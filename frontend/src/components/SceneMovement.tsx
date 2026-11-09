import type { DirectionProfile, StatSummary } from "../lib/types";
import {
  directionRows,
  directionSampleLabel,
  OCTANTS,
  type Octant,
} from "../lib/scene";
import { formatNumber } from "../lib/format";
import { MetricCard, MetricGrid } from "./MetricCard";
import { Panel } from "./Panel";
import { EmptyState } from "./StateViews";
import { SceneIcon } from "./icons";

interface SceneMovementProps {
  speed: StatSummary | null;
  directions: DirectionProfile | null;
}

function sourceLabel(source: string): string {
  if (source === "run_calibration") return "run calibration";
  if (source === "derived_event_observations" || source === "derived_observations") {
    return "derived observations";
  }
  return source.replaceAll("_", " ");
}

/** Compass angle in degrees clockwise from north, so the rose matches the
 * persisted octant names instead of an arbitrary rotation. */
const ROSE_ANGLE: Record<Octant, number> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

const ROSE_CENTER = 100;
const ROSE_INNER = 24;
const ROSE_RING = 80;

function rosePoint(angleDeg: number, radius: number): { x: number; y: number } {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: ROSE_CENTER + Math.sin(radians) * radius,
    y: ROSE_CENTER - Math.cos(radians) * radius,
  };
}

function DirectionRose({
  rows,
  dominant,
  samples,
}: {
  rows: { octant: Octant; share: number; dominant: boolean }[];
  dominant: Octant[];
  samples: number;
}) {
  const observed = rows.filter((row) => row.share > 0);
  const lead = dominant[0] ?? null;
  const leadShare = lead ? rows.find((row) => row.octant === lead)?.share ?? 0 : null;
  const description = [
    "Direction distribution",
    lead ? `dominant flow ${dominant.join(" · ")}` : "no octant above the 20% dominant threshold",
    `${observed.length} of ${OCTANTS.length} octants observed`,
    samples > 0 ? `${samples.toLocaleString()} heading samples` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="direction-rose-wrap">
      <svg
        className="direction-rose"
        viewBox="0 0 200 200"
        role="img"
        aria-label={description}
      >
        <circle className="direction-rose__ring" cx={ROSE_CENTER} cy={ROSE_CENTER} r={ROSE_RING} />
        <circle
          className="direction-rose__ring direction-rose__ring--inner"
          cx={ROSE_CENTER}
          cy={ROSE_CENTER}
          r={ROSE_INNER + (ROSE_RING - ROSE_INNER) * 0.5}
        />
        {OCTANTS.map((octant) => {
          const start = rosePoint(ROSE_ANGLE[octant], ROSE_INNER * 0.2);
          const end = rosePoint(ROSE_ANGLE[octant], ROSE_RING);
          return (
            <line
              key={`axis-${octant}`}
              className="direction-rose__axis"
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              aria-hidden="true"
            />
          );
        })}
        {rows.map((row) => {
          const angle = ROSE_ANGLE[row.octant];
          const start = rosePoint(angle, ROSE_INNER);
          const end = rosePoint(angle, ROSE_INNER + (ROSE_RING - ROSE_INNER) * row.share);
          return (
            <line
              key={row.octant}
              className={`direction-rose__spoke ${row.dominant ? "is-dominant" : ""} ${
                row.share > 0 ? "has-flow" : ""
              }`.trim()}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              strokeLinecap="round"
              aria-hidden="true"
            />
          );
        })}
        {OCTANTS.map((octant) => {
          const point = rosePoint(ROSE_ANGLE[octant], ROSE_RING + 13);
          const row = rows.find((candidate) => candidate.octant === octant);
          return (
            <text
              key={`label-${octant}`}
              className={`direction-rose__label ${
                row?.dominant ? "is-dominant" : ""
              }`.trim()}
              x={point.x}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="middle"
              aria-hidden="true"
            >
              {octant}
            </text>
          );
        })}
        <text
          className="direction-rose__core"
          x={ROSE_CENTER}
          y={ROSE_CENTER - 4}
          textAnchor="middle"
          aria-hidden="true"
        >
          {lead ?? "—"}
        </text>
        <text
          className="direction-rose__core-value"
          x={ROSE_CENTER}
          y={ROSE_CENTER + 14}
          textAnchor="middle"
          aria-hidden="true"
        >
          {leadShare === null ? "no flow" : `${(leadShare * 100).toFixed(1)}%`}
        </text>
      </svg>
    </div>
  );
}

function SpeedCards({ stats }: { stats: StatSummary }) {
  return (
    <MetricGrid columns={3} label="Speed baseline">
      <MetricCard
        label="Median speed"
        value={`${formatNumber(stats.p50, 1)} px/s`}
        hint="p50 of persisted samples"
        tone="accent"
      />
      <MetricCard
        label="Mean ± std"
        value={`${formatNumber(stats.mean, 1)}${
          stats.std === null || stats.std === undefined
            ? ""
            : ` ± ${formatNumber(stats.std, 1)}`
        } px/s`}
        hint={`${formatNumber(stats.samples)} samples`}
      />
      <MetricCard
        label="Moving share"
        value={
          stats.moving_fraction === null || stats.moving_fraction === undefined
            ? "—"
            : `${(stats.moving_fraction * 100).toFixed(1)}%`
        }
        meter={stats.moving_fraction}
        tone="accent-2"
        hint="samples with non-zero speed"
      />
    </MetricGrid>
  );
}

function SpeedEnvelope({ stats }: { stats: StatSummary }) {
  const p90 = stats.p90 ?? null;
  const hasEnvelope = stats.p10 !== null && p90 !== null;
  const min = stats.min ?? null;
  const max = stats.max ?? null;

  const domainMin = min ?? stats.p10 ?? 0;
  const domainMax = max ?? p90 ?? 0;
  const span = domainMax - domainMin;
  const position = (value: number | null): number =>
    value === null || span <= 0 ? 50 : ((value - domainMin) / span) * 100;

  return (
    <div className="scene-speed">
      {hasEnvelope ? (
        <div className="scene-envelope">
          <div className="scene-envelope__bar" aria-hidden="true">
            <span
              className="scene-envelope__band"
              style={{
                left: `${position(stats.p10)}%`,
                width: `${Math.max(position(p90) - position(stats.p10), 1)}%`,
              }}
            />
            <span
              className="scene-envelope__median"
              style={{ left: `${position(stats.p50)}%` }}
            />
            {min !== null && <span className="scene-envelope__edge scene-envelope__edge--min" />}
            {max !== null && <span className="scene-envelope__edge scene-envelope__edge--max" />}
          </div>
          <div className="scene-envelope__axis mono">
            <span>p10 {formatNumber(stats.p10, 1)}</span>
            <span>p50 {formatNumber(stats.p50, 1)}</span>
            <span>p90 {formatNumber(p90, 1)}</span>
          </div>
          <p className="hint hint--flush">
            Percentile envelope only. The scene endpoint returns summary percentiles, not a
            raw speed histogram, so no bins are fabricated.
          </p>
        </div>
      ) : (
        <p className="hint hint--flush">
          The API returned a sample count without a complete p10–p90 envelope.
        </p>
      )}

      <div className="scene-speed__facts">
        <span>{formatNumber(stats.samples)} samples</span>
        {min !== null && max !== null && (
          <span>
            observed {formatNumber(min, 1)}–{formatNumber(max, 1)} px/s
          </span>
        )}
        <span>{sourceLabel(stats.source ?? "unknown source")}</span>
      </div>
    </div>
  );
}

export function SceneMovement({ speed, directions }: SceneMovementProps) {
  const rows = directionRows(directions);
  const populated = rows.filter((row) => row.share > 0);
  const profileSource = directions?.source ?? "run_calibration";
  const dominant = (directions?.dominant ?? []).filter((octant): octant is Octant =>
    (OCTANTS as readonly string[]).includes(octant),
  );

  return (
    <div className="scene-movement">
      <Panel
        title="Movement intelligence"
        sub="Persisted heading and speed baseline"
        actions={<span className="tag mono">{sourceLabel(profileSource)}</span>}
      >
        <div className="scene-movement__summary">
          <div className="scene-panel-heading">
            <span className="mini-label">Speed distribution summary</span>
            <span className="mono scene-panel-heading__meta">
              {speed
                ? `${formatNumber(speed.samples)} persisted samples · ${sourceLabel(
                    speed.source ?? profileSource,
                  )}`
                : "no persisted speed samples"}
            </span>
          </div>
          {speed ? (
            <SpeedCards stats={speed} />
          ) : (
            <p className="hint hint--flush">
              No persisted speed samples support a speed envelope for this session.
            </p>
          )}
        </div>

        <div className="scene-movement__grid">
          <div className="scene-movement__directions">
            <div className="scene-panel-heading">
              <span className="mini-label">Dominant directions</span>
              <span className="mono scene-panel-heading__meta">
                {directionSampleLabel(directions)}
              </span>
            </div>
            {directions && populated.length > 0 ? (
              <>
                <div className="scene-flow">
                  <DirectionRose
                    rows={rows}
                    dominant={dominant}
                    samples={directions.samples}
                  />
                  <div className="scene-flow__body">
                    <div className="scene-dominant">
                      {directions.dominant.length > 0 ? (
                        directions.dominant.map((octant) => (
                          <span className="scene-dominant__chip mono" key={octant}>
                            {octant}
                          </span>
                        ))
                      ) : (
                        <span className="hint">
                          No octant reaches the 20% dominant threshold.
                        </span>
                      )}
                    </div>
                    <div className="scene-direction-list">
                      {OCTANTS.map((octant) => {
                        const row = rows.find((candidate) => candidate.octant === octant);
                        const share = row?.share ?? 0;
                        return (
                          <div
                            className={`scene-direction-row ${
                              row?.dominant ? "is-dominant" : ""
                            }`.trim()}
                            key={octant}
                          >
                            <span
                              className={`scene-direction-row__name mono ${
                                row?.dominant ? "is-dominant" : ""
                              }`.trim()}
                            >
                              {octant}
                            </span>
                            <span className="scene-direction-row__track" aria-hidden="true">
                              <span
                                className="scene-direction-row__fill"
                                style={{
                                  width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%`,
                                }}
                              />
                            </span>
                            <span className="scene-direction-row__value mono">
                              {(share * 100).toFixed(1)}%
                              {row?.count !== null && row?.count !== undefined
                                ? ` · ${formatNumber(row.count)}`
                                : ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="hint hint--flush">
                      Eight persisted octants; the brighter rows are the recorded dominant
                      flow (≥20% share). No heading is inferred for a missing bin.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <EmptyState
                compact
                title="No direction observations"
                body="This session did not persist a direction histogram, so no dominant flow can be named."
                glyph={<SceneIcon width={17} height={17} />}
              />
            )}
          </div>

          <div className="scene-movement__speed">
            <div className="scene-panel-heading">
              <span className="mini-label">Percentile envelope</span>
              <span className="mono scene-panel-heading__meta">
                {speed ? sourceLabel(speed.source ?? profileSource) : "unavailable"}
              </span>
            </div>
            {speed ? (
              <SpeedEnvelope stats={speed} />
            ) : (
              <EmptyState
                compact
                title="No speed observations"
                body="No persisted speed samples support a speed envelope for this session."
                glyph={<SceneIcon width={17} height={17} />}
              />
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
