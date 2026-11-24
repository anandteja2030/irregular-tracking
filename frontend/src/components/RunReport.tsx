import type { SessionItem, TrackItem } from "../lib/types";
import { formatNumber } from "../lib/format";
import { SectionHeader } from "./SectionHeader";
import { IrregularEvidence } from "./IrregularEvidence";
import { ResultsDashboard } from "./ResultsDashboard";

function pct(value: number, total: number): string {
  if (total <= 0) return "—";
  return `${((value / total) * 100).toFixed(1)}%`;
}

/** The run in one reading: how the engine classified this session.
 *
 * The sentence and the dashboard are both built from persisted rows. Nothing
 * is estimated; a missing value stays missing.
 */
export function RunReport({
  session,
  tracks,
  tracksTotal,
}: {
  session: SessionItem;
  tracks: TrackItem[];
  tracksTotal: number;
}) {
  const levels = session.counts.levels;
  const observations = session.counts.observations;
  const elevated = levels.Suspicious + levels.Irregular;
  const irregular = tracks.filter(
    (track) => track.observed.worst_level === "Irregular",
  ).length;
  const suspicious = tracks.filter(
    (track) => track.observed.worst_level === "Suspicious",
  ).length;
  const regular = tracks.length - irregular - suspicious;

  return (
    <div className="run-report">
      <SectionHeader
        title="Run report"
        meta={`${session.session} · ${formatNumber(observations)} observations`}
        level={3}
      />

      <div className="run-report__verdict">
        <span className="run-report__verdict-label mono">RESULT</span>
        <p className="run-report__verdict-text">
          {tracks.length > 0 ? (
            <>
              Of {formatNumber(tracksTotal)} tracked objects:{" "}
              <b className="verdict verdict--normal">{formatNumber(regular)}</b> regular / genuine
              ·{" "}
              <b className="verdict verdict--suspicious">{formatNumber(suspicious)}</b> suspicious ·{" "}
              <b className="verdict verdict--irregular">{formatNumber(irregular)}</b> irregular.
            </>
          ) : (
            <>Object verdicts appear when the track rows for this run load.</>
          )}
        </p>
        <span className="run-report__verdict-foot mono">
          {formatNumber(tracksTotal)} objects · {formatNumber(elevated)} elevated of{" "}
          {formatNumber(observations)} observations ({pct(elevated, observations)})
        </span>
      </div>

      <ResultsDashboard sessionId={session.session} title="Object verdicts" />
      <IrregularEvidence sessionId={session.session} tracks={tracks} />
    </div>
  );
}
