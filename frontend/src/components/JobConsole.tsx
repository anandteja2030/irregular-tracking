import type { JobStream } from "../hooks/useJobStream";
import {
  isActiveState,
  isTerminalState,
  percentText,
  progressText,
  stageLabel,
} from "../lib/studio";
import { formatDuration, formatNumber, formatResolution } from "../lib/format";
import { describeError } from "../lib/api";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { AlertIcon, AnomalyIcon, ClockIcon, PlayIcon, RadioIcon, RefreshIcon, StopIcon } from "./icons";

interface JobConsoleProps {
  jobId: string | null;
  stream: JobStream;
  cancelling: boolean;
  cancelError: unknown;
  onCancel: () => void;
  onClear: () => void;
  onInspect: (sessionId: string) => void;
}

const TRANSPORT_LABEL: Record<JobStream["state"], string> = {
  idle: "No stream",
  connecting: "Connecting",
  live: "Socket live",
  polling: "Polling 2s",
  done: "Stream closed",
  lost: "Job lost",
  error: "Stream failed",
};

const TRANSPORT_TONE: Record<JobStream["state"], string> = {
  idle: "pill--mono-dim",
  connecting: "pill--warn",
  live: "pill--ok",
  polling: "pill--warn",
  done: "pill--mono-dim",
  lost: "pill--bad",
  error: "pill--bad",
};

