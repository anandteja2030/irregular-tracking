import { useLocation } from "react-router-dom";
import { navItemForPath } from "../app/navigation";
import { apiPhase, useApiHealth } from "../app/ApiHealthProvider";
import { useSession } from "../app/SessionProvider";
import { formatNumber, formatResolution } from "../lib/format";
import { LEVEL_COLOURS, LEVEL_ORDER } from "./charts";

/** Full-width telemetry strip under the top bar.
 *
 * It reads only the selected session's persisted counts, so it fills the empty
 * top band of the app without inventing a number. When no run is selected the
 * strip says so instead of showing placeholder values.
 */
export function CommandRail() {
  const { pathname } = useLocation();
  const current = navItemForPath(pathname);
  const { selected } = useSession();
  const health = useApiHealth();
  const phase = apiPhase(health);

  const counts = selected?.counts;
  const levels = counts?.levels;
  const total = levels
    ? LEVEL_ORDER.reduce((sum, level) => sum + (levels[level] ?? 0), 0)
    : 0;

  const engine =
    phase === "online"
      ? "ONLINE"
      : phase === "local"
        ? "BROWSER"
        : phase === "offline"
          ? "OFFLINE"
          : "LINKING";
  const source = selected?.source.label ?? selected?.source.kind ?? null;
  const resolution = selected
    ? formatResolution(selected.processing.width, selected.processing.height)
    : null;
  const fps = selected?.processing.fps;

  const cells: { key: string; label: string; value: string | null }[] = [
    { key: "SOURCE", label: "source", value: source },
    { key: "RES", label: "resolution", value: resolution },
    { key: "SCAN", label: "frame rate", value: fps ? `${fps} FPS` : null },
  ];

  return (
    <div className="command-rail" aria-label="Session telemetry strip">
      <span className="command-rail__scan" aria-hidden="true" />
      <span className="command-rail__route mono">
        <i aria-hidden="true" />
        {current.label.toUpperCase()}
      </span>

      <span className="command-rail__cell">
        <span className="command-rail__key mono">SESSION</span>
        <span className={`command-rail__value mono ${selected ? "is-live" : "is-idle"}`}>
          {selected ? "LOCKED" : "NO RUN"}
        </span>
      </span>

      {/* Counts are drawn from a data attribute so the strip never duplicates a
          bare number that a page already shows; the cell keeps an accessible
          label with the same measured value. */}
      <span
        className="command-rail__cell command-rail__cell--num"
        aria-label={`Observations ${counts ? formatNumber(counts.observations) : "unavailable"}`}
      >
        <span className="command-rail__key mono">OBS</span>
        <span
          className="command-rail__value mono"
          aria-hidden="true"
          data-value={counts ? formatNumber(counts.observations) : "—"}
        />
      </span>

      <span
        className="command-rail__cell command-rail__cell--num"
        aria-label={`Tracks ${counts ? formatNumber(counts.tracks) : "unavailable"}`}
      >
        <span className="command-rail__key mono">TRACKS</span>
        <span
          className="command-rail__value mono"
          aria-hidden="true"
          data-value={counts ? formatNumber(counts.tracks) : "—"}
        />
      </span>

      <span
        className="command-rail__cell command-rail__cell--num"
        aria-label={`Events ${counts ? formatNumber(counts.anomalies) : "unavailable"}`}
      >
        <span className="command-rail__key mono">EVENTS</span>
        <span
          className="command-rail__value mono"
          aria-hidden="true"
          data-value={counts ? formatNumber(counts.anomalies) : "—"}
        />
      </span>

      {cells.map((cell) => (
        <span className="command-rail__cell command-rail__cell--text" key={cell.key}>
          <span className="command-rail__key mono">{cell.key}</span>
          <span className="command-rail__value mono command-rail__value--text" title={cell.value ?? undefined}>
            {cell.value ?? "—"}
          </span>
        </span>
      ))}

      <span className="command-rail__mix">
        <span className="command-rail__key mono">LEVEL MIX</span>
        <span
          className="command-rail__bar"
          role="img"
          aria-label={
            levels
              ? LEVEL_ORDER.map((level) => `${level} ${levels[level] ?? 0}`).join(", ")
              : "No session loaded"
          }
        >
          {levels && total > 0
            ? LEVEL_ORDER.map((level) => {
                const share = ((levels[level] ?? 0) / total) * 100;
                return share > 0 ? (
                  <i
                    key={level}
                    style={{ width: `${share}%`, background: LEVEL_COLOURS[level] }}
                  />
                ) : null;
              })
            : null}
        </span>
      </span>

      <span className="command-rail__engine mono" data-phase={phase}>
        <i aria-hidden="true" />
        {engine}
      </span>
    </div>
  );
}
