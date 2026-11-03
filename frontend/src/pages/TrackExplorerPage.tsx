import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import { useResource, type ResourceState } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { LevelBadge, Pager, Score } from "../components/SessionBits";
import { TrackIndex } from "../components/TrackIndex";
import { TrackTelemetry } from "../components/TrackTelemetry";
import { TrackAnomalies } from "../components/TrackAnomalies";
import { TrajectoryCanvas } from "../components/TrajectoryCanvas";
import { MotionChart } from "../components/MotionChart";
import { FrameInvestigator } from "../components/FrameInvestigator";
import { ArrowRightIcon, ImageIcon, TrackIcon } from "../components/icons";
import { formatNumber } from "../lib/format";
import {
  filterTracks,
  formatTrackId,
  summarizeDirections,
  trackListParams,
  type TrackLevelFilter,
  type TrackSort,
} from "../lib/tracks";
import type { MediaResponse } from "../lib/types";

const OBSERVATION_PAGE = 20;
const MOTION_LIMIT = 500;
const ANOMALY_LIMIT = 200;

function timeOfDay(ts: string): string {
  const iso = ts.replace("T", " ");
  return iso.slice(11, 19) || "—";
}

function integerParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function TrackExplorerPage() {
  const { selected, selectedId } = useSession();
  const [searchParams] = useSearchParams();
  // A link from the Anomaly Center can address one track and one frame.
  const linkedTrack = useRef(integerParam(searchParams, "track"));
  const linkedFrame = useRef(integerParam(searchParams, "frame"));
  const targetTrack = useRef(linkedTrack.current);
  const [pickedTrack, setPickedTrack] = useState<number | null>(linkedTrack.current);
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<TrackLevelFilter>("all");
  const [sort, setSort] = useState<TrackSort>("anomalies");
  const [offset, setOffset] = useState(0);
  const [focusFrame, setFocusFrame] = useState<number | null>(linkedFrame.current);
  const trackParam = integerParam(searchParams, "track");
  const frameParam = integerParam(searchParams, "frame");
  const linkKey = `${selectedId ?? "none"}:${trackParam ?? ""}:${frameParam ?? ""}`;
  const lastLinkKey = useRef<string | null>(null);

  const sessionKey = selectedId ?? "none";
  const params = trackListParams(levelFilter, sort);
  const tracks = useResource(
    (signal) => api.tracks(selectedId as string, { ...params, limit: 200 }, signal),
    { enabled: Boolean(selectedId), key: `${sessionKey}:${levelFilter}:${sort}` },
  );

  const visibleTracks = useMemo(
    () => filterTracks(tracks.data?.tracks ?? [], query),
    [tracks.data, query],
  );
  const activeId =
    pickedTrack !== null && visibleTracks.some((track) => track.track_id === pickedTrack)
      ? pickedTrack
      : (visibleTracks[0]?.track_id ?? null);
  const noTracksAtAll =
    tracks.status === "ready" &&
    tracks.data?.total === 0 &&
    levelFilter === "all" &&
    !query.trim();
  const tickKey = `${sessionKey}:${activeId ?? "none"}`;
  const detail = useResource(
    (signal) => api.track(selectedId as string, activeId as number, signal),
    { enabled: Boolean(selectedId) && activeId !== null, key: tickKey },
  );
  const trajectory = useResource(
    (signal) => api.trackTrajectory(selectedId as string, activeId as number, signal),
    { enabled: Boolean(selectedId) && activeId !== null, key: tickKey },
  );
  const observations = useResource(
    (signal) =>
      api.trackObservations(
        selectedId as string,
        activeId as number,
        { limit: OBSERVATION_PAGE, offset },
        signal,
      ),
    { enabled: Boolean(selectedId) && activeId !== null, key: `${tickKey}:${offset}` },
  );
  const motion = useResource(
    (signal) =>
      api.trackObservations(
        selectedId as string,
        activeId as number,
        { limit: MOTION_LIMIT, offset: 0 },
        signal,
      ),
    { enabled: Boolean(selectedId) && activeId !== null, key: `${tickKey}:motion` },
  );
  const anomalies = useResource(
    (signal) =>
      api.anomalies(
        selectedId as string,
        { track_id: activeId as number, sort: "frame", limit: ANOMALY_LIMIT },
        signal,
      ),
    { enabled: Boolean(selectedId) && activeId !== null, key: `${tickKey}:anomalies` },
  );
  const media = useResource((signal) => api.media(selectedId as string, signal), {
    enabled: Boolean(selectedId),
    key: sessionKey,
  });
  const frameIndex = useResource(
    (signal) =>
      api.trackFrames(
        selectedId as string,
        activeId as number,
        { limit: 500 },
        signal,
      ),
    { enabled: Boolean(selectedId) && activeId !== null, key: `${tickKey}:frames` },
  );

  // React to every deep link, including one delivered while this page is
  // already mounted (browser history, or a link from another surface).
  useEffect(() => {
    if (lastLinkKey.current === linkKey) return;
    lastLinkKey.current = linkKey;
    targetTrack.current = trackParam;
    linkedFrame.current = frameParam;
    setPickedTrack(trackParam);
    setQuery("");
    setLevelFilter("all");
    setSort("anomalies");
    setOffset(0);
    setFocusFrame(frameParam);
    // The active track may already be the link target, in which case the
    // activeId effect below will not run again; consume the request now.
    if (trackParam !== null && trackParam === activeId) {
      linkedFrame.current = null;
      targetTrack.current = null;
    }
  }, [activeId, frameParam, linkKey, trackParam]);

  useEffect(() => {
    setOffset(0);
    if (
      linkedFrame.current !== null &&
      targetTrack.current !== null &&
      activeId === targetTrack.current
    ) {
      setFocusFrame(linkedFrame.current);
      linkedFrame.current = null;
      targetTrack.current = null;
    } else {
      setFocusFrame(null);
    }
  }, [activeId]);

  useEffect(() => {
    if (observations.data && observations.data.total > 0 && offset >= observations.data.total) {
      setOffset(0);
    }
  }, [observations.data, offset]);

  useEffect(() => {
    if (focusFrame === null) return;
    const index = motion.data?.observations.findIndex((row) => row.frame === focusFrame) ?? -1;
    if (index < 0) return;
    const next = Math.floor(index / OBSERVATION_PAGE) * OBSERVATION_PAGE;
    setOffset((current) => (current === next ? current : next));
  }, [focusFrame, motion.data]);

  const pickTrack = (trackId: number) => {
    targetTrack.current = null;
    linkedFrame.current = null;
    setPickedTrack(trackId);
    setFocusFrame(null);
  };

  const inspectFrame = (frame: number, scroll = false) => {
    setFocusFrame(frame);
    const index = motion.data?.observations.findIndex((row) => row.frame === frame) ?? -1;
    if (index >= 0) {
      setOffset(Math.floor(index / OBSERVATION_PAGE) * OBSERVATION_PAGE);
    }
    if (scroll) {
      window.requestAnimationFrame(() => {
        const panel = document.getElementById("track-frame-investigation");
        panel?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      });
    }
  };

  const width = selected?.processing.width ?? 1280;
  const height = selected?.processing.height ?? 720;
  const fps = selected?.processing.fps ?? null;
  const firstFrame = detail.data?.frames.first ?? selected?.frame_range.first ?? null;
  const lastFrame = detail.data?.frames.last ?? selected?.frame_range.last ?? null;

  const scopedMedia = useMemo<ResourceState<MediaResponse>>(() => {
    if (!media.data) return media;
    const previewTs = new Map(media.data.frames.map((frame) => [frame.frame, frame.ts_s]));
    const examined = frameIndex.data;
    const complete = Boolean(examined && examined.count >= examined.total);
    const exactFrames = complete
      ? examined!.frames
          .filter((frame) => frame.preview_available && frame.frame_url)
          .map((frame) => ({
            frame: frame.frame,
            ts_s: previewTs.get(frame.frame) ?? (fps ? frame.frame / fps : 0),
            annotated_url: frame.frame_url as string,
            original_url: (frame.frame_url as string).replace(
              "kind=annotated",
              "kind=original",
            ),
          }))
      : null;
    const frames =
      exactFrames ??
      media.data.frames.filter(
        (frame) =>
          (firstFrame === null || frame.frame >= firstFrame) &&
          (lastFrame === null || frame.frame <= lastFrame),
      );
    const scope =
      activeId !== null && detail.data
        ? complete
          ? `Preview frames listed here are the tracked frames reported by GET /sessions/{id}/tracks/{track}/frames; ${formatNumber(examined!.total)} observations were checked. The annotated JPEG is drawn by the pipeline for every object in the frame.`
          : `Preview frames are filtered to ${formatTrackId(activeId)}'s lifetime (F${firstFrame ?? "—"}–F${lastFrame ?? "—"}); the track's frame association covers more than the ${formatNumber(examined?.count ?? 500)} observations loaded, so this is a lifetime filter rather than an exact per-frame match.`
        : null;
    return {
      ...media,
      data: {
        ...media.data,
        frames,
        preview_count: frames.length,
        notes: scope ? [...media.data.notes, scope] : media.data.notes,
      },
    };
    // media is recreated by useResource each render; scope on its payload.
  }, [media.data, media.status, media.error, media.reload, activeId, detail.data, firstFrame, lastFrame, frameIndex.data, fps]);

  const selectedObservation = useMemo(() => {
    if (focusFrame === null) return null;
    return motion.data?.observations.find((row) => row.frame === focusFrame) ?? null;
  }, [focusFrame, motion.data]);

  const observedTimes = useMemo(
    () =>
      new Map(
        (motion.data?.observations ?? []).map((row) => [row.frame, row.ts_utc]),
      ),
    [motion.data],
  );

  return (
    <>
      <PageHeader
        eyebrow="Trajectories"
        title="Track Explorer"
        lede="Per-object telemetry for a persisted session: measured motion, retained centroid paths, observation rows and the events behind them."
        aside={
          selected ? (
            <span className="pill pill--accent mono">
              <TrackIcon width={11} height={11} />
              {selected.session}
            </span>
          ) : (
            <span className="pill pill--mono-dim">
              <TrackIcon width={11} height={11} />
              No session selected
            </span>
          )
        }
      />

      {!selectedId || !selected ? (
        <Panel title="Track workspace" sub="Session required">
          <EmptyState
            title="No persisted session to explore"
            body="Tracks are read from the session store. Run an analysis or pick a recorded session in the top bar to populate this workspace."
            code="GET /api/v1/sessions"
            glyph={<TrackIcon width={17} height={17} />}
            actions={
              <Link className="btn btn--quiet" to="/video-studio">
                Open source inventory
                <span className="btn__icon">
                  <ArrowRightIcon width={13} height={13} />
                </span>
              </Link>
            }
          />
        </Panel>
      ) : noTracksAtAll ? (
        <Panel title="Track workspace" sub="0 objects">
          <EmptyState
            title="No tracked objects"
            body="The engine recorded no tracked objects for this run, so there are no trajectories, observations or events to explore. Run an analysis with visible motion to populate this workspace."
            glyph={<TrackIcon width={17} height={17} />}
          />
        </Panel>
      ) : (
        <div className="layout-main-aside">
          <div className="stack gap-14">
            {activeId === null ? (
              <Panel title="Track workspace" sub={tracks.status === "loading" ? "Loading tracks" : "No selection"}>
                {tracks.status === "loading" && !tracks.data ? (
                  <div className="panel__pad">
                    <LoadingRows rows={5} label="Loading tracks" />
                  </div>
                ) : (
                  <EmptyState
                    title={query.trim() || levelFilter !== "all" ? "No track matches" : "No tracked objects"}
                    body={
                      query.trim() || levelFilter !== "all"
                        ? "No object in this session matches the current search and level filter."
                        : "The engine recorded no tracked objects for this run, so there are no trajectories to inspect."
                    }
                    glyph={<TrackIcon width={17} height={17} />}
                  />
                )}
              </Panel>
            ) : (
              <>
                <Panel
                  title="Trajectory canvas"
                  sub={`${width} × ${height} · source-frame coordinates`}
                  actions={
                    <>
                      <span className="tag mono">{formatTrackId(activeId)}</span>
                      <label className="track-mobile-select">
                        <span className="sr-only">Selected track</span>
                        <select
                          value={activeId}
                          onChange={(event) => pickTrack(Number(event.target.value))}
                        >
                          {visibleTracks.map((track) => (
                            <option key={track.track_id} value={track.track_id}>
                              {formatTrackId(track.track_id)} · {track.observed.anomalies} events
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  }
                  bodyClassName="panel__body--flush"
                  foot={
                    <>
                      <span className={`dot ${trajectory.data?.available ? "dot--live" : "dot--warn"}`} />
                      {trajectory.data?.available
                        ? `${formatNumber(trajectory.data.points.length)} retained centroid points`
                        : "trajectory not retained for this track"}
                    </>
                  }
                >
                  {trajectory.status === "error" ? (
                    <div className="panel__pad">
                      <ErrorState error={trajectory.error} onRetry={trajectory.reload} compact />
                    </div>
                  ) : trajectory.status === "loading" && !trajectory.data ? (
                    <div className="panel__pad">
                      <LoadingRows rows={4} label="Loading trajectory" />
                    </div>
                  ) : trajectory.data?.available && trajectory.data.points.length > 0 ? (
                    <TrajectoryCanvas
                      trackId={activeId}
                      points={trajectory.data.points}
                      width={width}
                      height={height}
                      selectedFrame={focusFrame}
                      onSelectFrame={(frame) => inspectFrame(frame)}
                      timestamps={observedTimes}
                    />
                  ) : (
                    <div className="canvas-stub">
                      <div className="canvas-stub__grid" aria-hidden="true" />
                      <EmptyState
                        title="Trajectory not retained"
                        body={`${trajectory.data?.reason ??
                          "This session stores scores, speed and direction per observation, but not centroid coordinates."} In-process trajectories are kept only for the most recently analysed sessions and are lost when the API restarts; the observation-based movement panel below still reads persisted rows.`}
                        glyph={<TrackIcon width={17} height={17} />}
                      />
                    </div>
                  )}
                </Panel>

                <Panel
                  title="Movement over time"
                  sub={`${formatTrackId(activeId)} · measured speed and heading`}
                  actions={
                    motion.data ? <span className="tag">{formatNumber(motion.data.total)} rows</span> : undefined
                  }
                  foot={
                    <>
                      <span className="dot" />
                      Charts use recorded observation rows only; gaps are drawn as gaps, never as zero.
                    </>
                  }
                >
                  {motion.status === "error" ? (
                    <ErrorState error={motion.error} onRetry={motion.reload} compact title="Movement series unavailable" />
                  ) : motion.status === "loading" && !motion.data ? (
                    <LoadingRows rows={5} label="Loading movement series" />
                  ) : motion.data ? (
                    <MotionChart
                      observations={motion.data.observations}
                      totalObservations={motion.data.total}
                      meanSpeed={detail.data?.motion.mean_speed_px_s ?? null}
                      maxSpeed={detail.data?.motion.max_speed_px_s ?? null}
                      fps={fps}
                    />
                  ) : null}
                </Panel>

                <Panel
                  title="Observations"
                  sub={`${formatTrackId(activeId)} · earliest frame first`}
                  actions={
                    observations.data ? <span className="tag">{formatNumber(observations.data.total)} rows</span> : undefined
                  }
                  bodyClassName="panel__body--flush"
                  foot={
                    selectedObservation
                      ? <>
                          <span className="dot dot--live" />
                          Inspecting F{selectedObservation.frame} · {timeOfDay(selectedObservation.ts_utc)} ·{" "}
                          <LevelBadge level={selectedObservation.level} />
                        </>
                      : <>
                          <span className="dot" />
                          Select a row or a trajectory point to inspect one observation.
                        </>
                  }
                >
                  {observations.status === "error" ? (
                    <div className="panel__pad">
                      <ErrorState error={observations.error} onRetry={observations.reload} compact />
                    </div>
                  ) : observations.status === "loading" && !observations.data ? (
                    <div className="panel__pad">
                      <LoadingRows rows={5} label="Loading observations" />
                    </div>
                  ) : observations.data && observations.data.observations.length > 0 ? (
                    <>
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Frame</th>
                              <th>Time</th>
                              <th>Level</th>
                              <th>Fused</th>
                              <th>Rule</th>
                              <th>ML</th>
                              <th>Scene</th>
                              <th>Speed</th>
                              <th>Heading</th>
                              <th><span className="sr-only">Inspect</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {observations.data.observations.map((row) => (
                              <tr
                                key={row.event_id}
                                className={`is-clickable ${row.frame === focusFrame ? "is-active" : ""}`.trim()}
                                onClick={() => inspectFrame(row.frame)}
                              >
                                <td className="mono">{row.frame}</td>
                                <td className="mono">{timeOfDay(row.ts_utc)}</td>
                                <td>
                                  <LevelBadge level={row.level} />
                                </td>
                                <td>
                                  <Score value={row.scores.fused} />
                                </td>
                                <td>
                                  <Score value={row.scores.rule} />
                                </td>
                                <td>
                                  <Score value={row.scores.ml} />
                                </td>
                                <td>
                                  <Score value={row.scores.scene} />
                                </td>
                                <td className="mono">
                                  {row.motion.speed_px_s === null
                                    ? "—"
                                    : `${row.motion.speed_px_s.toFixed(0)} px/s`}
                                </td>
                                <td className="mono">
                                  {row.motion.direction_deg === null
                                    ? "—"
                                    : `${row.motion.direction_deg.toFixed(0)}°`}
                                </td>
                                <td>
                                  <button
                                    type="button"
                                    className="btn btn--quiet btn--sm"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      inspectFrame(row.frame, true);
                                    }}
                                    aria-label={`Inspect frame ${row.frame} in the frame viewer`}
                                  >
                                    <ImageIcon width={12} height={12} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="panel__pad panel__pad--tight">
                        <Pager
                          total={observations.data.total}
                          limit={OBSERVATION_PAGE}
                          offset={offset}
                          onChange={setOffset}
                          label="observations"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="panel__pad">
                      <EmptyState
                        compact
                        title="No observations on this page"
                        body="The track index reports this object, but no observation rows were returned for this page."
                      />
                    </div>
                  )}
                </Panel>

                <section id="track-frame-investigation">
                  <Panel
                    bodyClassName="panel__body--flush"
                    title="Frame investigation"
                    sub={`${formatTrackId(activeId)} · retained previews within F${firstFrame ?? "—"}–F${lastFrame ?? "—"}`}
                    actions={
                      scopedMedia.data
                        ? <span className="tag">{formatNumber(scopedMedia.data.preview_count)} previews</span>
                        : undefined
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
                    <FrameInvestigator
                      sessionId={selectedId}
                      media={scopedMedia}
                      events={anomalies.data?.anomalies ?? null}
                      eventsReady={Boolean(anomalies.data) || anomalies.status === "error"}
                      eventsError={anomalies.status === "error"}
                      eventTotal={anomalies.data?.total ?? 0}
                      focusFrame={focusFrame}
                    />
                  </Panel>
                </section>
              </>
            )}
          </div>

          <div className="stack gap-14">
            <Panel
              title="Track index"
              sub={tracks.data ? `${formatNumber(tracks.data.total)} objects · measured` : "objects in session"}
              actions={tracks.refreshing ? <span className="tag">syncing</span> : undefined}
            >
              <TrackIndex
                tracks={tracks}
                activeId={activeId}
                query={query}
                onQuery={setQuery}
                levelFilter={levelFilter}
                onLevelFilter={setLevelFilter}
                sort={sort}
                onSort={setSort}
                onPick={pickTrack}
              />
            </Panel>

            {activeId !== null && (
              <>
                <Panel
                  title="Track telemetry"
                  sub={`${formatTrackId(activeId)} · measured lifecycle and motion`}
                  actions={detail.refreshing ? <span className="tag">syncing</span> : undefined}
                >
                  {detail.status === "error" ? (
                    <ErrorState error={detail.error} onRetry={detail.reload} compact title="Track detail unavailable" />
                  ) : detail.status === "loading" && !detail.data ? (
                    <LoadingRows rows={6} label="Loading telemetry" />
                  ) : detail.data ? (
                    <TrackTelemetry
                      detail={detail.data}
                      directions={motion.data ? summarizeDirections(motion.data.observations) : null}
                      fps={fps}
                    />
                  ) : (
                    <p className="hint hint--flush">No detail was returned for this track.</p>
                  )}
                </Panel>

                <Panel
                  title="Related anomalies"
                  sub={`${formatTrackId(activeId)} · fused elevated events`}
                  actions={
                    anomalies.data ? <span className="tag">{formatNumber(anomalies.data.total)}</span> : undefined
                  }
                  bodyClassName="panel__body--flush"
                  foot={
                    <>
                      <span className="dot" />
                      Selecting an event jumps to its frame when that preview is retained.
                    </>
                  }
                >
                  <TrackAnomalies
                    trackId={activeId}
                    anomalies={anomalies}
                    activeFrame={focusFrame}
                    onInspect={(frame) => inspectFrame(frame, true)}
                  />
                </Panel>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
