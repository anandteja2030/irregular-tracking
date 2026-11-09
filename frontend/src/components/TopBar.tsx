import { useLocation } from "react-router-dom";
import { navItemForPath } from "../app/navigation";
import { apiPhase, useApiHealth } from "../app/ApiHealthProvider";
import { formatClock } from "../lib/format";
import { BrandMark } from "./BrandMark";
import { CommandIcon } from "./icons";
import { SessionSelect } from "./SessionSelect";
import { StatusPill, type StatusTone } from "./StatusPill";

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { pathname } = useLocation();
  const current = navItemForPath(pathname);
  const health = useApiHealth();
  const phase = apiPhase(health);

  const label =
    phase === "online"
      ? "Engine online"
      : phase === "offline"
        ? "Engine offline"
        : "Connecting";

  const tone: StatusTone = phase === "online" ? "ok" : phase === "offline" ? "bad" : "muted";

  return (
    <header className="topbar">
      <div className="topbar__identity">
        {/* The rail carries the brand above 720px; this mark carries it below. */}
        <span className="topbar__brand" aria-hidden="true">
          <BrandMark size={17} />
        </span>
        <nav className="crumbs" aria-label="Breadcrumb">
          <span className="crumbs__root" aria-hidden="true">
            NEURAL / COMMAND
          </span>
          <span className="crumbs__sep" aria-hidden="true">
            /
          </span>
          <span className="crumbs__leaf">{current.label}</span>
        </nav>
      </div>

      <div className="topbar__session">
        <SessionSelect />
      </div>

      <div className="topbar__health">
        <StatusPill tone={tone} dot className="shell-health" title={label}>
          {label}
          {phase === "online" && health.data && (
            <span className="shell-health__value tabular">
              {formatClock(health.data.uptime_s)}
            </span>
          )}
        </StatusPill>
        {/* Announced only when the phase itself changes, not on every uptime tick. */}
        <span className="sr-only" role="status" aria-live="polite">
          {`Engine status: ${phase}`}
        </span>
      </div>

      <div className="topbar__actions">
        <button
          type="button"
          className="palette-trigger"
          onClick={onOpenPalette}
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          aria-label="Open command palette"
          title="Command palette (Ctrl K)"
        >
          <span className="palette-trigger__glyph" aria-hidden="true">
            <CommandIcon width={13} height={13} />
          </span>
          <span className="palette-trigger__label" aria-hidden="true">
            Search
          </span>
          <span className="palette-trigger__key" aria-hidden="true">
            K
          </span>
        </button>
      </div>
    </header>
  );
}
