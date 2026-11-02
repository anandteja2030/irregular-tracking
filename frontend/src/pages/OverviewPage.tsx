import { Link } from "react-router-dom";
import { api, describeError } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { useApiHealth, apiPhase } from "../app/ApiHealthProvider";
import { useSession } from "../app/SessionProvider";
import { LevelMeter } from "../components/SessionBits";
import { NAV_ITEMS } from "../app/navigation";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { EmptyState, ErrorState, LoadingRows } from "../components/StateViews";
import {
  ArrowRightIcon,
  ClockIcon,
  DatabaseIcon,
  FilmIcon,
  RefreshIcon,
} from "../components/icons";
import {
  formatBytes,
  formatDuration,
  formatFps,
  formatNumber,
  formatResolution,
  formatUptime,
  truncateMiddle,
} from "../lib/format";
import type { SessionItem } from "../lib/types";

/** Readiness per surface, derived from the selected session rather than assumed. */
function surfaceState(
  id: string,
  session: SessionItem | null,
): { label: string; tone: string } {
  if (id === "overview") return { label: "Live", tone: "pill--ok" };
  if (id === "settings") return { label: "Config live", tone: "pill--ok" };
  if (id === "studio") return { label: "Sources linked", tone: "pill--accent" };
  if (!session) return { label: "No session", tone: "pill--mono-dim" };
  if (id === "tracks") return { label: `${session.counts.tracks} tracks`, tone: "pill--accent" };
  if (id === "anomalies") {
    return {
      label: `${session.counts.anomalies} events`,
      tone: session.counts.anomalies > 0 ? "pill--warn" : "pill--mono-dim",
    };
  }
  if (id === "scene") return { label: "Baseline measured", tone: "pill--accent" };
  if (id === "evaluation") {
    return session.counts.labels > 0
      ? { label: `${session.counts.labels} labels`, tone: "pill--accent" }
      : { label: "No ground truth", tone: "pill--mono-dim" };
  }
  return { label: "Ready", tone: "pill--mono-dim" };
}

