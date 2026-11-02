import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { SceneIcon } from "../components/icons";
import { formatNumber } from "../lib/format";
import type { StatSummary } from "../lib/types";

function SpeedRange({ stats }: { stats: StatSummary }) {
  const min = stats.min ?? 0;
  const max = stats.max ?? Math.max(stats.p90 ?? stats.p50, 1);
  const span = Math.max(max - min, 1);
  const at = (value: number) => ((value - min) / span) * 100;
  return (
    <div className="range">
      <div className="range__bar" aria-hidden="true">
        <span className="range__band" style={{ left: `${at(stats.p10)}%`, width: `${Math.max(at(stats.p90 ?? max) - at(stats.p10), 1)}%` }} />
        <span className="range__mark range__mark--median" style={{ left: `${at(stats.p50)}%` }} />
      </div>
      <div className="range__labels mono">
        <span>p10 {stats.p10.toFixed(0)}</span>
        <span className="range__median">p50 {stats.p50.toFixed(0)}</span>
        <span>p90 {(stats.p90 ?? max).toFixed(0)}</span>
      </div>
    </div>
  );
}

export function SceneIntelligencePage() {
  const config = useResource(api.config);
  const calibration = config.data?.calibration;
  const zone = config.data?.zone;
  const { selected, selectedId } = useSession();
  const scene = useResource((signal) => api.scene(selectedId as string, signal), {
    enabled: Boolean(selectedId),
    key: selectedId ?? "none",
  });
  const sceneData = scene.data;

  return (
    <>
      <PageHeader
        eyebrow="Baseline"
        title="Scene Intelligence"
        lede="Scene calibration, movement baseline and spatial zones as the engine currently holds them. Deviations attach to a processed session."
        aside={
          <span className={`pill ${zone?.enabled ? "pill--ok" : "pill--mono-dim"}`}>
            <SceneIcon width={11} height={11} />
            {zone ? (zone.enabled ? "Zones enabled" : "Zones off") : "Reading config"}
          </span>
        }
      />

      <div className="layout-main-aside">
        <div className="stack gap-14">
          <Panel
            title="Zone map"
            sub="Normalised frame coordinates"
            actions={<span className="tag">{zone ? `${zone.zones.length} zones` : "—"}</span>}
          >
            <div className="zone-map">
              <div className="zone-map__grid" aria-hidden="true" />
              {zone && zone.zones.length > 0 ? (
                zone.zones.map((rect) => (
                  <div
                    className="zone-box"
                    key={rect.name}
                    style={{
                      left: `${rect.x1 * 100}%`,
                      top: `${rect.y1 * 100}%`,
                      width: `${(rect.x2 - rect.x1) * 100}%`,
                      height: `${(rect.y2 - rect.y1) * 100}%`,
                    }}
                  >
                    <span className="zone-box__label mono">{rect.name}</span>
                  </div>
                ))
              ) : (
                <div className="zone-map__empty">
                  <EmptyState
                    compact
                    title="No zones defined"
                    body="Zones are drawn in the engine's configuration. Define a rectangle to give dwell time a spatial meaning."
                  />
                </div>
              )}
            </div>
            {zone && (
              <p className="note-line">
                <span className={`dot ${zone.enabled ? "dot--live" : ""}`} />
                Dwell threshold {zone.dwell_seconds}s · {zone.enabled ? "zone scoring active" : "zone scoring disabled"}
              </p>
            )}
          </Panel>

          <Panel
            title="Measured baseline"
            sub={selected ? `${selected.session} · ${sceneData?.speed_baseline.samples ?? 0} samples` : "session statistics"}
            actions={sceneData ? <span className="tag mono">{sceneData.source}</span> : undefined}
          >
            {!selectedId ? (
              <EmptyState
                title="Baseline not measured for a session"
                body="Warm-up speed and direction statistics are computed while a session runs. Pick a persisted session to read its measured envelope."
                glyph={<SceneIcon width={17} height={17} />}
                code="calibration.warmup_tracks · min_samples · direction_bin_deg"
              />
            ) : scene.status === "error" ? (
              <ErrorState error={scene.error} onRetry={scene.reload} compact />
            ) : scene.status === "loading" && !sceneData ? (
              <LoadingRows rows={5} label="Loading scene baseline" />
            ) : sceneData && sceneData.speed_baseline.samples > 0 ? (
              <div className="stack gap-18">
                <div>
                  <span className="mini-label">Speed envelope · px/s</span>
                  <SpeedRange stats={sceneData.speed_baseline} />
                  <div className="cluster">
                    <span className="tag">mean {sceneData.speed_baseline.mean.toFixed(1)}</span>
                    <span className="tag">std {sceneData.speed_baseline.std?.toFixed(1) ?? "—"}</span>
                    <span className="tag">
                      moving {((sceneData.speed_baseline.moving_fraction ?? 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>

                <div className="split-pair">
                  <div>
                    <span className="mini-label">Heading mix</span>
                    <div className="histogram">
                      {Object.entries(sceneData.directions.histogram).map(([bin, share]) => (
                        <span className="histogram__row" key={bin}>
                          <span className="histogram__bin mono">{bin}</span>
                          <span className="histogram__track">
                            <span className="histogram__fill" style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
                          </span>
                          <span className="histogram__value mono">{(share * 100).toFixed(0)}%</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="rows rows--tight">
                    <div className="row">
                      <span className="row__key">Deviation mean</span>
                      <span className="row__value mono">
                        {sceneData.deviations.scene_score.mean.toFixed(3)}
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Deviation max</span>
                      <span className="row__value mono">
                        {sceneData.deviations.scene_score.max.toFixed(3)}
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Above 0.20 / 0.30</span>
                      <span className="row__value mono">
                        {formatNumber(sceneData.deviations.above_0_2)} / {formatNumber(sceneData.deviations.above_0_3)}
                      </span>
                    </div>
                    <div className="row">
                      <span className="row__key">Affected tracks</span>
                      <span className="row__value mono">{sceneData.deviations.affected_tracks}</span>
                    </div>
                  </div>
                </div>

                {!sceneData.calibration.available && (
                  <p className="note-line note-line--wrap">
                    <span className="dot dot--warn" />
                    {sceneData.calibration.reason}
                  </p>
                )}
              </div>
            ) : (
              <EmptyState
                title="No scene observations"
                body="This session persisted no speed or direction samples, so no baseline can be derived from it."
                glyph={<SceneIcon width={17} height={17} />}
              />
            )}
          </Panel>
        </div>

        <div className="stack gap-14">
          <Panel title="Calibration" sub="Engine configuration">
            {config.status === "error" ? (
              <ErrorState error={config.error} onRetry={config.reload} compact />
            ) : config.status === "loading" && !config.data ? (
              <LoadingRows rows={4} label="Loading calibration" />
            ) : calibration ? (
              <div className="rows rows--tight">
                <div className="row">
                  <span className="row__key">Warm-up tracks</span>
                  <span className="row__value">{calibration.warmup_tracks}</span>
                </div>
                <div className="row">
                  <span className="row__key">Warm-up time</span>
                  <span className="row__value">{calibration.tracks_seconds}s</span>
                </div>
                <div className="row">
                  <span className="row__key">Min samples</span>
                  <span className="row__value">{calibration.min_samples}</span>
                </div>
                <div className="row">
                  <span className="row__key">Direction bin</span>
                  <span className="row__value">{calibration.direction_bin_deg}°</span>
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel title="Zones" sub="Configured rectangles">
            {zone && zone.zones.length > 0 ? (
              <div className="rows rows--tight">
                {zone.zones.map((rect) => (
                  <div className="row" key={rect.name}>
                    <span className="row__key">{rect.name}</span>
                    <span className="row__value">
                      {rect.x1.toFixed(2)},{rect.y1.toFixed(2)} → {rect.x2.toFixed(2)},{rect.y2.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="note-line">
                <span className="dot" />
                No zones configured — dwell rules stay inactive.
              </p>
            )}
          </Panel>

          <div className="note">
            <span className="note__label">Reading</span>
            <p className="note__body">
              The map and zone rows are the configuration the engine applies. The measured baseline
              beside them is derived from persisted observations; the learned calibrator itself is
              kept in memory and is not stored per session.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
