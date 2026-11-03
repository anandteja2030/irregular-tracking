import { useEffect, useMemo, useState } from "react";
import { api, ApiError, describeError } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { useApiHealth, apiPhase } from "../app/ApiHealthProvider";
import type { EngineConfig, JobList, SourceEntry } from "../lib/types";
import {
  draftFromConfig,
  draftIsDirty,
  patchFromDraft,
  validateDraft,
  type SettingsDraft,
} from "../lib/settings";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { AlertIcon, CpuIcon, FilmIcon, LockIcon, RefreshIcon } from "../components/icons";
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatUptime,
  truncateMiddle,
} from "../lib/format";

interface JobActivity {
  queued: number;
  running: number;
  cancelling: number;
  active: number;
}

async function loadJobActivity(signal?: AbortSignal): Promise<JobActivity> {
  const [queued, running, cancelling] = await Promise.all([
    api.jobs({ status: "queued", limit: 1 }, signal),
    api.jobs({ status: "running", limit: 1 }, signal),
    api.jobs({ status: "cancellation_requested", limit: 1 }, signal),
  ]);
  const count = (result: JobList) => result.total;
  return {
    queued: count(queued),
    running: count(running),
    cancelling: count(cancelling),
    active: count(queued) + count(running) + count(cancelling),
  };
}

interface Feedback {
  tone: "ok" | "bad" | "info";
  title: string;
  body?: string;
  details?: string[];
}

function configErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "config_invalid" && Array.isArray(error.detail)) {
    const details = error.detail
      .map((item) => {
        if (typeof item !== "object" || item === null) return null;
        const value = item as { loc?: unknown; msg?: unknown };
        const location = Array.isArray(value.loc) ? value.loc.join(".") : "config";
        return `${location}: ${String(value.msg ?? "invalid value")}`;
      })
      .filter((item): item is string => Boolean(item));
    return details.length > 0 ? `${describeError(error)} ${details.join("; ")}` : describeError(error);
  }
  return describeError(error);
}

