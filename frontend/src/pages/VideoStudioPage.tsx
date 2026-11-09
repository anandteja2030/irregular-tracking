import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, describeError } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { useJobStream } from "../hooks/useJobStream";
import { useSession } from "../app/SessionProvider";
import {
  ACCEPTED_EXTENSIONS,
  isActiveState,
  isTerminalState,
  stageLabel,
  validateVideoFile,
  type VideoIntakeLimits,
} from "../lib/studio";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SectionHeader } from "../components/SectionHeader";
import { MetricCard, MetricGrid } from "../components/MetricCard";
import { StatusPill } from "../components/StatusPill";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { LevelBadge, LevelMeter, Score } from "../components/SessionBits";
import { StudioIntake, type UploadState } from "../components/StudioIntake";
import { JobConsole } from "../components/JobConsole";
import { FrameInvestigator } from "../components/FrameInvestigator";
import { SessionHistoryPanel } from "../components/SessionHistoryPanel";
import { FilmIcon, ImageIcon, PlayIcon, TrackIcon } from "../components/icons";
import {
  formatBytes,
  formatDuration,
  formatFps,
  formatNumber,
  formatResolution,
  truncateMiddle,
} from "../lib/format";

const JOB_KEY = "neural-command.job";
const EMPTY_UPLOAD: UploadState = { status: "idle", record: null, progress: null, error: null };

type FlowState = "done" | "active" | "idle";

function readStoredJob(): string | null {
  try {
    return window.sessionStorage.getItem(JOB_KEY);
  } catch {
    return null;
  }
}

