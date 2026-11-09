import { Link } from "react-router-dom";
import { api, describeError } from "../lib/api";
import { useResource } from "../hooks/useResource";
import { useApiHealth, apiPhase } from "../app/ApiHealthProvider";
import { useSession } from "../app/SessionProvider";
import { LevelMeter } from "../components/SessionBits";
import { NAV_ITEMS } from "../app/navigation";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { SectionHeader } from "../components/SectionHeader";
import { MetricCard, MetricGrid } from "../components/MetricCard";
import { StatusPill, type StatusTone } from "../components/StatusPill";
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
): { label: string; tone: StatusTone } {
  if (id === "overview") return { label: "Live", tone: "ok" };
  if (id === "settings") return { label: "Config live", tone: "ok" };
  if (id === "studio") return { label: "Sources linked", tone: "accent" };
  if (!session) return { label: "No session", tone: "muted" };
  if (id === "tracks") return { label: `${session.counts.tracks} tracks`, tone: "accent" };
  if (id === "anomalies") {
    return {
      label: `${session.counts.anomalies} events`,
      tone: session.counts.anomalies > 0 ? "warn" : "muted",
    };
  }
  if (id === "scene") return { label: "Baseline measured", tone: "accent" };
  if (id === "evaluation") {
    return session.counts.labels > 0
      ? { label: `${session.counts.labels} labels`, tone: "accent" }
      : { label: "No ground truth", tone: "muted" };
  }
  return { label: "Ready", tone: "muted" };
}

export function OverviewPage() {
  const health = useApiHealth();
  const system = useResource(api.system);
  const sources = useResource(api.sources, { pollMs: 60_000 });
  const sessionState = useSession();
  const { sessions, total: sessionTotal, status: sessionStatus, selected: session } = sessionState;
  const phase = apiPhase(health);
  const online = phase === "online";

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

  const systemLoading = system.status === "loading" && !system.data;
  const systemError = system.status === "error" ? "runtime API unreachable" : null;
  const sourcesLoading = sources.status === "loading" && !sources.data;
  const sourcesError = sources.status === "error" ? "source scan unavailable" : null;

  return (
    <>
      <PageHeader
        eyebrow="Surveillance intelligence"
        title="Command Overview"
        lede="A single operational view of the analysis engine, its storage envelope and the surfaces that will carry session intelligence."
        aside={
          <>
            <StatusPill tone="muted" size="sm" icon={<ClockIcon width={11} height={11} />}>
              {lastSync
                ? `Synced ${new Date(lastSync).toLocaleTimeString("en-GB")}`
                : "Awaiting link"}
            </StatusPill>
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

      <section
        className={`hero deck ${phase !== "online" ? "hero--idle" : ""} deck--${phase}`.trim()}
        aria-labelledby="overview-state"
      >
        <div className="hero__grid">
          <div className="hero__copy">
            <span className="eyebrow">Runtime envelope</span>
            <h2 className="hero__title" id="overview-state">
              {heroTitle}
            </h2>
            <p className="hero__lede">{heroLede}</p>
            <div className="hero__meta">
              <StatusPill tone="accent" size="sm">
                NEURAL COMMAND API
              </StatusPill>
              <StatusPill tone="neutral" size="sm">
                v{health.data?.version ?? system.data?.version ?? "—"}
              </StatusPill>
              <StatusPill
                tone={online ? "ok" : phase === "offline" ? "bad" : "muted"}
                size="sm"
                dot
                live
              >
                {online ? "Operational" : phase === "offline" ? "Offline" : "Linking"}
              </StatusPill>
            </div>
            <div className="hero__foot">
              <Link className="btn btn--primary" to="/video-studio">
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
      </section>

      <section className="section" aria-labelledby="overview-vitals">
        <SectionHeader
          title="System vitals"
          id="overview-vitals"
          meta="Measured host facts · live"
          level={3}
        />

        <MetricGrid columns={5} label="System vitals" className="vitals-grid">
          <MetricCard
            label="Uptime"
            value={online ? formatUptime(health.data?.uptime_s) : undefined}
            hint="current process"
            tone={online ? "ok" : "neutral"}
            loading={phase === "linking"}
          />
          <MetricCard
            label="Python"
            value={system.data?.python}
            hint={system.data?.python_implementation ?? "runtime"}
            loading={systemLoading}
            error={systemError}
          />
          <MetricCard
            label="Session store"
            value={system.data ? formatBytes(system.data.storage.db.bytes) : undefined}
            hint={system.data?.storage.db.exists ? "SQLite present" : "not created yet"}
            loading={systemLoading}
            error={systemError}
          />
          <MetricCard
            label="Sample sources"
            value={sources.data?.valid}
            unit={sources.data ? `of ${sources.data.count}` : undefined}
            hint="decodable clips"
            loading={sourcesLoading}
            error={sourcesError}
          />
          <MetricCard
            label="Sessions"
            value={
              sessionStatus === "error" || (sessionStatus === "loading" && sessionTotal === 0)
                ? undefined
                : sessionTotal
            }
            hint="persisted runs"
            tone={sessionTotal > 0 ? "accent-2" : "neutral"}
            loading={sessionStatus === "loading" && sessionTotal === 0}
            error={sessionStatus === "error" ? sessionState.error ? describeError(sessionState.error) : "unavailable" : null}
          />
        </MetricGrid>

        {phase === "offline" && health.error ? (
          <p className="note-line note-line--danger deck-note">
            <span className="dot dot--down" />
            {describeError(health.error)}
          </p>
        ) : null}
      </section>

      <section className="section" aria-labelledby="overview-surface">
        <SectionHeader
          title="Operational surface"
          id="overview-surface"
          meta="Seven workspaces"
          level={3}
        />

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
                    <StatusPill tone={state.tone} size="sm" className="row--link__state">
                      {state.label}
                    </StatusPill>
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
            ) : systemLoading ? (
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

      <section className="section" aria-labelledby="overview-signals">
        <SectionHeader
          title="Signals"
          id="overview-signals"
          meta="Live sources · session ledger"
          level={3}
        />

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
            ) : sourcesLoading ? (
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
    </>
  );
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
