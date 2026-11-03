import { Link } from "react-router-dom";
import type { ResourceState } from "../hooks/useResource";
import type { SceneResponse, TrackList } from "../lib/types";
import { sceneScoredEvents, type LoadedSceneEvents } from "../lib/scene";
import { formatNumber } from "../lib/format";
import { formatTrackId } from "../lib/tracks";
import { LevelBadge } from "./SessionBits";
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

  return (
    <div className="scene-investigation">
      <div className="scene-deviation-metrics">
        <div className="scene-deviation-metric">
          <span className="scene-metric__label">Scene-scored observations</span>
          <strong className="scene-metric__value mono">
            {formatNumber(deviations.scene_score.samples)}
          </strong>
        </div>
        <div className="scene-deviation-metric">
          <span className="scene-metric__label">Mean scene score</span>
          <strong className="scene-metric__value mono">
            {formatNumber(deviations.scene_score.mean, 3)}
          </strong>
        </div>
        <div className="scene-deviation-metric">
          <span className="scene-metric__label">Max scene score</span>
          <strong className="scene-metric__value mono">
            {formatNumber(deviations.scene_score.max, 3)}
          </strong>
        </div>
        <div className="scene-deviation-metric">
          <span className="scene-metric__label">Above 0.20 / 0.30</span>
          <strong className="scene-metric__value mono">
            {formatNumber(deviations.above_0_2)} / {formatNumber(deviations.above_0_3)}
          </strong>
        </div>
        <div className="scene-deviation-metric">
          <span className="scene-metric__label">Affected tracks</span>
          <strong className="scene-metric__value mono">
            {formatNumber(deviations.affected_tracks)}
          </strong>
        </div>
      </div>

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
                    className="scene-event-row"
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
                      scene {event.scores.scene?.toFixed(3)}
                    </span>
                    <span className="scene-event-row__score scene-event-row__score--fused mono">
                      fused {event.scores.fused === null ? "—" : event.scores.fused.toFixed(3)}
                    </span>
                    <ArrowRightIcon width={11} height={11} />
                  </Link>
                ))}
              </div>
              <div className="panel__pad panel__pad--tight">
                <p className="hint hint--flush">
                  {formatNumber(scoredEvents.length)} of {formatNumber(eventTotal)} loaded
                  elevated events carry a positive scene score. Opening one preserves its
                  event, track and evidence context.
                  {events.data?.truncated
                    ? ` Only ${formatNumber(eventTotal)} of ${formatNumber(
                        events.data.total,
                      )} reported events are loaded.`
                    : ""}
                </p>
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
              <div className="scene-track-list">
                {positiveTracks.map((track) => {
                  const aggregate = tracks.data?.tracks.find(
                    (candidate) => candidate.track_id === track.track_id,
                  );
                  return (
                    <Link
                      className="scene-track-row"
                      key={track.track_id}
                      to={trackUrl(sessionId, track.track_id)}
                    >
                      <span className="scene-track-row__glyph">
                        <TrackIcon width={13} height={13} />
                      </span>
                      <span className="scene-track-row__body">
                        <span className="mono">{formatTrackId(track.track_id)}</span>
                        <span className="scene-track-row__meta">
                          {aggregate
                            ? `${formatNumber(aggregate.observed.anomalies)} elevated · ${formatNumber(
                                aggregate.observed.observations,
                              )} observations`
                            : `${formatNumber(track.observations)} scene-scored observations`}
                        </span>
                      </span>
                      <span className="scene-track-row__score mono">
                        max {track.max_scene_score.toFixed(3)}
                      </span>
                      <ArrowRightIcon width={11} height={11} />
                    </Link>
                  );
                })}
              </div>
              <div className="panel__pad panel__pad--tight">
                <p className="hint hint--flush">
                  Per-track maxima come from the scene endpoint's top {formatNumber(
                    deviations.top_tracks.length,
                  )}{" "}
                  list. A positive score marks deviation from the learned baseline, not a cause.
                </p>
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
