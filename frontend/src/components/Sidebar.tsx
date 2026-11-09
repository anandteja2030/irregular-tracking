import { NavLink } from "react-router-dom";
import { NAV_ITEMS } from "../app/navigation";
import { useApiHealth, apiPhase } from "../app/ApiHealthProvider";
import { BrandMark } from "./BrandMark";
import { DatabaseIcon } from "../components/icons";

export function Sidebar() {
  const health = useApiHealth();
  const phase = apiPhase(health);

  const statusLabel =
    phase === "online" ? "API LINKED" : phase === "offline" ? "API OFFLINE" : "LINKING";
  const statusSub =
    phase === "online"
      ? `v${health.data?.version ?? "—"} · ${health.data?.uptime_s ?? 0}s uptime`
      : phase === "offline"
        ? "service unreachable"
        : "handshake in progress";

  return (
    <aside className="rail" aria-label="Workspace navigation">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          <BrandMark />
        </span>
        <span className="brand__text">
          <span className="brand__name">NEURAL COMMAND</span>
          <span className="brand__tag">SURVEILLANCE INTELLIGENCE</span>
        </span>
      </div>

      <div className="rail__section">
        <span className="eyebrow">Workspace</span>
      </div>

      <nav className="rail__nav" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`}
            // The rail folds to an icon column below 1180px, so the link carries
            // its own name instead of relying on the label that CSS hides.
            aria-label={item.label}
            title={item.label}
          >
            <span className="nav-item__icon" aria-hidden="true">
              <item.Icon width={17} height={17} />
            </span>
            <span className="nav-item__label">{item.label}</span>
            <span className="nav-item__index" aria-hidden="true">
              {item.index}
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="rail__footer">
        <div className="rail-status" title={statusSub}>
          <span
            className={`dot ${
              phase === "online" ? "dot--live" : phase === "offline" ? "dot--down" : ""
            }`}
            aria-hidden="true"
          />
          <span className="rail-status__text">
            <span className="rail-status__title">{statusLabel}</span>
            <span className="rail-status__sub">{statusSub}</span>
          </span>
        </div>
        <div className="rail__version">
          <span>Console 0.1</span>
          <span aria-hidden="true">
            <DatabaseIcon width={11} height={11} />
          </span>
        </div>
      </div>
    </aside>
  );
}
