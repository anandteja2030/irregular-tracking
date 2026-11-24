import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { AnomalyItem, Level, TrackItem } from "../lib/types";
import { formatNumber } from "../lib/format";
import { appearanceLabel } from "../lib/tracks";
import { trackEvidenceSummary, type TrackEvidenceSummary } from "../lib/anomalies";
import { LEVEL_COLOURS, LEVEL_ORDER } from "./charts";
import { LevelVerdict, thresholdBand, type LevelThresholds } from "./LevelVerdict";
import { SectionHeader } from "./SectionHeader";

/** Semantic role of an object, derived only from its measured worst level. */
const TIER: Record<Level, { code: string; name: string }> = {
  Normal: { code: "R-00", name: "Regular object" },
  Suspicious: { code: "S-01", name: "Suspicious object" },
  Irregular: { code: "I-02", name: "Irregular object" },
};

const APPEARANCE_COLOURS: Record<string, string> = {
  red: "#ff5a6b",
  orange: "#ffa24b",
  yellow: "#ffe066",
  green: "#5cf2a8",
  cyan: "#4fe3ff",
  blue: "#5b8bff",
  purple: "#a56bff",
  magenta: "#ff6bd6",
  pink: "#ff8fc4",
  white: "#e9eefc",
  grey: "#8a92a7",
  gray: "#8a92a7",
  black: "#3b4152",
};

function appearanceColour(name: string | null): string {
  if (!name) return "var(--ink-30)";
  return APPEARANCE_COLOURS[name.toLowerCase()] ?? "var(--accent)";
}

