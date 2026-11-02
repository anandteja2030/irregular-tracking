import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { ErrorState, LoadingRows } from "../components/StateViews";
import { CpuIcon, LockIcon, RefreshIcon } from "../components/icons";
import { formatBytes, truncateMiddle } from "../lib/format";

export function SettingsPage() {
  const config = useResource(api.config);
  const system = useResource(api.system);
  const data = config.data;

  return (
    <>
      <PageHeader
        eyebrow="Engine"
        title="System Settings"
        lede="The configuration the running engine holds, and the runtime it runs in. Values are read live; this build never writes them."
        aside={
          <>
            <span className="pill pill--warn">
              <LockIcon width={11} height={11} />
              Read-only
            </span>
            <button
              type="button"
              className={`btn ${config.refreshing ? "is-spinning" : ""}`}
              onClick={() => {
                config.reload();
                system.reload();
              }}
            >
              <span className="btn__icon">
                <RefreshIcon width={13} height={13} />
              </span>
              Reload
            </button>
          </>
        }
      />

      {config.status === "error" ? (
        <Panel title="Configuration">
          <ErrorState error={config.error} onRetry={config.reload} />
        </Panel>
      ) : config.status === "loading" && !data ? (
        <div className="grid-2">
          <Panel title="Fusion & severity">
            <LoadingRows rows={6} label="Loading configuration" />
          </Panel>
          <Panel title="Tracking">
            <LoadingRows rows={6} label="Loading configuration" />
          </Panel>
        </div>
      ) : data ? (
        <div className="grid-2">
          <div className="stack gap-18">
            <Panel title="Fusion & severity" sub="anomaly">
              <div className="rows rows--tight">
                <Field label="Suspicious ≥" value={data.anomaly.threshold_suspicious.toFixed(2)} />
                <Field label="Irregular ≥" value={data.anomaly.threshold_irregular.toFixed(2)} />
                <Field label="Contamination" value={String(data.anomaly.contamination)} />
                <Field label="Per-object window" value={String(data.anomaly.per_object_window)} />
                <Field
                  label="Scene clusters"
                  value={`${data.anomaly.scene_cluster_k_min} – ${data.anomaly.scene_cluster_k_max}`}
                />
                <Field
                  label="Weights"
                  value={`rule ${data.anomaly.weights.rule} · ml ${data.anomaly.weights.ml} · scene ${data.anomaly.weights.scene}`}
                />
              </div>
            </Panel>

            <Panel title="Tracking" sub="kalman · hungarian">
              <div className="rows rows--tight">
                <Field label="Max age" value={String(data.tracking.max_age)} />
                <Field label="Min hits" value={String(data.tracking.min_hits)} />
                <Field label="IoU gate" value={String(data.tracking.iou_gate)} />
                <Field label="Position gate" value={`${data.tracking.position_gate_px} px`} />
                <Field label="Process noise" value={String(data.tracking.kalman_process_noise)} />
                <Field label="Measurement noise" value={String(data.tracking.kalman_measurement_noise)} />
              </div>
            </Panel>

            <Panel title="Processing" sub="video · preprocess">
              <div className="rows rows--tight">
                <Field
                  label="Resize"
                  value={
                    data.video.frame_width && data.video.frame_height
                      ? `${data.video.frame_width}×${data.video.frame_height}`
                      : "native"
                  }
                />
                <Field
                  label="Process fps"
                  value={data.video.process_fps ? String(data.video.process_fps) : "source"}
                />
                <Field label="Gaussian blur" value={`${data.preprocess.gaussian_blur_ksize} px`} />
                <Field label="Morph kernel" value={`${data.preprocess.morph_kernel_size} px`} />
                <Field label="Fill blobs" value={`${data.preprocess.fill_small_blobs_px} px`} />
              </div>
            </Panel>
          </div>

          <div className="stack gap-18">
            <Panel title="Storage paths" sub="read-only from the API">
              <div className="rows rows--tight">
                <Field label="Database" value={truncateMiddle(data.paths.db, 34)} title={data.paths.db} />
                <Field label="Samples" value={truncateMiddle(data.paths.samples, 34)} title={data.paths.samples} />
                <Field label="Output" value={truncateMiddle(data.paths.output, 34)} title={data.paths.output} />
                <Field
                  label="DB size"
                  value={system.data ? formatBytes(system.data.storage.db.bytes) : "—"}
                />
                <Field
                  label="Sample clips"
                  value={system.data ? String(system.data.storage.samples.videos ?? 0) : "—"}
                />
              </div>
              <p className="note-line">
                <span className="dot dot--warn" />
                Paths are server-owned; the write API rejects any patch containing them.
              </p>
            </Panel>

            <Panel
              title="Runtime"
              sub="process"
              actions={<span className="tag">{system.data?.python ?? "—"}</span>}
            >
              {system.data ? (
                <div className="rows rows--tight">
                  <Field label="API version" value={system.data.version} />
                  <Field label="Platform" value={truncateMiddle(system.data.platform, 30)} title={system.data.platform} />
                  <Field label="PID" value={String(system.data.runtime.pid)} />
                  <Field label="Executable" value={truncateMiddle(system.data.runtime.executable, 30)} />
                  <Field
                    label="Dependencies"
                    value={`${Object.values(system.data.packages).filter(Boolean).length} / ${Object.keys(system.data.packages).length} present`}
                  />
                </div>
              ) : (
                <LoadingRows rows={4} label="Loading runtime" />
              )}
            </Panel>

            <Panel title="Scene constants" sub="calibration · zone">
              <div className="rows rows--tight">
                <Field label="Warm-up tracks" value={String(data.calibration.warmup_tracks)} />
                <Field label="Warm-up time" value={`${data.calibration.tracks_seconds}s`} />
                <Field label="Min samples" value={String(data.calibration.min_samples)} />
                <Field label="Direction bin" value={`${data.calibration.direction_bin_deg}°`} />
                <Field label="Zones" value={data.zone.enabled ? `${data.zone.zones.length} active` : "disabled"} />
                <Field label="Dwell" value={`${data.zone.dwell_seconds}s`} />
              </div>
            </Panel>

            <div className="note">
              <span className="note__label">
                <CpuIcon width={11} height={11} /> Configuration writes
              </span>
              <p className="note__body">
                The engine exposes validated updates and defaults reset. Editing arrives with the
                settings implementation; nothing on this page mutates the singleton.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Field({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="row">
      <span className="row__key">{label}</span>
      <span className="row__value" title={title}>
        {value}
      </span>
    </div>
  );
}
