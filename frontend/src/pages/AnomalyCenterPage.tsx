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
import { LevelPlaybook, QuantumHero } from "../components/quantum";
import { ObjectRegistry } from "../components/ObjectRegistry";

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

  // Bring the selected event's investigation into view whenever it is not
  // already visible. Selecting a ledger row at the top of a 1,300 px workbench
  // otherwise left the detail panel far below the fold with no feedback.
  useEffect(() => {
    if (selectedEventId === null) return;
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      const panel = document.getElementById("anomaly-investigation");
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const obscured = rect.top < 80 || rect.top > window.innerHeight * 0.55 || rect.height > window.innerHeight;
      if (!obscured) return;
      panel.scrollIntoView?.({ behavior: "smooth", block: "start" });
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
        lede="The persisted event ledger, severity timeline and frame evidence for every elevated observation."
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
          <QuantumHero
            kicker="Fusion core · anomaly intelligence"
            title={
              <>
                Fused scores, <em>explained</em>
              </>
            }
            description="Rule findings, the Isolation Forest and scene deviation fused into one score per observation."
            status={
              summary.data
                ? `${formatNumber(summary.data.counts.anomalies)} elevated events`
                : "Reading the fused ledger"
            }
            metrics={[
              {
                label: "Observations",
                value: formatNumber(summary.data?.counts.observations),
              },
              {
                label: "Elevated",
                value: formatNumber(summary.data?.counts.anomalies),
                tone: "warn",
              },
              {
                label: "Objects affected",
                value: `${formatNumber(summary.data?.anomalies.tracks_affected)} / ${formatNumber(
                  summary.data?.counts.tracks,
                )}`,
                tone: "bad",
              },
              {
                label: "Mean fused",
                value:
                  summary.data?.anomalies.score_mean === null ||
                  summary.data?.anomalies.score_mean === undefined
                    ? "—"
                    : summary.data.anomalies.score_mean.toFixed(2),
                tone: "accent",
              },
              {
                label: "Peak fused",
                value:
                  summary.data?.anomalies.score_max === null ||
                  summary.data?.anomalies.score_max === undefined
                    ? "—"
                    : summary.data.anomalies.score_max.toFixed(2),
              },
            ]}
          />

          <section className="section" aria-labelledby="anomaly-playbook-title">
            <SectionHeader
              id="anomaly-playbook-title"
              title="What each level means here"
              level={3}
              meta="Fused thresholds · running engine configuration"
            />
            <Panel title="Level playbook" sub="Normal is still a tracked object — it is simply inside the baseline">
              <LevelPlaybook
                levels={summary.data?.counts.levels}
                thresholds={{
                  suspicious: config.data?.anomaly?.threshold_suspicious ?? null,
                  irregular: config.data?.anomaly?.threshold_irregular ?? null,
                }}
              />
            </Panel>
          </section>

          <section className="section" aria-label="Tracked objects behind these events">
            <ObjectRegistry
              tracks={tracks.data?.tracks ?? []}
              total={tracks.data?.total ?? 0}
              sessionId={selectedId}
              title="Tracked objects behind these events"
              sub="Every identity in the run · status from its worst measured fused level"
              events={events.data?.rows ?? null}
              thresholds={{
                suspicious: config.data?.anomaly?.threshold_suspicious ?? null,
                irregular: config.data?.anomaly?.threshold_irregular ?? null,
              }}
            />
          </section>

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
              sub={
                media.data?.preview_stride
                  ? `Retained previews · each one stands for ${media.data.preview_stride} source frames`
                  : "Retained previews for the selected event"
              }
              actions={
                media.data ? (
                  <span className="tag">{formatNumber(media.data.preview_count)} previews</span>
                ) : undefined
              }
              foot={
                <>
                  <span className="dot dot--live" />
                  Annotations are drawn onto every retained preview. Build a downloadable
                  annotated recap from those frames in the panel.
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
                  tracks={tracks.data?.tracks ?? []}
                  context={{
                    width: selected?.processing.width ?? null,
                    height: selected?.processing.height ?? null,
                    fps: selected?.processing.fps ?? null,
                    thresholds: {
                      suspicious: config.data?.anomaly?.threshold_suspicious ?? null,
                      irregular: config.data?.anomaly?.threshold_irregular ?? null,
                    },
                  }}
                  focusFrame={selectedEvent?.frame ?? null}
                  focusEvent={selectedEvent}
                />
              </div>
            </Panel>
          </section>
        </>
      )}
    </>
  );
}