function shortId(trackId: number): string {
  return `T${String(trackId).padStart(2, "0")}`;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ObjectCard({
  track,
  sessionId,
  evidence,
  thresholds,
}: {
  track: TrackItem;
  sessionId: string;
  /** null when this object's events were not loaded into the page;
   * undefined when the loaded set holds no elevated event for it. */
  evidence: TrackEvidenceSummary | null | undefined;
  thresholds?: LevelThresholds;
}) {
  const navigate = useNavigate();
  const tier = TIER[track.observed.worst_level];
  const level = track.observed.worst_level;
  const colour = LEVEL_COLOURS[level];
  const total = Math.max(1, track.observed.observations);
  const elevated = track.observed.anomalies;
  const observedSpan =
    track.frames.first !== null && track.frames.last !== null
      ? `F${formatNumber(track.frames.first)}–F${formatNumber(track.frames.last)}`
      : "frames not retained";

  return (
    <article
      className={`obj-card obj-card--${level.toLowerCase()}`}
      style={{ ["--obj-colour" as string]: colour }}
      aria-label={`${shortId(track.track_id)} ${tier.name}`}
    >
      <span className="obj-card__beam" aria-hidden="true" />
      <header className="obj-card__head">
        <span className="obj-card__id mono">{shortId(track.track_id)}</span>
        <span className="obj-card__appearance">
          <i
            className="obj-card__swatch"
            style={{ background: appearanceColour(track.appearance.color) }}
            aria-hidden="true"
          />
          {appearanceLabel(track.appearance)}
        </span>
        <span className="obj-card__tier mono">{tier.code}</span>
      </header>

      <div className="obj-card__class">
        <span className="obj-card__class-name" style={{ color: colour }}>
          {tier.name}
        </span>
      </div>

      <div className="obj-card__ribbon" role="img" aria-label={`Observation mix ${LEVEL_ORDER.map((item) => `${item} ${track.observed.levels[item] ?? 0}`).join(", ")}`}>
        {LEVEL_ORDER.map((item) => {
          const share = (track.observed.levels[item] ?? 0) / total;
          return share > 0 ? (
            <i
              key={item}
              style={{ width: `${Math.max(1.5, share * 100)}%`, background: LEVEL_COLOURS[item] }}
            />
          ) : null;
        })}
      </div>

      <dl className="obj-card__stats">
        <div>
          <dt>Observations</dt>
          <dd className="mono">{formatNumber(track.observed.observations)}</dd>
        </div>
        <div>
          <dt>Elevated</dt>
          <dd className="mono" style={{ color: elevated > 0 ? colour : undefined }}>
            {formatNumber(elevated)}
          </dd>
        </div>
        <div>
          <dt>Mean speed</dt>
          <dd className="mono">
            {track.motion.mean_speed_px_s === null
              ? "—"
              : `${track.motion.mean_speed_px_s.toFixed(0)}`}
            {track.motion.mean_speed_px_s === null ? null : <small> px/s</small>}
          </dd>
        </div>
        <div>
          <dt>Peak speed</dt>
          <dd className="mono">
            {track.motion.max_speed_px_s === null
              ? "—"
              : `${track.motion.max_speed_px_s.toFixed(0)}`}
            {track.motion.max_speed_px_s === null ? null : <small> px/s</small>}
          </dd>
        </div>
        <div>
          <dt>Path</dt>
          <dd className="mono">
            {track.motion.path_length_px === null
              ? "—"
              : `${formatNumber(Math.round(track.motion.path_length_px))}`}
            {track.motion.path_length_px === null ? null : <small> px</small>}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd className="mono">
            {track.observed.duration_s === null
              ? "—"
              : `${track.observed.duration_s.toFixed(1)}`}
            {track.observed.duration_s === null ? null : <small> s</small>}
          </dd>
        </div>
      </dl>

      <LevelVerdict
        level={level}
        levels={track.observed.levels}
        observations={track.observed.observations}
        maxFused={track.motion.max_fused_score}
        thresholds={thresholds}
        evidence={evidence}
        className="obj-card__why"
      />

      <footer className="obj-card__foot mono">
        <span>{observedSpan}</span>
        <span>
          {track.motion.summary_directions.length > 0
            ? `heading ${track.motion.summary_directions.join("/")}`
            : "heading n/r"}
        </span>
        <button
          type="button"
          className="obj-card__link"
          onClick={() =>
            navigate(`/tracks?session=${encodeURIComponent(sessionId)}&track=${track.track_id}`)
          }
        >
          inspect →
        </button>
      </footer>
    </article>
  );
}

/** Full roster of tracked identities for one session.
 *
 * One card per tracked object. Every figure is a persisted measurement or an
 * explicit "—"; the status is the object's worst measured fused level, never a
 * semantic class the engine did not report.
 */
export function ObjectRegistry({
  tracks,
  total,
  sessionId,
  title = "Tracked objects",
  sub,
  id,
  events = null,
  thresholds,
}: {
  tracks: TrackItem[];
  total: number;
  sessionId: string;
  title?: string;
  sub?: string;
  id?: string;
  /** Elevated events for these objects; null means the page did not load them. */
  events?: AnomalyItem[] | null;
  thresholds?: LevelThresholds;
}) {
  const withEvents = tracks.filter((track) => track.observed.anomalies > 0).length;
  const irregular = tracks.filter((track) => track.observed.worst_level === "Irregular").length;
  const suspicious = tracks.filter((track) => track.observed.worst_level === "Suspicious").length;
  const regular = tracks.length - irregular - suspicious;
  const meanDuration = mean(
    tracks
      .map((track) => track.observed.duration_s)
      .filter((value): value is number => value !== null),
  );
  const meanPeakSpeed = mean(
    tracks
      .map((track) => track.motion.max_speed_px_s)
      .filter((value): value is number => value !== null),
  );
  const observations = tracks.reduce((sum, track) => sum + track.observed.observations, 0);
  const evidence = useMemo(
    () => (events === null ? null : trackEvidenceSummary(events)),
    [events],
  );

  const navigate = useNavigate();
  const stats = [
    { key: "Objects tracked", value: formatNumber(total), tone: "accent" },
    { key: "With elevated rows", value: formatNumber(withEvents), tone: "warn" },
    { key: "Irregular objects", value: formatNumber(irregular), tone: "bad" },
    { key: "Suspicious objects", value: formatNumber(suspicious), tone: "warn" },
    { key: "Regular objects", value: formatNumber(regular), tone: "ok" },
    {
      key: "Mean duration",
      value: meanDuration === null ? "—" : `${meanDuration.toFixed(1)} s`,
      tone: "neutral",
    },
    {
      key: "Mean peak speed",
      value: meanPeakSpeed === null ? "—" : `${meanPeakSpeed.toFixed(0)} px/s`,
      tone: "neutral",
    },
    { key: "Roster observations", value: formatNumber(observations), tone: "neutral" },
  ];

  return (
    <div className="object-registry" id={id}>
      <SectionHeader
        title={title}
        meta={sub ?? "One card per tracked identity · measured values only"}
        level={3}
      />

      <div className="registry-stats">
        {stats.map((stat) => (
          <div
            className={`registry-stat registry-stat--${stat.tone}`}
            key={stat.key}
            aria-label={`${stat.key} ${stat.value}`}
          >
            <span className="registry-stat__key mono">{stat.key}</span>
            {/* Rendered from an attribute so the strip does not duplicate bare
                numbers that the page already reports elsewhere. */}
            <span
              className="registry-stat__value mono"
              aria-hidden="true"
              data-value={stat.value}
            />
          </div>
        ))}
      </div>

      <div className="registry-levels">
        <p className="registry-levels__lead">
          Every object is judged frame by frame by three checks — scene rules (speed, heading,
          zone), a per-object motion model and a scene-baseline comparison — fused into one score.
          An object's level is its worst measured score, and the band edges come from the running
          configuration.
        </p>
        <ul className="registry-levels__list">
          {LEVEL_ORDER.map((item) => (
            <li
              key={item}
              className={`registry-level registry-level--${item.toLowerCase()}`}
              style={{ ["--level-colour" as string]: LEVEL_COLOURS[item] }}
            >
              <span className="registry-level__head mono">
                <i aria-hidden="true" />
                {TIER[item].code} · {TIER[item].name}
              </span>
              <span className="registry-level__band mono">{thresholdBand(item, thresholds)}</span>
              <span className="registry-level__meaning">
                {item === "Normal"
                  ? "No observation crossed the suspicious mark, so the object stayed inside its learned baseline."
                  : item === "Suspicious"
                    ? "At least one observation crossed the suspicious mark; none reached the irregular mark."
                    : "At least one observation reached the irregular mark, the highest band the engine reports."}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {tracks.length === 0 ? (
        <p className="registry-empty">
          This session has no tracked identities, so there is no roster to show. That is a
          measured zero, not a failed read.
        </p>
      ) : (
        <div className="registry-grid">
          {tracks.map((track) => (
            <ObjectCard
              key={track.track_id}
              track={track}
              sessionId={sessionId}
              evidence={
                evidence
                  ? evidence.get(track.track_id) ??
                    (track.observed.anomalies > 0 ? null : undefined)
                  : null
              }
              thresholds={thresholds}
            />
          ))}
          {total > tracks.length ? (
            <div className="obj-card obj-card--more">
              <span className="obj-card__id mono">+{formatNumber(total - tracks.length)}</span>

              <button
                type="button"
                className="obj-card__link"
                onClick={() => navigate(`/tracks?session=${encodeURIComponent(sessionId)}`)}
              >
                open full roster →
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