export function OverviewPage() {
  const health = useApiHealth();
  const system = useResource(api.system);
  const sources = useResource(api.sources, { pollMs: 60_000 });
  const sessionState = useSession();
  const { sessions, total: sessionTotal, status: sessionStatus, selected: session } = sessionState;
  const phase = apiPhase(health);

  const refreshAll = () => {
    health.reload();
    system.reload();
    sources.reload();
    sessionState.reload();
  };

  const lastSync = Math.max(
    health.updatedAt ?? 0,
    system.updatedAt ?? 0,
    sources.updatedAt ?? 0,
  );

  const heroTitle =
    phase === "online" ? (
      <>
        Engine <em>reachable</em>
      </>
    ) : phase === "offline" ? (
      <>
        Engine <em>unreachable</em>
      </>
    ) : (
      <>Establishing link</>
    );

  const heroLede =
    phase === "offline"
      ? "The console could not reach the analysis service on this origin. Runtime readings stay empty until the link recovers — nothing below is estimated."
      : "Runtime facts on this surface are measured live from the Python host: version, uptime, dependency inventory and the storage envelope behind the engine.";

  return (
    <>
      <PageHeader
        eyebrow="Surveillance intelligence"
        title="Command Overview"
        lede="A single operational view of the analysis engine, its storage envelope and the surfaces that will carry session intelligence."
        aside={
          <>
            <span className="pill pill--mono-dim">
              <ClockIcon width={11} height={11} />
              {lastSync ? `Synced ${new Date(lastSync).toLocaleTimeString("en-GB")}` : "Awaiting link"}
            </span>
            <button
              type="button"
              className={`btn ${system.refreshing || sources.refreshing ? "is-spinning" : ""}`}
              onClick={refreshAll}
            >
              <span className="btn__icon">
                <RefreshIcon width={13} height={13} />
              </span>
              Refresh
            </button>
          </>
        }
      />

      <section className={`hero ${phase !== "online" ? "hero--idle" : ""}`.trim()}>
        <div className="hero__grid">
          <div className="hero__copy">
            <span className="eyebrow">Runtime envelope</span>
            <h2 className="hero__title">{heroTitle}</h2>
            <p className="hero__lede">{heroLede}</p>
            <div className="hero__meta">
              <span className="pill pill--accent">NEURAL COMMAND API</span>
              <span className="pill">v{health.data?.version ?? system.data?.version ?? "—"}</span>
              <span className="pill">
                <span
                  className={`dot ${
                    phase === "online" ? "dot--live" : phase === "offline" ? "dot--down" : ""
                  }`}
                />
                {phase === "online" ? "Operational" : phase === "offline" ? "Offline" : "Linking"}
              </span>
            </div>
            <div className="hero__foot">
              <Link className="btn" to="/video-studio">
                Open source inventory
                <span className="btn__icon">
                  <ArrowRightIcon width={13} height={13} />
                </span>
              </Link>
              <Link className="btn btn--quiet" to="/settings">
                Runtime &amp; configuration
              </Link>
            </div>
          </div>

          <div className="hero__orb">
            <div
              className={`orb ${
                phase === "online" ? "" : phase === "offline" ? "is-down" : "is-idle"
              }`}
              aria-hidden="true"
            >
              <span className="orb__ring" />
              <span className="orb__ring orb__ring--mid" />
              <span className="orb__ring orb__ring--inner" />
              <span className="orb__sweep" />
              <span className="orb__core" />
            </div>
            <div className="orb-caption">
              <span className="mini-label">Link state</span>
              <span className="orb-caption__value">
                {phase === "online"
                  ? formatUptime(health.data?.uptime_s)
                  : phase === "offline"
                    ? "no route"
                    : "pending"}
              </span>
            </div>
          </div>
        </div>

        <div className="readings hero__readings">
          <div className="reading">
            <span className="reading__label">Uptime</span>
            <span className="reading__value">
              {phase === "online" ? formatUptime(health.data?.uptime_s) : "—"}
            </span>
            <span className="reading__hint">current process</span>
          </div>
          <div className="reading">
            <span className="reading__label">Python</span>
            <span className="reading__value">
              {system.data ? system.data.python : system.status === "error" ? "—" : "…"}
            </span>
            <span className="reading__hint">{system.data?.python_implementation ?? "runtime"}</span>
          </div>
          <div className="reading">
            <span className="reading__label">Session store</span>
            <span className="reading__value">
              {system.data ? formatBytes(system.data.storage.db.bytes) : system.status === "error" ? "—" : "…"}
            </span>
            <span className="reading__hint">
              {system.data?.storage.db.exists ? "SQLite present" : "not created yet"}
            </span>
          </div>
          <div className="reading">
            <span className="reading__label">Sample sources</span>
            <span className="reading__value">
              {sources.data ? sources.data.valid : sources.status === "error" ? "—" : "…"}
              {sources.data && <span className="reading__unit">of {sources.data.count}</span>}
            </span>
            <span className="reading__hint">decodable clips</span>
          </div>
          <div className="reading">
            <span className="reading__label">Sessions</span>
            <span className="reading__value">
              {sessionStatus === "error" ? "—" : sessionStatus === "loading" && sessionTotal === 0 ? "…" : sessionTotal}
            </span>
            <span className="reading__hint">persisted runs</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <span className="section__title">Operational surface</span>
          <span className="section__meta">Seven workspaces</span>
        </div>

        <div className="layout-wide-left">
          <Panel
            title="Workspace readiness"
            sub="Navigation foundation"
            bodyClassName="panel__body--flush"
          >
            <div className="rows">
              {NAV_ITEMS.map((item) => {
                const state = surfaceState(item.id, session);
                return (
                  <Link key={item.id} to={item.path} className="row row--link">
                    <span className="surface-index mono">{item.index}</span>
                    <span className="surface-text">
                      <span className="surface-title">{item.label}</span>
                      <span className="surface-blurb">{item.blurb}</span>
                    </span>
                    <span className={`pill ${state.tone}`}>{state.label}</span>
                    <span className="row-arrow">
                      <ArrowRightIcon width={13} height={13} />
                    </span>
                  </Link>
                );
              })}
            </div>
          </Panel>

          <Panel
            title="Runtime"
            sub="Measured host facts"
            actions={
              <span className="tag">{system.data ? `${Object.keys(system.data.packages).length} deps` : "—"}</span>
            }
          >
            {system.status === "error" ? (
              <ErrorState error={system.error} onRetry={system.reload} compact />
            ) : system.status === "loading" && !system.data ? (
              <LoadingRows rows={5} label="Loading runtime" />
            ) : system.data ? (
              <div className="stack gap-14">
                <div className="rows rows--tight">
                  <div className="row">
                    <span className="row__key">Platform</span>
                    <span className="row__value" title={system.data.platform}>
                      {truncateMiddle(system.data.platform, 30)}
                    </span>
                  </div>
                  <div className="row">
                    <span className="row__key">Python</span>
                    <span className="row__value">{system.data.python}</span>
                  </div>
                  <div className="row">
                    <span className="row__key">PID</span>
                    <span className="row__value">{system.data.runtime.pid}</span>
                  </div>
                  <div className="row">
                    <span className="row__key">Executable</span>
                    <span className="row__value" title={system.data.runtime.executable}>
                      {truncateMiddle(system.data.runtime.executable, 26)}
                    </span>
                  </div>
                </div>
                <div className="package-grid">
                  {Object.entries(system.data.packages).map(([name, version]) => (
                    <span className="package" key={name}>
                      <span className="package__name">{name}</span>
                      <span className="package__version">{version ?? "absent"}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </Panel>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <span className="section__title">Signals</span>
          <span className="section__meta">Live sources · session ledger</span>
        </div>

        <div className="grid-2">
          <Panel
            title="Sample inventory"
            sub={sources.data?.directory ? truncateMiddle(sources.data.directory, 38) : "samples directory"}
            actions={
              <Link className="btn btn--quiet" to="/video-studio">
                Inspect all
              </Link>
            }
          >
            {sources.status === "error" ? (
              <ErrorState error={sources.error} onRetry={sources.reload} compact />
            ) : sources.status === "loading" && !sources.data ? (
              <LoadingRows rows={3} label="Loading sources" />
            ) : sources.data && sources.data.sources.length > 0 ? (
              <div className="source-list source-list--compact">
                {sources.data.sources.slice(0, 3).map((source) => (
                  <div className="source-row" key={source.path}>
                    <span className="source-row__glyph">
                      <FilmIcon width={15} height={15} />
                    </span>
                    <span className="source-row__text">
                      <span className="source-row__name truncate">{source.name}</span>
                      <span className="source-row__meta">
                        {formatResolution(source.width, source.height)} · {formatFps(source.fps)} ·{" "}
                        {formatDuration(source.duration_s)}
                      </span>
                    </span>
                    <span className="source-row__size mono">{formatBytes(source.bytes)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                title="No sample footage found"
                body="The engine's samples directory is empty, so there is nothing to inventory yet."
                code={sources.data?.directory}
              />
            )}
          </Panel>

          <Panel
            title="Session ledger"
            sub={
              sessionStatus === "error"
                ? "session API unreachable"
                : `${sessionTotal} persisted ${sessionTotal === 1 ? "run" : "runs"}`
            }
            actions={
              sessions.length > 0 ? (
                <Link className="btn btn--quiet" to="/tracks">
                  Open explorer
                </Link>
              ) : undefined
            }
          >
            {sessionStatus === "error" ? (
              <ErrorState error={sessionState.error} onRetry={sessionState.reload} compact />
            ) : sessionStatus === "loading" && sessions.length === 0 ? (
              <LoadingRows rows={3} label="Loading sessions" />
            ) : sessions.length > 0 ? (
              <div className="ledger">
                {sessions.slice(0, 4).map((item) => (
                  <Link
                    key={item.session}
                    className="ledger__row"
                    to={`/tracks?session=${encodeURIComponent(item.session)}`}
                  >
                    <LevelMeter levels={item.counts.levels} />
                    <span className="ledger__text">
                      <span className="ledger__id mono truncate">{item.session}</span>
                      <span className="ledger__meta truncate">
                        {item.source.label ?? item.source.kind ?? "source"} ·{" "}
                        {formatResolution(item.processing.width, item.processing.height)} ·{" "}
                        {formatNumber(item.counts.observations)} obs
                      </span>
                    </span>
                    <span className="ledger__stat">
                      <span className="ledger__value mono">{item.counts.tracks}</span>
                      <span className="ledger__unit">tracks</span>
                    </span>
                    <span className="ledger__stat">
                      <span className="ledger__value mono">{item.counts.anomalies}</span>
                      <span className="ledger__unit">events</span>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No sessions recorded"
                body="The engine has not persisted a run yet. Sessions appear here as soon as one finishes — this surface never fabricates them."
                code="track_events · track_summaries · run_stats"
                glyph={<DatabaseIcon width={17} height={17} />}
                actions={
                  <Link className="btn btn--quiet" to="/video-studio">
                    Open source inventory
                  </Link>
                }
              />
            )}
            {system.data && (
              <p className="note-line">
                <span className={`dot ${sessionStatus === "error" ? "dot--warn" : "dot--live"}`} />
                {formatBytes(system.data.storage.db.bytes)} stored at {basenameOf(system.data.storage.db.path)}
                <span className="dim"> · {system.data.storage.output.files} exported files</span>
              </p>
            )}
          </Panel>
        </div>
      </section>

      {phase === "offline" && health.error ? (
        <p className="note-line note-line--danger">
          <span className="dot dot--down" />
          {describeError(health.error)}
        </p>
      ) : null}
    </>
  );
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
