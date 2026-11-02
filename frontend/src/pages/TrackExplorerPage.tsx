import { useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { LevelBadge, LevelMeter, Pager, Score, levelClass } from "../components/SessionBits";
import { ArrowRightIcon, TrackIcon } from "../components/icons";
import { formatDuration, formatNumber } from "../lib/format";
import type { Level, TrajectoryPoint } from "../lib/types";

const OBSERVATION_PAGE = 20;

function pad(trackId: number): string {
  return `T${String(trackId).padStart(2, "0")}`;
}

function TrajectoryCanvas({
  points,
  width,
  height,
}: {
  points: TrajectoryPoint[];
  width: number;
  height: number;
}) {
  const usable = points.filter(
    (point): point is TrajectoryPoint & { x: number; y: number } =>
      point.x !== null && point.y !== null,
  );
  const path = usable
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const first = usable[0];
  const last = usable[usable.length - 1];

  return (
    <div className="trajectory">
      <span className="trajectory__grid" aria-hidden="true" />
      <svg
        className="trajectory__svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Persisted path for ${pad(0)}, ${usable.length} points`}
      >
        <path className="trajectory__path" d={path} />
        {usable.map((point, index) => (
          <circle
            key={`${point.frame}-${index}`}
            cx={point.x}
            cy={point.y}
            r={Math.max(width, height) / 220}
            className={`trajectory__point ${levelClass(point.level)}`}
          />
        ))}
        {first && (
          <circle
            cx={first.x}
            cy={first.y}
            r={Math.max(width, height) / 90}
            className="trajectory__marker trajectory__marker--start"
          />
        )}
        {last && (
          <circle
            cx={last.x}
            cy={last.y}
            r={Math.max(width, height) / 90}
            className="trajectory__marker trajectory__marker--end"
          />
        )}
      </svg>
      <span className="trajectory__stamp mono">
        {usable.length} points · frame {first?.frame ?? "—"}–{last?.frame ?? "—"}
      </span>
    </div>
  );
}

export function TrackExplorerPage() {
  const { selected, selectedId } = useSession();
  const [pickedTrack, setPickedTrack] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);

  const trackKey = `${selectedId ?? "none"}`;
  const tracks = useResource(
    (signal) => api.tracks(selectedId as string, { limit: 60, sort: "anomalies" }, signal),
    { enabled: Boolean(selectedId), key: trackKey },
  );

  const activeId =
    pickedTrack !== null && tracks.data?.tracks.some((t) => t.track_id === pickedTrack)
      ? pickedTrack
      : (tracks.data?.tracks[0]?.track_id ?? null);

  const detailKey = `${trackKey}:${activeId ?? "none"}`;
  const detail = useResource(
    (signal) => api.track(selectedId as string, activeId as number, signal),
    { enabled: Boolean(selectedId) && activeId !== null, key: detailKey },
  );
  const trajectory = useResource(
    (signal) => api.trackTrajectory(selectedId as string, activeId as number, signal),
    { enabled: Boolean(selectedId) && activeId !== null, key: detailKey },
  );
  const observations = useResource(
    (signal) =>
      api.trackObservations(
        selectedId as string,
        activeId as number,
        { limit: OBSERVATION_PAGE, offset },
        signal,
      ),
    { enabled: Boolean(selectedId) && activeId !== null, key: `${detailKey}:${offset}` },
  );

  const pickTrack = (trackId: number) => {
    setPickedTrack(trackId);
    setOffset(0);
  };

  const width = selected?.processing.width ?? 1280;
  const height = selected?.processing.height ?? 720;

  return (
    <>
      <PageHeader
        eyebrow="Trajectories"
        title="Track Explorer"
        lede="Per-object telemetry for a persisted session: measured motion, fused levels and the observation rows behind them."
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
      ) : (
        <div className="layout-main-aside">
          <div className="stack gap-14">
            <Panel
              title="Trajectory canvas"
              sub={`${selected.processing.width ?? "—"} × ${selected.processing.height ?? "—"} · frame coordinates`}
              actions={
                activeId !== null ? (
                  <span className="tag mono">{pad(activeId)}</span>
                ) : undefined
              }
              bodyClassName="panel__body--flush"
              foot={
                <>
                  <span className={`dot ${trajectory.data?.available ? "dot--live" : "dot--warn"}`} />
                  {trajectory.data?.available
                    ? `${trajectory.data.points} persisted points`
                    : "centroid path not persisted for this session"}
                </>
              }
            >
              {trajectory.status === "error" ? (
                <div className="panel__pad">
                  <ErrorState error={trajectory.error} onRetry={trajectory.reload} compact />
                </div>
              ) : trajectory.status === "loading" ? (
                <div className="panel__pad">
                  <LoadingRows rows={4} label="Loading trajectory" />
                </div>
              ) : trajectory.data?.available && trajectory.data.points.length > 0 ? (
                <TrajectoryCanvas points={trajectory.data.points} width={width} height={height} />
              ) : (
                <div className="canvas-stub">
                  <div className="canvas-stub__grid" aria-hidden="true" />
                  <EmptyState
                    title="Path not persisted"
                    body={
                      trajectory.data?.reason ??
                      "This session stores scores, speed and direction per observation, but not centroid coordinates."
                    }
                    glyph={<TrackIcon width={17} height={17} />}
                  />
                </div>
              )}
            </Panel>

            <Panel
              title="Observations"
              sub={activeId !== null ? `Track ${pad(activeId)} · newest scoring first` : "Select a track"}
              actions={
                observations.data ? (
                  <span className="tag">{formatNumber(observations.data.total)} rows</span>
                ) : undefined
              }
              bodyClassName="panel__body--flush"
            >
              {activeId === null ? (
                <div className="panel__pad">
                  <EmptyState
                    compact
                    title="No tracks in this session"
                    body="The engine recorded no tracked objects for the selected run."
                  />
                </div>
              ) : observations.status === "error" ? (
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
                          <th>Level</th>
                          <th>Fused</th>
                          <th>Rule</th>
                          <th>ML</th>
                          <th>Scene</th>
                          <th>Speed</th>
                          <th>Heading</th>
                        </tr>
                      </thead>
                      <tbody>
                        {observations.data.observations.map((row) => (
                          <tr key={row.event_id}>
                            <td className="mono">{row.frame}</td>
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
                      label="rows"
                    />
                  </div>
                </>
              ) : (
                <div className="panel__pad">
                  <EmptyState
                    compact
                    title="No observations for this track"
                    body="The track index reports this object, but no observation rows were returned."
                  />
                </div>
              )}
            </Panel>
          </div>

          <div className="stack gap-14">
            <Panel
              title="Track index"
              sub={tracks.data ? `${tracks.data.total} objects · worst first` : "objects in session"}
              actions={
                tracks.refreshing ? <span className="tag">syncing</span> : undefined
              }
            >
              {tracks.status === "error" ? (
                <ErrorState error={tracks.error} onRetry={tracks.reload} compact />
              ) : tracks.status === "loading" && !tracks.data ? (
                <LoadingRows rows={5} label="Loading tracks" />
              ) : tracks.data && tracks.data.tracks.length > 0 ? (
                <div className="track-list">
                  {tracks.data.tracks.map((track) => (
                    <button
                      key={track.track_id}
                      type="button"
                      className={`track-row ${track.track_id === activeId ? "is-active" : ""}`.trim()}
                      onClick={() => pickTrack(track.track_id)}
                      aria-pressed={track.track_id === activeId}
                    >
                      <span className="track-row__id mono">{pad(track.track_id)}</span>
                      <span className="track-row__body">
                        <span className="track-row__line">
                          <span className="track-row__color">
                            {track.appearance.color ?? "unknown"}
                            {track.appearance.shape ? ` · ${track.appearance.shape}` : ""}
                          </span>
                          <span className="mono track-row__count">
                            {track.observed.anomalies}/{track.observed.observations}
                          </span>
                        </span>
                        <LevelMeter levels={track.observed.levels} />
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <EmptyState compact title="No tracks recorded" body="This session contains no tracked objects." />
              )}
            </Panel>

            <Panel title="Track telemetry" sub={activeId !== null ? `Track ${pad(activeId)}` : "no selection"}>
              {detail.status === "error" ? (
                <ErrorState error={detail.error} onRetry={detail.reload} compact />
              ) : detail.status === "loading" && !detail.data ? (
                <LoadingRows rows={5} label="Loading telemetry" />
              ) : detail.data ? (
                <div className="stack gap-14">
                  <div className="rows rows--tight">
                    <div className="row">
                      <span className="row__key">Worst level</span>
                      <span className="row__value">
                        <LevelBadge level={detail.data.observed.worst_level as Level} />
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Observed</span>
                      <span className="row__value mono">
                        {formatDuration(detail.data.observed.duration_s)}
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Mean speed</span>
                      <span className="row__value mono">
                        {detail.data.motion.mean_speed_px_s?.toFixed(1) ?? "—"} px/s
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Max speed</span>
                      <span className="row__value mono">
                        {detail.data.motion.max_speed_px_s?.toFixed(1) ?? "—"} px/s
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Path length</span>
                      <span className="row__value mono">
                        {detail.data.motion.path_length_px?.toFixed(1) ?? "—"} px
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Straightness</span>
                      <span className="row__value mono">
                        {detail.data.motion.straightness?.toFixed(2) ?? "—"}
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Max fused</span>
                      <span className="row__value">
                        <Score value={detail.data.motion.max_fused_score} />
                      </span>
                    </div>
                  </div>

                  {Object.keys(detail.data.direction_profile.histogram).length > 0 && (
                    <div className="histogram">
                      <span className="mini-label">Heading distribution</span>
                      {Object.entries(detail.data.direction_profile.histogram).map(([bin, share]) => (
                        <span className="histogram__row" key={bin}>
                          <span className="histogram__bin mono">{bin}</span>
                          <span className="histogram__track">
                            <span className="histogram__fill" style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
                          </span>
                          <span className="histogram__value mono">{(share * 100).toFixed(0)}%</span>
                        </span>
                      ))}
                    </div>
                  )}

                  <p className="note-line">
                    <span className="dot" />
                    Speeds sourced from {detail.data.motion.speed_source}
                    <span className="dim"> · {detail.data.direction_profile.source}</span>
                  </p>
                </div>
              ) : null}
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}
