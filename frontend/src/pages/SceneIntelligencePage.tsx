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
import { SceneQuantum } from "../components/SceneQuantum";
import { ObjectRegistry } from "../components/ObjectRegistry";

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
    <div className="scene-surface">
      <PageHeader
        eyebrow="Scene core"
        title="Scene Intelligence"
        lede="Every tracked object in this clip, the baseline it was measured against, and where its observations deviate."
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
        </Panel>
      ) : !sceneData ? (
        <Panel>
          <LoadingRows rows={8} label="Loading scene intelligence" />
        </Panel>
      ) : (
        <>
          <section className="scene-stage" aria-labelledby="scene-quantum-title">
            <SceneQuantum
              sessionId={selectedId}
              scene={sceneData}
              tracks={tracks.data?.tracks ?? []}
              events={events.data?.rows ?? []}
              eventsTotal={events.data?.total ?? 0}
              tracksTotal={tracks.data?.total ?? 0}
              levels={session.data?.counts.levels ?? null}
              thresholds={{
                suspicious: config.data?.anomaly.threshold_suspicious ?? null,
                irregular: config.data?.anomaly.threshold_irregular ?? null,
              }}
            />
          </section>

          <section className="scene-registry-band" aria-label="Tracked objects in this scene">
            <ObjectRegistry
              tracks={tracks.data?.tracks ?? []}
              total={tracks.data?.total ?? 0}
              sessionId={selectedId}
              title="Tracked objects in this scene"
              sub="Named identities · measured speed, path and worst fused level"
              events={events.data?.rows ?? null}
              thresholds={{
                suspicious: config.data?.anomaly.threshold_suspicious ?? null,
                irregular: config.data?.anomaly.threshold_irregular ?? null,
              }}
            />
          </section>

          <section className="scene-duo" aria-label="Calibration and movement baseline">
            <SceneCalibration scene={sceneData} config={config} />
            <SceneMovement
              speed={sceneData.speed_baseline}
              directions={sceneData.directions}
            />
          </section>

          <section className="scene-holo" aria-labelledby="scene-spatial-title">
            <SectionHeader
              id="scene-spatial-title"
              title="Spatial scene"
              meta={
                session.data?.artifacts.trajectories
                  ? "Retained centroids · measured paths"
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

          <section className="scene-investigation-band" aria-labelledby="scene-investigation-title">
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

        </>
      )}
    </div>
  );
}
