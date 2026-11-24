import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "../app/SessionProvider";
import { api, mediaUrl } from "../lib/api";
import { useResource, type ResourceState } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { LevelBadge, Pager, Score } from "../components/SessionBits";
import { StatusPill } from "../components/StatusPill";
import { TrackIndex } from "../components/TrackIndex";
import { TrackTelemetry } from "../components/TrackTelemetry";
import { TrackAnomalies } from "../components/TrackAnomalies";
import { TrajectoryCanvas } from "../components/TrajectoryCanvas";
import { MotionChart } from "../components/MotionChart";
import { FrameInvestigator } from "../components/FrameInvestigator";
import { LevelVerdict } from "../components/LevelVerdict";
import { trackEvidenceSummary } from "../lib/anomalies";
import { ArrowRightIcon, ImageIcon, TrackIcon } from "../components/icons";
import { formatNumber } from "../lib/format";
import {
  BarList,
  LEVEL_COLOURS,
  LEVEL_ORDER,
  LevelDonut,
  LevelLegend,
  ScatterPlot,
} from "../components/charts";
import {
  FleetRoster,
  LevelPlaybook,
  ObjectConstellation,
  QuantumHero,
  type ConstellationObject,
} from "../components/quantum";
import {
  appearanceLabel,
  classLabel,
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
  const activeTrack = visibleTracks.find((track) => track.track_id === activeId) ?? null;
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
  const config = useResource(api.config);
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

  /** Evidence for the selected object only: these events were fetched for it. */
  const activeEvidence = useMemo(() => {
    if (!anomalies.data || activeId === null) return null;
    return trackEvidenceSummary(anomalies.data.anomalies).get(activeId) ?? undefined;
  }, [anomalies.data, activeId]);

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

  const fleetLevels = useMemo(() => {
    const totals = { Normal: 0, Suspicious: 0, Irregular: 0 };
    for (const track of visibleTracks) {
      for (const level of LEVEL_ORDER) totals[level] += track.observed.levels[level] ?? 0;
    }
    return totals;
  }, [visibleTracks]);

  const fleetPoints = useMemo(
    () =>
      visibleTracks
        .filter(
          (track) =>
            track.motion.max_speed_px_s !== null && track.motion.max_fused_score !== null,
        )
        .map((track) => ({
          x: track.motion.max_speed_px_s as number,
          y: track.motion.max_fused_score as number,
          label: `T${String(track.track_id).padStart(2, "0")} · ${track.observed.worst_level}`,
          color: LEVEL_COLOURS[track.observed.worst_level],
          size: Math.min(9, 3.5 + track.observed.observations / 120),
        })),
    [visibleTracks],
  );

  const fleetLeaders = useMemo(
    () =>
      [...visibleTracks]
        .sort((a, b) => b.observed.anomalies - a.observed.anomalies)
        .slice(0, 6)
        .map((track) => ({
          key: String(track.track_id),
          label: `T${String(track.track_id).padStart(2, "0")} · ${appearanceLabel(track.appearance)}`,
          value: track.observed.anomalies,
          color: LEVEL_COLOURS[track.observed.worst_level],
          hint: `${formatNumber(track.observed.observations)} obs`,
        })),
    [visibleTracks],
  );

  // Every visible object is fetched so the constellation and roster can name
  // all of them at once. The fan-out is capped; the remainder stay in the index.
  const constellationTracks = useMemo(() => visibleTracks.slice(0, 18), [visibleTracks]);
  const constellationKey = constellationTracks
    .map((track) => track.track_id)
    .join(",");
  const fleetTrajectories = useResource(
    async (signal) => {
      const settled = await Promise.allSettled(
        constellationTracks.map((track) =>
          api.trackTrajectory(selectedId as string, track.track_id, signal),
        ),
      );
      return constellationTracks.map((track, index): ConstellationObject => {
        const result = settled[index];
        const payload = result.status === "fulfilled" ? result.value : null;
        return {
          trackId: track.track_id,
          level: track.observed.worst_level,
          observations: track.observed.observations,
          events: track.observed.anomalies,
          available: Boolean(payload?.available),
          points: payload?.points ?? [],
        };
      });
    },
    {
      enabled: Boolean(selectedId) && constellationTracks.length > 0,
      key: `${sessionKey}:${constellationKey}`,
    },
  );

  const fleetObservations = visibleTracks.reduce(
    (sum, track) => sum + track.observed.observations,
    0,
  );
  const fleetElevated = visibleTracks.filter((track) => track.observed.anomalies > 0).length;
  const fleetRegular = visibleTracks.filter(
    (track) => track.observed.worst_level === "Normal",
  ).length;
  const fleetPeakSpeed = visibleTracks.reduce(
    (peak, track) => Math.max(peak, track.motion.max_speed_px_s ?? 0),
    0,
  );

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
            annotated_url: mediaUrl(frame.frame_url as string),
            original_url: mediaUrl(
              (frame.frame_url as string).replace(
                "kind=annotated",
                "kind=original",
              ),
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
        lede="Per-object telemetry for the selected session."
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
        <div className="layout-main-aside track-workspace">
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
                <section className="track-deck" aria-labelledby="track-identity">
                  <div className="track-deck__lead">
                    <span className="mini-label">Selected object</span>
                    <h2 className="track-deck__id mono" id="track-identity">
                      {formatTrackId(activeId)}
                    </h2>
                    <div className="track-deck__badges">
                      <LevelBadge level={activeTrack?.observed.worst_level ?? null} />
                      <StatusPill tone="muted" size="sm">
                        {activeTrack
                          ? appearanceLabel(activeTrack.appearance)
                          : "class not reported"}
                      </StatusPill>
                    </div>
                  </div>
                  <dl className="track-deck__facts">
                    <div>
                      <dt>Observations</dt>
                      <dd className="mono">
                        {formatNumber(activeTrack?.observed.observations)}
                      </dd>
                    </div>
                    <div>
                      <dt>Elevated events</dt>
                      <dd className="mono">{formatNumber(activeTrack?.observed.anomalies)}</dd>
                    </div>
                    <div>
                      <dt>Lifecycle</dt>
                      <dd className="mono">
                        F{activeTrack?.frames.first ?? "—"}–F{activeTrack?.frames.last ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Max speed</dt>
                      <dd className="mono">
                        {activeTrack?.motion.max_speed_px_s === null ||
                        activeTrack?.motion.max_speed_px_s === undefined
                          ? "—"
                          : `${activeTrack.motion.max_speed_px_s.toFixed(0)} px/s`}
                      </dd>
                    </div>
                  </dl>

                  {activeTrack && (
                    <LevelVerdict
                      level={activeTrack.observed.worst_level}
                      levels={activeTrack.observed.levels}
                      observations={activeTrack.observed.observations}
                      maxFused={activeTrack.motion.max_fused_score}
                      thresholds={{
                        suspicious: config.data?.anomaly?.threshold_suspicious ?? null,
                        irregular: config.data?.anomaly?.threshold_irregular ?? null,
                      }}
                      evidence={activeEvidence}
                      className="track-deck__why"
                    />
                  )}
                </section>

                <QuantumHero
                  kicker="Track constellation · quantum scan"
                  title={
                    <>
                      Every object is a <em>signal</em>
                    </>
                  }
                  description="All tracked objects in this run are drawn together, named and colour-coded by their worst measured level. Cyan is regular, amber is suspicious, magenta is irregular. Select any object to focus its path, observations and evidence — nothing is hidden behind a chart."
                  status={`${visibleTracks.length} objects in scope`}
                  metrics={[
                    {
                      label: "Objects",
                      value: formatNumber(visibleTracks.length),
                      hint: `${formatNumber(fleetRegular)} regular`,
                      tone: "accent",
                    },
                    {
                      label: "Elevated",
                      value: formatNumber(fleetElevated),
                      hint: "carry an event",
                      tone: "warn",
                    },
                    {
                      label: "Observations",
                      value: formatNumber(fleetObservations),
                      hint: "persisted rows",
                    },
                    {
                      label: "Peak speed",
                      value: `${formatNumber(fleetPeakSpeed, 0)} px/s`,
                      hint: "fastest object",
                      tone: "bad",
                    },
                  ]}
                />

                <Panel
                  title="Level playbook"
                  sub="What the three bands mean for these objects"
                  actions={<LevelLegend />}
                >
                  <LevelPlaybook levels={fleetLevels} />
                </Panel>

                <Panel
                  title="Object constellation"
                  sub={`${constellationTracks.length} objects · measured centroid paths in ${width} × ${height} source coordinates`}
                  actions={<LevelLegend />}
                  foot={
                    fleetTrajectories.status === "error" ? (
                      <>
                        <span className="dot dot--warn" /> The trajectory requests failed; the index,
                        roster and per-object detail below still read persisted rows.
                      </>
                    ) : (
                      <>
                        <span className="dot dot--live" /> Paths are drawn only from retained
                        centroids; a gap in a path is missing evidence, not zero movement.
                      </>
                    )
                  }
                >
                  {fleetTrajectories.status === "error" ? (
                    <ErrorState
                      error={fleetTrajectories.error}
                      onRetry={fleetTrajectories.reload}
                      compact
                      title="Constellation trajectories unavailable"
                    />
                  ) : fleetTrajectories.status === "loading" && !fleetTrajectories.data ? (
                    <LoadingRows rows={4} label="Loading object constellation" />
                  ) : (
                    <ObjectConstellation
                      objects={fleetTrajectories.data ?? []}
                      width={width}
                      height={height}
                      activeId={activeId}
                      onPick={pickTrack}
                    />
                  )}
                </Panel>

                <Panel
                  title="Fleet roster"
                  sub={`${formatNumber(visibleTracks.length)} objects named · click to focus one`}
                  actions={<LevelLegend />}
                >
                  {activeId !== null && (
                    <p className="quantum-panel-intro">
                      Active object <span className="mono">{formatTrackId(activeId)}</span> is
                      highlighted in the constellation and in this roster. Bars under each name
                      split its observations by the level the engine measured.
                    </p>
                  )}
                  <FleetRoster
                    objects={visibleTracks.map((track) => ({
                      trackId: track.track_id,
                      level: track.observed.worst_level,
                      observations: track.observed.observations,
                      anomalies: track.observed.anomalies,
                      levels: track.observed.levels,
                      maxSpeed: track.motion.max_speed_px_s,
                      meanSpeed: track.motion.mean_speed_px_s,
                      firstFrame: track.frames.first,
                      lastFrame: track.frames.last,
                      colour: track.appearance.color,
                      shape: track.appearance.shape,
                      className: classLabel(track.appearance),
                      durationS: track.observed.duration_s,
                    }))}
                    activeId={activeId}
                    onPick={pickTrack}
                  />
                </Panel>

                <Panel
                  title="Object map"
                  sub={`${formatNumber(visibleTracks.length)} tracked objects · measured speed and peak fused score`}
                  actions={<LevelLegend />}
                >
                  <div className="fleet-charts">
                    <ScatterPlot
                      points={fleetPoints}
                      xLabel="peak speed px/s"
                      yLabel="peak fused score"
                      ariaLabel={`${fleetPoints.length} tracked objects plotted by peak speed and peak fused score`}
                    />
                    <div className="fleet-side">
                      <LevelDonut levels={fleetLevels} centerLabel="observations" size={136} />
                      <BarList
                        ariaLabel="Objects by elevated observations"
                        rows={fleetLeaders}
                        formatValue={(value) => `${formatNumber(value)} ev`}
                        emptyLabel="No elevated object in this filter"
                      />
                    </div>
                  </div>
                </Panel>

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
                        ? `${formatNumber(trajectory.data.points.length)} ${
                            trajectory.data.source === "persisted"
                              ? "stored"
                              : "retained"
                          } centroid points`
                        : "no stored trajectory for this track"}
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
                        title="No stored trajectory"
                        body={`${trajectory.data?.reason ??
                          "No centroid coordinates are stored for this track."} Movement, observations and events below still read persisted rows; missing coordinates are never reconstructed.`}
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
                    <div className="cinema">
                      <FrameInvestigator
                        sessionId={selectedId}
                        media={scopedMedia}
                        events={anomalies.data?.anomalies ?? null}
                        eventsReady={Boolean(anomalies.data) || anomalies.status === "error"}
                        eventsError={anomalies.status === "error"}
                        eventTotal={anomalies.data?.total ?? 0}
                        focusFrame={focusFrame}
                      />
                    </div>
                  </Panel>
                </section>
              </>
            )}
          </div>

          <div className="stack gap-14 track-workspace__rail">
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
