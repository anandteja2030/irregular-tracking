import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { AnomalyItem, SceneResponse, TrackItem } from "../lib/types";
import { formatNumber } from "../lib/format";
import { classLabel, formatTrackId } from "../lib/tracks";
import { Panel } from "./Panel";
import { EmptyState } from "./StateViews";
import { TrackIcon } from "./icons";
import { SceneIcon } from "./icons";

interface SceneObjectAtlasProps {
  sessionId: string;
  scene: SceneResponse;
  tracks: TrackItem[];
  totalTracks: number;
  events: AnomalyItem[] | null;
}

type DeviationBand = "diverging" | "drifting" | "edge" | "conforming" | "unscored";

const BAND_COPY: Record<DeviationBand, { label: string; meaning: string }> = {
  diverging: {
    label: "Diverging",
    meaning:
      "at least one observation was far from the learned baseline (scene score ≥ 0.30)",
  },
  drifting: {
    label: "Drifting",
    meaning:
      "the object left the baseline noticeably but never far (scene score 0.15–0.30)",
  },
  edge: {
    label: "At the edge",
    meaning: "only a faint deviation was measured (scene score below 0.15)",
  },
  conforming: {
    label: "Conforming",
    meaning: "every scored observation stayed on the learned baseline",
  },
  unscored: {
    label: "Not scene-scored",
    meaning: "this run stored no scene score for the object",
  },
};

function bandOf(max: number | null): DeviationBand {
  if (max === null) return "unscored";
  if (max >= 0.3) return "diverging";
  if (max >= 0.15) return "drifting";
  if (max > 0) return "edge";
  return "conforming";
}

function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/**
 * Scene-specific object reading: how each object's measured motion compares
 * with the scene baseline, built from persisted per-observation scene scores.
 *
 * This deliberately does not repeat the Anomaly Center's fused verdict table.
 * It answers a different question: which objects moved unlike the learned
 * traffic baseline, and by how much.
 */
export function SceneObjectAtlas({
  sessionId,
  scene,
  tracks,
  totalTracks,
  events,
}: SceneObjectAtlasProps) {
  const baseline = scene.speed_baseline;
  const median = baseline?.p50 ?? null;

  const rows = useMemo(() => {
    const scored = new Map<number, number[]>();
    for (const event of events ?? []) {
      const score = event.scores.scene;
      if (score === null || score === undefined) continue;
      const list = scored.get(event.track_id) ?? [];
      list.push(score);
      scored.set(event.track_id, list);
    }
    return tracks
      .map((track) => {
        const values = scored.get(track.track_id) ?? [];
        const max = values.length ? Math.max(...values) : null;
        const mean = values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;
        const over = values.filter((value) => value >= 0.2).length;
        const meanSpeed = track.motion.mean_speed_px_s;
        const ratio =
          meanSpeed !== null && median !== null && median > 0 ? meanSpeed / median : null;
        return {
          track,
          max,
          mean,
          scored: values.length,
          over,
          share: values.length ? over / values.length : null,
          ratio,
          band: bandOf(max),
        };
      })
      .sort((a, b) => (b.max ?? -1) - (a.max ?? -1) || a.track.track_id - b.track.track_id);
  }, [events, median, tracks]);

  const counts = rows.reduce<Record<DeviationBand, number>>(
    (acc, row) => ({ ...acc, [row.band]: acc[row.band] + 1 }),
    { diverging: 0, drifting: 0, edge: 0, conforming: 0, unscored: 0 },
  );
  const scoredRows = rows.filter((row) => row.max !== null);
  const visible = [...scoredRows, ...rows.filter((row) => row.max === null)].slice(0, 14);

  return (
    <Panel
      title="Scene behaviour atlas"
      sub="How each object moves compared with the learned baseline — not its fused verdict"
      actions={
        <span className="tag mono">
          {formatNumber(scoredRows.length)} / {formatNumber(totalTracks)} scene-scored
        </span>
      }
      className="scene-atlas-panel"
    >
      <div className="scene-atlas">
        <p className="scene-atlas__intro">
          The scene score measures one thing: how far an object's measured motion sits from
          this run's learned speed and flow baseline. A score near 0 means the object moved like
          the traffic around it; a higher score means it departed from that baseline. The fused
          severity verdicts, rules and frame evidence live in the Anomaly Center — this atlas
          shows <b>who moved unlike the scene</b>, and why.
        </p>

        <div className="scene-atlas__bands" aria-label="Deviation band counts">
          {(["diverging", "drifting", "edge", "conforming"] as DeviationBand[]).map((band) => (
            <div className={`scene-atlas__band scene-atlas__band--${band}`} key={band}>
              <span className="scene-atlas__band-count mono">{formatNumber(counts[band])}</span>
              <span className="scene-atlas__band-label">{BAND_COPY[band].label}</span>
              <span className="scene-atlas__band-meaning">{BAND_COPY[band].meaning}</span>
            </div>
          ))}
        </div>

        {median !== null && (
          <p className="scene-atlas__baseline mono">
            Scene median speed {formatNumber(median, 1)} px/s · p90{" "}
            {formatNumber(baseline?.p90, 1)} px/s ·{" "}
            {baseline?.source === "run_calibration" ? "run calibration" : "derived from observations"}
          </p>
        )}

        {visible.length === 0 ? (
          <EmptyState
            compact
            title="No tracked objects to compare"
            body="This run stored no tracked objects, so there is nothing to compare with the baseline."
            glyph={<SceneIcon width={17} height={17} />}
          />
        ) : (
          <ul className="scene-atlas__list">
            {visible.map((row) => {
              const label = classLabel(row.track.appearance);
              return (
                <li className={`scene-atlas__row scene-atlas__row--${row.band}`} key={row.track.track_id}>
                  <span className="scene-atlas__glyph">
                    <TrackIcon width={13} height={13} />
                  </span>
                  <div className="scene-atlas__body">
                    <div className="scene-atlas__head">
                      <span className="mono">{formatTrackId(row.track.track_id)}</span>
                      {label && <span className="scene-atlas__class">{label}</span>}
                      <span className={`scene-atlas__chip scene-atlas__chip--${row.band}`}>
                        {BAND_COPY[row.band].label}
                      </span>
                    </div>
                    <p className="scene-atlas__reading">
                      {row.max === null ? (
                        "No scene score was persisted for this object, so no comparison is claimed."
                      ) : (
                        <>
                          Peak departure <b>{row.max.toFixed(2)}</b> ({percent(row.max)} of the
                          scale)
                          {row.mean !== null && <> · average {row.mean.toFixed(2)}</>}
                          {row.scored > 0 && (
                            <>
                              {" "}· {formatNumber(row.over)} of {formatNumber(row.scored)} scored
                              observations above 0.20
                            </>
                          )}
                          {row.ratio !== null && (
                            <>
                              {" "}· mean speed {row.ratio.toFixed(2)}× the scene median
                            </>
                          )}
                          .
                        </>
                      )}
                    </p>
                    <div className="scene-atlas__meter" aria-hidden="true">
                      <span
                        className="scene-atlas__meter-fill"
                        style={{ width: `${(row.max ?? 0) * 100}%` }}
                      />
                    </div>
                  </div>
                  <Link
                    className="scene-atlas__link"
                    to={`/tracks?session=${encodeURIComponent(sessionId)}&track=${row.track.track_id}`}
                    aria-label={`Open ${formatTrackId(row.track.track_id)} in Track Explorer`}
                  >
                    Open
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
