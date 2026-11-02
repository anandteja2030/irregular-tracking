import { useState } from "react";
import { useSession } from "../app/SessionProvider";
import { api } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import { LevelBadge, Pager, Score } from "../components/SessionBits";
import { AnomalyIcon } from "../components/icons";
import { formatNumber, truncateMiddle } from "../lib/format";

const EVENT_PAGE = 20;

type Severity = "all" | "Suspicious" | "Irregular";

export function AnomalyCenterPage() {
  const config = useResource(api.config);
  const anomaly = config.data?.anomaly;
  const weights = anomaly?.weights;
  const { selected, selectedId } = useSession();
  const [severity, setSeverity] = useState<Severity>("all");
  const [offset, setOffset] = useState(0);

  const events = useResource(
    (signal) =>
      api.anomalies(
        selectedId as string,
        {
          severity: severity === "all" ? undefined : severity,
          sort: "score",
          limit: EVENT_PAGE,
          offset,
        },
        signal,
      ),
    { enabled: Boolean(selectedId), key: `${selectedId}:${severity}:${offset}` },
  );

  const changeSeverity = (next: Severity) => {
    setSeverity(next);
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        eyebrow="Fusion evidence"
        title="Anomaly Center"
        lede="Severity bands and evidence channels exactly as the engine is configured. Events populate here from a persisted session's fused scoring."
        aside={
          <span className="pill pill--accent">
            <AnomalyIcon width={11} height={11} />
            {anomaly ? `Bands ${anomaly.threshold_suspicious.toFixed(2)} / ${anomaly.threshold_irregular.toFixed(2)}` : "Loading bands"}
          </span>
        }
      />

      <div className="layout-split">
        <Panel
          title="Severity ladder"
          sub="Fused score → verdict"
          actions={<span className="tag">live config</span>}
        >
          {config.status === "error" ? (
            <ErrorState error={config.error} onRetry={config.reload} />
          ) : config.status === "loading" && !config.data ? (
            <LoadingRows rows={5} label="Loading severity bands" />
          ) : anomaly ? (
            <div className="stack gap-18">
              <div className="ladder">
                <div className="ladder__track" aria-hidden="true">
                  <span
                    className="ladder__zone ladder__zone--normal"
                    style={{ width: `${anomaly.threshold_suspicious * 100}%` }}
                  />
                  <span
                    className="ladder__zone ladder__zone--suspicious"
                    style={{
                      width: `${(anomaly.threshold_irregular - anomaly.threshold_suspicious) * 100}%`,
                    }}
                  />
                  <span
                    className="ladder__zone ladder__zone--irregular"
                    style={{ width: `${(1 - anomaly.threshold_irregular) * 100}%` }}
                  />
                  <span
                    className="ladder__tick"
                    style={{ left: `${anomaly.threshold_suspicious * 100}%` }}
                  />
                  <span
                    className="ladder__tick"
                    style={{ left: `${anomaly.threshold_irregular * 100}%` }}
                  />
                </div>
                <div className="ladder__scale">
                  {[
                    { at: 0, text: "0.00", edge: "start" },
                    { at: anomaly.threshold_suspicious, text: anomaly.threshold_suspicious.toFixed(2) },
                    { at: anomaly.threshold_irregular, text: anomaly.threshold_irregular.toFixed(2) },
                    { at: 1, text: "1.00", edge: "end" },
                  ].map((mark) => (
                    <span
                      key={mark.text + mark.at}
                      className={`ladder__scale-mark ${mark.edge ? `ladder__scale-mark--${mark.edge}` : ""}`.trim()}
                      style={{ left: `${mark.at * 100}%` }}
                    >
                      {mark.text}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rows rows--tight">
                <BandRow
                  tone="ok"
                  name="Normal"
                  range={`score < ${anomaly.threshold_suspicious.toFixed(2)}`}
                  note="no elevated evidence"
                />
                <BandRow
                  tone="warn"
                  name="Suspicious"
                  range={`${anomaly.threshold_suspicious.toFixed(2)} – ${anomaly.threshold_irregular.toFixed(2)}`}
                  note="partial rule / model / scene agreement"
                />
                <BandRow
                  tone="bad"
                  name="Irregular"
                  range={`score ≥ ${anomaly.threshold_irregular.toFixed(2)}`}
                  note="strong multi-channel evidence"
                />
              </div>

              <div className="cluster">
                <span className="tag">contamination {anomaly.contamination}</span>
                <span className="tag">window {anomaly.per_object_window}</span>
                <span className="tag">
                  clusters {anomaly.scene_cluster_k_min}–{anomaly.scene_cluster_k_max}
                </span>
              </div>
            </div>
          ) : null}
        </Panel>

        <div className="stack gap-14">
          <Panel title="Evidence channels" sub="Fusion weights">
            {weights ? (
              <div className="weights">
                <WeightBar name="Rule engine" value={weights.rule} />
                <WeightBar name="Isolation Forest" value={weights.ml} />
                <WeightBar name="Scene deviation" value={weights.scene} />
              </div>
            ) : (
              <LoadingRows rows={3} label="Loading weights" />
            )}
            <p className="note-line">
              <span className="dot dot--warn" />
              Weights are read from the running engine; they are not cached in the browser.
            </p>
          </Panel>

          <Panel title="Rule thresholds" sub="Rule channel">
            {anomaly ? (
              <div className="rows rows--tight">
                <div className="row">
                  <span className="row__key">Speed pctl</span>
                  <span className="row__value">
                    {anomaly.rule.speed_pctl_slow} → {anomaly.rule.speed_pctl_fast}
                  </span>
                </div>
                <div className="row">
                  <span className="row__key">Max z-score</span>
                  <span className="row__value">{anomaly.rule.max_z}</span>
                </div>
                <div className="row">
                  <span className="row__key">Loiter</span>
                  <span className="row__value">{anomaly.rule.loiter_seconds}s</span>
                </div>
                <div className="row">
                  <span className="row__key">Direction dev</span>
                  <span className="row__value">{anomaly.rule.direction_dev_deg}°</span>
                </div>
              </div>
            ) : (
              <LoadingRows rows={4} label="Loading rule thresholds" />
            )}
          </Panel>
        </div>
      </div>

      <section className="section">
        <div className="section__head">
          <span className="section__title">Event ledger</span>
          <span className="section__meta">
            {selected
              ? `${selected.session} · ${formatNumber(selected.counts.anomalies)} non-normal observations`
              : "Suspicious · Irregular"}
          </span>
        </div>
        <Panel
          bodyClassName="panel__body--flush"
          actions={
            selected ? (
              <div className="seg">
                {(["all", "Suspicious", "Irregular"] as Severity[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`seg__item ${severity === option ? "is-active" : ""}`.trim()}
                    onClick={() => changeSeverity(option)}
                    aria-pressed={severity === option}
                  >
                    {option === "all" ? "All" : option}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          {!selectedId ? (
            <div className="panel__pad">
              <EmptyState
                title="No session selected"
                body="Fused events are served per session. Pick a persisted session in the top bar and its ledger loads here."
                glyph={<AnomalyIcon width={17} height={17} />}
              />
            </div>
          ) : events.status === "error" ? (
            <div className="panel__pad">
              <ErrorState error={events.error} onRetry={events.reload} compact />
            </div>
          ) : events.status === "loading" && !events.data ? (
            <div className="panel__pad">
              <LoadingRows rows={6} label="Loading events" />
            </div>
          ) : events.data && events.data.anomalies.length > 0 ? (
            <>
              <div className="table-wrap">
                <table className="table table--events">
                  <thead>
                    <tr>
                      <th>Fused</th>
                      <th>Level</th>
                      <th>Frame</th>
                      <th>Track</th>
                      <th>Rule</th>
                      <th>ML</th>
                      <th>Scene</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.data.anomalies.map((event) => (
                      <tr key={event.event_id}>
                        <td>
                          <Score value={event.scores.fused} />
                        </td>
                        <td>
                          <LevelBadge level={event.level} />
                        </td>
                        <td className="mono">{event.frame}</td>
                        <td className="mono">T{String(event.track_id).padStart(2, "0")}</td>
                        <td>
                          <Score value={event.scores.rule} />
                        </td>
                        <td>
                          <Score value={event.scores.ml} />
                        </td>
                        <td>
                          <Score value={event.scores.scene} />
                        </td>
                        <td className="table__summary" title={event.summary}>
                          {truncateMiddle(event.summary, 96)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel__pad panel__pad--tight">
                <Pager
                  total={events.data.total}
                  limit={EVENT_PAGE}
                  offset={offset}
                  onChange={setOffset}
                  label="events"
                />
              </div>
            </>
          ) : (
            <div className="panel__pad">
              <EmptyState
                title={severity === "all" ? "No elevated events in this run" : `No ${severity.toLowerCase()} events`}
                body="Every observation in the selected session scored below the suspicious band. The engine reports this honestly rather than padding the ledger."
                glyph={<AnomalyIcon width={17} height={17} />}
              />
            </div>
          )}
        </Panel>
      </section>
    </>
  );
}

function BandRow({
  tone,
  name,
  range,
  note,
}: {
  tone: "ok" | "warn" | "bad";
  name: string;
  range: string;
  note: string;
}) {
  return (
    <div className="row">
      <span className={`band-dot band-dot--${tone}`} />
      <span className="band-name">{name}</span>
      <span className="band-range mono">{range}</span>
      <span className="row__value row__value--dim">{note}</span>
    </div>
  );
}

function WeightBar({ name, value }: { name: string; value: number }) {
  return (
    <div className="weight">
      <div className="weight__head">
        <span className="weight__name">{name}</span>
        <span className="weight__value mono">{value.toFixed(2)}</span>
      </div>
      <div className="weight__track">
        <span className="weight__fill" style={{ width: `${Math.max(2, value * 100)}%` }} />
      </div>
    </div>
  );
}
