/** Why one tracked object carries the level it carries.
 *
 * The verdict is derived only from measured data: the observation mix the API
 * stored for this track, the fused thresholds in the running configuration and
 * the rule / model / scene evidence of the events that were actually loaded.
 * A missing value stays visibly missing.
 */
import type { Level, LevelCounts } from "../lib/types";
import { ruleLabel, type TrackEvidenceSummary } from "../lib/anomalies";
import { formatNumber } from "../lib/format";
import { LEVEL_COLOURS, LEVEL_ORDER } from "./charts";

export interface LevelThresholds {
  suspicious?: number | null;
  irregular?: number | null;
}

export const TIER_NAME: Record<Level, string> = {
  Normal: "Regular object",
  Suspicious: "Suspicious object",
  Irregular: "Irregular object",
};

function fixed(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : null;
}

/** The fused-score band a level occupies, from the running configuration. */
export function thresholdBand(level: Level, thresholds?: LevelThresholds): string {
  const suspicious = fixed(thresholds?.suspicious);
  const irregular = fixed(thresholds?.irregular);
  if (level === "Normal") {
    return suspicious === null ? "below the suspicious threshold" : `< ${suspicious}`;
  }
  if (level === "Suspicious") {
    if (suspicious === null && irregular === null) return "suspicious band";
    if (suspicious === null) return `< ${irregular}`;
    if (irregular === null) return `>= ${suspicious}`;
    return `${suspicious} – ${irregular}`;
  }
  return irregular === null ? "at or above the irregular threshold" : `>= ${irregular}`;
}

function share(count: number, total: number): string | null {
  if (total <= 0) return null;
  return `${((count / total) * 100).toFixed(1)}%`;
}

/** Plain-language meaning of the level, before this object's own numbers. */
const LEVEL_MEANING: Record<Level, string> = {
  Normal:
    "Regular means every observation stayed below the suspicious threshold, so the object never left the learned baseline.",
  Suspicious:
    "Suspicious means at least one observation entered the middle band but none reached the irregular threshold.",
  Irregular:
    "Irregular means at least one observation reached the irregular threshold, the highest band the engine reports.",
};

/** One measured sentence stating why this object holds its level. */
export function verdictLine(
  level: Level,
  levels: LevelCounts,
  observations: number,
  thresholds?: LevelThresholds,
  maxFused?: number | null,
): string {
  if (observations <= 0) {
    return "No observation rows were stored for this identity, so no level could be measured.";
  }
  const peak = fixed(maxFused);
  const suspicious = levels.Suspicious ?? 0;
  const irregular = levels.Irregular ?? 0;
  const suspiciousMark = fixed(thresholds?.suspicious);
  const irregularMark = fixed(thresholds?.irregular);

  if (level === "Irregular") {
    const count = `${formatNumber(irregular)} of ${formatNumber(observations)} observations (${share(
      irregular,
      observations,
    )})`;
    return `${LEVEL_MEANING.Irregular} Here ${count} sat in that band${
      peak === null ? "" : ` and the peak fused score was ${peak}`
    }${irregularMark === null ? "" : ` against a mark of ${irregularMark}`}.`;
  }
  if (level === "Suspicious") {
    const count = `${formatNumber(suspicious)} of ${formatNumber(observations)} observations (${share(
      suspicious,
      observations,
    )})`;
    return `${LEVEL_MEANING.Suspicious} Here ${count} sat in that band${
      peak === null ? "" : ` and the peak fused score was ${peak}`
    }${suspiciousMark === null ? "" : ` against a mark of ${suspiciousMark}`}; none reached irregular.`;
  }
  return `${LEVEL_MEANING.Normal} All ${formatNumber(observations)} observations here stayed under the mark${
    suspiciousMark === null ? "" : ` of ${suspiciousMark}`
  }${
    peak === null
      ? ""
      : `, the highest fused score being ${peak}${
          suspiciousMark === null ? "" : ` — ${(Number(suspiciousMark) - Number(peak)).toFixed(2)} below it`
        }`
  }.`;
}

function MixRow({
  level,
  count,
  observations,
}: {
  level: Level;
  count: number;
  observations: number;
}) {
  const portion = share(count, observations);
  return (
    <li className="level-why__mix-row">
      <i
        className="level-why__dot"
        style={{ background: LEVEL_COLOURS[level] }}
        aria-hidden="true"
      />
      <span className="level-why__mix-level">{level}</span>
      <span className="level-why__mix-count mono">{formatNumber(count)}</span>
      <span className="level-why__mix-share mono">{portion ?? "—"}</span>
    </li>
  );
}

