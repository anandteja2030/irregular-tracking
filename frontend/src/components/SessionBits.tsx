import type { Level, LevelCounts } from "../lib/types";

const ORDER: Level[] = ["Normal", "Suspicious", "Irregular"];

const MODIFIER: Record<Level, string> = {
  Normal: "normal",
  Suspicious: "suspicious",
  Irregular: "irregular",
};

export function levelClass(level: Level | null | undefined): string {
  return level ? `level level--${MODIFIER[level]}` : "level";
}

export function LevelBadge({ level }: { level: Level | null | undefined }) {
  return <span className={levelClass(level)}>{level ?? "Unknown"}</span>;
}

/** Counts → a single fused bar, so a session's mood reads at a glance. */
export function LevelMeter({ levels }: { levels: LevelCounts }) {
  const total = ORDER.reduce((sum, level) => sum + levels[level], 0);
  return (
    <span
      className="level-meter"
      role="img"
      aria-label={ORDER.map((level) => `${levels[level]} ${level.toLowerCase()}`).join(", ")}
      title={ORDER.map((level) => `${level}: ${levels[level]}`).join(" · ")}
    >
      {total > 0 &&
        ORDER.map((level) => {
          const share = (levels[level] / total) * 100;
          return share > 0 ? (
            <span
              key={level}
              className={`level-meter__seg level-meter__seg--${MODIFIER[level]}`}
              style={{ width: `${share}%` }}
            />
          ) : null;
        })}
      {total === 0 && <span className="level-meter__seg level-meter__seg--empty" />}
    </span>
  );
}

interface PagerProps {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  label: string;
}

export function Pager({ total, limit, offset, onChange, label }: PagerProps) {
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="pager">
      <span className="pager__readout mono">
        {start}–{end} / {total} {label}
      </span>
      <div className="pager__controls">
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          onClick={() => onChange(Math.max(0, offset - limit))}
          disabled={offset === 0}
        >
          Prev
        </button>
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          onClick={() => onChange(offset + limit)}
          disabled={end >= total}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Fixed-width percentage, so score columns never jitter while loading. */
export function Score({ value }: { value: number | null | undefined }) {
  return <span className="mono score">{value === null || value === undefined ? "—" : value.toFixed(2)}</span>;
}
