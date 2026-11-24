import { useEffect, useMemo, useState } from "react";
import type { ResourceState } from "../hooks/useResource";
import { useResource } from "../hooks/useResource";
import type {
  AnomalyItem,
  MediaResponse,
  TrackItem,
  TrajectoryPoint,
} from "../lib/types";
import { api, mediaUrl } from "../lib/api";
import { stepPreviewFrame } from "../lib/studio";
import { classLabel, nearestFrame } from "../lib/tracks";
import { ruleLabel } from "../lib/anomalies";
import { formatClock, formatNumber } from "../lib/format";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { LevelBadge, Score } from "./SessionBits";
import { ImageIcon, RefreshIcon } from "./icons";

type Kind = "annotated" | "original";

export interface FrameSessionContext {
  width: number | null;
  height: number | null;
  fps: number | null;
  thresholds: { suspicious: number | null; irregular: number | null };
}

interface FrameInvestigatorProps {
  sessionId: string | null;
  media: ResourceState<MediaResponse>;
  events: AnomalyItem[] | null;
  eventTotal: number;
  eventsReady: boolean;
  eventsError?: boolean;
  /** Track aggregates, used for the object's recognised class and averages. */
  tracks?: TrackItem[];
  /** Frame geometry and bands, so the reading can name the band and position. */
  context?: FrameSessionContext;
  /** Optional external request: jump to this source frame when a retained
   * preview exists, otherwise to the nearest retained one. */
  focusFrame?: number | null;
  /** The event the user selected; its reading stays visible when the retained
   * preview is only the nearest frame to the event's own frame. */
  focusEvent?: AnomalyItem | null;
}

function regionOf(
  x: number,
  y: number,
  width: number | null,
  height: number | null,
): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const column = Math.min(2, Math.max(0, Math.floor((x / width) * 3)));
  const row = Math.min(2, Math.max(0, Math.floor((y / height) * 3)));
  const rows = ["top", "middle", "bottom"] as const;
  const columns = ["left", "centre", "right"] as const;
  return `${rows[row]}-${columns[column]}`;
}

function framePoint(points: TrajectoryPoint[], frame: number): TrajectoryPoint | null {
  let best: TrajectoryPoint | null = null;
  for (const point of points) {
    if (point.frame > frame) break;
    if (point.x === null || point.y === null) continue;
    best = point;
  }
  return best;
}

/** One plain-language reading of a single event on the shown frame: what
 * changed, where it happened, how it was measured and why it carries that
 * level. Every sentence is built from persisted fields or retained points. */