interface Reason {
  kind: string;
  text: string;
}

/** The measured behaviours behind this object's level, quoted from the
 * persisted evidence of its loaded events. */
function reasons(level: Level, evidence: TrackEvidenceSummary | null | undefined): Reason[] {
  if (evidence === null) {
    return [
      {
        kind: "Evidence",
        text: "This object's events were not loaded into the page, so no rule, model or scene note can be quoted for it here.",
      },
    ];
  }
  const out: Reason[] = [];
  const rules = evidence?.rules ?? [];
  for (const rule of rules.slice(0, 3)) {
    out.push({
      kind: "Rule",
      text: `${ruleLabel(rule.rule)} fired on ${formatNumber(rule.count)} observation${
        rule.count === 1 ? "" : "s"
      }${
        rule.description
          ? ` — ${rule.description}`
          : " — no description was stored for this rule"
      }`,
    });
  }
  if (evidence && evidence.mlEvents > 0) {
    out.push({
      kind: "Model",
      text: `the motion model flagged ${formatNumber(evidence.mlEvents)} of ${formatNumber(
        evidence.events,
      )} elevated observations${evidence.mlNote ? ` — e.g. ${evidence.mlNote}` : ""}`,
    });
  }
  if (evidence && evidence.sceneEvents > 0) {
    out.push({
      kind: "Scene",
      text: `the scene comparison raised ${formatNumber(
        evidence.sceneEvents,
      )} of ${formatNumber(evidence.events)} elevated observations${
        evidence.sceneNote ? ` — e.g. ${evidence.sceneNote}` : ""
      }`,
    });
  }
  if (out.length === 0) {
    out.push({
      kind: "Evidence",
      text:
        level === "Normal"
          ? "no rule fired, the motion model raised no note and the scene comparison stayed inside the baseline for this object's loaded observations"
          : "the loaded observations carry no rule, model or scene note, so their level rests on the fused score alone",
    });
  }
  return out;
}

export function LevelVerdict({
  level,
  levels,
  observations,
  maxFused,
  thresholds,
  evidence,
  className,
}: {
  level: Level;
  levels: LevelCounts;
  observations: number;
  maxFused: number | null;
  thresholds?: LevelThresholds;
  /** null means this object's events were not loaded; undefined means none exist. */
  evidence?: TrackEvidenceSummary | null;
  className?: string;
}) {
  const peak = fixed(maxFused);
  const ruleCount = evidence?.rules.reduce((sum, rule) => sum + rule.count, 0) ?? 0;
  const lines = reasons(level, evidence);

  return (
    <div
      className={`level-why ${className ?? ""}`.trim()}
      style={{ ["--obj-colour" as string]: LEVEL_COLOURS[level] }}
    >
      <span className="level-why__label mono">Why this object is {level.toLowerCase()}</span>
      <p className="level-why__verdict">
        {verdictLine(level, levels, observations, thresholds, maxFused)}
      </p>

      <span className="level-why__sub mono">Measured evidence</span>
      <ul className="level-why__reasons">
        {lines.map((line) => (
          <li key={`${line.kind}-${line.text}`} className="level-why__reason">
            <span className="level-why__reason-kind mono">{line.kind}</span>
            <span className="level-why__reason-text">{line.text}</span>
          </li>
        ))}
      </ul>

      <span className="level-why__sub mono">Observation mix</span>
      <ul className="level-why__mix" aria-label="Observation mix by measured level">
        {LEVEL_ORDER.map((item) => (
          <MixRow
            key={item}
            level={item}
            count={levels[item] ?? 0}
            observations={observations}
          />
        ))}
      </ul>

      <dl className="level-why__basis">
        <div>
          <dt>Peak fused</dt>
          <dd className="mono">
            {peak ?? "—"}
            <small> · {thresholdBand(level, thresholds)}</small>
          </dd>
        </div>
        <div>
          <dt>Elevated rows</dt>
          <dd className="mono">
            {evidence === null
              ? "events not loaded"
              : `${formatNumber(evidence?.events ?? 0)}`}
            {evidence === null ? null : <small> of {formatNumber(observations)} observations</small>}
          </dd>
        </div>
        <div>
          <dt>Rule triggers</dt>
          <dd className="mono">
            {evidence === null
              ? "—"
              : ruleCount === 0 || !evidence?.rules[0]
                ? "none recorded"
                : `${formatNumber(ruleCount)} · ${ruleLabel(evidence.rules[0].rule)}`}
          </dd>
        </div>
      </dl>
    </div>
  );
}
