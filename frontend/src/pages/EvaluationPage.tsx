import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../app/SessionProvider";
import { api, describeError, downloadSessionExport } from "../lib/api";
import type { SessionDownloadKind } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import {
  AlertIcon,
  ArrowRightIcon,
  EvaluationIcon,
  LayersIcon,
} from "../components/icons";
import {
  confusionMatrix,
  coveragePercent,
  evaluationState,
  formatMetric,
  formatRate,
  labelTotal,
  rocAuc,
} from "../lib/evaluation";
import { formatBytes, formatNumber } from "../lib/format";

type DownloadStatus = "idle" | "loading" | "success" | "error";

interface DownloadFeedback {
  status: DownloadStatus;
  message?: string;
}

type DownloadMap = Record<SessionDownloadKind, DownloadFeedback>;

const INITIAL_DOWNLOADS: DownloadMap = {
  events: { status: "idle" },
  tracks: { status: "idle" },
  report: { status: "idle" },
};

const DOWNLOAD_META: Record<
  SessionDownloadKind,
  { glyph: string; title: string; meta: string }
> = {
  events: {
    glyph: "CSV",
    title: "Event observations",
    meta: "per-row scores, motion and reason",
  },
  tracks: {
    glyph: "CSV",
    title: "Track aggregates",
    meta: "aggregated per-object rows",
  },
  report: {
    glyph: "MD",
    title: "Session report",
    meta: "markdown summary of the run",
  },
};

