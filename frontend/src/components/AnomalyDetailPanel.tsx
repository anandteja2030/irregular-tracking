import { Link } from "react-router-dom";
import type { ResourceState } from "../hooks/useResource";
import type { AnomalyDetail, AnomalyItem } from "../lib/types";
import { anomalyTypeLabel } from "../lib/anomalies";
import { formatNumber } from "../lib/format";
import { formatTrackId, formatUtc } from "../lib/tracks";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { LevelBadge } from "./SessionBits";
import { AnomalyIcon, ArrowRightIcon, ImageIcon, TrackIcon } from "./icons";
import { Panel } from "./Panel";

interface AnomalyDetailPanelProps {
  sessionId: string;
  selected: AnomalyItem | null;
  detail: ResourceState<AnomalyDetail>;
}

function trackUrl(sessionId: string, trackId: number, frame?: number): string {
  const params = new URLSearchParams({ session: sessionId, track: String(trackId) });
  if (frame !== undefined) params.set("frame", String(frame));
  return `/tracks?${params.toString()}`;
}

export function AnomalyDetailPanel({
  sessionId,
  selected,
  detail,
}: AnomalyDetailPanelProps) {
  return (
    <div id="anomaly-investigation" className="anomaly-investigation">
      <Panel
        title="Event investigation"
        sub="Persisted event, scores and retained evidence"
        actions={selected ? <span className="tag mono">E{selected.event_id}</span> : undefined}
      >
        {!selected ? (
          <EmptyState
            compact
            title="Select an event"
            body="Choose a ledger row, a timeline mark or a frequency bucket to inspect its rule, model and frame evidence."
            glyph={<AnomalyIcon width={17} height={17} />}
          />
        ) : detail.status === "error" ? (
          <ErrorState
            error={detail.error}
            onRetry={detail.reload}
            compact
            title="Event investigation unavailable"
          />
        ) : !detail.data ? (
          <>
            <div className="event-hero">
              <LevelBadge level={selected.level} />
              <span className="mono">E{selected.event_id}</span>
              <span className="mono">F{selected.frame}</span>
              <span>{formatUtc(selected.ts_utc)}</span>
            </div>
            <LoadingRows rows={7} label={`Loading event ${selected.event_id}`} />
          </>
        ) : (
          <EventBody event={detail.data} sessionId={sessionId} />
        )}
      </Panel>

      {selected && detail.data && (
        <FrameActions sessionId={sessionId} event={detail.data} />
      )}
    </div>
  );
}

