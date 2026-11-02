import { useSession } from "../app/SessionProvider";
import { API_BASE, api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { EvaluationIcon, LayersIcon } from "../components/icons";
import { formatNumber } from "../lib/format";

function metricLabel(key: string): string {
  return key.replace(/_/g, " ");
}

export function EvaluationPage() {
  const { selected, selectedId } = useSession();
  const evaluation = useResource(
    (signal) => api.evaluation(selectedId as string, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "none" },
  );
  const data = evaluation.data;
  const sessionBase = `${API_BASE}/sessions/${encodeURIComponent(selectedId ?? "")}`;
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

  return (
    <>
      <PageHeader
        eyebrow="Ground truth"
        title="Evaluation &amp; Reports"
        lede="Measured agreement against curated labels, plus the session exports the API already serves. Nothing on this surface is scored until labels exist."
        aside={
          <span className={`pill ${data?.available ? "pill--accent" : "pill--mono-dim"}`}>
            <EvaluationIcon width={11} height={11} />
            {data?.available
              ? `${formatNumber(data.labeled_observations)} labeled`
              : data
                ? "Labels required"
                : selected
                  ? "Reading session"
                  : "No session"}
          </span>
        }
      />

      <div className="layout-split">
        <Panel
          title="Agreement ledger"
          sub={selected ? `${selected.session} · ${formatNumber(data?.total_observations ?? selected.counts.observations)} observations` : "label vs prediction"}
          actions={data ? <span className="tag mono">coverage {percent(data.coverage)}</span> : undefined}
        >
          {!selectedId ? (
            <EmptyState
              title="No session selected"
              body="Evaluation reads the selected session's labels and predictions. Pick a persisted session in the top bar."
              glyph={<EvaluationIcon width={17} height={17} />}
            />
          ) : evaluation.status === "error" ? (
            <ErrorState error={evaluation.error} onRetry={evaluation.reload} compact />
          ) : evaluation.status === "loading" && !data ? (
            <LoadingRows rows={5} label="Loading evaluation" />
          ) : data?.available && data.metrics ? (
            <div className="stack gap-14">
              <div className="metric-grid">
                {Object.entries(data.metrics).map(([key, value]) => (
                  <div className="metric-cell" key={key}>
                    <span className="metric-cell__label mono">{metricLabel(key)}</span>
                    <span className="metric-cell__value">
                      {value === null
                        ? "—"
                        : Number.isInteger(value)
                          ? formatNumber(value)
                          : value.toFixed(3)}
                    </span>
                    <span
                      className="metric-cell__bar"
                      aria-hidden="true"
                      style={{
                        width: `${Math.min(100, Math.max(0, (value ?? 0) <= 1 ? (value ?? 0) * 100 : value ?? 0))}%`,
                      }}
                    />
                  </div>
                ))}
              </div>
              <p className="note-line">
                <span className="dot dot--live" />
                {data.positive_rule}
              </p>
            </div>
          ) : (
            <div className="stack gap-14">
              <div className="metric-stub" aria-hidden="true">
                {["precision", "recall", "f1"].map((metric) => (
                  <div className="metric-stub__cell" key={metric}>
                    <span className="metric-stub__label mono">{metric}</span>
                    <span className="metric-stub__value">—</span>
                    <span className="metric-stub__bar" />
                  </div>
                ))}
              </div>
              <EmptyState
                compact
                title="No evaluated metrics yet"
                body={
                  data?.reason ??
                  "Curated labels drive every figure here. Until a session carries ground truth, the API reports metrics as unavailable."
                }
                glyph={<EvaluationIcon width={17} height={17} />}
              />
              <p className="note-line note-line--wrap">
                <span className="dot dot--warn" />
                Label curation is not wired into this console yet, so this surface stays read-only:
                it reports whatever ground truth the session already carries.
              </p>
            </div>
          )}
        </Panel>

        <div className="stack gap-14">
          <Panel title="Report exports" sub={selected ? selected.session : "per session"}>
            {!selectedId ? (
              <p className="note-line">
                <span className="dot dot--warn" />
                Exports are served per session; select one to enable these links.
              </p>
            ) : (
              <div className="stack gap-8">
                <a className="export-row" href={`${sessionBase}/export/csv?dataset=events`}>
                  <span className="export-row__glyph mono">CSV</span>
                  <span className="export-row__text">
                    <span className="export-row__title">Observation export</span>
                    <span className="export-row__meta">per-row scores, motion and reason</span>
                  </span>
                  <span className="pill pill--accent">download</span>
                </a>
                <a className="export-row" href={`${sessionBase}/export/csv?dataset=tracks`}>
                  <span className="export-row__glyph mono">CSV</span>
                  <span className="export-row__text">
                    <span className="export-row__title">Track export</span>
                    <span className="export-row__meta">aggregated per-object rows</span>
                  </span>
                  <span className="pill pill--accent">download</span>
                </a>
                <a className="export-row" href={`${sessionBase}/report?download=true`}>
                  <span className="export-row__glyph mono">MD</span>
                  <span className="export-row__text">
                    <span className="export-row__title">Session report</span>
                    <span className="export-row__meta">markdown summary of the run</span>
                  </span>
                  <span className="pill pill--accent">download</span>
                </a>
              </div>
            )}
            <p className="note-line">
              <span className="dot dot--live" />
              Served by the session API — the console links, it never fabricates a file.
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
                    <span className="coverage__fill" style={{ width: `${Math.min(100, data.coverage * 100)}%` }} />
                  </div>
                  <div className="coverage__labels mono">
                    <span>{formatNumber(data.labeled_observations)} labeled</span>
                    <span>{formatNumber(data.unlabeled_observations)} unlabeled</span>
                  </div>
                </div>
                <div className="rows rows--tight">
                  <div className="row">
                    <span className="row__key">Normal labels</span>
                    <span className="row__value mono">{formatNumber(data.label_counts.Normal)}</span>
                  </div>
                  <div className="row">
                    <span className="row__key">Anomaly labels</span>
                    <span className="row__value mono">{formatNumber(data.label_counts.Anomaly)}</span>
                  </div>
                  <div className="row">
                    <span className="row__key">Predicted positive</span>
                    <span className="row__value mono">{formatNumber(data.predicted_positive)}</span>
                  </div>
                </div>
                <p className="note-line">
                  <span className="dot dot--warn" />
                  Labels are matched by frame and track
                  <span className="dim"> · {selected ? selected.session : ""}</span>
                </p>
              </div>
            ) : evaluation.status === "loading" ? (
              <LoadingRows rows={4} label="Loading labels" />
            ) : (
              <EmptyState
                compact
                title="No labels stored"
                body="Ground-truth rows are matched to a session's observations by frame and track."
                glyph={<LayersIcon width={17} height={17} />}
              />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
