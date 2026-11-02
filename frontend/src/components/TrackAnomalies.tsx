import type { ResourceState } from "../hooks/useResource";
import type { AnomalyItem, AnomalyList } from "../lib/types";
import { eventTypeLabel, formatTrackId, formatUtc } from "../lib/tracks";
import { formatNumber } from "../lib/format";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { LevelBadge, Score } from "./SessionBits";
import { AnomalyIcon, ArrowRightIcon } from "./icons";

interface TrackAnomaliesProps {
  trackId: number;
  anomalies: ResourceState<AnomalyList>;
  activeFrame: number | null;
  onInspect: (frame: number) => void;
}

function AnomalyRow({
  event,
  active,
  onInspect,
}: {
  event: AnomalyItem;
  active: boolean;
  onInspect: () => void;
}) {
  return (
    <button
      type="button"
      className={`track-event ${active ? "is-active" : ""}`.trim()}
      onClick={onInspect}
      aria-label={`Inspect frame ${event.frame}, ${event.level} event on track ${formatTrackId(event.track_id)}`}
    >
      <span className="track-event__head">
        <LevelBadge level={event.level} />
        <span className="mono">F{event.frame}</span>
        {(!event.evidence?.rules || event.evidence.rules.length === 0) && (
          <span className="mono track-event__type">{eventTypeLabel(event)}</span>
        )}
        <Score value={event.scores.fused} />
      </span>
      <span className="track-event__summary" title={event.summary}>
        {event.summary}
      </span>
      {event.evidence?.rules && event.evidence.rules.length > 0 ? (
        <span className="track-event__evidence mono">
          {event.evidence.rules
            .map((rule) => {
              const severity =
                typeof rule.severity === "number"
                  ? ` (${Math.round(rule.severity * 100)}%)`
                  : "";
              return `${rule.rule}${severity}`;
            })
            .join(" · ")}
        </span>
      ) : event.evidence?.available === false ? (
        <span className="track-event__evidence mono">rule-level evidence not retained</span>
      ) : null}
      <span className="track-event__foot mono">
        {formatUtc(event.ts_utc)}
        {event.motion.speed_px_s !== null ? ` · ${event.motion.speed_px_s.toFixed(0)} px/s` : ""}
        {event.motion.direction_deg !== null ? ` · ${event.motion.direction_deg.toFixed(0)}°` : ""}
        {event.evidence?.ml_note ? ` · ML: ${event.evidence.ml_note}` : ""}
      </span>
      <span className="track-event__action">
        Inspect frame
        <span className="btn__icon">
          <ArrowRightIcon width={11} height={11} />
        </span>
      </span>
    </button>
  );
}

export function TrackAnomalies({ trackId, anomalies, activeFrame, onInspect }: TrackAnomaliesProps) {
  return (
    <>
      {anomalies.status === "error" ? (
        <ErrorState error={anomalies.error} onRetry={anomalies.reload} compact title="Track events unavailable" />
      ) : anomalies.status === "loading" && !anomalies.data ? (
        <LoadingRows rows={4} label="Loading track events" />
      ) : anomalies.data && anomalies.data.anomalies.length > 0 ? (
        <>
          <div className="track-events">
            {anomalies.data.anomalies.map((event) => (
              <AnomalyRow
                key={event.event_id}
                event={event}
                active={activeFrame === event.frame}
                onInspect={() => onInspect(event.frame)}
              />
            ))}
          </div>
          <p className="hint hint--flush">
            {formatNumber(anomalies.data.total)} elevated event
            {anomalies.data.total === 1 ? "" : "s"} for {formatTrackId(trackId)}, ordered by frame.
            {anomalies.data.total > anomalies.data.anomalies.length
              ? ` Showing the first ${formatNumber(anomalies.data.anomalies.length)}.`
              : ""}
          </p>
        </>
      ) : (
        <div className="panel__pad">
          <EmptyState
            compact
            title="No elevated events"
            body={`${formatTrackId(trackId)} never crossed the Suspicious or Irregular threshold in this session.`}
            glyph={<AnomalyIcon width={16} height={16} />}
          />
        </div>
      )}
    </>
  );
}
