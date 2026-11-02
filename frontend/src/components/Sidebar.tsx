import { NavLink } from "react-router-dom";
import { NAV_ITEMS } from "../app/navigation";
import { useApiHealth, apiPhase } from "../app/ApiHealthProvider";
import { DatabaseIcon } from "../components/icons";

function BrandMark() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.6 21 7.4v9.2L12 21.4 3 16.6V7.4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        opacity="0.75"
      />
      <path d="M12 7.1v9.8M7.6 9.6v4.8M16.4 9.6v4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

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
    <aside className="rail">
      <div className="brand">
        <span className="brand__mark">
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
            title={item.label}
          >
            <span className="nav-item__icon">
              <item.Icon width={17} height={17} />
            </span>
            <span className="nav-item__label">{item.label}</span>
            <span className="nav-item__index">{item.index}</span>
          </NavLink>
        ))}
      </nav>

      <div className="rail__footer">
        <div className="rail-status" title={statusSub}>
          <span
            className={`dot ${
              phase === "online" ? "dot--live" : phase === "offline" ? "dot--down" : ""
            }`}
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