function FrameEventReading({
  event,
  previous,
  track,
  points,
  context,
}: {
  event: AnomalyItem;
  previous: AnomalyItem | null;
  track: TrackItem | null;
  points: TrajectoryPoint[];
  context?: FrameSessionContext;
}) {
  const className =
    classLabel(track?.appearance ?? event.evidence.appearance ?? { color: null, shape: null }) ??
    null;
  const point = event.frame !== null ? framePoint(points, event.frame) : null;
  const earlierPoint =
    point === null
      ? null
      : [...points]
          .reverse()
          .find(
            (candidate) =>
              candidate.frame < (point.frame ?? 0) && candidate.x !== null && candidate.y !== null,
          ) ?? null;
  const moved =
    point && earlierPoint && point.x !== null && point.y !== null &&
    earlierPoint.x !== null && earlierPoint.y !== null
      ? Math.hypot(point.x - earlierPoint.x, point.y - earlierPoint.y)
      : null;
  const region =
    point && point.x !== null && point.y !== null
      ? regionOf(point.x, point.y, context?.width ?? null, context?.height ?? null)
      : null;

  let where =
    "No retained centroid for this frame; the boxed object in the annotated image is the engine's own detection.";
  if (point && point.x !== null && point.y !== null) {
    const relative =
      context?.width && context?.height
        ? `${Math.round((point.x / context.width) * 100)}% across, ${Math.round(
            (point.y / context.height) * 100,
          )}% down`
        : "frame size not recorded";
    where = `${region ? `${region} of the frame` : "measured position"} — ${relative} (source pixels ${point.x.toFixed(
      0,
    )} × ${point.y.toFixed(0)})`;
  }

  const what: string[] = [];
  if (previous) {
    if (event.scores.fused !== null && previous.scores.fused !== null) {
      const delta = event.scores.fused - previous.scores.fused;
      what.push(
        `fused score ${delta >= 0 ? "rose" : "fell"} ${Math.abs(delta).toFixed(2)} from ${previous.scores.fused.toFixed(2)} at F${previous.frame}`,
      );
    }
    if (event.motion.speed_px_s !== null && previous.motion.speed_px_s !== null) {
      const delta = event.motion.speed_px_s - previous.motion.speed_px_s;
      what.push(
        `speed ${delta >= 0 ? "increased" : "dropped"} by ${Math.abs(delta).toFixed(0)} px/s from ${previous.motion.speed_px_s.toFixed(0)} px/s`,
      );
    }
  } else {
    what.push("first elevated observation of this object, so there is no earlier event to compare");
  }
  if (track?.motion.mean_speed_px_s != null && event.motion.speed_px_s !== null) {
    const ratio = event.motion.speed_px_s / Math.max(track.motion.mean_speed_px_s, 1);
    what.push(
      `this frame is ${ratio.toFixed(1)}× the object's own mean speed (${track.motion.mean_speed_px_s.toFixed(0)} px/s)`,
    );
  }
  if (moved !== null && point) {
    what.push(`moved ${moved.toFixed(0)} px since F${earlierPoint?.frame ?? "—"}`);
  }

  const ruleEvidence = (event.evidence?.rules ?? []).filter((rule) => rule.rule);
  const how =
    ruleEvidence.length > 0
      ? ruleEvidence
          .map(
            (rule) =>
              `${ruleLabel(rule.rule)}${
                typeof rule.severity === "number" ? ` · ${rule.severity.toFixed(2)}` : ""
              }`,
          )
          .join(" · ")
      : "No rule fired";

  const fused = event.scores.fused;
  const irregular = context?.thresholds.irregular ?? null;
  const suspicious = context?.thresholds.suspicious ?? null;
  let band = "Fused score not recorded, so no band comparison is claimed.";
  if (fused !== null && irregular !== null && suspicious !== null) {
    band =
      fused >= irregular
        ? `Fused ${fused.toFixed(2)} is at or above the Irregular cut-off (${irregular.toFixed(2)}).`
        : fused >= suspicious
          ? `Fused ${fused.toFixed(2)} is between the Suspicious cut-off (${suspicious.toFixed(2)}) and the Irregular cut-off (${irregular.toFixed(2)}).`
          : `Fused ${fused.toFixed(2)} is below the Suspicious cut-off (${suspicious.toFixed(2)}).`;
  }

  return (
    <article className={`frame-reading__card frame-reading__card--${event.level.toLowerCase()}`}>
      <header className="frame-reading__head">
        <LevelBadge level={event.level} />
        <span className="mono">E{event.event_id}</span>
        <span className="mono">T{String(event.track_id).padStart(2, "0")}</span>
        {className && <span className="frame-reading__class">{className}</span>}
        <Score value={event.scores.fused} />
      </header>

      <dl className="frame-reading__grid">
        <div>
          <dt>What changed</dt>
          <dd>{what.join("; ")}.</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{where}</dd>
        </div>
        <div>
          <dt>How it was measured</dt>
          <dd>{how}</dd>
        </div>
        <div>
          <dt>Why this level</dt>
          <dd>{band}</dd>
        </div>
      </dl>
    </article>
  );
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
  tracks = [],
  context,
  focusFrame,
  focusEvent = null,
}: FrameInvestigatorProps) {
  const [index, setIndex] = useState(0);
  const [kind, setKind] = useState<Kind>("annotated");
  const [broken, setBroken] = useState<string | null>(null);
  const [focusNote, setFocusNote] = useState<string | null>(null);

  const frames = media.data?.frames ?? [];
  const frame = frames[Math.min(index, Math.max(0, frames.length - 1))] ?? null;
  const src = frame
    ? mediaUrl(kind === "annotated" ? frame.annotated_url : frame.original_url)
    : null;

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
  const trackById = useMemo(
    () => new Map(tracks.map((track) => [track.track_id, track])),
    [tracks],
  );
  // A retained preview set is decimated, so the selected event's exact frame
  // is often not retained. In that case the nearest retained preview is shown
  // and the selected event's own reading stays beside it, labelled honestly.
  const nearestFocus =
    focusEvent &&
    frame &&
    frameEvents.length === 0 &&
    Math.abs(frame.frame - focusEvent.frame) <=
      Math.max(1, media.data?.preview_stride ?? 1)
      ? focusEvent
      : null;
  const readingEvents = frameEvents.length > 0 ? frameEvents : nearestFocus ? [nearestFocus] : [];
  const previousByTrack = useMemo(() => {
    const map = new Map<number, AnomalyItem>();
    const reference = readingEvents.length > 0 ? readingEvents[0].frame : (frame?.frame ?? 0);
    for (const event of events ?? []) {
      if (event.frame >= reference) continue;
      const current = map.get(event.track_id);
      if (!current || event.frame > current.frame) map.set(event.track_id, event);
    }
    return map;
    // readingEvents derives from events, frame and focusEvent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, frame?.frame, focusEvent?.event_id]);

  const frameTrackIds = [...new Set(readingEvents.map((event) => event.track_id))].slice(0, 4);
  const frameTrackKey = frameTrackIds.join(",");
  const trajectories = useResource(
    async (signal) => {
      const settled = await Promise.allSettled(
        frameTrackIds.map((trackId) =>
          api.trackTrajectory(sessionId as string, trackId, signal),
        ),
      );
      const map: Record<number, TrajectoryPoint[]> = {};
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") map[frameTrackIds[index]] = result.value.points;
      });
      return map;
    },
    {
      enabled: Boolean(sessionId) && frameTrackIds.length > 0,
      key: `${sessionId ?? "none"}:${frame?.frame ?? "none"}:${frameTrackKey}`,
    },
  );

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
                  loading="lazy"
                  decoding="async"
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

            <section className="frame-reading" aria-labelledby="frame-reading-title">
              <div className="frame-reading__head-row">
                <span className="note__label" id="frame-reading-title">
                  What this frame shows
                </span>
                <span className="tag">
                  F{frame.frame} · {readingEvents.length} elevation reading
                  {readingEvents.length === 1 ? "" : "s"}
                </span>
              </div>
              {readingEvents.length === 0 ? (
                <p className="hint hint--flush">No elevated event on F{frame.frame}.</p>
              ) : (
                <>
                  <div className="frame-reading__list">
                    {readingEvents.map((event) => (
                      <FrameEventReading
                        key={event.event_id}
                        event={event}
                        previous={previousByTrack.get(event.track_id) ?? null}
                        track={trackById.get(event.track_id) ?? null}
                        points={trajectories.data?.[event.track_id] ?? []}
                        context={context}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
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
