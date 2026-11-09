import type { TrackDetail } from "../lib/types";
import type { DirectionSummary } from "../lib/tracks";
import { formatTrackId } from "../lib/tracks";
import { formatDuration, formatNumber } from "../lib/format";
import { LevelBadge, LevelMeter, Score } from "./SessionBits";
import { MetricCard, MetricGrid } from "./MetricCard";

interface TrackTelemetryProps {
  detail: TrackDetail;
  directions: DirectionSummary | null;
  fps: number | null;
}

export function TrackTelemetry({ detail, directions, fps }: TrackTelemetryProps) {
  const motion = detail.motion;
  const observed = detail.observed;
  const levels = [
    { level: "Normal" as const, count: observed.levels.Normal },
    { level: "Suspicious" as const, count: observed.levels.Suspicious },
    { level: "Irregular" as const, count: observed.levels.Irregular },
  ];

  return (
    <div className="stack gap-14">
      <MetricGrid columns={3} label="Observation levels" className="telemetry-levels">
        {levels.map((entry) => (
          <MetricCard
            key={entry.level}
            label={entry.level}
            value={formatNumber(entry.count)}
            hint="observations"
            tone={entry.level === "Normal" ? "ok" : entry.level === "Suspicious" ? "warn" : "bad"}
            meter={
              observed.observations > 0 ? entry.count / observed.observations : null
            }
          />
        ))}
      </MetricGrid>
      <LevelMeter levels={observed.levels} />

      <div className="rows rows--tight">
        <div className="row">
          <span className="row__key">Lifecycle</span>
          <span className="row__value mono">
            F{detail.frames.first ?? "—"}–F{detail.frames.last ?? "—"}
          </span>
        </div>
        <div className="row">
          <span className="row__key">First seen</span>
          <span className="row__value mono">{formatTimestamp(detail.timestamps.first_ts)}</span>
        </div>
        <div className="row">
          <span className="row__key">Last seen</span>
          <span className="row__value mono">{formatTimestamp(detail.timestamps.last_ts)}</span>
        </div>
        <div className="row">
          <span className="row__key">Duration</span>
          <span className="row__value mono">{formatDuration(observed.duration_s)}</span>
        </div>
        <div className="row">
          <span className="row__key">Observations</span>
          <span className="row__value mono">{formatNumber(observed.observations)}</span>
        </div>
        <div className="row">
          <span className="row__key">Worst level</span>
          <span className="row__value">
            <LevelBadge level={observed.worst_level} />
          </span>
        </div>
        <div className="row">
          <span className="row__key">Mean speed</span>
          <span className="row__value mono">
            {motion.mean_speed_px_s === null ? "—" : `${motion.mean_speed_px_s.toFixed(1)} px/s`}
          </span>
        </div>
        <div className="row">
          <span className="row__key">Max speed</span>
          <span className="row__value mono">
            {motion.max_speed_px_s === null ? "—" : `${motion.max_speed_px_s.toFixed(1)} px/s`}
          </span>
        </div>
        <div className="row">
          <span className="row__key">Path length</span>
          <span className="row__value mono">
            {motion.path_length_px === null ? "—" : `${motion.path_length_px.toFixed(1)} px`}
          </span>
        </div>
        <div className="row">
          <span className="row__key">Straightness</span>
          <span className="row__value mono">
            {motion.straightness === null ? "—" : motion.straightness.toFixed(3)}
          </span>
        </div>
        <div className="row">
          <span className="row__key">Max fused</span>
          <span className="row__value">
            <Score value={motion.max_fused_score} />
          </span>
        </div>
        <div className="row">
          <span className="row__key">Points</span>
          <span className="row__value mono">
            {motion.n_points === null ? "—" : formatNumber(motion.n_points)}
            {motion.n_seconds === null ? "" : ` / ${motion.n_seconds.toFixed(2)}s`}
          </span>
        </div>
        <div className="row">
          <span className="row__key">Heading turns</span>
          <span className="row__value mono">
            {directions ? `${formatNumber(directions.changes)} > ${directions.thresholdDeg}°` : "—"}
          </span>
        </div>
      </div>

      {Object.keys(detail.direction_profile.histogram).length > 0 && (
        <DirectionHistogram profile={detail.direction_profile} />
      )}

      <p className="note-line">
        <span className="dot" />
        {formatTrackId(detail.track_id)} · speeds from {motion.speed_source} · directions from{" "}
        {detail.direction_profile.source}
        {fps ? ` · ${fps.toFixed(0)} fps session` : ""}
      </p>
    </div>
  );
}

function DirectionHistogram({ profile }: { profile: TrackDetail["direction_profile"] }) {
  const entries = Object.entries(profile.histogram).sort((a, b) => b[1] - a[1]);
  return (
    <div className="histogram">
      <span className="mini-label">
        Heading distribution · {formatNumber(profile.samples)} samples
      </span>
      {entries.map(([bin, share]) => (
        <span className="histogram__row" key={bin}>
          <span className="histogram__bin mono">{bin}</span>
          <span className="histogram__track">
            <span className="histogram__fill" style={{ width: `${Math.max(share * 100, 1.5)}%` }} />
          </span>
          <span className="histogram__value mono">{(share * 100).toFixed(1)}%</span>
        </span>
      ))}
      {profile.dominant.length > 0 && (
        <span className="hint hint--flush">
          Dominant heading{profile.dominant.length === 1 ? "" : "s"}: {profile.dominant.join(", ")}
        </span>
      )}
    </div>
  );
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  const iso = ts.replace("T", " ").replace("+00:00", "").replace("Z", "");
  return `${iso.slice(0, 19)} UTC`;
}
