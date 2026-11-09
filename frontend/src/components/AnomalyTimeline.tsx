import type { AnomalyItem } from "../lib/types";
import type { ResourceStatus } from "../hooks/useResource";
import {
  EVENT_LEVELS,
  eventLevelCounts,
  eventsPerFrame,
  framePosition,
  timelineBuckets,
} from "../lib/anomalies";
import { formatNumber } from "../lib/format";
import { formatUtc } from "../lib/tracks";
import { Panel } from "./Panel";
import { EmptyState, ErrorState } from "./StateViews";
import { AnomalyIcon } from "./icons";

interface AnomalyTimelineProps {
  events: AnomalyItem[];
  firstFrame: number;
  lastFrame: number;
  firstTs: string | null;
  lastTs: string | null;
  fps: number | null;
  selectedEventId: number | null;
  totalEvents: number;
  truncated: boolean;
  status: ResourceStatus;
  error: unknown;
  reload: () => void;
  onSelect: (event: AnomalyItem) => void;
}

const BINS = 24;

export function AnomalyTimeline({
  events,
  firstFrame,
  lastFrame,
  firstTs,
  lastTs,
  fps,
  selectedEventId,
  totalEvents,
  truncated,
  status,
  error,
  reload,
  onSelect,
}: AnomalyTimelineProps) {
  const levels = eventLevelCounts(events);
  const buckets = timelineBuckets(events, firstFrame, lastFrame, BINS);
  const maxBucket = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const density = eventsPerFrame(events.length, firstFrame, lastFrame);
  const span = Math.max(1, lastFrame - firstFrame + 1);
  const duration = fps && fps > 0 ? span / fps : null;
  const selected = events.find((event) => event.event_id === selectedEventId) ?? null;
  const midFrame = Math.round(firstFrame + (lastFrame - firstFrame) / 2);

  return (
    <Panel
      title="Event timeline"
      sub={
        status === "error"
          ? "Event request failed"
          : events.length > 0
            ? `F${firstFrame}–F${lastFrame} · ${formatNumber(events.length)} events plotted`
            : "No elevated events"
      }
      actions={
        events.length > 0 ? (
          <span className="tag">
            {truncated ? `${formatNumber(events.length)} of ${formatNumber(totalEvents)}` : "all loaded"}
          </span>
        ) : undefined
      }
    >
      {status === "error" ? (
        <ErrorState
          error={error}
          onRetry={reload}
          compact
          title="Event timeline unavailable"
        />
      ) : events.length === 0 ? (
        <EmptyState
          compact
          title="No events to plot"
          body="The timeline is built from persisted event frames. With no elevated events there is no honest position to draw."
          glyph={<AnomalyIcon width={17} height={17} />}
        />
      ) : (
        <div className="event-timeline">
          <div className="event-timeline__facts">
            <span>
              <b>{formatNumber(levels.Suspicious)}</b> Suspicious
            </span>
            <span>
              <b>{formatNumber(levels.Irregular)}</b> Irregular
            </span>
            <span>
              {density === null ? "—" : `${density.toFixed(2)} events / frame`}
            </span>
            <span>
              {duration === null
                ? `${formatNumber(span)} frames`
                : `${duration.toFixed(2)} s of frame span at ${formatNumber(fps, 1)} fps`}
            </span>
          </div>

          <div
            className="timeline-histogram"
            role="group"
            aria-label="Event frequency by frame bucket"
          >
            {buckets.map((bucket) => {
              const height = (bucket.total / maxBucket) * 100;
              const firstEvent =
                bucket.firstEventId === null
                  ? null
                  : events.find((event) => event.event_id === bucket.firstEventId) ?? null;
              return (
                <button
                  key={bucket.index}
                  type="button"
                  className={`timeline-bin ${bucket.total > 0 ? "has-events" : ""}`.trim()}
                  onClick={() => firstEvent && onSelect(firstEvent)}
                  disabled={!firstEvent}
                  aria-label={`Select first event in frames ${bucket.start} to ${bucket.end}: ${bucket.total} events`}
                  title={`F${bucket.start}–F${bucket.end}: ${bucket.total} events (${bucket.Suspicious} Suspicious, ${bucket.Irregular} Irregular)`}
                >
                  <span className="timeline-bin__track">
                    <span className="timeline-bin__fill" style={{ height: `${height}%` }}>
                      {bucket.Irregular > 0 && (
                        <span
                          className="timeline-bin__segment level-fill--irregular"
                          style={{ flex: bucket.Irregular }}
                        />
                      )}
                      {bucket.Suspicious > 0 && (
                        <span
                          className="timeline-bin__segment level-fill--suspicious"
                          style={{ flex: bucket.Suspicious }}
                        />
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="timeline-axis mono">
            <span>
              F{firstFrame} · {firstTs ? formatUtc(firstTs).replace(" UTC", "") : "timestamp —"}
            </span>
            <span>F{midFrame}</span>
            <span>
              F{lastFrame} · {lastTs ? formatUtc(lastTs).replace(" UTC", "") : "timestamp —"}
            </span>
          </div>

          <div className="timeline-lanes">
            {EVENT_LEVELS.map((level) => {
              const lane = events.filter((event) => event.level === level);
              return (
                <div className="timeline-lane" key={level}>
                  <span className="timeline-lane__label">
                    {level} <span className="mono">{formatNumber(lane.length)}</span>
                  </span>
                  <div className="timeline-lane__rail">
                    {lane.map((event) => (
                      <button
                        key={event.event_id}
                        type="button"
                        className={`timeline-mark timeline-mark--${level.toLowerCase()} ${
                          selectedEventId === event.event_id ? "is-selected" : ""
                        }`.trim()}
                        style={{ left: `${framePosition(event.frame, firstFrame, lastFrame)}%` }}
                        onClick={() => onSelect(event)}
                        aria-label={`Select event ${event.event_id}, frame ${event.frame}, ${level}, track ${event.track_id}`}
                        title={`E${event.event_id} · F${event.frame} · ${formatUtc(event.ts_utc)}\n${event.summary}`}
                      >
                        <span className="sr-only">
                          Event {event.event_id}, frame {event.frame}, {level}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="timeline-selected">
            {selected ? (
              <>
                <span className={`timeline-selected__mark level-fill--${selected.level.toLowerCase()}`} />
                <span className="mono">E{selected.event_id}</span>
                <span className="mono">F{selected.frame}</span>
                <span>{formatUtc(selected.ts_utc)}</span>
                <span>{selected.level}</span>
                <span className="mono">T{String(selected.track_id).padStart(2, "0")}</span>
              </>
            ) : (
              <span className="hint hint--flush">
                Select a severity mark or a frequency bucket to open its persisted event.
              </span>
            )}
          </div>
          <p className="hint hint--flush">
            Marks use recorded frame numbers; buckets divide the session's real frame span
            evenly. The UTC stamps are the persisted observation timestamps, while the seconds
            span is derived from frames and the recorded fps; no event or missing position is
            interpolated.
            {truncated
              ? ` This view plots ${formatNumber(events.length)} of ${formatNumber(totalEvents)} reported events.`
              : ""}
          </p>
        </div>
      )}
    </Panel>
  );
}
