import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSession } from "../app/SessionProvider";
import { api, describeError, downloadSessionExport } from "../lib/api";
import type { SessionDownloadKind } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { MetricCard, MetricGrid } from "../components/MetricCard";
import { SectionHeader } from "../components/SectionHeader";
import { ReportGuide } from "../components/ReportGuide";
import { ResultsDashboard } from "../components/ResultsDashboard";
import { StatusPill, type StatusTone } from "../components/StatusPill";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { BarList } from "../components/charts";
import { QuantumHero } from "../components/quantum";
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

const MATRIX_LEGEND: { code: string; name: string; detail: string; tone: string }[] = [
  { code: "TP", name: "True positive", detail: "predicted anomaly · labelled anomaly", tone: "tp" },
  { code: "FP", name: "False positive", detail: "predicted anomaly · labelled normal", tone: "fp" },
  { code: "FN", name: "False negative", detail: "predicted normal · labelled anomaly", tone: "fn" },
  { code: "TN", name: "True negative", detail: "predicted normal · labelled normal", tone: "tn" },
];

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

/** Readiness band shown above any evaluation payload, whatever its state. */
function ReadinessHero({
  tone,
  title,
  detail,
  matched,
  total,
  coverage,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  title: string;
  detail: string;
  matched: number | null | undefined;
  total: number | null | undefined;
  coverage: number | null | undefined;
}) {
  const share =
    coverage === null || coverage === undefined || !Number.isFinite(coverage)
      ? null
      : Math.min(100, Math.max(0, coverage * 100));
  return (
    <div className="eval-hero" data-tone={tone}>
      <span className="eval-hero__pulse" aria-hidden="true" />
      <div className="eval-hero__copy">
        <span className="eval-hero__eyebrow mono">Evaluation readiness</span>
        <p className="eval-hero__title">{title}</p>
        <p className="eval-hero__detail">{detail}</p>
      </div>
      <div className="eval-hero__coverage">
        <span className="eval-hero__coverage-value mono">
          {formatNumber(matched)}
          <span className="eval-hero__coverage-total"> / {formatNumber(total)}</span>
        </span>
        <span className="eval-hero__coverage-label mono">labels matched</span>
        <span className="eval-hero__coverage-bar" aria-hidden="true">
          {share !== null && <span style={{ width: `${share}%` }} />}
        </span>
      </div>
    </div>
  );
}

