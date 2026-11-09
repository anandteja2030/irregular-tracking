import { Link } from "react-router-dom";
import type { ResourceState, ResourceStatus } from "../hooks/useResource";
import type {
  AnomalyItem,
  EngineConfig,
  SessionSummary,
  TrackList,
  Level,
} from "../lib/types";
import {
  channelCounts,
  repeatedTracks,
  ruleFrequencies,
  trackFrequencies,
} from "../lib/anomalies";
import { formatNumber } from "../lib/format";
import { formatTrackId } from "../lib/tracks";
import { ArrowRightIcon, TrackIcon } from "./icons";
import { LevelBadge, LevelMeter } from "./SessionBits";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { Panel } from "./Panel";
import { MetricCard, MetricGrid } from "./MetricCard";
import { SectionHeader } from "./SectionHeader";

const LEVELS: Level[] = ["Normal", "Suspicious", "Irregular"];

interface AnomalySummaryProps {
  sessionId: string;
  summary: ResourceState<SessionSummary>;
  tracks: ResourceState<TrackList>;
  config: ResourceState<EngineConfig>;
  events: AnomalyItem[];
  eventsReady: boolean;
  eventsStatus: ResourceStatus;
  eventsError: unknown;
  reloadEvents: () => void;
  eventsTotal: number;
  truncated: boolean;
}

