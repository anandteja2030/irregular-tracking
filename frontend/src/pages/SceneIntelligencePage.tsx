import { useResource } from "../hooks/useResource";
import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import type { AnomalyItem, TrackItem } from "../lib/types";
import type {
  LoadedSceneEvents,
  SceneTrajectoryLoad,
} from "../lib/scene";
import { formatNumber } from "../lib/format";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SectionHeader } from "../components/SectionHeader";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { SceneIcon } from "../components/icons";
import { SceneCalibration } from "../components/SceneCalibration";
import { SceneMovement } from "../components/SceneMovement";
import { SceneSpatial } from "../components/SceneSpatial";
import { SceneInvestigation } from "../components/SceneInvestigation";

const FETCH_CHUNK = 500;
const MAX_EVENTS = 2_000;
const MAX_TRAJECTORY_TRACKS = 24;

/** Bounded event read for scene-event and zone-evidence summaries. */
async function loadSceneEvents(
  sessionId: string,
  signal: AbortSignal,
): Promise<LoadedSceneEvents> {
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

/** Fetch only retained trajectories for the highest-event tracks, with a hard
 * cap so a large session cannot trigger an unbounded request fan-out. */
async function loadSceneTrajectories(
  sessionId: string,
  tracks: TrackItem[],
  totalTracks: number,
  signal: AbortSignal,
): Promise<SceneTrajectoryLoad> {
  const selected = tracks.slice(0, MAX_TRAJECTORY_TRACKS);
  const settled = await Promise.allSettled(
    selected.map((track) => api.trackTrajectory(sessionId, track.track_id, signal)),
  );
  let failed = 0;
  const rows = settled.map((result, index) => {
    const trackId = selected[index].track_id;
    if (result.status === "rejected") {
      failed += 1;
      return {
        trackId,
        points: [],
        available: false,
        reason: "Trajectory request failed.",
      };
    }
    return {
      trackId,
      points: result.value.points,
      available: result.value.available,
      reason: result.value.reason,
    };
  });
  return {
    tracks: rows,
    requested: selected.length,
    totalTracks,
    failed,
  };
}

export function SceneIntelligencePage() {
  const { selected, selectedId } = useSession();
  const sessionKey = selectedId ?? "none";
  const config = useResource(api.config);
  const session = useResource(
    (signal) => api.session(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const scene = useResource(
    (signal) => api.scene(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const tracks = useResource(
    (signal) =>
      api.tracks(selectedId as string, { sort: "anomalies", limit: 200 }, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const events = useResource(
    (signal) => loadSceneEvents(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: sessionKey },
  );
  const trajectoryEnabled =
    Boolean(selectedId) &&
    Boolean(session.data?.artifacts.trajectories) &&
    Boolean(tracks.data);
  const trajectoryKey = tracks.data
    ? `${sessionKey}:${tracks.data.tracks
        .slice(0, MAX_TRAJECTORY_TRACKS)
        .map((track) => track.track_id)
        .join(",")}`
    : `${sessionKey}:pending`;
  const trajectories = useResource(
    (signal) =>
      loadSceneTrajectories(
        selectedId as string,
        tracks.data?.tracks ?? [],
        tracks.data?.total ?? 0,
        signal,
      ),
    {
      enabled: trajectoryEnabled,
      key: trajectoryKey,
    },
  );

  const sceneData = scene.data;
  const zoneConfig = config.data?.zone;

  return (
    <>
      <PageHeader
        eyebrow="Scene baseline"
        title="Scene Intelligence"
        lede="Calibration evidence, learned movement, retained spatial coordinates and the elevated events that deviate from the scene. Missing artifacts stay unavailable; no coordinate, zone or measurement is invented."
        aside={
          selected ? (
            <div className="scene-header-aside">
              <span className="pill pill--accent mono">
                <SceneIcon width={11} height={11} />
                {selected.session}
              </span>
              <span className={`pill ${zoneConfig?.enabled ? "pill--ok" : "pill--mono-dim"}`}>
                {zoneConfig
                  ? zoneConfig.enabled
                    ? `${zoneConfig.zones.length} zones active`
                    : "Zones disabled"
                  : "Reading zones"}
              </span>
            </div>
          ) : (
            <span className="pill pill--mono-dim">No session</span>
          )
        }
      />

      {!selectedId ? (
        <Panel>
          <EmptyState
            title="No session selected"
            body="Scene intelligence is scoped to a persisted analysis run. Select a session in the top bar to read its calibration, movement baseline and retained spatial evidence."
            glyph={<SceneIcon width={17} height={17} />}
          />
        </Panel>
      ) : scene.status === "error" ? (
        <Panel>
          <ErrorState
            error={scene.error}
            onRetry={scene.reload}
            compact={false}
            title="Scene intelligence unavailable"
          />
          <p className="hint hint--flush">
            The scene endpoint could not be read. No fallback baseline, density map or zone
            activity is shown.
          </p>
        </Panel>
      ) : !sceneData ? (
        <Panel>
          <LoadingRows rows={8} label="Loading scene intelligence" />
        </Panel>
      ) : (
        <>
          <section className="section">
            <SceneCalibration scene={sceneData} config={config} />
          </section>

          <section className="section">
            <SceneMovement
              speed={sceneData.speed_baseline}
              directions={sceneData.directions}
            />
          </section>

          <section className="section" aria-labelledby="scene-spatial-title">
            <SectionHeader
              id="scene-spatial-title"
              title="Spatial scene"
              meta={
                session.data?.artifacts.trajectories
                  ? "Retained centroids"
                  : session.status === "error"
                    ? "Retention unknown"
                    : "No retained coordinates"
              }
            />
            <SceneSpatial
              sessionId={selectedId}
              session={session}
              tracks={tracks}
              trajectories={trajectories}
              events={events}
              zones={zoneConfig?.zones ?? []}
              zonesEnabled={Boolean(zoneConfig?.enabled)}
            />
          </section>

          <section className="section" aria-labelledby="scene-investigation-title">
            <SectionHeader
              id="scene-investigation-title"
              title="Scene investigation"
              meta={
                <>
                  {formatNumber(sceneData.deviations.affected_tracks)} affected tracks ·{" "}
                  {formatNumber(sceneData.deviations.above_0_2)} observations ≥0.20
                </>
              }
            />
            <SceneInvestigation
              sessionId={selectedId}
              scene={sceneData}
              events={events}
              tracks={tracks}
            />
          </section>

          <section className="section">
            <Panel title="Reading & limits" sub="What this surface can and cannot claim">
              <div className="scene-limits">
                <div>
                  <span className="note__label">API notes</span>
                  {sceneData.notes.length > 0 ? (
                    <ul className="note-list">
                      {sceneData.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="hint hint--flush">No additional API notes for this session.</p>
                  )}
                </div>
                <div>
                  <span className="note__label">Session limits</span>
                  {session.data?.limitations.length ? (
                    <ul className="note-list">
                      {session.data.limitations.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="hint hint--flush">
                      {session.status === "error"
                        ? "Session limitation details could not be read."
                        : "No additional session limitations were reported."}
                    </p>
                  )}
                </div>
                <div>
                  <span className="note__label">Reading rules</span>
                  <ul className="note-list">
                    <li>
                      Speed and trajectory values are pixels and seconds from the source frame;
                      no camera calibration or metric units are implied.
                    </li>
                    <li>
                      Calibration is a readiness state and evidence count, not a probability.
                      The API exposes no statistical confidence and no separate
                      failed-calibration flag.
                    </li>
                    <li>
                      Density is the count of retained centroid points per cell. It is not
                      occupancy, dwell time or optical density.
                    </li>
                    <li>
                      Zone rows include only elevated events with retained structured evidence.
                      Configured rectangles are not activity, and absence of evidence is not
                      absence of activity.
                    </li>
                    <li>
                      A positive scene score means deviation from this clip's learned baseline;
                      it does not establish a cause or intent.
                    </li>
                  </ul>
                </div>
              </div>
            </Panel>
          </section>
        </>
      )}
    </>
  );
}
