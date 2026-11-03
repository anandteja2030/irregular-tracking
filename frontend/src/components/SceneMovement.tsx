import type { DirectionProfile, StatSummary } from "../lib/types";
import {
  directionRows,
  directionSampleLabel,
  OCTANTS,
} from "../lib/scene";
import { formatNumber } from "../lib/format";
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

function SpeedEnvelope({ stats }: { stats: StatSummary }) {
  const p90 = stats.p90 ?? null;
  const hasEnvelope = stats.p10 !== null && p90 !== null;
  const min = stats.min ?? null;
  const max = stats.max ?? null;
  return (
    <div className="scene-speed">
      <div className="scene-speed__reading">
        <div>
          <span className="mini-label">Median speed</span>
          <strong className="mono">{formatNumber(stats.p50, 1)} px/s</strong>
        </div>
        <div>
          <span className="mini-label">Mean ± std</span>
          <strong className="mono">
            {formatNumber(stats.mean, 1)}
            {stats.std === null || stats.std === undefined
              ? ""
              : ` ± ${formatNumber(stats.std, 1)}`}{" "}
            px/s
          </strong>
        </div>
        <div>
          <span className="mini-label">Moving share</span>
          <strong className="mono">
            {stats.moving_fraction === null || stats.moving_fraction === undefined
              ? "—"
              : `${(stats.moving_fraction * 100).toFixed(1)}%`}
          </strong>
        </div>
      </div>

      {hasEnvelope ? (
        <div className="scene-envelope">
          <div className="scene-envelope__bar" aria-hidden="true">
            <span className="scene-envelope__band" />
            <span className="scene-envelope__median" />
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

  return (
    <div className="scene-movement">
      <Panel
        title="Movement intelligence"
        sub="Persisted heading and speed baseline"
        actions={<span className="tag mono">{sourceLabel(profileSource)}</span>}
      >
        <div className="scene-movement__grid">
          <div>
            <div className="scene-panel-heading">
              <span className="mini-label">Dominant directions</span>
              <span className="mono scene-panel-heading__meta">
                {directionSampleLabel(directions)}
              </span>
            </div>
            {directions && populated.length > 0 ? (
              <>
                <div className="scene-dominant">
                  {directions.dominant.length > 0 ? (
                    directions.dominant.map((octant) => (
                      <span className="scene-dominant__chip mono" key={octant}>
                        {octant}
                      </span>
                    ))
                  ) : (
                    <span className="hint">No octant reaches the 20% dominant threshold.</span>
                  )}
                </div>
                <div className="scene-direction-list">
                  {OCTANTS.map((octant) => {
                    const row = rows.find((candidate) => candidate.octant === octant);
                    const share = row?.share ?? 0;
                    return (
                      <div className="scene-direction-row" key={octant}>
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
                            style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }}
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
                  Eight persisted octants; the brighter rows are the recorded dominant flow
                  (≥20% share). No heading is inferred for a missing bin.
                </p>
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
              <span className="mini-label">Speed distribution summary</span>
              <span className="mono scene-panel-heading__meta">
                {sourceLabel(speed?.source ?? profileSource)}
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