/** Live run console: real stage, real frame counts, real cancellation. */
export function JobConsole({
  jobId,
  stream,
  cancelling,
  cancelError,
  onCancel,
  onClear,
  onInspect,
}: JobConsoleProps) {
  const { job, state } = stream;

  if (!jobId) {
    return (
      <PanelShell transport={state}>
        <div className="panel__pad">
          <EmptyState
            compact
            title="No analysis in flight"
            body="Upload a clip (or run one of the bundled samples) and press Start analysis. The engine reports the stage and frame counts it actually reaches."
            glyph={<PlayIcon width={16} height={16} />}
          />
        </div>
      </PanelShell>
    );
  }

  if (state === "lost") {
    return (
      <PanelShell transport={state}>
        <div className="panel__pad">
          <div className="alert alert--warn" role="status">
            <AlertIcon width={15} height={15} />
            <div className="alert__body">
              <p className="alert__title">This API process no longer knows that job</p>
              <p className="alert__text">
                The job registry is in memory, so a server restart, a different API instance or an
                expired process clears it. Nothing is guessed here: if the analysis finished and was
                persisted, its session appears in the history below.
              </p>
            </div>
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn--quiet btn--sm" onClick={stream.refresh}>
              <span className="btn__icon">
                <RefreshIcon width={12} height={12} />
              </span>
              Retry lookup
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={onClear}>
              Clear job
            </button>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (state === "error") {
    return (
      <PanelShell transport={state}>
        <div className="panel__pad">
          <ErrorState
            error={stream.error}
            onRetry={stream.refresh}
            title="Job status unavailable"
            compact
          />
        </div>
      </PanelShell>
    );
  }

  if (!job) {
    return (
      <PanelShell transport={state}>
        <div className="panel__pad">
          <LoadingRows rows={4} label="Reading job status" />
        </div>
      </PanelShell>
    );
  }

  const active = isActiveState(job.state);
  const terminal = isTerminalState(job.state);
  const cancellingNow = job.state === "cancellation_requested";
  const percent = job.progress.percent;

  return (
    <PanelShell transport={state}>
      <div className="panel__pad">
        <div className={`job-state job-state--${job.state}`}>
          <div className="job-state__head">
            <span className="job-state__stage">{stageLabel(job.stage)}</span>
            <span className={`pill ${terminal ? (job.state === "completed" ? "pill--ok" : job.state === "failed" ? "pill--bad" : "pill--warn") : "pill--accent"}`}>
              {job.state.replace(/_/g, " ")}
            </span>
          </div>
          <p className="job-state__source">{job.source.label}</p>
          <p className="job-state__meta mono">
            {job.source.kind === "upload" ? `upload ${job.source.ref}` : job.source.ref}
            {job.source.max_frames ? ` · cap ${job.source.max_frames} frames` : ""} · {job.job_id}
          </p>
        </div>

        <div className="job-progress">
          <div className="job-progress__head">
            <span className="mono">{progressText(job)}</span>
            <span className="job-progress__pct mono">{percentText(job)}</span>
          </div>
          <div
            className={`bar ${percent === null ? "bar--unmeasured" : ""}`.trim()}
            role="progressbar"
            aria-label="Frames processed"
            aria-valuemin={0}
            aria-valuemax={job.progress.total ?? undefined}
            aria-valuenow={percent === null ? undefined : job.progress.processed}
            aria-valuetext={progressText(job)}
          >
            <span className="bar__fill" style={{ width: `${percent ?? 0}%` }} aria-hidden="true" />
          </div>
          <p className="hint">
            {job.progress.measured
              ? "The total comes from the container's frame count; the percentage is processed ÷ total."
              : "This container reports no total frame count, so only the processed count is known — no percentage is invented."}
          </p>
        </div>

        <div className="rows rows--tight">
          <div className="row">
            <span className="row__key">Elapsed</span>
            <span className="row__value mono">
              {job.timings.elapsed_s === null ? "—" : formatDuration(job.timings.elapsed_s)}
            </span>
          </div>
          <div className="row">
            <span className="row__key">Started</span>
            <span className="row__value mono">{job.timings.started_ts ?? "not started"}</span>
          </div>
          <div className="row">
            <span className="row__key">Ended</span>
            <span className="row__value mono">{job.timings.ended_ts ?? "—"}</span>
          </div>
          <div className="row">
            <span className="row__key">
              {job.state === "completed" ? "Session" : "Reserved session id"}
            </span>
            <span className="row__value mono">{job.session_id}</span>
          </div>
        </div>

        {cancellingNow && (
          <p className="note-line">
            <span className="dot dot--warn" />
            Cancellation is cooperative: the engine stops after the current frame and persists nothing.
          </p>
        )}

        {job.state === "cancelled" && (
          <div className="alert alert--warn" role="status">
            <StopIcon width={15} height={15} />
            <div className="alert__body">
              <p className="alert__title">Analysis cancelled</p>
              <p className="alert__text">
                {job.progress.processed.toLocaleString("en-US")} frames were processed before the engine
                stopped. No session was written for this run.
              </p>
            </div>
          </div>
        )}

        {job.state === "failed" && (
          <div className="alert alert--bad" role="alert">
            <AnomalyIcon width={15} height={15} />
            <div className="alert__body">
              <p className="alert__title">Analysis failed · {job.error?.code ?? "unknown"}</p>
              <p className="alert__text">{job.error?.message ?? "The API reported a failure without a message."}</p>
            </div>
          </div>
        )}

        {job.state === "completed" && job.result && (
          <div className="job-result" role="status">
            <span className="job-result__check" aria-hidden="true">
              ✓
            </span>
            <div>
              <p className="job-result__title">Analysis complete</p>
              <p className="job-result__meta mono">
                {formatNumber(job.result.frames_processed)} frames ·{" "}
                {formatResolution(job.result.frame_width, job.result.frame_height)} ·{" "}
                {formatNumber(job.result.tracks)} tracks · {formatDuration(job.result.wall_s)} processing
              </p>
            </div>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onInspect(job.session_id)}>
              Open session
            </button>
          </div>
        )}

        {cancelError ? (
          <p className="note-line note-line--danger">
            <span className="dot dot--down" />
            {describeError(cancelError)}
          </p>
        ) : null}

        <div className="row-actions">
          {active && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={onCancel}
              disabled={cancelling || cancellingNow}
            >
              <span className="btn__icon">
                <StopIcon width={12} height={12} />
              </span>
              {cancellingNow ? "Cancelling…" : cancelling ? "Requesting…" : "Cancel analysis"}
            </button>
          )}
          {terminal && (
            <button type="button" className="btn btn--quiet btn--sm" onClick={onClear}>
              Clear job
            </button>
          )}
          <button type="button" className="btn btn--quiet btn--sm" onClick={stream.refresh}>
            <span className="btn__icon">
              <RefreshIcon width={12} height={12} />
            </span>
            Refresh
          </button>
        </div>
      </div>
    </PanelShell>
  );
}

function PanelShell({ transport, children }: { transport: JobStream["state"]; children: React.ReactNode }) {
  return (
    <section className="panel studio-console">
      <header className="panel__head">
        <div className="panel__titles">
          <span className="panel__title">Analysis console</span>
          <span className="panel__sub">Existing job API · in-memory registry</span>
        </div>
        <div className="panel__actions">
          <span className={`pill ${TRANSPORT_TONE[transport]}`}>
            {transport === "live" ? <RadioIcon width={11} height={11} /> : <ClockIcon width={11} height={11} />}
            {TRANSPORT_LABEL[transport]}
          </span>
        </div>
      </header>
      <div className="panel__body panel__body--flush">{children}</div>
    </section>
  );
}
