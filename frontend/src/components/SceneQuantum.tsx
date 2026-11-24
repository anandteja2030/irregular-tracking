/** Scene anomaly intelligence: the scene channel explained and plotted.
 *
 * Only persisted values are drawn. The histogram bins the scene score of the
 * elevated events this page loaded; the bar list ranks the tracks the API
 * reports as deviating most from the learned scene baseline.
 */
import { Link } from "react-router-dom";
import type { AnomalyItem, LevelCounts, SceneResponse, TrackItem } from "../lib/types";
import { formatNumber } from "../lib/format";
import {
  BarList,
  ChartNote,
  ColumnChart,
  DonutChart,
  LEVEL_COLOURS,
  LEVEL_ORDER,
  LevelLegend,
  Sparkline,
  StackedLevelBar,
} from "./charts";
import { Panel } from "./Panel";
import { LevelPlaybook, QuantumHero } from "./quantum";

/** Arc gauge for the mean scene deviation, drawn on a 0–1 scale. */
function SceneGauge({ value, samples }: { value: number | null; samples: number }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const share = value === null ? 0 : Math.max(0, Math.min(1, value));
  const measured = value !== null && Number.isFinite(value);
  return (
    <>
      <div className="scene-gauge">
        <svg
          viewBox="0 0 128 128"
          role="img"
          aria-label={
            measured
              ? `Mean scene deviation ${value.toFixed(2)} of 1.00`
              : "No scene deviation measured"
          }
        >
          <circle className="scene-gauge__track" cx="64" cy="64" r={radius} />
          {measured && (
            <circle
              className="scene-gauge__arc"
              cx="64"
              cy="64"
              r={radius}
              strokeDasharray={`${share * circumference} ${circumference}`}
              transform="rotate(-90 64 64)"
            />
          )}
          <circle className="scene-gauge__core" cx="64" cy="64" r="38" />
        </svg>
        <span className="scene-gauge__readout">
          <span className="scene-gauge__value mono">
            {measured ? value.toFixed(2) : "—"}
          </span>
          <span className="scene-gauge__label mono">MEAN DEVIATION</span>
        </span>
      </div>
      <span className="scene-gauge__hint mono">{formatNumber(samples)} samples</span>
    </>
  );
}