export function VideoStudioPage() {
  const {
    sessions,
    selected,
    selectedId,
    select,
    reload: reloadSessions,
  } = useSession();

  const [upload, setUpload] = useState<UploadState>(EMPTY_UPLOAD);
  const [fileError, setFileError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [duplicateJobId, setDuplicateJobId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(readStoredJob);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const completedRef = useRef<string | null>(null);

  const stream = useJobStream(jobId);
  const job = stream.job;

  const sources = useResource(api.sources, { pollMs: 120_000 });
  const system = useResource(api.system, { pollMs: 60_000 });
  const intakeLimits = useMemo<VideoIntakeLimits | undefined>(() => {
    if (!system.data?.limits) return undefined;
    return {
      maxUploadBytes: system.data.limits.max_upload_bytes,
      extensions: system.data.formats?.extensions,
      mimeTypes: system.data.formats?.mime_types,
    };
  }, [system.data]);
  const intakeExtensions = intakeLimits?.extensions?.length
    ? intakeLimits.extensions
    : ACCEPTED_EXTENSIONS;
  const intakeFormatLabel = intakeExtensions.map((extension) => extension.replace(/^\./, "")).join(" · ");
  const summary = useResource(
    (signal) => api.sessionSummary(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "" },
  );
  const detail = useResource(
    (signal) => api.session(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "" },
  );
  const media = useResource(
    (signal) => api.media(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "" },
  );
  const events = useResource(
    (signal) => api.anomalies(selectedId as string, { limit: 200, sort: "score" }, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "" },
  );

  useEffect(() => {
    try {
      if (jobId) window.sessionStorage.setItem(JOB_KEY, jobId);
      else window.sessionStorage.removeItem(JOB_KEY);
    } catch {
      /* storage disabled — the job still streams for this page session */
    }
  }, [jobId]);

  useEffect(() => () => uploadAbort.current?.abort(), []);

  const completedSession = job?.state === "completed" ? job.session_id : null;
  useEffect(() => {
    if (!completedSession || completedRef.current === completedSession) return;
    completedRef.current = completedSession;
    reloadSessions();
    select(completedSession);
  }, [completedSession, reloadSessions, select]);

  const handleFile = useCallback((file: File) => {
    const check = validateVideoFile(file, intakeLimits);
    setFileError(check.error);
    setStartError(null);
    setDuplicateJobId(null);
    if (!check.ok) return;

    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUpload({ status: "uploading", record: null, progress: 0, error: null });

    api
      .uploadVideo(file, {
        signal: controller.signal,
        onProgress: (percent) =>
          setUpload((previous) =>
            previous.status === "uploading" ? { ...previous, progress: percent } : previous,
          ),
      })
      .then((record) => setUpload({ status: "done", record, progress: 100, error: null }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          setUpload(EMPTY_UPLOAD);
          return;
        }
        setUpload({ status: "error", record: null, progress: null, error });
      });
  }, [intakeLimits]);

  const startAnalysis = useCallback(
    async (source: { kind: "sample" | "upload"; ref: string }) => {
      setStarting(true);
      setStartError(null);
      setDuplicateJobId(null);
      setCancelError(null);
      try {
        const payload = await api.createJob(source);
        completedRef.current = null;
        setJobId(payload.job.job_id);
      } catch (error) {
        if (error instanceof ApiError && error.code === "job_duplicate") {
          const detailValue = error.detail as { job_id?: string } | undefined;
          setDuplicateJobId(detailValue?.job_id ?? null);
        }
        setStartError(describeError(error));
      } finally {
        setStarting(false);
      }
    },
    [],
  );

  const cancelJob = async () => {
    if (!jobId) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelJob(jobId);
    } catch (error) {
      setCancelError(error);
    } finally {
      setCancelling(false);
    }
  };

  const openSession = (sessionId: string) => {
    select(sessionId);
    const target = document.getElementById("studio-results");
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const clearJob = () => {
    setJobId(null);
    setCancelError(null);
    setDuplicateJobId(null);
    setStartError(null);
    completedRef.current = null;
  };

  const busy = upload.status === "uploading" || starting || Boolean(job && isActiveState(job.state));
  const topEvents = (events.data?.anomalies ?? []).slice(0, 5);
  const mediaMissing = detail.data ? !detail.data.media.available : false;

  // Workflow chrome reports only what the intake, job and selection actually hold.
  const uploadDone = Boolean(upload.record) || Boolean(jobId);
  const jobTerminal = job ? isTerminalState(job.state) : false;
  const flow: { id: string; label: string; meta: string; state: FlowState; word: string }[] = [
    {
      id: "intake",
      label: "Intake",
      meta: upload.record
        ? upload.record.filename
        : upload.status === "uploading"
          ? "Streaming to the API"
          : upload.status === "error"
            ? "Upload rejected"
            : "Awaiting a source",
      state: upload.status === "uploading" ? "active" : uploadDone ? "done" : "idle",
      word: upload.status === "uploading" ? "in progress" : uploadDone ? "complete" : "pending",
    },
    {
      id: "analysis",
      label: "Analysis",
      meta: job ? stageLabel(job.stage) : jobId ? "Reading job status" : "No job started",
      state: busy ? "active" : jobTerminal ? "done" : "idle",
      word: busy ? "in progress" : jobTerminal ? "complete" : "pending",
    },
    {
      id: "inspect",
      label: "Investigation",
      meta: selected ? selected.session : "No session selected",
      state: selectedId ? "active" : "idle",
      word: selectedId ? "open" : "pending",
    },
  ];
  const currentStep = flow.findIndex((step) => step.state === "active");

  return (
    <>
      <PageHeader
        eyebrow="Intake · analysis"
        title="Video Studio"
        lede="Upload a clip or run a bundled sample through the existing engine. Progress, counts and previews below come from the API exactly as reported — no simulated runs, no placeholder metrics."
        aside={
          <>
            <StatusPill tone="accent" size="sm" icon={<FilmIcon width={11} height={11} />}>
              {sources.data ? `${sources.data.valid} decodable clips` : "Source scan"}
            </StatusPill>
            <StatusPill
              tone={busy ? "warn" : "ok"}
              size="sm"
              icon={<PlayIcon width={11} height={11} />}
              live
            >
              {busy ? "Analysis running" : "Engine idle"}
            </StatusPill>
          </>
        }
      />

      <ol className="flow" aria-label="Studio workflow">
        {flow.map((step, index) => (
          <li
            key={step.id}
            className="flow__step"
            data-state={step.state}
            aria-current={index === currentStep ? "step" : undefined}
          >
            <span className="flow__index mono" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="flow__body">
              <span className="flow__label">{step.label}</span>
              <span className="flow__meta mono truncate">{step.meta}</span>
            </span>
            <span className="flow__tick" aria-hidden="true" />
            <span className="sr-only">{step.word}</span>
          </li>
        ))}
      </ol>

      <div className="layout-studio layout-studio--workflow">
        <Panel
          title="Ingest"
          sub="Upload, validate, then start"
          actions={<span className="tag">{intakeFormatLabel}</span>}
          foot={
            system.data?.limits ? undefined : (
              <>
                <span className="dot dot--warn" />
                Current API limits are unavailable; using the documented fallback. The server still
                validates formats and rejects oversized uploads.
              </>
            )
          }
        >
          <StudioIntake
            upload={upload}
            fileError={fileError}
            startError={startError}
            duplicateJobId={duplicateJobId}
            busy={busy}
            limits={intakeLimits}
            limitsReported={Boolean(system.data?.limits)}
            onFile={handleFile}
            onCancelUpload={() => {
              uploadAbort.current?.abort();
              setUpload(EMPTY_UPLOAD);
            }}
            onAnalyse={() =>
              upload.record &&
              void startAnalysis({ kind: "upload", ref: upload.record.upload_id })
            }
            onDiscard={() => {
              setUpload(EMPTY_UPLOAD);
              setFileError(null);
              setStartError(null);
            }}
            onOpenJob={() => {
              if (duplicateJobId) {
                completedRef.current = null;
                setJobId(duplicateJobId);
                setDuplicateJobId(null);
              }
            }}
          />
        </Panel>

        <JobConsole
          jobId={jobId}
          stream={stream}
          cancelling={cancelling}
          cancelError={cancelError}
          onCancel={() => void cancelJob()}
          onClear={clearJob}
          onInspect={openSession}
        />
      </div>

      <section className="section" aria-labelledby="studio-samples">
        <SectionHeader
          title="Sample footage"
          id="studio-samples"
          meta={
            sources.data
              ? `${sources.data.count} clips in ${sources.data.directory}`
              : "resolving directory"
          }
          level={3}
        />
        <Panel bodyClassName="panel__body--flush">
          {sources.status === "error" ? (
            <div className="panel__pad">
              <ErrorState error={sources.error} onRetry={sources.reload} compact />
            </div>
          ) : sources.status === "loading" && !sources.data ? (
            <div className="panel__pad">
              <LoadingRows rows={3} label="Scanning bundled samples" />
            </div>
          ) : (sources.data?.sources ?? []).length === 0 ? (
            <div className="panel__pad">
              <EmptyState
                compact
                title="No bundled footage"
                body="The samples directory holds no decodable video. Upload a clip instead."
                glyph={<FilmIcon width={16} height={16} />}
              />
            </div>
          ) : (
            <ul className="sample-list">
              {(sources.data?.sources ?? []).map((source) => (
                <li key={source.path} className="sample-item">
                  <span className="sample-item__glyph">
                    <FilmIcon width={14} height={14} />
                  </span>
                  <div className="sample-item__body">
                    <span className="sample-item__name">{source.name}</span>
                    <span className="sample-item__meta mono">
                      {formatResolution(source.width, source.height)} · {formatFps(source.fps)} ·{" "}
                      {formatDuration(source.duration_s)} · {formatBytes(source.bytes)}
                      {source.synthetic ? " · synthetic" : ""}
                    </span>
                  </div>
                  {source.valid ? (
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      disabled={busy}
                      onClick={() => void startAnalysis({ kind: "sample", ref: source.name })}
                    >
                      <span className="btn__icon">
                        <PlayIcon width={11} height={11} />
                      </span>
                      Analyse
                    </button>
                  ) : (
                    <StatusPill tone="bad" size="sm">
                      unreadable
                    </StatusPill>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      <section className="section" id="studio-results" aria-labelledby="studio-results-title">
        <SectionHeader
          title="Analysis results"
          id="studio-results-title"
          meta={
            selected
              ? `${selected.session} · ${selected.source.label ?? "source unrecorded"}`
              : "select or run a session"
          }
          level={3}
        />

        <div className="layout-studio layout-studio--results">
          <Panel
            title="Result envelope"
            sub="Persisted session aggregates"
            actions={selected ? <span className="tag">{selected.session}</span> : undefined}
          >
            {!selectedId ? (
              <EmptyState
                compact
                title="No session selected"
                body="Finish an analysis or open a persisted session below to read its real aggregates."
                glyph={<ImageIcon width={16} height={16} />}
              />
            ) : summary.status === "error" ? (
              <ErrorState error={summary.error} onRetry={summary.reload} compact />
            ) : summary.status === "loading" && !summary.data ? (
              <LoadingRows rows={5} label="Loading session summary" />
            ) : summary.data ? (
              <div className="stack gap-16">
                <MetricGrid columns={4} label="Severity distribution">
                  <MetricCard
                    label="Normal"
                    value={formatNumber(summary.data.counts.levels.Normal)}
                    tone="ok"
                  />
                  <MetricCard
                    label="Suspicious"
                    value={formatNumber(summary.data.counts.levels.Suspicious)}
                    tone="warn"
                  />
                  <MetricCard
                    label="Irregular"
                    value={formatNumber(summary.data.counts.levels.Irregular)}
                    tone="bad"
                  />
                  <MetricCard
                    label="Tracks"
                    value={formatNumber(summary.data.counts.tracks)}
                    tone="accent-2"
                  />
                </MetricGrid>

                <div className="rows rows--tight">
                  <Row label="Frames processed" value={formatNumber(summary.data.processing.frames_processed)} />
                  <Row
                    label="Resolution"
                    value={formatResolution(summary.data.processing.width, summary.data.processing.height)}
                  />
                  <Row label="Source fps" value={formatFps(summary.data.processing.fps)} />
                  <Row
                    label="Processing fps"
                    value={formatFps(summary.data.processing.processing_fps)}
                  />
                  <Row
                    label="Processing time"
                    value={formatDuration(summary.data.processing.wall_s)}
                  />
                  <Row
                    label="Video duration"
                    value={formatDuration(summary.data.processing.video_duration_s)}
                  />
                  <Row label="Observations" value={formatNumber(summary.data.counts.observations)} />
                  <Row label="Events" value={formatNumber(summary.data.counts.anomalies)} />
                  <Row
                    label="Tracks with events"
                    value={`${formatNumber(summary.data.tracks.with_anomalies)} / ${formatNumber(summary.data.tracks.count)}`}
                  />
                  <Row
                    label="Observed window"
                    value={
                      summary.data.temporal.observed_seconds === null
                        ? "—"
                        : formatDuration(summary.data.temporal.observed_seconds)
                    }
                  />
                </div>

                <div className="cluster">
                  <span className="tag">{formatResolution(summary.data.processing.width, summary.data.processing.height)}</span>
                  <span className="tag">{summary.data.source.kind ?? "unknown source"}</span>
                  {summary.data.labels.labels === 0 && <span className="tag">no ground-truth labels</span>}
                </div>

                {selected && (
                  <div className="row-actions">
                    <Link className="btn btn--quiet btn--sm" to="/tracks">
                      <span className="btn__icon">
                        <TrackIcon width={12} height={12} />
                      </span>
                      Track Explorer
                    </Link>
                    <Link className="btn btn--quiet btn--sm" to="/anomalies">
                      Open anomaly ledger
                    </Link>
                  </div>
                )}
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Severity evidence"
            sub="Highest fused scores in this session"
            actions={
              events.data ? (
                <span className="tag">{formatNumber(events.data.total)} events</span>
              ) : undefined
            }
          >
            {!selectedId ? (
              <EmptyState compact title="Nothing to rank yet" body="Events appear once a session is selected." />
            ) : events.status === "error" ? (
              <ErrorState error={events.error} onRetry={events.reload} compact />
            ) : events.status === "loading" && !events.data ? (
              <LoadingRows rows={4} label="Loading events" />
            ) : topEvents.length === 0 ? (
              <EmptyState
                compact
                title="No elevated events"
                body="Every observation scored inside the Normal band, so the ledger stays empty rather than padded."
              />
            ) : (
              <ul className="evidence-list">
                {topEvents.map((event) => (
                  <li
                    key={event.event_id}
                    className={`evidence-item evidence-item--${event.level.toLowerCase()}`}
                  >
                    <div className="evidence-item__head">
                      <LevelBadge level={event.level} />
                      <span className="mono">F{event.frame}</span>
                      <span className="mono">T{String(event.track_id).padStart(2, "0")}</span>
                      <Score value={event.scores.fused} />
                    </div>
                    <p className="evidence-item__summary">{truncateMiddle(event.summary, 118)}</p>
                    {event.evidence?.rules?.length ? (
                      <p className="evidence-item__rules mono">
                        {event.evidence.rules.map((rule) => rule.rule).join(" · ")}
                        {event.evidence.ml_note ? ` · ${event.evidence.ml_note}` : ""}
                      </p>
                    ) : (
                      <p className="evidence-item__rules mono">
                        {event.evidence?.available === false
                          ? "rule evidence is no longer retained in this API process"
                          : "no rule fired"}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </section>

      <section className="section" aria-labelledby="studio-investigation">
        <SectionHeader
          title="Video investigation"
          id="studio-investigation"
          meta={
            media.data
              ? `${formatNumber(media.data.preview_count)} retained previews`
              : "preview frames"
          }
          level={3}
        />
        <Panel
          className="panel--viewport"
          bodyClassName="panel__body--flush"
          foot={
            <>
              <span className="dot dot--warn" />
              {media.data
                ? media.data.annotated_video.reason
                : "No annotated video is produced by the engine; only retained preview frames exist."}
            </>
          }
        >
          <div className="studio-viewport">
            <FrameInvestigator
              sessionId={selectedId}
              media={media}
              events={events.data?.anomalies ?? null}
              eventsReady={Boolean(events.data)}
              eventTotal={events.data?.total ?? 0}
            />
          </div>
        </Panel>
      </section>

      <section className="section" aria-labelledby="studio-history">
        <SectionHeader
          title="Session history"
          id="studio-history"
          meta={sessions.length > 0 ? `${sessions.length} persisted runs` : "persisted runs"}
          level={3}
        />
        <div className="layout-studio layout-studio--history">
          <Panel bodyClassName="panel__body--flush" title="Persisted sessions" sub="Newest first">
            <SessionHistoryPanel sessions={sessions} selectedId={selectedId} onOpen={openSession} />
          </Panel>

          <Panel title="Historical availability" sub="What this session kept">
            {!selectedId ? (
              <EmptyState compact title="No session selected" body="Choose a run to see what was persisted." />
            ) : detail.status === "error" ? (
              <ErrorState error={detail.error} onRetry={detail.reload} compact />
            ) : detail.status === "loading" && !detail.data ? (
              <LoadingRows rows={4} label="Loading session detail" />
            ) : detail.data ? (
              <div className="stack gap-14">
                <div className="rows rows--tight">
                  <Row label="Preview frames" value={formatNumber(detail.data.media.preview_frames)} />
                  <Row label="Preview stride" value={detail.data.media.preview_stride ? `${detail.data.media.preview_stride}` : "—"} />
                  <Row label="Centroid paths" value={detail.data.artifacts.trajectories ? "retained" : "not retained"} />
                  <Row label="Rule evidence" value={detail.data.artifacts.structured_evidence ? "retained" : "not retained"} />
                  <Row label="Scene calibration" value={detail.data.artifacts.scene_calibration ? "retained" : "not retained"} />
                  <Row label="Labels" value={formatNumber(detail.data.labels.labels)} />
                </div>
                {mediaMissing && (
                  <div className="alert alert--warn" role="status">
                    <ImageIcon width={14} height={14} />
                    <div className="alert__body">
                      <p className="alert__title">No media for this session</p>
                      <p className="alert__text">
                        Frames live only in the API process that analysed the run. This session's
                        observations, tracks and events are still queryable from SQLite.
                      </p>
                    </div>
                  </div>
                )}
                {detail.data.limitations.length > 0 && (
                  <div>
                    <p className="note__label">API limitations for this session</p>
                    <ul className="note-list">
                      {detail.data.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="cluster">
                  <LevelMeter levels={detail.data.counts.levels} />
                  <span className="tag">{formatNumber(detail.data.counts.observations)} observations</span>
                  <span className="tag">{formatNumber(detail.data.counts.anomalies)} events</span>
                </div>
              </div>
            ) : null}
          </Panel>
        </div>
      </section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <span className="row__key">{label}</span>
      <span className="row__value">{value}</span>
    </div>
  );
}