function EventBody({
  event,
  sessionId,
}: {
  event: AnomalyDetail;
  sessionId: string;
}) {
  const evidence = event.evidence;
  const noStructuredEvidence = !evidence.available;
  const retainedNoRules = evidence.available && evidence.rules.length === 0;

  return (
    <div className="event-detail">
      <div className="event-hero">
        <LevelBadge level={event.level} />
        <span className="mono">E{event.event_id}</span>
        <span className="mono">F{event.frame}</span>
        <span>{formatUtc(event.ts_utc)}</span>
        <Link className="event-hero__track mono" to={trackUrl(sessionId, event.track_id)}>
          <TrackIcon width={11} height={11} />
          {formatTrackId(event.track_id)}
        </Link>
      </div>

      <p className="event-explanation">
        {event.summary || "No persisted explanation was recorded for this event."}
      </p>

      <div className="event-score-grid">
        {(
          [
            ["Fused", event.scores.fused],
            ["Rule", event.scores.rule],
            ["ML", event.scores.ml],
            ["Scene", event.scores.scene],
          ] as const
        ).map(([label, value]) => (
          <div className="event-score" key={label}>
            <span className="event-score__label">{label}</span>
            <span className="event-score__value mono">
              {value === null ? "—" : value.toFixed(3)}
            </span>
            <span className="event-score__track" aria-hidden="true">
              <span
                className={`event-score__fill ${label === "Fused" ? "is-fused" : ""}`.trim()}
                style={{ width: value === null ? "0%" : `${Math.max(0, Math.min(1, value)) * 100}%` }}
              />
            </span>
            <span className="event-score__missing">
              {value === null ? "not recorded" : "persisted"}
            </span>
          </div>
        ))}
      </div>
      <p className="hint hint--flush">
        Fused, rule, ML and scene values are the persisted scores. The browser does not
        re-fuse or infer a missing score.
      </p>

      <div className="event-motion">
        <div>
          <span className="note__label">Event type</span>
          <p className="mono event-motion__value">{anomalyTypeLabel(event)}</p>
        </div>
        <div>
          <span className="note__label">Speed</span>
          <p className="mono event-motion__value">
            {event.motion.speed_px_s === null
              ? "—"
              : `${formatNumber(event.motion.speed_px_s, 1)} px/s`}
          </p>
        </div>
        <div>
          <span className="note__label">Direction</span>
          <p className="mono event-motion__value">
            {event.motion.direction_deg === null
              ? "—"
              : `${formatNumber(event.motion.direction_deg, 1)}°`}
          </p>
        </div>
      </div>

      <section className="event-evidence" aria-labelledby="event-evidence-title">
        <div className="event-section-head">
          <span className="note__label" id="event-evidence-title">
            Structured evidence
          </span>
          <span className={`tag ${noStructuredEvidence ? "tag--warn" : ""}`.trim()}>
            {noStructuredEvidence ? "not retained" : evidence.source}
          </span>
        </div>

        {noStructuredEvidence ? (
          <div className="evidence-state evidence-state--missing">
            <p className="evidence-state__title">Rule-level evidence is missing for this session</p>
            <p className="evidence-state__body">
              The persisted event keeps its explanation and scores, but rule names, per-rule
              severity and ML/scene notes were not written to the database. This is missing
              evidence, not evidence that no rule fired.
            </p>
          </div>
        ) : evidence.rules.length > 0 ? (
          <ul className="rule-list">
            {evidence.rules.map((rule, index) => (
              <li className="rule-card" key={`${rule.rule}-${index}`}>
                <div className="rule-card__head">
                  <span className="mono rule-card__name">{rule.rule}</span>
                  <span className="tag">
                    severity{" "}
                    {typeof rule.severity === "number"
                      ? rule.severity.toFixed(2)
                      : "—"}
                  </span>
                </div>
                <p className="rule-card__description">
                  {rule.description || "No description was recorded for this rule trigger."}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint hint--flush">
            Structured evidence was retained for this event, but no rule trigger was
            recorded. This is different from evidence that is missing.
          </p>
        )}

        {evidence.available && (
          <div className="evidence-notes">
            <div>
              <span className="note__label">ML note</span>
              <p>{evidence.ml_note || "No ML note was recorded for this event."}</p>
            </div>
            <div>
              <span className="note__label">Scene note</span>
              <p>{evidence.scene_note || "No scene note was recorded for this event."}</p>
            </div>
            {(evidence.zone || evidence.zone_dwell_s !== null) && (
              <div>
                <span className="note__label">Zone</span>
                <p>
                  {evidence.zone ?? "Zone unavailable"}
                  {evidence.zone_dwell_s === null
                    ? ""
                    : ` · ${formatNumber(evidence.zone_dwell_s, 2)} s dwell`}
                </p>
              </div>
            )}
          </div>
        )}
        {retainedNoRules && evidence.ml_note === null && evidence.scene_note === null && (
          <p className="hint hint--flush">
            No rule, ML note or scene note was recorded, while the evidence record itself is
            present.
          </p>
        )}
      </section>

      <section className="event-track-context" aria-labelledby="event-track-title">
        <div className="event-section-head">
          <span className="note__label" id="event-track-title">
            Associated track
          </span>
          <span className="tag mono">{formatTrackId(event.track_id)}</span>
        </div>
        {event.track ? (
          <>
            <div className="event-track-facts">
              <span>{formatNumber(event.track.observations)} observations</span>
              <span>{formatNumber(event.track.anomalies)} elevated events</span>
              <span>{event.track.worst_level}</span>
              <span>
                F{event.track.first_frame ?? "—"}–F{event.track.last_frame ?? "—"}
              </span>
              <span>
                {event.track.color ?? "colour —"} · {event.track.shape ?? "shape —"}
              </span>
            </div>
            <Link className="row-link" to={trackUrl(sessionId, event.track.track_id)}>
              <span>Open {formatTrackId(event.track.track_id)} in Track Explorer</span>
              <ArrowRightIcon width={12} height={12} />
            </Link>
          </>
        ) : (
          <p className="hint hint--flush">
            The persisted event names track {formatTrackId(event.track_id)}, but no track
            aggregate was returned for it.
          </p>
        )}
      </section>

      {event.notes.length > 0 && (
        <div className="event-notes">
          <span className="note__label">Evidence limits</span>
          <ul className="note-list">
            {event.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FrameActions({
  sessionId,
  event,
}: {
  sessionId: string;
  event: AnomalyDetail;
}) {
  return (
    <div className="event-frame-actions">
      <div>
        <span className="note__label">Frame evidence</span>
        <p>
          {event.frame_info.media_available
            ? `A retained preview for F${event.frame_info.index} is available below.`
            : "No retained preview is available for this frame in the current API process."}
        </p>
      </div>
      <div className="event-frame-actions__buttons">
        <a className="btn btn--quiet btn--sm" href="#anomaly-frame-evidence">
          <span className="btn__icon">
            <ImageIcon width={12} height={12} />
          </span>
          View frame evidence
        </a>
        <Link
          className="btn btn--quiet btn--sm"
          to={trackUrl(sessionId, event.track_id, event.frame)}
        >
          <span className="btn__icon">
            <TrackIcon width={12} height={12} />
          </span>
          Open frame in Track Explorer
        </Link>
      </div>
    </div>
  );
}
