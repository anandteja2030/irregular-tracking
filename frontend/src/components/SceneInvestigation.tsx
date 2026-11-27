import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ResourceState } from "../hooks/useResource";
import type { SceneResponse, TrackList } from "../lib/types";
import { sceneScoredEvents, type LoadedSceneEvents } from "../lib/scene";
import { formatNumber } from "../lib/format";
import { classLabel, formatTrackId } from "../lib/tracks";
import { LEVEL_COLOURS, BarList, StackedLevelBar } from "./charts";
import { LevelBadge } from "./SessionBits";
import { MetricCard, MetricGrid } from "./MetricCard";
import { Panel } from "./Panel";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { AnomalyIcon, ArrowRightIcon, TrackIcon } from "./icons";

interface SceneInvestigationProps {
  sessionId: string;
  scene: SceneResponse;
  events: ResourceState<LoadedSceneEvents>;
  tracks: ResourceState<TrackList>;
}

function eventUrl(sessionId: string, eventId: number): string {
  return `/anomalies?session=${encodeURIComponent(sessionId)}&event=${eventId}`;
}

function trackUrl(sessionId: string, trackId: number): string {
  return `/tracks?session=${encodeURIComponent(sessionId)}&track=${trackId}`;
}

/** A persisted scene score is bounded 0–1; the meter only visualises it. */
function scoreWidth(score: number | null | undefined): number {
  if (score === null || score === undefined || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score * 100));
}

/** Plain words for a peak scene score, so the number has a meaning. */
function deviationWord(score: number): { label: string; detail: string } {
  if (score >= 0.6) {
    return {
      label: "Far from the baseline",
      detail: "most of its scored motion was unlike anything the calibrator learned",
    };
  }
  if (score >= 0.3) {
    return {
      label: "Clear departure",
      detail: "it repeatedly moved outside the learned speed or heading envelope",
    };
  }
  if (score >= 0.15) {
    return {
      label: "Noticeable drift",
      detail: "a few observations sat outside the baseline, without a sustained departure",
    };
  }
  if (score > 0) {
    return {
      label: "Slight drift",
      detail: "only a faint difference from the baseline was measured",
    };
  }
  return {
    label: "On the baseline",
    detail: "its scored motion matched the learned scene behaviour",
  };
}

const BUCKETS = [
  { key: "0.00–0.10", min: 0, max: 0.1, tone: "calm" },
  { key: "0.10–0.20", min: 0.1, max: 0.2, tone: "low" },
  { key: "0.20–0.30", min: 0.2, max: 0.3, tone: "mid" },
  { key: "0.30–1.00", min: 0.3, max: 1.01, tone: "high" },
];