function triggerDownload(blob: Blob, filename: string) {
  if (typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function downloadMessage(kind: SessionDownloadKind, file: { blob: Blob; rowCount: number | null }) {
  const size = formatBytes(file.blob.size);
  if (kind === "report") return `Downloaded report · ${size}`;
  if (file.rowCount === 0) return "Downloaded header-only CSV · 0 rows";
  if (file.rowCount !== null) return `Downloaded ${formatNumber(file.rowCount)} rows · ${size}`;
  return `Downloaded CSV · ${size}`;
}

export function EvaluationPage() {
  const { sessions, selected, selectedId, select } = useSession();
  const evaluation = useResource(
    (signal) => api.evaluation(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "none" },
  );
  const data = evaluation.data;
  const state = evaluationState(data);
  const metrics = data?.metrics ?? null;
  const matrix = confusionMatrix(metrics);
  const auc = rocAuc(metrics);
  const [downloads, setDownloads] = useState<DownloadMap>(INITIAL_DOWNLOADS);
  const controllers = useRef<Partial<Record<SessionDownloadKind, AbortController>>>({});

  useEffect(() => {
    setDownloads(INITIAL_DOWNLOADS);
    for (const controller of Object.values(controllers.current)) controller?.abort();
    controllers.current = {};
  }, [selectedId]);

  useEffect(
    () => () => {
      for (const controller of Object.values(controllers.current)) controller?.abort();
      controllers.current = {};
    },
    [],
  );

  const rateCards = useMemo(
    () =>
      metrics
        ? [
            { label: "Accuracy", value: metrics.accuracy },
            { label: "Precision", value: metrics.precision },
            { label: "Recall", value: metrics.recall },
            { label: "F1 score", value: metrics.f1 },
            { label: "False positive rate", value: metrics.fpr },
          ]
        : [],
    [metrics],
  );

  async function handleDownload(kind: SessionDownloadKind) {
    if (!selectedId) return;
    controllers.current[kind]?.abort();
    const controller = new AbortController();
    controllers.current[kind] = controller;
    setDownloads((current) => ({
      ...current,
      [kind]: { status: "loading" },
    }));

    try {
      const file = await downloadSessionExport(selectedId, kind, controller.signal);
      triggerDownload(file.blob, file.filename);
      setDownloads((current) => ({
        ...current,
        [kind]: { status: "success", message: downloadMessage(kind, file) },
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setDownloads((current) => ({
        ...current,
        [kind]: { status: "error", message: describeError(error) },
      }));
    } finally {
      if (controllers.current[kind] === controller) delete controllers.current[kind];
    }
  }

  const pill =
    evaluation.status === "error"
      ? { className: "pill--bad", label: "Evaluation unavailable" }
      : !selectedId
        ? { className: "pill--mono-dim", label: "No session" }
        : !data
          ? { className: "pill--mono-dim", label: "Reading evaluation" }
          : state === "ready"
            ? {
                className: "pill--accent",
                label: `${formatNumber(data.labeled_observations)} labeled`,
              }
            : state === "no_labels"
              ? { className: "pill--mono-dim", label: "Labels required" }
              : state === "insufficient"
                ? { className: "pill--warn", label: "Insufficient classes" }
                : { className: "pill--warn", label: "Metrics unavailable" };

  let evaluationBody: React.ReactNode;
  if (!selectedId) {
    evaluationBody = (
      <EmptyState
        title="No session selected"
        body="Evaluation reads the selected session's labels and predictions. Pick a persisted session above."
        glyph={<EvaluationIcon width={17} height={17} />}
      />
    );
  } else if (evaluation.status === "error") {
    evaluationBody = (
      <>
        <ErrorState
          error={evaluation.error}
          onRetry={evaluation.reload}
          title="Evaluation unavailable"
          compact
        />
        <p className="note-line note-line--wrap">
          <span className="dot dot--bad" />
          No scores are shown when the evaluation request fails. A failed read is
          not an empty evaluation and never becomes a zero score.
        </p>
      </>
    );
  } else if (evaluation.status === "loading" && !data) {
    evaluationBody = <LoadingRows rows={5} label="Loading evaluation" />;
  } else if (state === "ready" && metrics && matrix) {
    evaluationBody = (
      <div className="stack gap-14">
        <div className="metric-grid">
          {rateCards.map((card) => (
            <div className="metric-cell" key={card.label}>
              <span className="metric-cell__label mono">{card.label}</span>
              <span className="metric-cell__value">{formatRate(card.value)}</span>
              <span
                className="metric-cell__bar"
                aria-hidden="true"
                style={{ width: `${Math.min(100, Math.max(0, card.value * 100))}%` }}
              />
            </div>
          ))}
          {auc !== null && (
            <div className="metric-cell">
              <span className="metric-cell__label mono">ROC-AUC</span>
              <span className="metric-cell__value">{formatMetric(auc)}</span>
              <span
                className="metric-cell__bar"
                aria-hidden="true"
                style={{ width: `${Math.min(100, Math.max(0, auc * 100))}%` }}
              />
            </div>
          )}
        </div>

        <div className="eval-divider">
          <span className="mono">Confusion matrix</span>
          <span className="mono">{formatNumber(matrix.total)} matched labels</span>
        </div>
        <table className="confusion" aria-label="Confusion matrix">
          <caption className="sr-only">
            Predicted anomaly versus normal, by ground-truth label
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="confusion__axis">Ground truth</span>
              </th>
              <th scope="col">
                <span className="confusion__axis">Predicted anomaly</span>
                <span className="confusion__sub">positive</span>
              </th>
              <th scope="col">
                <span className="confusion__axis">Predicted normal</span>
                <span className="confusion__sub">negative</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                <span className="confusion__axis">Anomaly label</span>
              </th>
              <td className="confusion__cell confusion__cell--tp">
                <span className="confusion__value">{formatNumber(matrix.tp)}</span>
                <span className="confusion__code mono">TP</span>
              </td>
              <td className="confusion__cell confusion__cell--fn">
                <span className="confusion__value">{formatNumber(matrix.fn)}</span>
                <span className="confusion__code mono">FN</span>
              </td>
            </tr>
            <tr>
              <th scope="row">
                <span className="confusion__axis">Normal label</span>
              </th>
              <td className="confusion__cell confusion__cell--fp">
                <span className="confusion__value">{formatNumber(matrix.fp)}</span>
                <span className="confusion__code mono">FP</span>
              </td>
              <td className="confusion__cell confusion__cell--tn">
                <span className="confusion__value">{formatNumber(matrix.tn)}</span>
                <span className="confusion__code mono">TN</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="note-line note-line--wrap">
          <span className="dot dot--live" />
          {data?.positive_rule}
          <span className="dim">
            {" "}
            · {formatNumber(metrics.n_labeled)} labels matched to observations
          </span>
        </p>

        {auc === null && (
          <div className="eval-unavailable" role="status">
            <AlertIcon width={15} height={15} />
            <div>
              <p className="eval-unavailable__title">ROC-AUC not available</p>
              <p className="eval-unavailable__body">
                The evaluation API returns threshold metrics only. It does not
                expose ranked probabilities, so an ROC-AUC cannot be computed
                here — it is not reported as zero or guessed.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  } else if (state === "insufficient") {
    evaluationBody = (
      <div className="stack gap-14">
        <EmptyState
          compact
          title="Not enough label diversity"
          body={
            data?.reason ??
            "Metrics require at least one Normal and one Anomaly label matched to observations. Only one class is present, so no score is computed."
          }
          glyph={<LayersIcon width={17} height={17} />}
        />
        <div className="eval-facts">
          <span>
            Stored labels: {formatNumber(labelTotal(data))}
            <span className="dim">
              {" "}
              ({formatNumber(data?.label_counts?.Normal ?? 0)} normal /{" "}
              {formatNumber(data?.label_counts?.Anomaly ?? 0)} anomaly)
            </span>
          </span>
          <span>Matched: {formatNumber(data?.labeled_observations)}</span>
          <span>Predicted positive: {formatNumber(data?.predicted_positive)}</span>
        </div>
        <div className="eval-unavailable" role="status">
          <AlertIcon width={15} height={15} />
          <div>
            <p className="eval-unavailable__title">No score shown</p>
            <p className="eval-unavailable__body">
              A single-class evaluation cannot distinguish signal from chance.
              These labels remain useful, but precision, recall and ROC-AUC are
              not computable yet.
            </p>
          </div>
        </div>
      </div>
    );
  } else if (state === "no_labels") {
    evaluationBody = (
      <div className="stack gap-14">
        <EmptyState
          compact
          title="No ground-truth labels"
          body={
            data?.reason ??
            "This session has no curated labels. Metrics stay unavailable until a Normal and an Anomaly label are matched to observations."
          }
          glyph={<EvaluationIcon width={17} height={17} />}
        />
        <div className="eval-facts">
          <span>Total observations: {formatNumber(data?.total_observations)}</span>
          <span>Predicted positive: {formatNumber(data?.predicted_positive)}</span>
          <span>Labels stored: {formatNumber(labelTotal(data))}</span>
        </div>
        <p className="note-line note-line--wrap">
          <span className="dot dot--warn" />
          Label curation is not wired into this console yet, so this surface is
          read-only. An unlabeled session is reported as unlabeled — never as a
          zero score.
        </p>
      </div>
    );
  } else {
    evaluationBody = (
      <div className="stack gap-14">
        <EmptyState
          compact
          title="Metrics unavailable"
          body={
            data?.reason ??
            "The API reported labels but returned no metric payload. No fallback score is invented."
          }
          glyph={<AlertIcon width={17} height={17} />}
        />
        <p className="note-line note-line--wrap">
          <span className="dot dot--warn" />
          This is an unavailable metric response, not an API failure and not a
          measured zero.
        </p>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Ground truth"
        title="Evaluation & Reports"
        lede="Measured agreement against curated labels, plus the session exports the API already serves. Nothing on this surface is scored until labels exist."
        aside={
          <div className="eval-aside">
            <label className="session-select eval-session-select">
              <span className="session-select__label">Session</span>
              <select
                className="session-select__control"
                aria-label="Evaluation session"
                value={selectedId ?? ""}
                onChange={(event) => select(event.target.value)}
                disabled={sessions.length === 0}
              >
                {sessions.length === 0 ? (
                  <option value="">No persisted sessions</option>
                ) : (
                  sessions.map((session) => (
                    <option value={session.session} key={session.session}>
                      {session.session} ·{" "}
                      {session.counts.labels > 0
                        ? `${formatNumber(session.counts.labels)} labels`
                        : "no labels"}
                    </option>
                  ))
                )}
              </select>
            </label>
            <span className={`pill ${pill.className}`}>
              <EvaluationIcon width={11} height={11} />
              {pill.label}
            </span>
          </div>
        }
      />

      <div className="layout-split">
        <Panel
          title="Agreement ledger"
          sub={
            selected
              ? `${selected.session} · ${formatNumber(
                  data?.total_observations ?? selected.counts.observations,
                )} observations`
              : "label vs prediction"
          }
          actions={
            data ? <span className="tag mono">coverage {coveragePercent(data)}</span> : undefined
          }
        >
          {evaluationBody}
        </Panel>

        <div className="stack gap-14">
          <Panel title="Report exports" sub={selected ? selected.session : "per session"}>
            {!selectedId ? (
              <p className="note-line">
                <span className="dot dot--warn" />
                Exports are served per session; select one to enable these downloads.
              </p>
            ) : (
              <div className="stack gap-8">
                {(["events", "tracks", "report"] as const).map((kind) => {
                  const meta = DOWNLOAD_META[kind];
                  const feedback = downloads[kind];
                  const loading = feedback.status === "loading";
                  return (
                    <div className="eval-download" key={kind}>
                      <button
                        type="button"
                        className="export-row export-row--button"
                        onClick={() => void handleDownload(kind)}
                        disabled={loading}
                        aria-label={loading ? `Preparing ${meta.title} download` : `Download ${meta.title}`}
                      >
                        <span className="export-row__glyph mono">{meta.glyph}</span>
                        <span className="export-row__text">
                          <span className="export-row__title">{meta.title}</span>
                          <span
                            className={`export-row__meta ${
                              feedback.status === "success" ? "export-row__meta--success" : ""
                            }`}
                            aria-live="polite"
                          >
                            {feedback.status === "success" ? feedback.message : meta.meta}
                          </span>
                        </span>
                        <span
                          className={`pill ${
                            feedback.status === "success"
                              ? "pill--ok"
                              : feedback.status === "error"
                                ? "pill--bad"
                                : "pill--accent"
                          }`}
                        >
                          {loading
                            ? "preparing"
                            : feedback.status === "success"
                              ? "saved"
                              : feedback.status === "error"
                                ? "retry"
                                : "download"}
                        </span>
                      </button>
                      {feedback.status === "error" && (
                        <p className="eval-download__error" role="alert">
                          {feedback.message}
                        </p>
                      )}
                    </div>
                  );
                })}
                {selected && selected.counts.observations === 0 && (
                  <p className="note-line note-line--wrap">
                    <span className="dot dot--warn" />
                    This session has no observations. Its CSV exports will contain
                    headers only, and the report will state that the run is empty.
                  </p>
                )}
              </div>
            )}
            <p className="note-line">
              <span className="dot dot--live" />
              Served by the session API — the console downloads the file, it never
              fabricates one.
            </p>
          </Panel>

          <Panel title="Ground truth" sub="Coverage of this run">
            {!selectedId ? (
              <p className="note-line">
                <span className="dot" />
                No session selected.
              </p>
            ) : data ? (
              <div className="stack gap-14">
                <div>
                  <div className="coverage">
                    {data.coverage !== null && (
                      <span
                        className="coverage__fill"
                        style={{ width: `${Math.min(100, Math.max(0, data.coverage * 100))}%` }}
                      />
                    )}
                  </div>
                  <div className="coverage__labels mono">
                    <span>{formatNumber(data.labeled_observations)} matched</span>
                    <span>
                      {data.coverage === null
                        ? "coverage not measurable"
                        : `${coveragePercent(data)} coverage`}
                    </span>
                  </div>
                </div>
                <div className="rows rows--tight">
                  <div className="row">
                    <span className="row__key">Stored labels</span>
                    <span className="row__value mono">{formatNumber(labelTotal(data))}</span>
                  </div>
                  <div className="row">
                    <span className="row__key">Normal labels</span>
                    <span className="row__value mono">
                      {formatNumber(data.label_counts?.Normal ?? 0)}
                    </span>
                  </div>
                  <div className="row">
                    <span className="row__key">Anomaly labels</span>
                    <span className="row__value mono">
                      {formatNumber(data.label_counts?.Anomaly ?? 0)}
                    </span>
                  </div>
                  <div className="row">
                    <span className="row__key">Unlabeled observations</span>
                    <span className="row__value mono">
                      {formatNumber(data.unlabeled_observations)}
                    </span>
                  </div>
                  <div className="row">
                    <span className="row__key">Predicted positive</span>
                    <span className="row__value mono">
                      {formatNumber(data.predicted_positive)}
                    </span>
                  </div>
                </div>
                <p className="note-line note-line--wrap">
                  <span className="dot dot--warn" />
                  Labels are matched to observations by frame and track. Stored
                  labels can include rows that match no observation, so coverage
                  reflects matched labels only.
                </p>
              </div>
            ) : evaluation.status === "loading" ? (
              <LoadingRows rows={4} label="Loading labels" />
            ) : (
              <EmptyState
                compact
                title="No label data"
                body="Ground-truth rows are matched to a session's observations by frame and track."
                glyph={<LayersIcon width={17} height={17} />}
              />
            )}
          </Panel>

          <Panel title="Investigate" sub="Continue from this evaluation">
            {!selected ? (
              <p className="note-line">
                <span className="dot" />
                Select a session to open its evidence.
              </p>
            ) : (
              <div className="stack gap-8">
                <Link
                  className="export-row"
                  to={`/anomalies?session=${encodeURIComponent(selected.session)}`}
                  aria-label={`Open Anomaly Center for ${selected.session}`}
                >
                  <span className="export-row__glyph mono">AN</span>
                  <span className="export-row__text">
                    <span className="export-row__title">Anomaly Center</span>
                    <span className="export-row__meta">
                      {formatNumber(selected.counts.anomalies)} elevated observations
                    </span>
                  </span>
                  <span className="row-arrow">
                    <ArrowRightIcon width={14} height={14} />
                  </span>
                </Link>
                <Link
                  className="export-row"
                  to={`/tracks?session=${encodeURIComponent(selected.session)}`}
                  aria-label={`Open Track Explorer for ${selected.session}`}
                >
                  <span className="export-row__glyph mono">TR</span>
                  <span className="export-row__text">
                    <span className="export-row__title">Track Explorer</span>
                    <span className="export-row__meta">
                      {formatNumber(selected.counts.tracks)} persisted tracks
                    </span>
                  </span>
                  <span className="row-arrow">
                    <ArrowRightIcon width={14} height={14} />
                  </span>
                </Link>
                <p className="note-line note-line--wrap">
                  <span className="dot dot--live" />
                  These links carry the session into the evidence surfaces; they
                  do not invent event or track identifiers.
                </p>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