/** Normal/Anomaly share of whatever labels the API actually reported. */
function ClassBalance({
  normal,
  anomaly,
}: {
  normal: number | null | undefined;
  anomaly: number | null | undefined;
}) {
  const n = normal ?? 0;
  const a = anomaly ?? 0;
  const total = n + a;
  const normalShare = total > 0 ? (n / total) * 100 : 0;
  return (
    <div className="eval-balance">
      <div className="eval-balance__bar" aria-hidden="true">
        {total > 0 ? (
          <>
            <span className="eval-balance__fill eval-balance__fill--normal" style={{ width: `${normalShare}%` }} />
            <span className="eval-balance__fill eval-balance__fill--anomaly" style={{ width: `${100 - normalShare}%` }} />
          </>
        ) : (
          <span className="eval-balance__empty" />
        )}
      </div>
      <div className="eval-balance__legend mono">
        <span className="eval-balance__key">
          <span className="eval-balance__swatch eval-balance__swatch--normal" aria-hidden="true" />
          Normal {formatNumber(normal)}
        </span>
        <span className="eval-balance__key">
          <span className="eval-balance__swatch eval-balance__swatch--anomaly" aria-hidden="true" />
          Anomaly {formatNumber(anomaly)}
        </span>
        <span className="dim">{total > 0 ? "share of stored labels" : "no labels stored"}</span>
      </div>
    </div>
  );
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
            { label: "Accuracy", value: metrics.accuracy, hint: "correct of matched labels", tone: "accent" as const },
            { label: "Precision", value: metrics.precision, hint: "TP / predicted positive", tone: "neutral" as const },
            { label: "Recall", value: metrics.recall, hint: "TP / labelled anomaly", tone: "neutral" as const },
            { label: "F1 score", value: metrics.f1, hint: "harmonic mean of precision and recall", tone: "accent-2" as const },
            { label: "False positive rate", value: metrics.fpr, hint: "FP / labelled normal", tone: "warn" as const },
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

  const pill: { tone: StatusTone; label: string } =
    evaluation.status === "error"
      ? { tone: "bad", label: "Evaluation unavailable" }
      : !selectedId
        ? { tone: "muted", label: "No session" }
        : !data
          ? { tone: "muted", label: "Reading evaluation" }
          : state === "ready"
            ? {
                tone: "accent",
                label: `${formatNumber(data.labeled_observations)} labeled`,
              }
            : state === "no_labels"
              ? { tone: "muted", label: "Labels required" }
              : state === "insufficient"
                ? { tone: "warn", label: "Insufficient classes" }
                : { tone: "warn", label: "Metrics unavailable" };

  const normalLabels = data?.label_counts?.Normal ?? 0;
  const anomalyLabels = data?.label_counts?.Anomaly ?? 0;
  const labelsStored = labelTotal(data) ?? 0;
  const scoreSteps: { key: string; label: string; detail: string; met: boolean }[] = [
    {
      key: "run",
      label: "A persisted run is selected",
      met: Boolean(selectedId),
      detail: selected ? selected.session : "Choose a run in the session picker.",
    },
    {
      key: "labels",
      label: "Curated labels are stored",
      met: labelsStored > 0,
      detail: `${formatNumber(labelsStored)} stored · ${formatNumber(
        data?.labeled_observations,
      )} matched to observations`,
    },
    {
      key: "classes",
      label: "Both classes are present",
      met: normalLabels > 0 && anomalyLabels > 0,
      detail: `${formatNumber(normalLabels)} normal / ${formatNumber(anomalyLabels)} anomaly`,
    },
    {
      key: "scores",
      label: "Scores are computed",
      met: state === "ready",
      detail:
        state === "ready"
          ? "Precision, recall, F1 and the confusion matrix are measured below."
          : "The API scores the run once the three checks above hold.",
    },
  ];

  const scorePath = (
    <ol className="score-path" aria-label="What a scored evaluation needs">
      {scoreSteps.map((step, index) => (
        <li key={step.key} className={`score-path__step ${step.met ? "is-met" : ""}`.trim()}>
          <span className="score-path__index mono">{String(index + 1).padStart(2, "0")}</span>
          <span className="score-path__text">
            <span className="score-path__label">{step.label}</span>
            <span className="score-path__detail mono">{step.detail}</span>
          </span>
          <span className="score-path__state mono">{step.met ? "met" : "pending"}</span>
        </li>
      ))}
    </ol>
  );

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
          <span>
            No scores are shown when the evaluation request fails. A failed read is
            not an empty evaluation and never becomes a zero score.
          </span>
        </p>
      </>
    );
  } else if (evaluation.status === "loading" && !data) {
    evaluationBody = <LoadingRows rows={5} label="Loading evaluation" />;
  } else if (state === "ready" && metrics && matrix) {
    evaluationBody = (
      <div className="stack gap-14">
        <ReadinessHero
          tone="ok"
          title="Evaluation ready"
          detail={`Scores are computed by the API from ${formatNumber(
            data?.predicted_positive,
          )} positive predictions matched to persisted labels.`}
          matched={data?.labeled_observations}
          total={data?.total_observations}
          coverage={data?.coverage}
        />

        <SectionHeader
          title="Agreement metrics"
          meta={`${formatNumber(metrics.n_labeled)} labels matched`}
        />
        <MetricGrid columns={5} label="Agreement metrics">
          {rateCards.map((card) => (
            <MetricCard
              key={card.label}
              label={card.label}
              value={formatRate(card.value)}
              meter={Number.isFinite(card.value) ? card.value : null}
              tone={card.tone}
              hint={card.hint}
            />
          ))}
        </MetricGrid>

        <Panel title="Agreement at a glance" sub="Rate comparison on one 0–100% scale">
          <BarList
            ariaLabel="Agreement metrics as percentages"
            max={1}
            rows={rateCards.map((card) => ({
              key: card.label,
              label: card.label,
              value: Math.max(0, Math.min(1, card.value)),
              color:
                card.label === "False positive rate" ? "var(--chart-5)" : "var(--chart-1)",
              hint: card.hint,
            }))}
            formatValue={(value) => `${(value * 100).toFixed(1)}%`}
          />
        </Panel>

        <div className="eval-matrix">
          <div className="eval-matrix__main">
            <SectionHeader
              title="Confusion matrix"
              meta={`${formatNumber(matrix.total)} matched labels`}
            />
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
                    <span className="confusion__name">True positive</span>
                  </td>
                  <td className="confusion__cell confusion__cell--fn">
                    <span className="confusion__value">{formatNumber(matrix.fn)}</span>
                    <span className="confusion__code mono">FN</span>
                    <span className="confusion__name">False negative</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    <span className="confusion__axis">Normal label</span>
                  </th>
                  <td className="confusion__cell confusion__cell--fp">
                    <span className="confusion__value">{formatNumber(matrix.fp)}</span>
                    <span className="confusion__code mono">FP</span>
                    <span className="confusion__name">False positive</span>
                  </td>
                  <td className="confusion__cell confusion__cell--tn">
                    <span className="confusion__value">{formatNumber(matrix.tn)}</span>
                    <span className="confusion__code mono">TN</span>
                    <span className="confusion__name">True negative</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="note-line note-line--wrap">
              <span className="dot dot--live" />
              <span>
                {data?.positive_rule}
                <span className="dim">
                  {" "}
                  · {formatNumber(metrics.n_labeled)} labels matched to observations
                </span>
              </span>
            </p>
          </div>

          <aside className="eval-matrix__side">
            {auc !== null ? (
              <MetricCard
                label="ROC-AUC"
                value={formatMetric(auc)}
                meter={auc}
                tone="accent"
                hint="ranked separation returned by the API"
              />
            ) : (
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
            <ul className="eval-legend">
              {MATRIX_LEGEND.map((entry) => (
                <li className={`eval-legend__item eval-legend__item--${entry.tone}`} key={entry.code}>
                  <span className="eval-legend__code mono">{entry.code}</span>
                  <span className="eval-legend__body">
                    <span className="eval-legend__name">{entry.name}</span>
                    <span className="eval-legend__detail mono">{entry.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    );
  } else if (state === "insufficient") {
    evaluationBody = (
      <div className="stack gap-14">
        <ReadinessHero
          tone="warn"
          title="Insufficient label diversity"
          detail="A single labelled class cannot support agreement scores, so this run is reported as uncomputable rather than scored."
          matched={data?.labeled_observations}
          total={data?.total_observations}
          coverage={data?.coverage}
        />
        <div className="eval-state">
          <EmptyState
            compact
            title="Not enough label diversity"
            body={
              data?.reason ??
              "Metrics require at least one Normal and one Anomaly label matched to observations. Only one class is present, so no score is computed."
            }
            glyph={<LayersIcon width={17} height={17} />}
          />
          <div className="eval-panel">
            <ClassBalance
              normal={data?.label_counts?.Normal}
              anomaly={data?.label_counts?.Anomaly}
            />
            <div className="eval-facts">
              <span>
                Stored labels: {formatNumber(labelTotal(data))}
                <span className="dim">
                  {" "}
                  ({formatNumber(normalLabels)} normal / {formatNumber(anomalyLabels)} anomaly)
                </span>
              </span>
              <span>Matched: {formatNumber(data?.labeled_observations)}</span>
              <span>Predicted positive: {formatNumber(data?.predicted_positive)}</span>
            </div>
          </div>
        </div>
        {scorePath}
        <div className="eval-unavailable" role="status">
          <AlertIcon width={15} height={15} />
          <div>
            <p className="eval-unavailable__title">No score shown</p>
            <p className="eval-unavailable__body">
              A single-class run cannot distinguish signal from chance. These labels
              remain useful, but precision, recall and ROC-AUC are not computable yet.
            </p>
          </div>
        </div>
      </div>
    );
  } else if (state === "no_labels") {
    evaluationBody = (
      <div className="stack gap-14">
        <ReadinessHero
          tone="warn"
          title="Labels required"
          detail="Nothing in this run is scored until curated labels are matched to observations."
          matched={data?.labeled_observations}
          total={data?.total_observations}
          coverage={data?.coverage}
        />
        <div className="eval-state">
          <EmptyState
            compact
            title="No ground-truth labels"
            body={
              data?.reason ??
              "This session has no curated labels. Metrics stay unavailable until a Normal and an Anomaly label are matched to observations."
            }
            glyph={<EvaluationIcon width={17} height={17} />}
          />
          <div className="eval-panel">
            <ClassBalance
              normal={data?.label_counts?.Normal}
              anomaly={data?.label_counts?.Anomaly}
            />
            <div className="eval-facts">
              <span>Total observations: {formatNumber(data?.total_observations)}</span>
              <span>Predicted positive: {formatNumber(data?.predicted_positive)}</span>
              <span>Labels stored: {formatNumber(labelTotal(data))}</span>
            </div>
          </div>
        </div>
        {scorePath}
        <p className="note-line note-line--wrap">
          <span className="dot dot--warn" />
          <span>
            Label curation is not wired into this console yet, so this surface is
            read-only. An unlabeled session is reported as unlabeled — never as a
            zero score.
          </span>
        </p>
      </div>
    );
  } else {
    evaluationBody = (
      <div className="stack gap-14">
        <ReadinessHero
          tone="warn"
          title="Metrics unavailable"
          detail="The label set loaded, but no metric document came back with it."
          matched={data?.labeled_observations}
          total={data?.total_observations}
          coverage={data?.coverage}
        />
        <div className="eval-state">
          <EmptyState
            compact
            title="Metrics unavailable"
            body={
              data?.reason ??
              "The API reported labels but returned no metric payload. No fallback score is invented."
            }
            glyph={<AlertIcon width={17} height={17} />}
          />
          <div className="eval-panel">
            <ClassBalance
              normal={data?.label_counts?.Normal}
              anomaly={data?.label_counts?.Anomaly}
            />
            <div className="eval-facts">
              <span>Labels stored: {formatNumber(labelTotal(data))}</span>
              <span>Matched: {formatNumber(data?.labeled_observations)}</span>
              <span>Predicted positive: {formatNumber(data?.predicted_positive)}</span>
            </div>
          </div>
        </div>
        {scorePath}
        <p className="note-line note-line--wrap">
          <span className="dot dot--warn" />
          <span>
            This is an unavailable metric response, not an API failure and not a
            measured zero.
          </span>
        </p>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Ground truth"
        title="Evaluation & Reports"
        lede="Object verdicts and agreement scores for the selected run."
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
            <StatusPill tone={pill.tone} icon={<EvaluationIcon width={11} height={11} />}>
              {pill.label}
            </StatusPill>
          </div>
        }
      />

      <QuantumHero
        kicker="Ground truth · measurement integrity"
        title={
          <>
            Agreement is a <em>measurement</em>
          </>
        }
        description="Scores come only from curated labels matched to persisted observations. An unlabelled or single-class run is reported as unscoreable, never as zero."
        status={pill.label}
        metrics={[
          {
            label: "Observations",
            value: formatNumber(data?.total_observations ?? selected?.counts.observations),
            hint: "in this session",
          },
          {
            label: "Labels matched",
            value: formatNumber(data?.labeled_observations),
            hint: `${formatNumber(labelTotal(data))} stored`,
            tone: "accent",
          },
          {
            label: "Coverage",
            value:
              data?.coverage === null || data?.coverage === undefined
                ? "—"
                : `${Math.round(data.coverage * 100)}%`,
            hint: "labelled share (rounded)",
            tone: "warn",
          },
          {
            label: "Predicted positive",
            value: formatNumber(data?.predicted_positive),
            hint: data?.positive_rule ?? "Suspicious + Irregular",
          },
          {
            label: "Score state",
            value:
              state === "ready"
                ? "scored"
                : state === "insufficient"
                  ? "single class"
                  : state === "no_labels"
                    ? "unlabelled"
                    : state === "metrics_missing"
                      ? "metrics missing"
                      : "—",
            hint: "never invented",
            tone: state === "ready" ? "normal" : "bad",
          },
        ]}
      />

      <div
        className={`layout-split eval-layout ${
          state === "ready" ? "" : "eval-layout--stacked"
        }`.trim()}
      >
        <section className="panel eval-scores" aria-labelledby="eval-scores-title">
          <header className="panel__head">
            <div className="panel__titles">
              <span className="panel__title" id="eval-scores-title">
                Scoring
              </span>
              <span className="panel__sub">
                {selected
                  ? `${selected.session} · ${formatNumber(
                      data?.total_observations ?? selected.counts.observations,
                    )} observations`
                  : "Label against prediction"}
              </span>
            </div>
            {data ? (
              <div className="panel__actions">
                <span className="tag mono">coverage {coveragePercent(data)}</span>
              </div>
            ) : null}
          </header>
          <div className="panel__body">{evaluationBody}</div>
        </section>

        <div className="stack gap-14">
          <Panel
            title="Report exports"
            sub={selected ? selected.session : "per session"}
            actions={<span className="tag mono">server-rendered</span>}
          >
            {!selectedId ? (
              <p className="note-line">
                <span className="dot dot--warn" />
                Exports are served per session; select one to enable these downloads.
              </p>
            ) : (
              <div className="eval-exports">
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
                        <span className="export-row__arrow" aria-hidden="true">
                          <ArrowRightIcon width={13} height={13} />
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
                    <span>
                      This session has no observations. Its CSV exports will contain
                      headers only, and the report will state that the run is empty.
                    </span>
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel
            title="Ground truth"
            sub="Coverage of this run"
            actions={
              data ? (
                <span className="tag mono">{formatNumber(data.labeled_observations)} matched</span>
              ) : undefined
            }
          >
            {!selectedId ? (
              <p className="note-line">
                <span className="dot" />
                No session selected.
              </p>
            ) : data ? (
              <div className="stack gap-14">
                <div className="eval-coverage">
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
                <ClassBalance normal={data.label_counts?.Normal} anomaly={data.label_counts?.Anomaly} />
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
              <div className="eval-links">
                <Link
                  className="export-row export-row--link"
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
                  className="export-row export-row--link"
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
              </div>
            )}
          </Panel>
        </div>
      </div>

      <ResultsDashboard sessionId={selectedId ?? ""} title="Results dashboard" />

      <ReportGuide />
    </>
  );
}