export function SceneQuantum({
  sessionId,
  scene,
  tracks,
  events,
  eventsTotal,
  tracksTotal,
  levels,
  thresholds,
}: {
  sessionId: string;
  scene: SceneResponse;
  tracks: TrackItem[];
  events: AnomalyItem[];
  eventsTotal: number;
  tracksTotal: number;
  levels?: LevelCounts | null;
  thresholds?: { suspicious?: number | null; irregular?: number | null };
}) {
  const deviation = scene.deviations;
  const scoredEvents = events.filter(
    (event) => event.scores.scene !== null && Number.isFinite(event.scores.scene),
  );
  const bins = Array.from({ length: 10 }, (_, index) => ({
    label: (index / 10).toFixed(1),
    value: 0,
  }));
  for (const event of scoredEvents) {
    const score = event.scores.scene as number;
    bins[Math.min(9, Math.max(0, Math.floor(score * 10)))].value += 1;
  }
  const eventLevels = {
    Normal: events.filter((event) => event.level === "Normal").length,
    Suspicious: events.filter((event) => event.level === "Suspicious").length,
    Irregular: events.filter((event) => event.level === "Irregular").length,
  };
  const worstByTrack = new Map(
    tracks.map((track) => [track.track_id, track.observed.worst_level]),
  );
  const topTrackRows = deviation.top_tracks.slice(0, 7).map((row) => ({
    key: String(row.track_id),
    label: `T${String(row.track_id).padStart(2, "0")} · ${
      worstByTrack.get(row.track_id) ?? "level n/r"
    }`,
    value: row.max_scene_score,
    color: LEVEL_COLOURS[worstByTrack.get(row.track_id) ?? "Normal"],
    hint: `${formatNumber(row.observations)} obs`,
  }));
  const peakBin = bins.reduce((best, bin) => (bin.value > best.value ? bin : best), bins[0]);
  const p90 = "p90" in deviation.scene_score ? deviation.scene_score.p90 ?? null : null;
  const peak = deviation.scene_score.max;
  const mean = deviation.scene_score.mean;

  // Measured order: the loaded elevated events as the API sorted them by frame.
  const pulse = [...scoredEvents]
    .sort((a, b) => a.frame - b.frame)
    .map((event) => event.scores.scene as number);

  return (
    <div className="scene-quantum">
      <QuantumHero
        kicker="Scene anomaly field · baseline deviation"
        title={
          <>
            The room has a <em>signature</em>
          </>
        }
        description="The scene channel learns what this clip normally looks like, then scores how far each observation deviates from that baseline."
        status={`${formatNumber(deviation.affected_tracks)} objects deviating`}
        metrics={[
          {
            label: "Mean scene score",
            value: mean === null ? "—" : mean.toFixed(2),
            tone: "accent",
          },
          {
            label: "≥ 0.20",
            value: formatNumber(deviation.above_0_2),
            tone: "warn",
          },
          {
            label: "≥ 0.30",
            value: formatNumber(deviation.above_0_3),
            tone: "bad",
          },
          {
            label: "p90",
            value: p90 === null ? "—" : p90.toFixed(2),
          },
          {
            label: "Objects",
            value: `${formatNumber(deviation.affected_tracks)} / ${formatNumber(tracksTotal)}`,
          },
        ]}
      />

      <div className="scene-signature">
        <div className="scene-signature__gauge">
          <span className="scene-signature__tag mono">DEVIATION MAGNITUDE</span>
          <SceneGauge value={mean} samples={deviation.scene_score.samples} />
        </div>

        <div className="scene-signature__pulse">
          <span className="scene-signature__tag mono">DEVIATION PULSE · EVENTS IN FRAME ORDER</span>
          {pulse.length > 0 ? (
            <Sparkline
              values={pulse}
              height={86}
              color="var(--chart-6)"
              ariaLabel="Scene score of the loaded elevated events in frame order"
            />
          ) : (
            <p className="chart-empty">No loaded event carries a scene score.</p>
          )}
          <div className="scene-signature__stats">
            <span className="mono">
              peak <b>{peak === null ? "—" : peak.toFixed(2)}</b>
            </span>
            <span className="mono">
              p50 <b>{deviation.scene_score.p50 === null ? "—" : deviation.scene_score.p50.toFixed(2)}</b>
            </span>
            <span className="mono">
              scored <b>{formatNumber(scoredEvents.length)}</b> / {formatNumber(events.length)}
            </span>
          </div>
        </div>

        <div className="scene-signature__ladder">
          <span className="scene-signature__tag mono">DEVIATION LADDER</span>
          <ul className="deviation-ladder">
            <li>
              <span className="deviation-ladder__band mono">≥ 0.30</span>
              <span className="deviation-ladder__track" aria-hidden="true">
                <i
                  style={{
                    width: `${
                      deviation.scene_score.samples > 0
                        ? Math.min(100, (deviation.above_0_3 / deviation.scene_score.samples) * 100)
                        : 0
                    }%`,
                    background: LEVEL_COLOURS.Irregular,
                  }}
                />
              </span>
              <span className="deviation-ladder__value mono">{formatNumber(deviation.above_0_3)}</span>
            </li>
            <li>
              <span className="deviation-ladder__band mono">≥ 0.20</span>
              <span className="deviation-ladder__track" aria-hidden="true">
                <i
                  style={{
                    width: `${
                      deviation.scene_score.samples > 0
                        ? Math.min(100, (deviation.above_0_2 / deviation.scene_score.samples) * 100)
                        : 0
                    }%`,
                    background: LEVEL_COLOURS.Suspicious,
                  }}
                />
              </span>
              <span className="deviation-ladder__value mono">{formatNumber(deviation.above_0_2)}</span>
            </li>
            <li>
              <span className="deviation-ladder__band mono">ALL</span>
              <span className="deviation-ladder__track" aria-hidden="true">
                <i style={{ width: "100%", background: LEVEL_COLOURS.Normal }} />
              </span>
              <span className="deviation-ladder__value mono">
                {formatNumber(deviation.scene_score.samples)}
              </span>
            </li>
          </ul>
          <p className="scene-signature__note mono">
            denominator · scene-scored observations
          </p>
        </div>

        <div className="scene-signature__mix">
          <span className="scene-signature__tag mono">LOADED EVENTS BY LEVEL</span>
          <StackedLevelBar levels={eventLevels} />
          <ul className="scene-mix-legend">
            {LEVEL_ORDER.map((level) => (
              <li key={level}>
                <i style={{ background: LEVEL_COLOURS[level] }} aria-hidden="true" />
                <span className="mono">{level}</span>
                <b className="mono">{formatNumber(eventLevels[level])}</b>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="scene-board">
        <Panel
          title="Scene score field"
          sub={`${formatNumber(scoredEvents.length)} loaded elevated events with a scene score`}
          actions={<LevelLegend />}
        >
          {scoredEvents.length === 0 ? (
            <p className="chart-empty">
              No loaded elevated event carries a scene score, so no deviation field is drawn.
            </p>
          ) : (
            <>
              <div className="score-chart-row">
                <ColumnChart
                  bins={bins}
                  height={168}
                  color="var(--chart-6)"
                  ariaLabel="Elevated events per scene-score decile"
                  valueFormat={(value) => `${formatNumber(value)} ev`}
                />
                <DonutChart
                  size={150}
                  centerValue={formatNumber(events.length)}
                  centerLabel="events"
                  ariaLabel={`Suspicious ${eventLevels.Suspicious}, Irregular ${eventLevels.Irregular}`}
                  segments={[
                    {
                      label: "Suspicious",
                      value: eventLevels.Suspicious,
                      color: LEVEL_COLOURS.Suspicious,
                    },
                    {
                      label: "Irregular",
                      value: eventLevels.Irregular,
                      color: LEVEL_COLOURS.Irregular,
                    },
                  ]}
                />
                <dl className="score-facts">
                  <div>
                    <dt className="mono">PEAK DECILE</dt>
                    <dd className="mono">
                      {peakBin.value > 0
                        ? `${peakBin.label}–${(Number(peakBin.label) + 0.1).toFixed(1)}`
                        : "—"}
                    </dd>
                    <span className="mono">{formatNumber(peakBin.value)} events</span>
                  </div>
                  <div>
                    <dt className="mono">ABOVE 0.20</dt>
                    <dd className="mono">{formatNumber(deviation.above_0_2)}</dd>
                    <span className="mono">observations</span>
                  </div>
                  <div>
                    <dt className="mono">SCENE SAMPLES</dt>
                    <dd className="mono">{formatNumber(deviation.scene_score.samples)}</dd>
                    <span className="mono">persisted</span>
                  </div>
                </dl>
              </div>
              <ChartNote>
                {eventsTotal > events.length
                  ? `${formatNumber(eventsTotal - events.length)} further events were not loaded into this view.`
                  : ""}
              </ChartNote>
            </>
          )}
        </Panel>

        <Panel
          title="Objects deviating from baseline"
          sub="Ranked by peak scene score · measured per object"
          actions={<span className="tag mono">{formatNumber(tracksTotal)} objects</span>}
        >
          <BarList
            ariaLabel="Tracked objects ranked by peak scene deviation"
            rows={topTrackRows}
            formatValue={(value) =>
              value === undefined || value === null ? "—" : value.toFixed(2)
            }
            emptyLabel="No object carries a retained scene deviation"
          />
          {topTrackRows.length > 0 ? (
            <div className="scene-object-links">
              {topTrackRows.map((row) => (
                <Link
                  key={row.key}
                  className="scene-object-link mono"
                  to={`/tracks?session=${encodeURIComponent(sessionId)}&track=${row.key}`}
                >
                  {row.label.split(" · ")[0]} →
                </Link>
              ))}
            </div>
          ) : null}
        </Panel>
      </div>

      <Panel
        title="How to read a scene anomaly"
        sub="Same three bands as the fused level"
        actions={<LevelLegend />}
      >
        <LevelPlaybook compact levels={levels} thresholds={thresholds} />
      </Panel>
    </div>
  );
}