export function SceneInvestigation({
  sessionId,
  scene,
  events,
  tracks,
}: SceneInvestigationProps) {
  const deviations = scene.deviations;
  const scoredEvents = sceneScoredEvents(events.data?.rows ?? []);
  const topEvents = scoredEvents.slice(0, 8);
  const positiveTracks = deviations.top_tracks.filter((track) => track.max_scene_score > 0);
  const eventTotal = events.data?.rows.length ?? 0;
  const trackById = new Map(
    (tracks.data?.tracks ?? []).map((track) => [track.track_id, track]),
  );

  const allScores = useMemo(
    () =>
      scoredEvents
        .map((event) => event.scores.scene)
        .filter((score): score is number => score !== null && Number.isFinite(score)),
    [scoredEvents],
  );

  const buckets = useMemo(
    () =>
      BUCKETS.map((bucket) => ({
        key: bucket.key,
        label: bucket.key,
        value: allScores.filter((score) => score >= bucket.min && score < bucket.max).length,
        color:
          bucket.tone === "high"
            ? "var(--chart-5)"
            : bucket.tone === "mid"
              ? "var(--chart-4)"
              : bucket.tone === "low"
                ? "var(--chart-2)"
                : "var(--chart-1)",
        hint:
          bucket.tone === "high"
            ? "clear departures"
            : bucket.tone === "mid"
              ? "noticeable"
              : bucket.tone === "low"
                ? "faint drift"
                : "on the baseline",
      })),
    [allScores],
  );

  const perTrack = useMemo(
    () =>
      positiveTracks.map((track) => {
        const scores = scoredEvents
          .filter((event) => event.track_id === track.track_id && event.scores.scene !== null)
          .map((event) => event.scores.scene as number);
        const mean = scores.length
          ? scores.reduce((sum, value) => sum + value, 0) / scores.length
          : null;
        return { ...track, mean, word: deviationWord(track.max_scene_score) };
      }),
    [positiveTracks, scoredEvents],
  );

  const chartRows = perTrack.map((track) => {
    const aggregate = trackById.get(track.track_id);
    const label = classLabel(aggregate?.appearance ?? { color: null, shape: null });
    const worst = aggregate?.observed.worst_level ?? null;
    return {
      key: `T${track.track_id}`,
      label: `${formatTrackId(track.track_id)}${label ? ` · ${label}` : ""}`,
      value: track.max_scene_score,
      color: worst ? LEVEL_COLOURS[worst] : "var(--chart-2)",
      hint:
        track.mean === null
          ? `${formatNumber(track.observations)} scored obs.`
          : `avg ${track.mean.toFixed(2)} · ${formatNumber(track.observations)} scored obs.`,
    };
  });

  return (
    <div className="scene-investigation">
      <MetricGrid columns={5} label="Scene deviation metrics" className="scene-deviation-metrics">
        <MetricCard
          label="Scene-scored observations"
          value={formatNumber(deviations.scene_score.samples)}
          hint="carry a baseline comparison"
        />
        <MetricCard
          label="Typical scene score"
          value={formatNumber(deviations.scene_score.mean, 3)}
          meter={deviations.scene_score.mean}
          tone="accent"
          hint="mean distance from the baseline"
        />
        <MetricCard
          label="Largest departure"
          value={formatNumber(deviations.scene_score.max, 3)}
          meter={deviations.scene_score.max}
          tone="warn"
          hint="single most unusual observation"
        />
        <MetricCard
          label="Noticeable / clear"
          value={`${formatNumber(deviations.above_0_2)} / ${formatNumber(
            deviations.above_0_3,
          )}`}
          hint="observations at ≥0.20 / ≥0.30"
        />
        <MetricCard
          label="Objects affected"
          value={formatNumber(deviations.affected_tracks)}
          tone="bad"
          hint="with at least one deviation"
        />
      </MetricGrid>

      <div className="scene-investigation__grid">
        <Panel
          title="Scene-sensitive events"
          sub="Elevated events with a positive persisted scene score"
          actions={
            events.data && events.data.rows.length > 0 ? (
              <Link
                className="btn btn--quiet btn--sm"
                to={`/anomalies?session=${encodeURIComponent(sessionId)}`}
              >
                Open Anomaly Center
                <span className="btn__icon">
                  <ArrowRightIcon width={11} height={11} />
                </span>
              </Link>
            ) : undefined
          }
          bodyClassName="panel__body--flush"
        >
          {events.status === "error" ? (
            <div className="panel__pad">
              <ErrorState
                error={events.error}
                onRetry={events.reload}
                compact
                title="Scene-sensitive events unavailable"
              />
            </div>
          ) : events.status === "loading" && !events.data ? (
            <div className="panel__pad">
              <LoadingRows rows={6} label="Loading scene-sensitive events" />
            </div>
          ) : topEvents.length > 0 ? (
            <div className="scene-event-list">
              {topEvents.map((event) => (
                <Link
                  className={`scene-event-row scene-event-row--${String(
                    event.level,
                  ).toLowerCase()}`}
                  key={event.event_id}
                  to={eventUrl(sessionId, event.event_id)}
                >
                  <LevelBadge level={event.level} />
                  <span className="scene-event-row__id mono">E{event.event_id}</span>
                  <span className="scene-event-row__frame mono">F{event.frame}</span>
                  <span className="scene-event-row__track mono">
                    {formatTrackId(event.track_id)}
                  </span>
                  <span className="scene-event-row__score mono">
                    <span className="scene-event-row__meter" aria-hidden="true">
                      <span
                        className="scene-event-row__meter-fill"
                        style={{ width: `${scoreWidth(event.scores.scene)}%` }}
                      />
                    </span>
                    scene {event.scores.scene?.toFixed(3)}
                  </span>
                  <span className="scene-event-row__score scene-event-row__score--fused mono">
                    fused {event.scores.fused === null ? "—" : event.scores.fused.toFixed(3)}
                  </span>
                  <ArrowRightIcon width={11} height={11} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="panel__pad">
              <EmptyState
                compact
                title={
                  eventTotal === 0
                    ? "No elevated events"
                    : "No scene-scored elevated events"
                }
                body={
                  eventTotal === 0
                    ? "This run has no persisted elevated events, so there is no event-level scene evidence to open."
                    : "Elevated events exist, but none carries a positive persisted scene score. No event is invented to fill the list."
                }
                glyph={<AnomalyIcon width={17} height={17} />}
              />
            </div>
          )}
        </Panel>

        <Panel
          title="How far each object departed from the scene"
          sub="Peak scene deviation per object, in plain language"
          actions={
            <span className="tag">{formatNumber(positiveTracks.length)} with a deviation</span>
          }
          bodyClassName="panel__body--flush"
        >
          <div className="panel__pad deviation-guide">
            <p className="deviation-guide__intro">
              A scene score is the measured distance between one observation and this run's
              learned baseline of speed and flow. <b>0</b> means the object moved like the scene;
              higher values mean it moved unlike what the calibrator learned. This is a
              baseline-relative measurement — the fused verdict and rule evidence are in the
              Anomaly Center.
            </p>
            <div className="deviation-scale" aria-hidden="true">
              <span className="deviation-scale__rail" />
              <div className="deviation-scale__legend">
                {[
                  { value: "0.00", label: "on the baseline" },
                  { value: "0.20", label: "noticeable" },
                  { value: "0.30", label: "clear departure" },
                  { value: "1.00", label: "unlike the scene" },
                ].map((tick) => (
                  <span className="deviation-scale__stop" key={tick.value}>
                    <b className="mono">{tick.value}</b>
                    <em>{tick.label}</em>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {tracks.status === "error" ? (
            <div className="panel__pad">
              <ErrorState
                error={tracks.error}
                onRetry={tracks.reload}
                compact
                title="Track context unavailable"
              />
            </div>
          ) : allScores.length === 0 && perTrack.length === 0 ? (
            <div className="panel__pad">
              <EmptyState
                compact
                title="No scene deviations measured"
                body="No persisted observation carries a positive scene score in this run, so there is no per-object departure to rank. Nothing is invented to fill this list."
                glyph={<TrackIcon width={17} height={17} />}
              />
            </div>
          ) : (
            <>
              <div className="panel__pad deviation-distribution">
                <span className="note__label">Distribution of all scored observations</span>
                <BarList
                  rows={buckets}
                  formatValue={(value) => `${formatNumber(value)} obs`}
                  ariaLabel="Scene score distribution across all scored observations"
                  emptyLabel="No scene-scored observation"
                />
              </div>

              {perTrack.length > 0 ? (
                <div className="deviation-list">
                  {perTrack.map((track) => {
                    const aggregate = trackById.get(track.track_id);
                    const label = classLabel(
                      aggregate?.appearance ?? { color: null, shape: null },
                    );
                    const observations = aggregate?.observed.observations ?? null;
                    const elevated = aggregate?.observed.anomalies ?? null;
                    return (
                      <Link
                        className={`deviation-row deviation-row--${track.word.label
                          .toLowerCase()
                          .replace(/[^a-z]+/g, "-")}`}
                        key={track.track_id}
                        to={trackUrl(sessionId, track.track_id)}
                      >
                        <span className="deviation-row__glyph">
                          <TrackIcon width={13} height={13} />
                        </span>
                        <span className="deviation-row__body">
                          <span className="deviation-row__head">
                            <span className="mono">{formatTrackId(track.track_id)}</span>
                            {label && <span className="deviation-row__class">{label}</span>}
                            <span className="deviation-row__word">{track.word.label}</span>
                          </span>
                          <span className="deviation-row__reading">
                            Peak <b className="mono">{track.max_scene_score.toFixed(3)}</b>
                            {track.mean !== null && (
                              <> · average <span className="mono">{track.mean.toFixed(3)}</span></>
                            )}{" "}
                            — {track.word.detail}.
                          </span>
                          <span className="deviation-row__meta mono">
                            {aggregate && observations !== null && elevated !== null
                              ? `${formatNumber(elevated)} elevated of ${formatNumber(
                                  observations,
                                )} observations · verdict ${aggregate.observed.worst_level}`
                              : `${formatNumber(
                                  track.observations,
                                )} scored observations · track aggregate not loaded`}
                          </span>
                          {aggregate && (
                            <span className="deviation-row__levels">
                              <StackedLevelBar levels={aggregate.observed.levels} height={6} />
                            </span>
                          )}
                        </span>
                        <span className="deviation-row__score">
                          <span className="deviation-row__meter" aria-hidden="true">
                            <span
                              className="deviation-row__meter-fill"
                              style={{ width: `${scoreWidth(track.max_scene_score)}%` }}
                            />
                          </span>
                          <span className="mono">{track.max_scene_score.toFixed(2)} peak</span>
                        </span>
                        <ArrowRightIcon width={11} height={11} />
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="panel__pad">
                  <EmptyState
                    compact
                    title="Scored observations, no per-object ranking"
                    body="Scene scores exist but no object's aggregate was returned, so only the distribution above is shown."
                    glyph={<TrackIcon width={17} height={17} />}
                  />
                </div>
              )}

              {perTrack.length > 0 && (
                <div className="panel__pad scene-track-chart">
                  <span className="note__label">Peak scene score per object</span>
                  <BarList
                    rows={chartRows}
                    max={1}
                    formatValue={(value) => value.toFixed(2)}
                    ariaLabel="Maximum scene deviation score per object"
                  />
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
