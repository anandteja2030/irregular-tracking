import { useEffect, useState } from "react";
import type { ResourceState } from "../hooks/useResource";
import type { AnomalyItem, MediaResponse } from "../lib/types";
import { stepPreviewFrame } from "../lib/studio";
import { nearestFrame } from "../lib/tracks";
import { formatClock, formatNumber } from "../lib/format";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { LevelBadge, Score } from "./SessionBits";
import { AnomalyIcon, ImageIcon, RefreshIcon } from "./icons";

type Kind = "annotated" | "original";

interface FrameInvestigatorProps {
  sessionId: string | null;
  media: ResourceState<MediaResponse>;
  events: AnomalyItem[] | null;
  eventTotal: number;
  eventsReady: boolean;
  eventsError?: boolean;
  /** Optional external request: jump to this source frame when a retained
   * preview exists, otherwise to the nearest retained one. */
  focusFrame?: number | null;
}

/**
 * Retained preview frames only. The API retains a decimated set in memory for
 * the most recent sessions; this panel never presents them as a video.
 */
export function FrameInvestigator({
  sessionId,
  media,
  events,
  eventsReady,
  eventsError = false,
  eventTotal,
  focusFrame,
}: FrameInvestigatorProps) {
  const [index, setIndex] = useState(0);
  const [kind, setKind] = useState<Kind>("annotated");
  const [broken, setBroken] = useState<string | null>(null);
  const [focusNote, setFocusNote] = useState<string | null>(null);

  const frames = media.data?.frames ?? [];
  const frame = frames[Math.min(index, Math.max(0, frames.length - 1))] ?? null;
  const src = frame ? (kind === "annotated" ? frame.annotated_url : frame.original_url) : null;

  useEffect(() => {
    setIndex(0);
    setBroken(null);
    setKind("annotated");
    setFocusNote(null);
  }, [sessionId]);

  useEffect(() => {
    if (focusFrame === null || focusFrame === undefined || frames.length === 0) return;
    const retained = frames.find((entry) => entry.frame === focusFrame);
    if (retained) {
      setIndex(frames.indexOf(retained));
      setFocusNote(null);
      return;
    }
    const nearest = nearestFrame(frames.map((entry) => entry.frame), focusFrame);
    if (nearest === null) return;
    setIndex(frames.findIndex((entry) => entry.frame === nearest));
    setFocusNote(
      `Frame F${focusFrame} is not in this session's retained preview set; showing the nearest retained frame F${nearest}.`,
    );
  }, [focusFrame, frames]);

  useEffect(() => {
    if (index > frames.length - 1) setIndex(Math.max(0, frames.length - 1));
  }, [frames.length, index]);

  useEffect(() => setBroken(null), [src]);

  const goTo = (next: number) => {
    setIndex(next);
    setFocusNote(null);
  };

  const frameEvents = frame
    ? (events ?? []).filter((event) => event.frame === frame.frame)
    : [];
  const loadedEvents = events?.length ?? 0;

  return (
    <div className="investigator">
      <div className="investigator__stage">
        {!sessionId ? (
          <EmptyState
            title="No session selected"
            body="Pick a session to inspect its retained preview frames."
            glyph={<ImageIcon width={17} height={17} />}
          />
        ) : media.status === "error" ? (
          <ErrorState error={media.error} onRetry={media.reload} compact title="Preview media unavailable" />
        ) : media.status === "loading" && !media.data ? (
          <LoadingRows rows={4} label="Reading preview media" />
        ) : !media.data?.available || frames.length === 0 ? (
          <EmptyState
            title="No preview frames are retained"
            body={
              media.data?.notes?.join(" ") ??
              "The API retains annotated preview frames only for sessions analysed by this API process."
            }
            code={media.data?.annotated_video.reason}
            glyph={<ImageIcon width={17} height={17} />}
          />
        ) : frame ? (
          <>
            <figure
              className="frame"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") goTo(stepPreviewFrame(frames.length, index, -1));
                if (event.key === "ArrowRight") goTo(stepPreviewFrame(frames.length, index, 1));
              }}
              aria-label={`Preview frame ${frame.frame}`}
            >
              {broken === src ? (
                <div className="frame__missing">
                  <p className="frame__missing-title">This preview did not load</p>
                  <p className="frame__missing-body">
                    Retained frames live in the API process memory; if the process restarted they are gone
                    while the persisted session remains.
                  </p>
                </div>
              ) : (
                <img
                  src={src as string}
                  alt={`${kind === "annotated" ? "Annotated" : "Original"} preview frame ${frame.frame}`}
                  onError={() => setBroken(src)}
                />
              )}
              <figcaption className="frame__caption mono">
                <span className="frame__index">F{String(frame.frame).padStart(5, "0")}</span>
                <span>{formatClock(frame.ts_s)}</span>
                <span>{frame.ts_s.toFixed(2)}s</span>
                <span className="frame__kind">{kind}</span>
              </figcaption>
            </figure>

            <div className="frame-nav">
              <div className="frame-nav__transport">
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => goTo(0)}
                  disabled={index === 0}
                  aria-label="First retained frame"
                >
                  |‹
                </button>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => goTo(stepPreviewFrame(frames.length, index, -1))}
                  disabled={index === 0}
                  aria-label="Previous retained frame"
                >
                  ‹
                </button>
                <span className="frame-nav__readout mono">
                  {index + 1} / {frames.length}
                </span>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => goTo(stepPreviewFrame(frames.length, index, 1))}
                  disabled={index >= frames.length - 1}
                  aria-label="Next retained frame"
                >
                  ›
                </button>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => goTo(frames.length - 1)}
                  disabled={index >= frames.length - 1}
                  aria-label="Last retained frame"
                >
                  ›|
                </button>
              </div>
              <div className="seg" role="group" aria-label="Frame rendering">
                {(["annotated", "original"] as Kind[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`seg__item ${kind === option ? "is-active" : ""}`.trim()}
                    onClick={() => setKind(option)}
                    aria-pressed={kind === option}
                  >
                    {option === "annotated" ? "Annotated" : "Original"}
                  </button>
                ))}
              </div>
            </div>

            {focusNote && <p className="hint hint--focus">{focusNote}</p>}
            <p className="hint">
              {media.data?.preview_stride
                ? `One frame in every ${media.data.preview_stride} is retained (${formatNumber(media.data.preview_count)} frames). Arrow keys step through the retained set.`
                : "Only the retained preview set is available."}{" "}
              Bounding boxes and track IDs are drawn into the annotated JPEG by the pipeline; the browser adds
              no overlay.
            </p>
          </>
        ) : null}
      </div>

      <aside className="investigator__aside">
        <div className="investigator__events">
          <div className="investigator__events-head">
            <span className="investigator__events-title">Events on this frame</span>
            <span className="tag">{frame ? `F${frame.frame}` : "—"}</span>
          </div>
          {!frame || media.status !== "ready" ? (
            <p className="hint hint--flush">Frame events appear once a retained preview is selected.</p>
          ) : eventsError ? (
            <p className="hint hint--flush">
              Frame event evidence is unavailable because the session's event request failed.
            </p>
          ) : !eventsReady ? (
            <p className="hint hint--flush">Reading this session's events…</p>
          ) : frameEvents.length > 0 ? (
            <ul className="event-mini">
              {frameEvents.map((event) => (
                <li key={event.event_id} className="event-mini__item">
                  <div className="event-mini__line">
                    <LevelBadge level={event.level} />
                    <span className="mono">T{String(event.track_id).padStart(2, "0")}</span>
                    <Score value={event.scores.fused} />
                  </div>
                  <p className="event-mini__summary" title={event.summary}>
                    {event.summary}
                  </p>
                  {event.evidence?.rules?.length ? (
                    <p className="event-mini__rules mono">
                      {event.evidence.rules.map((rule) => rule.rule).join(" · ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint hint--flush">
              {eventTotal === 0
                ? "No elevated events were loaded for this view, so no frame carries event evidence."
                : `No elevated event falls on this exact frame in the ${formatNumber(loadedEvents)} loaded events.`}
            </p>
          )}
          {eventTotal > loadedEvents && (
            <p className="hint">
              This view holds {formatNumber(eventTotal)} events; the frame lookup covers{" "}
              {formatNumber(loadedEvents)} of them.
            </p>
          )}
        </div>

        <div className="investigator__notes">
          <span className="note__label">
            <AnomalyIcon width={11} height={11} /> Media scope
          </span>
          {media.data?.available ? (
            <>
              <p className="note__body">{media.data.annotated_video.reason}</p>
              {media.data.notes.length > 0 && (
                <ul className="note-list">
                  {media.data.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="note__body">
              Frame retention is scoped to this API process; the empty state above carries the reason the
              API returned.
            </p>
          )}
          <button type="button" className="btn btn--quiet btn--sm" onClick={media.reload}>
            <span className="btn__icon">
              <RefreshIcon width={12} height={12} />
            </span>
            Reload media
          </button>
        </div>
      </aside>
    </div>
  );
}
