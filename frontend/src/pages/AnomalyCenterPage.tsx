import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import type { AnomalyItem } from "../lib/types";
import { eventSpan } from "../lib/anomalies";
import { formatNumber } from "../lib/format";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState } from "../components/StateViews";
import { AnomalyIcon } from "../components/icons";
import { AnomalySummary } from "../components/AnomalySummary";
import { AnomalyTimeline } from "../components/AnomalyTimeline";
import { AnomalyLedger } from "../components/AnomalyLedger";
import { AnomalyDetailPanel } from "../components/AnomalyDetailPanel";
import { FrameInvestigator } from "../components/FrameInvestigator";
import { SectionHeader } from "../components/SectionHeader";

const FETCH_CHUNK = 500;
const MAX_EVENTS = 5_000;

interface LoadedEvents {
  rows: AnomalyItem[];
  total: number;
  truncated: boolean;
}

/** Read every elevated event in bounded pages so filters, search, timeline and
 * summary statistics all operate on the same honest set. */
async function loadAllAnomalies(
  sessionId: string,
  signal: AbortSignal,
): Promise<LoadedEvents> {
  const rows: AnomalyItem[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const page = await api.anomalies(
      sessionId,
      { sort: "frame", limit: FETCH_CHUNK, offset },
      signal,
    );
    total = page.total;
    rows.push(...page.anomalies);
    offset += page.anomalies.length;
    if (page.anomalies.length === 0 || offset >= total || rows.length >= MAX_EVENTS) {
      break;
    }
  }
  return { rows, total, truncated: rows.length < total };
}

function eventParam(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function AnomalyCenterPage() {
  const { selected, selectedId } = useSession();
  const [searchParams] = useSearchParams();
  const linkedParam = searchParams.get("event");
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [linkedEventId, setLinkedEventId] = useState<number | null>(() =>
    eventParam(linkedParam),
  );
  const sessionKey = selectedId ?? "none";

  const summary = useResource(
    (signal) => api.sessionSummary(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const tracks = useResource(
    (signal) =>
      api.tracks(selectedId as string, { sort: "anomalies", limit: 200 }, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const config = useResource(api.config);
  const events = useResource(
    (signal) => loadAllAnomalies(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const media = useResource((signal) => api.media(selectedId as string, signal), {
    enabled: Boolean(selectedId),
    key: sessionKey,
  });
  const detail = useResource(
    (signal) =>
      api.anomalyDetail(selectedId as string, selectedEventId as number, signal),
    {
      enabled: Boolean(selectedId) && selectedEventId !== null,
      key: `${sessionKey}:${selectedEventId ?? "none"}`,
    },
  );

  useEffect(() => {
    setSelectedEventId(null);
  }, [selectedId]);

  useEffect(() => {
    setLinkedEventId(eventParam(linkedParam));
  }, [linkedParam]);

  useEffect(() => {
    if (linkedEventId === null || !events.data) return;
    if (events.data.rows.some((event) => event.event_id === linkedEventId)) {
      setSelectedEventId(linkedEventId);
    }
    setLinkedEventId(null);
  }, [linkedEventId, events.data]);

  useEffect(() => {
    if (selectedEventId === null) return;
    if (typeof window === "undefined" || window.innerWidth > 1000) return;
    window.requestAnimationFrame(() => {
      document
        .getElementById("anomaly-investigation")
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
  }, [selectedEventId]);

  const allEvents = events.data?.rows ?? [];
  const selectedEvent =
    selectedEventId === null
      ? null
      : (allEvents.find((event) => event.event_id === selectedEventId) ?? null);
  const loadedSpan = eventSpan(allEvents);
  const firstFrame =
    selected?.frame_range.first ?? loadedSpan.first ?? summary.data?.temporal.first_frame ?? 0;
  const lastFrame =
    selected?.frame_range.last ?? loadedSpan.last ?? summary.data?.temporal.last_frame ?? 0;
  const fps = selected?.processing.fps ?? null;
  const data = events.data;

  const chooseEvent = (event: AnomalyItem) => {
    setSelectedEventId(event.event_id);
  };

  return (
    <>
      <PageHeader
        eyebrow="Fusion intelligence"
        title="Anomaly Intelligence Center"
        lede="A persisted event ledger, severity timeline and evidence investigation built from the engine's fused scores. Missing evidence stays missing; no event, timestamp or explanation is synthesized."
        aside={
          selected ? (
            <span className="pill pill--accent mono">
              <AnomalyIcon width={11} height={11} />
              {selected.session}
            </span>
          ) : (
            <span className="pill pill--mono-dim">No session</span>
          )
        }
      />

      {!selectedId ? (
        <Panel>
          <EmptyState
            title="No session selected"
            body="Anomaly events are persisted per session. Pick a recorded session in the top bar to read its ledger, timeline and evidence."
            glyph={<AnomalyIcon width={17} height={17} />}
          />
        </Panel>
      ) : (
        <>
          <AnomalySummary
            sessionId={selectedId}
            summary={summary}
            tracks={tracks}
            config={config}
            events={allEvents}
            eventsReady={events.status === "ready" || events.status === "error"}
            eventsStatus={events.status}
            eventsError={events.error}
            reloadEvents={events.reload}
            eventsTotal={data?.total ?? 0}
            truncated={data?.truncated ?? false}
          />

          <section className="section">
            <AnomalyTimeline
              events={allEvents}
              firstFrame={firstFrame}
              lastFrame={lastFrame}
              firstTs={selected?.timestamps.first_ts ?? null}
              lastTs={selected?.timestamps.last_ts ?? null}
              fps={fps}
              selectedEventId={selectedEventId}
              totalEvents={data?.total ?? 0}
              truncated={data?.truncated ?? false}
              status={events.status}
              error={events.error}
              reload={events.reload}
              onSelect={chooseEvent}
            />
          </section>

          <section className="section">
            <SectionHeader
              title="Event workbench"
              level={3}
              meta={
                data
                  ? `${formatNumber(data.rows.length)} loaded · ${formatNumber(data.total)} reported`
                  : events.status === "error"
                    ? "Event request failed"
                    : "Reading persisted events"
              }
            />
            <div className="anomaly-workbench">
              <AnomalyLedger
                sessionId={selectedId}
                events={allEvents}
                status={events.status}
                error={events.error}
                reload={events.reload}
                selectedEventId={selectedEventId}
                onSelect={chooseEvent}
                totalEvents={data?.total ?? 0}
                truncated={data?.truncated ?? false}
              />
              <AnomalyDetailPanel
                sessionId={selectedId}
                selected={selectedEvent}
                detail={detail}
              />
            </div>
          </section>

          <section className="section" id="anomaly-frame-evidence">
            <Panel
              bodyClassName="panel__body--flush"
              title="Frame evidence"
              sub="Retained previews for the selected event"
              actions={
                media.data ? (
                  <span className="tag">{formatNumber(media.data.preview_count)} previews</span>
                ) : undefined
              }
              foot={
                <>
                  <span className="dot dot--warn" />
                  {media.data
                    ? media.data.annotated_video.reason
                    : "No annotated video is produced by the engine; only retained preview frames exist."}
                </>
              }
            >
              <div className="cinema">
                <FrameInvestigator
                  sessionId={selectedId}
                  media={media}
                  events={allEvents}
                  eventsReady={events.status === "ready" || events.status === "error"}
                  eventsError={events.status === "error"}
                  eventTotal={data?.total ?? 0}
                  focusFrame={selectedEvent?.frame ?? null}
                />
              </div>
            </Panel>
          </section>
        </>
      )}
    </>
  );
}
