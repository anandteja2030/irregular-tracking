import { useLocation } from "react-router-dom";
import { navItemForPath } from "../app/navigation";
import { apiPhase, useApiHealth } from "../app/ApiHealthProvider";
import { formatClock } from "../lib/format";
import { CommandIcon } from "./icons";
import { SessionSelect } from "./SessionSelect";

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { pathname } = useLocation();
  const current = navItemForPath(pathname);
  const health = useApiHealth();
  const phase = apiPhase(health);

  const pillClass =
    phase === "online" ? "is-live" : phase === "offline" ? "is-down" : "is-pending";

  const label =
    phase === "online"
      ? "Engine online"
      : phase === "offline"
        ? "Engine offline"
        : "Connecting";

  return (
    <header className="topbar">
      <div className="crumbs">
        <span className="crumbs__root">NEURAL / COMMAND</span>
        <span className="crumbs__sep">/</span>
        <span className="crumbs__leaf">{current.label}</span>
      </div>

      <div className="topbar__meta">
        <SessionSelect />

        <div className={`health-pill ${pillClass}`} aria-live="polite">
          <span
            className={`dot ${
              phase === "online" ? "dot--live" : phase === "offline" ? "dot--down" : ""
            }`}
          />
          <span>{label}</span>
          {phase === "online" && health.data && (
            <span className="health-pill__value tabular">
              {formatClock(health.data.uptime_s)}
            </span>
          )}
        </div>

        <button
          type="button"
          className="kbd"
          onClick={onOpenPalette}
          aria-haspopup="dialog"
        >
          <span className="kbd__glyph">
            <CommandIcon width={11} height={11} />
          </span>
          K
        </button>
      </div>
    </header>
  );
}