export function SettingsPage() {
  const health = useApiHealth();
  const config = useResource(api.config);
  const system = useResource(api.system);
  const sources = useResource(api.sources);
  const activity = useResource(loadJobActivity, { pollMs: 15_000 });

  const [baseline, setBaseline] = useState<EngineConfig | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    if (!config.data) return;
    const wasDirty = baseline ? draftIsDirty(draft, baseline) : false;
    setBaseline(config.data);
    if (!draft || !wasDirty) setDraft(draftFromConfig(config.data));
  }, [config.data, config.updatedAt]);

  const errors = useMemo(() => (draft ? validateDraft(draft) : {}), [draft]);
  const dirty = draftIsDirty(draft, baseline);
  const errorCount = Object.keys(errors).length;
  const phase = health.error ? "offline" : apiPhase(health);
  const activeJobs = activity.data?.active ?? 0;
  const queueKnown = activity.status === "ready" && !activity.error;
  const canWrite =
    phase === "online" &&
    queueKnown &&
    activeJobs === 0 &&
    Boolean(draft && baseline) &&
    !saving &&
    !resetting;
  const canSave = canWrite && dirty && errorCount === 0;

  const refresh = () => {
    health.reload();
    config.reload();
    system.reload();
    sources.reload();
    activity.reload();
  };

  const updateField = (section: keyof SettingsDraft, key: string, value: string) => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        [section]: {
          ...(current[section] as Record<string, string>),
          [key]: value,
        },
      } as SettingsDraft;
    });
    setFeedback(null);
    setResetArmed(false);
  };

  const save = async () => {
    if (!draft || !baseline || errorCount > 0) return;
    const patch = patchFromDraft(draft, baseline);
    if (Object.keys(patch).length === 0) {
      setFeedback({ tone: "info", title: "No changes to save", body: "The draft matches the running configuration." });
      return;
    }
    setSaving(true);
    setFeedback(null);
    setResetArmed(false);
    try {
      const result = await api.updateConfig(patch);
      setBaseline(result.config);
      setDraft(draftFromConfig(result.config));
      setFeedback({
        tone: "ok",
        title: result.changed ? "Configuration applied" : "No changes applied",
        body: result.changed
          ? "The running engine accepted the update. It is process-local and will reset when the API restarts."
          : "The API validated the document but found no effective change.",
        details: result.applied.length ? result.applied : undefined,
      });
      config.reload();
    } catch (error) {
      setFeedback({ tone: "bad", title: "Configuration rejected", body: configErrorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    setFeedback(null);
    try {
      const result = await api.resetConfig();
      setBaseline(result.config);
      setDraft(draftFromConfig(result.config));
      setResetArmed(false);
      setFeedback({
        tone: "ok",
        title: result.changed ? "Defaults restored" : "Already at defaults",
        body: "Every configuration section was reset in this API process. A restart also returns these defaults.",
        details: result.applied.length ? result.applied : undefined,
      });
      config.reload();
    } catch (error) {
      setFeedback({ tone: "bad", title: "Reset failed", body: configErrorText(error) });
    } finally {
      setResetting(false);
    }
  };

  const limits = system.data?.limits;
  const formats = system.data?.formats;
  const processingLabel = activity.error
    ? "Unavailable"
    : activity.status === "loading"
      ? "Reading queue"
      : activeJobs > 0
        ? "Busy"
        : "Ready";
  const processingTone = activity.error ? "pill--bad" : activeJobs > 0 ? "pill--warn" : "pill--ok";

  return (
    <>
      <PageHeader
        eyebrow="Engine"
        title="System Settings"
        lede="Live API health, processing limits and the engine configuration held by this process. Every write is validated by the backend; nothing here is persisted outside the running service."
        aside={
          <>
            <span
              className={`pill ${
                phase === "online" ? "pill--ok" : phase === "offline" ? "pill--bad" : "pill--warn"
              }`}
            >
              <CpuIcon width={11} height={11} />
              {phase === "online" ? "API online" : phase === "offline" ? "API offline" : "API linking"}
            </span>
            <button type="button" className="btn" onClick={refresh}>
              <span className="btn__icon">
                <RefreshIcon width={13} height={13} />
              </span>
              Refresh
            </button>
          </>
        }
      />

      <div className="grid-2 settings-health">
        <Panel title="API health" sub="Liveness and runtime">
          {health.status === "error" && !health.data ? (
            <ErrorState
              error={health.error}
              onRetry={health.reload}
              title="API health check failed"
              compact
            />
          ) : health.status === "loading" && !health.data ? (
            <LoadingRows rows={4} label="Checking API health" />
          ) : (
            <div className="rows rows--tight">
              <Row
                label="Health"
                value={health.data ? `${health.data.status} · version ${health.data.version}` : "—"}
              />
              <Row label="Uptime" value={health.data ? formatUptime(health.data.uptime_s) : "—"} />
              <Row
                label="Last check"
                value={
                  health.updatedAt
                    ? new Date(health.updatedAt).toLocaleTimeString("en-US", { hour12: false })
                    : "Not reported"
                }
              />
              <Row
                label="System version"
                value={system.data?.version ?? (system.status === "error" ? "Unavailable" : "—")}
              />
            </div>
          )}
          {Boolean(health.error) && health.data !== null && (
            <p className="note-line note-line--wrap">
              <span className="dot dot--bad" /> The latest health poll failed. The last successful
              response is shown, but it is not a current success.
            </p>
          )}
        </Panel>

        <Panel title="Processing service" sub="Job manager state from /jobs">
          <div className="rows rows--tight">
            <Row label="Service" value={processingLabel} />
            <Row
              label="Workers"
              value={limits ? String(limits.max_workers) : system.status === "error" ? "Unavailable" : "Not exposed"}
            />
            <Row label="Queued" value={activity.data ? formatNumber(activity.data.queued) : "—"} />
            <Row label="Running" value={activity.data ? formatNumber(activity.data.running) : "—"} />
            <Row
              label="Cancellation requested"
              value={activity.data ? formatNumber(activity.data.cancelling) : "—"}
            />
          </div>
          {activity.error ? (
            <>
              <ErrorState
                error={activity.error}
                onRetry={activity.reload}
                title="Job queue unavailable"
                compact
              />
              {activity.data !== null && (
                <p className="note-line note-line--wrap">
                  <span className="dot dot--warn" /> Showing the last successful queue read; it may be
                  stale.
                </p>
              )}
            </>
          ) : activity.status === "loading" && !activity.data ? (
            <p className="note-line">
              <span className="dot dot--warn" /> Reading the live job queue.
            </p>
          ) : activeJobs === 0 ? (
            <p className="note-line">
              <span className="dot dot--live" /> No active analysis jobs in the API queue.
            </p>
          ) : (
            <p className="note-line note-line--wrap">
              <span className={`dot ${processingTone === "pill--bad" ? "dot--bad" : "dot--warn"}`} />
              {activeJobs} active job{activeJobs === 1 ? "" : "s"} — configuration writes are disabled
              until the queue drains.
            </p>
          )}
        </Panel>
      </div>

      <div className="layout-split settings-layout">
        <div className="stack gap-18">
          <div className="settings-savebar" aria-live="polite">
            <div className="settings-savebar__state">
              <span className="mono settings-savebar__label">Engine configuration</span>
              <span className={`tag ${dirty ? "tag--inline" : ""}`}>
                {dirty ? `${errorCount ? "Invalid" : "Unsaved"} changes` : "In sync with process"}
              </span>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => setResetArmed(true)}
                disabled={!canWrite}
              >
                Reset defaults
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void save()}
                disabled={!canSave}
                aria-busy={saving}
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>

          {resetArmed && (
            <div className="alert alert--warn" role="alert">
              <AlertIcon width={14} height={14} />
              <div className="alert__body">
                <p className="alert__title">Reset every section to shipped defaults?</p>
                <p className="alert__text">
                  This also resets fields not shown in this editor, applies only to the running
                  process, and is lost on restart.
                </p>
                <div className="row-actions">
                  <button type="button" className="btn btn--quiet btn--sm" onClick={() => setResetArmed(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => void reset()}
                    disabled={resetting || !canWrite}
                  >
                    {resetting ? "Resetting…" : "Confirm reset"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {feedback && (
            <div
              className={`alert ${
                feedback.tone === "bad" ? "alert--bad" : feedback.tone === "ok" ? "settings-alert--ok" : "alert--warn"
              }`}
              role={feedback.tone === "bad" ? "alert" : "status"}
            >
              {feedback.tone === "bad" ? <AlertIcon width={14} height={14} /> : <span className="dot dot--live" />}
              <div className="alert__body">
                <p className="alert__title">{feedback.title}</p>
                {feedback.body && <p className="alert__text">{feedback.body}</p>}
                {feedback.details && (
                  <ul className="note-list settings-applied">
                    {feedback.details.slice(0, 12).map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {activeJobs > 0 && (
            <div className="alert alert--warn" role="status">
              <AlertIcon width={14} height={14} />
              <div className="alert__body">
                <p className="alert__title">Configuration writes paused</p>
                <p className="alert__text">
                  {activeJobs} analysis job{activeJobs === 1 ? " is" : "s are"} active. Saving or
                  resetting could change settings a running pipeline reads, so writes stay disabled.
                </p>
              </div>
            </div>
          )}
          {Boolean(activity.error) && (
            <div className="alert alert--warn" role="status">
              <AlertIcon width={14} height={14} />
              <div className="alert__body">
                <p className="alert__title">Active-job state unavailable</p>
                <p className="alert__text">
                  Configuration writes are disabled until the job queue can be read. This prevents
                  a change from silently landing under an active analysis.
                </p>
              </div>
            </div>
          )}
          {Boolean(config.error) && config.data !== null && (
            <div className="alert alert--warn" role="status">
              <AlertIcon width={14} height={14} />
              <div className="alert__body">
                <p className="alert__title">Latest configuration read failed</p>
                <p className="alert__text">
                  The editor is showing the last successful document. Saving requires live API health
                  and a known job queue.
                </p>
              </div>
            </div>
          )}

          {config.status === "error" && !config.data ? (
            <Panel title="Configuration">
              <ErrorState
                error={config.error}
                onRetry={config.reload}
                title="Configuration unavailable"
              />
            </Panel>
          ) : config.status === "loading" && !config.data ? (
            <Panel title="Configuration">
              <LoadingRows rows={6} label="Loading engine configuration" />
            </Panel>
          ) : draft && baseline ? (
            <>
              <Panel title="Processing" sub="video · preprocess" className="config-section">
                <div className="settings-field-pair">
                  <ConfigField
                    id="settings-frame-width"
                    label="Frame width"
                    value={draft.video.frame_width}
                    onChange={(value) => updateField("video", "frame_width", value)}
                    error={errors["video.frame_width"]}
                    min={64}
                    max={7680}
                    step={1}
                    placeholder="source"
                    hint="Blank keeps source width."
                  />
                  <ConfigField
                    id="settings-frame-height"
                    label="Frame height"
                    value={draft.video.frame_height}
                    onChange={(value) => updateField("video", "frame_height", value)}
                    error={errors["video.frame_height"]}
                    min={64}
                    max={4320}
                    step={1}
                    placeholder="source"
                    hint="Blank keeps source height."
                  />
                </div>
                <div className="settings-fields">
                  <ConfigField
                    id="settings-process-fps"
                    label="Process fps"
                    value={draft.video.process_fps}
                    onChange={(value) => updateField("video", "process_fps", value)}
                    error={errors["video.process_fps"]}
                    min={0.1}
                    max={240}
                    step="any"
                    placeholder="source fps"
                    hint="Blank follows the source frame rate."
                  />
                  <ConfigField
                    id="settings-gaussian"
                    label="Gaussian blur"
                    value={draft.preprocess.gaussian_blur_ksize}
                    onChange={(value) => updateField("preprocess", "gaussian_blur_ksize", value)}
                    error={errors["preprocess.gaussian_blur_ksize"]}
                    min={1}
                    max={31}
                    step={1}
                    suffix="px"
                    hint="Odd kernel size."
                  />
                  <ConfigField
                    id="settings-morph"
                    label="Morph kernel"
                    value={draft.preprocess.morph_kernel_size}
                    onChange={(value) => updateField("preprocess", "morph_kernel_size", value)}
                    error={errors["preprocess.morph_kernel_size"]}
                    min={1}
                    max={31}
                    step={1}
                    suffix="px"
                    hint="Odd kernel size."
                  />
                  <ConfigField
                    id="settings-fill-blobs"
                    label="Fill small blobs"
                    value={draft.preprocess.fill_small_blobs_px}
                    onChange={(value) => updateField("preprocess", "fill_small_blobs_px", value)}
                    error={errors["preprocess.fill_small_blobs_px"]}
                    min={0}
                    max={1_000_000}
                    step={1}
                    suffix="px²"
                  />
                </div>
              </Panel>

              <Panel title="Tracking" sub="kalman · hungarian" className="config-section">
                <div className="settings-fields">
                  <ConfigField
                    id="settings-max-age"
                    label="Max age"
                    value={draft.tracking.max_age}
                    onChange={(value) => updateField("tracking", "max_age", value)}
                    error={errors["tracking.max_age"]}
                    min={0}
                    max={10_000}
                    step={1}
                    hint="Frames an unmatched track survives."
                  />
                  <ConfigField
                    id="settings-min-hits"
                    label="Min hits"
                    value={draft.tracking.min_hits}
                    onChange={(value) => updateField("tracking", "min_hits", value)}
                    error={errors["tracking.min_hits"]}
                    min={1}
                    max={100}
                    step={1}
                  />
                  <ConfigField
                    id="settings-iou-gate"
                    label="IoU gate"
                    value={draft.tracking.iou_gate}
                    onChange={(value) => updateField("tracking", "iou_gate", value)}
                    error={errors["tracking.iou_gate"]}
                    min={0}
                    max={1}
                    step="any"
                  />
                  <ConfigField
                    id="settings-position-gate"
                    label="Position gate"
                    value={draft.tracking.position_gate_px}
                    onChange={(value) => updateField("tracking", "position_gate_px", value)}
                    error={errors["tracking.position_gate_px"]}
                    min={0}
                    max={5000}
                    step={1}
                    suffix="px"
                  />
                  <ConfigField
                    id="settings-process-noise"
                    label="Process noise"
                    value={draft.tracking.kalman_process_noise}
                    onChange={(value) => updateField("tracking", "kalman_process_noise", value)}
                    error={errors["tracking.kalman_process_noise"]}
                    min={0}
                    max={1000}
                    step="any"
                  />
                  <ConfigField
                    id="settings-measurement-noise"
                    label="Measurement noise"
                    value={draft.tracking.kalman_measurement_noise}
                    onChange={(value) => updateField("tracking", "kalman_measurement_noise", value)}
                    error={errors["tracking.kalman_measurement_noise"]}
                    min={0}
                    max={10_000}
                    step="any"
                  />
                </div>
              </Panel>

              <Panel title="Scene calibration" sub="baseline gates" className="config-section">
                <div className="settings-fields">
                  <ConfigField
                    id="settings-warmup-tracks"
                    label="Warm-up tracks"
                    value={draft.calibration.warmup_tracks}
                    onChange={(value) => updateField("calibration", "warmup_tracks", value)}
                    error={errors["calibration.warmup_tracks"]}
                    min={1}
                    max={100}
                    step={1}
                  />
                  <ConfigField
                    id="settings-warmup-seconds"
                    label="Warm-up time"
                    value={draft.calibration.tracks_seconds}
                    onChange={(value) => updateField("calibration", "tracks_seconds", value)}
                    error={errors["calibration.tracks_seconds"]}
                    min={0}
                    max={3600}
                    step="any"
                    suffix="s"
                  />
                  <ConfigField
                    id="settings-min-samples"
                    label="Min samples"
                    value={draft.calibration.min_samples}
                    onChange={(value) => updateField("calibration", "min_samples", value)}
                    error={errors["calibration.min_samples"]}
                    min={1}
                    max={100_000}
                    step={1}
                  />
                  <ConfigField
                    id="settings-direction-bin"
                    label="Direction bin"
                    value={draft.calibration.direction_bin_deg}
                    onChange={(value) => updateField("calibration", "direction_bin_deg", value)}
                    error={errors["calibration.direction_bin_deg"]}
                    min={1}
                    max={180}
                    step="any"
                    suffix="°"
                  />
                </div>
              </Panel>

              <Panel title="Fusion & severity" sub="anomaly · thresholds · weights" className="config-section">
                <div className="settings-fields">
                  <ConfigField
                    id="settings-contamination"
                    label="Contamination"
                    value={draft.anomaly.contamination}
                    onChange={(value) => updateField("anomaly", "contamination", value)}
                    error={errors["anomaly.contamination"]}
                    min={0.001}
                    max={0.5}
                    step="any"
                  />
                  <ConfigField
                    id="settings-window"
                    label="Per-object window"
                    value={draft.anomaly.per_object_window}
                    onChange={(value) => updateField("anomaly", "per_object_window", value)}
                    error={errors["anomaly.per_object_window"]}
                    min={5}
                    max={10_000}
                    step={1}
                  />
                  <ConfigField
                    id="settings-cluster-min"
                    label="Scene clusters min"
                    value={draft.anomaly.scene_cluster_k_min}
                    onChange={(value) => updateField("anomaly", "scene_cluster_k_min", value)}
                    error={errors["anomaly.scene_cluster_k_min"]}
                    min={1}
                    max={50}
                    step={1}
                  />
                  <ConfigField
                    id="settings-cluster-max"
                    label="Scene clusters max"
                    value={draft.anomaly.scene_cluster_k_max}
                    onChange={(value) => updateField("anomaly", "scene_cluster_k_max", value)}
                    error={errors["anomaly.scene_cluster_k_max"]}
                    min={1}
                    max={50}
                    step={1}
                  />
                  <ConfigField
                    id="settings-threshold-suspicious"
                    label="Suspicious ≥"
                    value={draft.anomaly.threshold_suspicious}
                    onChange={(value) => updateField("anomaly", "threshold_suspicious", value)}
                    error={errors["anomaly.threshold_suspicious"]}
                    min={0}
                    max={1}
                    step="any"
                  />
                  <ConfigField
                    id="settings-threshold-irregular"
                    label="Irregular ≥"
                    value={draft.anomaly.threshold_irregular}
                    onChange={(value) => updateField("anomaly", "threshold_irregular", value)}
                    error={errors["anomaly.threshold_irregular"]}
                    min={0}
                    max={1}
                    step="any"
                  />
                </div>
                <div className="settings-subhead">
                  <span className="mono">Fusion weights</span>
                  <span>must sum to 1.0</span>
                </div>
                <div className="settings-fields settings-fields--three">
                  <ConfigField
                    id="settings-weight-rule"
                    label="Rule"
                    value={draft.anomaly.weight_rule}
                    onChange={(value) => updateField("anomaly", "weight_rule", value)}
                    error={errors["anomaly.weight_rule"]}
                    min={0}
                    max={1}
                    step="any"
                  />
                  <ConfigField
                    id="settings-weight-ml"
                    label="ML"
                    value={draft.anomaly.weight_ml}
                    onChange={(value) => updateField("anomaly", "weight_ml", value)}
                    error={errors["anomaly.weight_ml"]}
                    min={0}
                    max={1}
                    step="any"
                  />
                  <ConfigField
                    id="settings-weight-scene"
                    label="Scene"
                    value={draft.anomaly.weight_scene}
                    onChange={(value) => updateField("anomaly", "weight_scene", value)}
                    error={errors["anomaly.weight_scene"]}
                    min={0}
                    max={1}
                    step="any"
                  />
                </div>
                <p className="note-line note-line--wrap">
                  <span className="dot dot--warn" />
                  Client checks mirror the API constraints. The backend validates the merged
                  document and rejects the whole patch if any invariant fails.
                </p>
              </Panel>

              <div className="note">
                <span className="note__label">
                  <LockIcon width={11} height={11} /> Process-local configuration
                </span>
                <p className="note__body">
                  <code>PUT /config</code> mutates the running process only. The backend does not
                  write these values to disk, so a restart restores the shipped defaults. The reset
                  endpoint also affects sections not exposed in this editor. Paths remain read-only.
                </p>
              </div>
            </>
          ) : (
            <Panel title="Configuration">
              <EmptyState
                title="No configuration document"
                body="The API did not return an editable configuration document."
                glyph={<CpuIcon width={17} height={17} />}
              />
            </Panel>
          )}
        </div>

        <div className="stack gap-18">
          <Panel
            title="Upload & job limits"
            sub="reported by /system"
            actions={<span className={`pill ${system.data?.limits && !system.error ? "pill--accent" : "pill--mono-dim"}`}>
              {system.error ? "stale" : system.data?.limits ? "measured" : "not exposed"}
            </span>}
          >
            {system.status === "error" && !system.data ? (
              <ErrorState
                error={system.error}
                onRetry={system.reload}
                title="System limits unavailable"
                compact
              />
            ) : system.status === "loading" && !system.data ? (
              <LoadingRows rows={4} label="Loading system limits" />
            ) : limits && formats ? (
              <div className="stack gap-14">
                <div className="rows rows--tight">
                  <Row label="Upload cap" value={formatBytes(limits.max_upload_bytes)} />
                  <Row label="Upload retention" value={formatDuration(limits.upload_ttl_s)} />
                  <Row label="Max workers" value={formatNumber(limits.max_workers)} />
                  <Row label="Frame cap" value={formatNumber(limits.max_frames_cap)} />
                </div>
                <div>
                  <span className="settings-mini-label mono">Accepted formats</span>
                  <div className="cluster settings-formats">
                    {formats.extensions.map((extension) => (
                      <span className="tag" key={extension}>{extension}</span>
                    ))}
                  </div>
                </div>
                <p className="note-line">Values are the current API runtime limits, not editor defaults.</p>
                {Boolean(system.error) && (
                  <p className="note-line note-line--wrap">
                    <span className="dot dot--bad" /> The latest /system read failed; these limits are
                    from the last successful response.
                  </p>
                )}
              </div>
            ) : (
              <EmptyState
                compact
                title="Limits not exposed"
                body="This API build does not report upload limits. Video Studio still relies on the server's rejection instead of guessing a cap."
                glyph={<AlertIcon width={17} height={17} />}
              />
            )}
          </Panel>

          <Panel
            title="Video sources"
            sub={sources.data?.directory ? truncateMiddle(sources.data.directory, 30) : "bundled samples"}
            actions={
              sources.data ? (
                <span className="tag">{sources.data.valid} / {sources.data.count} valid</span>
              ) : undefined
            }
          >
            {sources.status === "error" ? (
              <ErrorState
                error={sources.error}
                onRetry={sources.reload}
                title="Source inventory unavailable"
                compact
              />
            ) : sources.status === "loading" && !sources.data ? (
              <LoadingRows rows={3} label="Scanning video sources" />
            ) : sources.data && sources.data.sources.length > 0 ? (
              <>
                <ul className="source-list settings-source-list">
                  {sources.data.sources.map((source) => (
                    <SourceRow source={source} key={source.path} />
                  ))}
                </ul>
                {Boolean(sources.error) && (
                  <p className="note-line note-line--wrap">
                    <span className="dot dot--bad" /> The latest source scan failed; this list is from
                    the last successful response.
                  </p>
                )}
              </>
            ) : (
              <EmptyState
                compact
                title="No bundled sources"
                body="The samples directory contains no video files. Uploads from Video Studio are still validated server-side."
                glyph={<FilmIcon width={17} height={17} />}
              />
            )}
          </Panel>

          <Panel title="Runtime & storage" sub="measured environment">
            {system.status === "error" && !system.data ? (
              <ErrorState error={system.error} onRetry={system.reload} title="Runtime status unavailable" compact />
            ) : system.status === "loading" && !system.data ? (
              <LoadingRows rows={5} label="Loading runtime status" />
            ) : system.data ? (
              <div className="stack gap-14">
                <div className="rows rows--tight">
                  <Row label="Python" value={`${system.data.python_implementation} ${system.data.python}`} />
                  <Row label="Platform" value={truncateMiddle(system.data.platform, 31)} />
                  <Row label="PID" value={formatNumber(system.data.runtime.pid)} />
                  <Row
                    label="Dependencies"
                    value={`${Object.values(system.data.packages).filter(Boolean).length} / ${Object.keys(system.data.packages).length} present`}
                  />
                  <Row label="Database" value={formatBytes(system.data.storage.db.bytes)} />
                  <Row label="Samples" value={`${formatNumber(system.data.storage.samples.videos)} · ${formatBytes(system.data.storage.samples.bytes)}`} />
                  <Row label="Output files" value={`${formatNumber(system.data.storage.output.files)} · ${formatBytes(system.data.storage.output.bytes)}`} />
                </div>
                <p className="note-line note-line--wrap">
                  <span className={`dot ${system.error ? "dot--bad" : "dot--live"}`} />
                  {system.error
                    ? "The latest runtime read failed; these values are from the last successful response."
                    : "Runtime, storage and package versions come directly from the API environment."}
                </p>
              </div>
            ) : null}
          </Panel>

          <Panel title="Storage paths" sub="read-only from the API">
            {system.data?.configuration && (
              <div className="rows rows--tight">
                <Row
                  label="Configuration"
                  value={
                    system.data.configuration.writable
                      ? `${system.data.configuration.persistence.replace(/_/g, " ")}${system.data.configuration.resets_on_restart ? " · resets on restart" : ""}`
                      : "read-only"
                  }
                />
              </div>
            )}
            {config.data ? (
              <div className="rows rows--tight">
                <Row label="Database" value={truncateMiddle(config.data.paths.db, 28)} title={config.data.paths.db} />
                <Row label="Samples" value={truncateMiddle(config.data.paths.samples, 28)} title={config.data.paths.samples} />
                <Row label="Output" value={truncateMiddle(config.data.paths.output, 28)} title={config.data.paths.output} />
              </div>
            ) : (
              <p className="note-line">Paths are available with the configuration document.</p>
            )}
            <p className="note-line note-line--wrap">
              <span className="dot dot--warn" /> The write API rejects patches containing paths.
            </p>
          </Panel>
        </div>
      </div>

      <p className="hint settings-footnote">
        API health is polled by the console. Configuration is held by the backend process and is not
        a durable settings file. Video Studio uses the current upload formats and cap reported by
        this service.
      </p>
    </>
  );
}

function ConfigField({
  id,
  label,
  value,
  onChange,
  error,
  min,
  max,
  step,
  suffix,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  min?: number;
  max?: number;
  step?: number | "any";
  suffix?: string;
  placeholder?: string;
  hint?: string;
}) {
  const helpId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <label className={`settings-field ${error ? "has-error" : ""}`.trim()} htmlFor={id}>
      <span className="settings-field__label">{label}</span>
      <span className="settings-field__control">
        <input
          id={id}
          className="settings-field__input"
          type="number"
          aria-label={label}
          inputMode="decimal"
          value={value}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={helpId}
        />
        {suffix && <span className="settings-field__suffix mono">{suffix}</span>}
      </span>
      {error ? (
        <span className="settings-field__error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="settings-field__hint" id={`${id}-hint`}>{hint}</span>
      ) : null}
    </label>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="row">
      <span className="row__key">{label}</span>
      <span className="row__value" title={title}>{value}</span>
    </div>
  );
}

function SourceRow({ source }: { source: SourceEntry }) {
  return (
    <li className="source-row">
      <span className="source-row__glyph">
        <FilmIcon width={14} height={14} />
      </span>
      <div className="source-row__text">
        <span className="source-row__name">{source.name}</span>
        <span className="source-row__meta">
          {source.valid
            ? `${source.width ?? "—"}×${source.height ?? "—"} · ${source.fps?.toFixed(2) ?? "—"} fps · ${formatDuration(source.duration_s)}`
            : source.error ?? "Could not decode this source"}
          {source.synthetic ? " · synthetic" : ""}
        </span>
      </div>
      <span className={`pill ${source.valid ? "pill--ok" : "pill--bad"}`}>
        {source.valid ? "valid" : "invalid"}
      </span>
    </li>
  );
}