export function AnomalySummary({
  sessionId,
  summary,
  tracks,
  config,
  events,
  eventsReady,
  eventsStatus,
  eventsError,
  reloadEvents,
  eventsTotal,
  truncated,
}: AnomalySummaryProps) {
  const data = summary.data;
  const levels = data?.counts.levels;
  const observations = data?.counts.observations ?? 0;
  const repeated = repeatedTracks(tracks.data?.tracks ?? []);
  const frequencies = trackFrequencies(events);
  const channels = channelCounts(events);
  const rules = ruleFrequencies(events);
  const evidenceRetained = events.some((event) => event.evidence.available);

  return (
    <section className="section" aria-labelledby="anomaly-summary-title">
      <SectionHeader
        title="Intelligence summary"
        id="anomaly-summary-title"
        level={3}
        meta={data ? `${formatNumber(observations)} persisted observations` : "Reading session"}
      />

      {summary.status === "error" ? (
        <Panel>
          <ErrorState
            error={summary.error}
            onRetry={summary.reload}
            compact
            title="Session summary unavailable"
          />
        </Panel>
      ) : !data ? (
        <Panel>
          <LoadingRows rows={4} label="Loading session intelligence" />
        </Panel>
      ) : (
        <>
          <MetricGrid columns={6} label="Intelligence metrics" className="anomaly-metrics-grid">
            <MetricCard
              label="Observations"
              value={formatNumber(data.counts.observations)}
              hint="persisted rows"
            />
            <MetricCard
              label="Tracked objects"
              value={formatNumber(data.counts.tracks)}
              hint="distinct tracks"
            />
            <MetricCard
              label="Elevated events"
              value={formatNumber(data.counts.anomalies)}
              hint="Suspicious + Irregular"
              tone="warn"
            />
            <MetricCard
              label="Distinct affected tracks"
              value={formatNumber(data.anomalies.tracks_affected)}
              hint="carry an event"
            />
            <MetricCard
              label="Mean fused score"
              value={formatNumber(data.anomalies.score_mean, 2)}
              hint="persisted scores"
              meter={data.anomalies.score_mean}
            />
            <MetricCard
              label="Highest fused score"
              value={formatNumber(data.anomalies.score_max, 2)}
              hint="single event max"
              tone="bad"
              meter={data.anomalies.score_max}
            />
          </MetricGrid>

          <div className="anomaly-summary-grid">
            <Panel title="Severity distribution" sub="Every persisted observation">
              <div className="severity-distribution">
                {LEVELS.map((level) => {
                  const count = levels?.[level] ?? 0;
                  const share = observations > 0 ? count / observations : null;
                  return (
                    <div className="severity-row" key={level}>
                      <LevelBadge level={level} />
                      <span className="severity-row__track" aria-hidden="true">
                        <span
                          className={`severity-row__fill level-fill--${level.toLowerCase()}`}
                          style={{ width: `${share === null ? 0 : share * 100}%` }}
                        />
                      </span>
                      <span className="severity-row__count mono">{formatNumber(count)}</span>
                      <span className="severity-row__share mono">
                        {share === null ? "—" : `${(share * 100).toFixed(1)}%`}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="severity-meter">
                <LevelMeter levels={data.counts.levels} />
              </div>
              <p className="hint hint--flush">
                Normal observations are counted here but are not anomaly events; the ledger
                endpoint returns only Suspicious and Irregular observations.
              </p>
            </Panel>

            <Panel
              title="Repeated anomaly tracks"
              sub="Track-level frequency"
              actions={
                tracks.data ? (
                  <span className="tag">{formatNumber(tracks.data.total)} objects</span>
                ) : undefined
              }
            >
              {tracks.status === "error" ? (
                <ErrorState
                  error={tracks.error}
                  onRetry={tracks.reload}
                  compact
                  title="Track aggregates unavailable"
                />
              ) : tracks.status === "loading" && !tracks.data ? (
                <LoadingRows rows={4} label="Loading track aggregates" />
              ) : repeated.length === 0 ? (
                <EmptyState
                  compact
                  title="No repeated track events"
                  body="No track carries more than one elevated observation in the persisted aggregates."
                  glyph={<TrackIcon width={17} height={17} />}
                />
              ) : (
                <div className="repeat-tracks">
                  {repeated.slice(0, 6).map((track) => (
                    <Link
                      className="repeat-track"
                      key={track.track_id}
                      to={`/tracks?session=${encodeURIComponent(sessionId)}&track=${track.track_id}`}
                    >
                      <span className="repeat-track__id mono">
                        {formatTrackId(track.track_id)}
                      </span>
                      <span className="repeat-track__meta">
                        <span>{formatNumber(track.observed.anomalies)} events</span>
                        <span className="repeat-track__levels">
                          <span>S {formatNumber(track.observed.levels.Suspicious)}</span>
                          <span>I {formatNumber(track.observed.levels.Irregular)}</span>
                        </span>
                      </span>
                      <ArrowRightIcon width={11} height={11} />
                    </Link>
                  ))}
                </div>
              )}
              <p className="hint hint--flush">
                {data.anomalies.count > 0
                  ? `${formatNumber(data.anomalies.count)} events are not ${formatNumber(
                      data.anomalies.tracks_affected,
                    )} objects: one track can emit many events. Repeated activity describes coexistence in the same track, not a cause.`
                  : "No elevated event means there is no repeated track activity to describe. The count stays zero rather than inventing a track."}
              </p>
              {frequencies.length > 0 && eventsReady && (
                <p className="hint hint--flush mono">
                  Loaded ledger shares:{" "}
                  {frequencies
                    .slice(0, 4)
                    .map(
                      (track) =>
                        `${formatTrackId(track.trackId)} ${formatNumber(track.events)}`,
                    )
                    .join(" · ")}
                  {truncated ? ` of ${formatNumber(eventsTotal)} events loaded` : ""}
                </p>
              )}
            </Panel>

            <Panel title="Channel contributions" sub="Persisted scores only">
              {eventsStatus === "error" ? (
                <ErrorState
                  error={eventsError}
                  onRetry={reloadEvents}
                  compact
                  title="Channel contributions unavailable"
                />
              ) : !eventsReady ? (
                <LoadingRows rows={3} label="Loading channel contributions" />
              ) : events.length === 0 ? (
                <p className="hint hint--flush">
                  No elevated events were loaded, so no channel contribution can be attributed.
                </p>
              ) : (
                <>
                  <div className="channel-rows">
                    <ChannelRow
                      label="Rule channel > 0"
                      value={channels.rule}
                      total={events.length}
                      missing={channels.missingRule}
                    />
                    <ChannelRow
                      label="ML channel > 0"
                      value={channels.ml}
                      total={events.length}
                      missing={channels.missingMl}
                    />
                    <ChannelRow
                      label="Scene channel > 0"
                      value={channels.scene}
                      total={events.length}
                      missing={channels.missingScene}
                    />
                  </div>
                  {rules.length > 0 ? (
                    <div className="rule-frequency">
                      <span className="note__label">Retained rule triggers</span>
                      {rules.slice(0, 4).map((rule) => (
                        <div className="rule-frequency__row" key={rule.rule}>
                          <span className="mono">{rule.rule}</span>
                          <span className="mono">{formatNumber(rule.events)} events</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="hint hint--flush">
                      {evidenceRetained
                        ? "Structured evidence was retained, but no rule trigger appears in the loaded events."
                        : "Structured rule evidence is not retained for this session; rule names cannot be recovered from persisted rows."}
                    </p>
                  )}
                  {truncated && (
                    <p className="hint hint--flush">
                      These counts cover the {formatNumber(events.length)} events loaded by this
                      view, not all {formatNumber(eventsTotal)} reported events.
                    </p>
                  )}
                </>
              )}
            </Panel>

            <Panel title="Fusion bands" sub="Running engine configuration">
              {config.status === "error" ? (
                <ErrorState
                  error={config.error}
                  onRetry={config.reload}
                  compact
                  title="Fusion configuration unavailable"
                />
              ) : !config.data ? (
                <LoadingRows rows={4} label="Loading fusion bands" />
              ) : (
                <FusionBands config={config.data} />
              )}
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}

function ChannelRow({
  label,
  value,
  total,
  missing,
}: {
  label: string;
  value: number;
  total: number;
  missing: number;
}) {
  const share = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="channel-row">
      <span className="channel-row__label">{label}</span>
      <span className="channel-row__track" aria-hidden="true">
        <span className="channel-row__fill" style={{ width: `${share}%` }} />
      </span>
      <span className="channel-row__value mono">
        {formatNumber(value)} / {formatNumber(total)}
      </span>
      <span className="channel-row__missing mono">
        {missing > 0 ? `${formatNumber(missing)} missing` : "none missing"}
      </span>
    </div>
  );
}

function FusionBands({ config }: { config: EngineConfig }) {
  const anomaly = config.anomaly;
  if (!anomaly) return <p className="hint hint--flush">No anomaly configuration was returned.</p>;
  return (
    <div className="fusion-bands">
      <div className="ladder">
        <div className="ladder__track" aria-hidden="true">
          <span
            className="ladder__zone ladder__zone--normal"
            style={{ width: `${anomaly.threshold_suspicious * 100}%` }}
          />
          <span
            className="ladder__zone ladder__zone--suspicious"
            style={{
              width: `${(anomaly.threshold_irregular - anomaly.threshold_suspicious) * 100}%`,
            }}
          />
          <span
            className="ladder__zone ladder__zone--irregular"
            style={{ width: `${(1 - anomaly.threshold_irregular) * 100}%` }}
          />
        </div>
        <div className="ladder__scale">
          <span className="ladder__scale-mark ladder__scale-mark--start">0.00</span>
          <span className="ladder__scale-mark" style={{ left: `${anomaly.threshold_suspicious * 100}%` }}>
            {anomaly.threshold_suspicious.toFixed(2)}
          </span>
          <span className="ladder__scale-mark" style={{ left: `${anomaly.threshold_irregular * 100}%` }}>
            {anomaly.threshold_irregular.toFixed(2)}
          </span>
          <span className="ladder__scale-mark ladder__scale-mark--end">1.00</span>
        </div>
      </div>
      <div className="fusion-weights">
        {(
          [
            ["Rule", anomaly.weights.rule],
            ["ML", anomaly.weights.ml],
            ["Scene", anomaly.weights.scene],
          ] as const
        ).map(([label, value]) => (
          <div className="weight" key={label}>
            <div className="weight__head">
              <span className="weight__name">{label}</span>
              <span className="weight__value mono">{value.toFixed(2)}</span>
            </div>
            <div className="weight__track">
              <span
                className="weight__fill"
                style={{ width: `${Math.max(2, Math.min(1, value) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="hint hint--flush">
        Scores below {anomaly.threshold_suspicious.toFixed(2)} are Normal; at or above{" "}
        {anomaly.threshold_irregular.toFixed(2)} they are Irregular. Values are read live from
        the engine and are not recomputed in the browser.
      </p>
    </div>
  );
}
