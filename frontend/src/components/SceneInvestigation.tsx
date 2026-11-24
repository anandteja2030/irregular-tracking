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
  const chartRows = positiveTracks.map((track) => {
    const aggregate = trackById.get(track.track_id);
    const label = classLabel(aggregate?.appearance ?? { color: null, shape: null });
    const worst = aggregate?.observed.worst_level ?? null;
    return {
      key: `T${track.track_id}`,
      label: `${formatTrackId(track.track_id)}${label ? ` · ${label}` : ""}`,
      value: track.max_scene_score,
      color: worst ? LEVEL_COLOURS[worst] : "var(--chart-2)",
      hint: `${formatNumber(track.observations)} scored obs.`,
    };
  });

  return (
    <div className="scene-investigation">
      <MetricGrid columns={5} label="Scene deviation metrics" className="scene-deviation-metrics">
        <MetricCard
          label="Scene-scored observations"
          value={formatNumber(deviations.scene_score.samples)}
        />
        <MetricCard
          label="Mean scene score"
          value={formatNumber(deviations.scene_score.mean, 3)}
          meter={deviations.scene_score.mean}
          tone="accent"
        />
        <MetricCard
          label="Max scene score"
          value={formatNumber(deviations.scene_score.max, 3)}
          meter={deviations.scene_score.max}
          tone="warn"
        />
        <MetricCard
          label="Above 0.20 / 0.30"
          value={`${formatNumber(deviations.above_0_2)} / ${formatNumber(
            deviations.above_0_3,
          )}`}
        />
        <MetricCard
          label="Affected tracks"
          value={formatNumber(deviations.affected_tracks)}
          tone="bad"
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
            <>
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
            </>
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
          title="Track deviations"
          sub="Tracks with a positive maximum scene score"
          actions={<span className="tag">{formatNumber(positiveTracks.length)} positive</span>}
          bodyClassName="panel__body--flush"
        >
          {tracks.status === "error" ? (
            <div className="panel__pad">
              <ErrorState
                error={tracks.error}
                onRetry={tracks.reload}
                compact
                title="Track context unavailable"
              />
            </div>
          ) : positiveTracks.length > 0 ? (
            <>
              <div className="panel__pad scene-track-chart">
                <BarList
                  rows={chartRows}
                  max={1}
                  formatValue={(value) => value.toFixed(2)}
                  ariaLabel="Maximum scene deviation score per object"
                />
              </div>
              <div className="scene-track-list">
                {positiveTracks.map((track) => {
                  const aggregate = trackById.get(track.track_id);
                  const worst = aggregate?.observed.worst_level ?? null;
                  const label = classLabel(
                    aggregate?.appearance ?? { color: null, shape: null },
                  );
                  const observations = aggregate?.observed.observations ?? null;
                  const elevated = aggregate?.observed.anomalies ?? null;
                  const share =
                    observations && elevated !== null
                      ? ((elevated / Math.max(observations, 1)) * 100).toFixed(1)
                      : null;
                  return (
                    <Link
                      className={`scene-track-row ${
                        worst ? `scene-track-row--${worst.toLowerCase()}` : ""
                      }`.trim()}
                      key={track.track_id}
                      to={trackUrl(sessionId, track.track_id)}
                    >
                      <span className="scene-track-row__glyph">
                        <TrackIcon width={13} height={13} />
                      </span>
                      <span className="scene-track-row__body">
                        <span className="scene-track-row__head">
                          <span className="mono">{formatTrackId(track.track_id)}</span>
                          {label && <span className="scene-track-row__class">{label}</span>}
                        </span>
                        <span className="scene-track-row__meta">
                          {aggregate && observations !== null && elevated !== null
                            ? `${formatNumber(elevated)} elevated of ${formatNumber(
                                observations,
                              )} observations (${share}%) · ${
                                worst === "Normal"
                                  ? "below the sustained-evidence verdict bar"
                                  : `verdict ${worst}`
                              }`
                            : `${formatNumber(
                                track.observations,
                              )} scene-scored observations · verdict level not retained`}
                        </span>
                        {aggregate && (
                          <span className="scene-track-row__levels">
                            <StackedLevelBar levels={aggregate.observed.levels} height={6} />
                          </span>
                        )}
                      </span>
                      <span className="scene-track-row__score mono">
                        <span className="scene-track-row__meter" aria-hidden="true">
                          <span
                            className="scene-track-row__meter-fill"
                            style={{ width: `${scoreWidth(track.max_scene_score)}%` }}
                          />
                        </span>
                        max {track.max_scene_score.toFixed(3)}
                      </span>
                      <ArrowRightIcon width={11} height={11} />
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="panel__pad">
              <EmptyState
                compact
                title="No track deviations"
                body="No track has a positive persisted scene score in this run. The threshold summary above remains available."
                glyph={<TrackIcon width={17} height={17} />}
              />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
