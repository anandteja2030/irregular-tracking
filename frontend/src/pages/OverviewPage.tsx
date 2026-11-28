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
  BarList,
  LEVEL_COLOURS,
  LevelDonut,
  LevelLegend,
  StackedLevelBar,
} from "../components/charts";
import {
  ArrowRightIcon,
  ClockIcon,
  DatabaseIcon,
  FilmIcon,
  RefreshIcon,
} from "../components/icons";
import { QuantumFlow } from "../components/quantum";
import { DetectionCore } from "../components/DetectionCore";
import { RunReport } from "../components/RunReport";
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
import { appearanceLabel } from "../lib/tracks";

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
  const {
    sessions,
    total: sessionTotal,
    status: sessionStatus,
    selected: session,
    selectedId,
  } = sessionState;
  const phase = apiPhase(health);
  const online = phase === "online";
  const trackList = useResource(
    (signal) => api.tracks(selectedId as string, { sort: "anomalies", limit: 50 }, signal),
    { enabled: Boolean(selectedId), key: selectedId ?? "none" },
  );
  const levels = session?.counts.levels ?? null;
  const observations = session?.counts.observations ?? 0;
  const elevated = levels ? levels.Suspicious + levels.Irregular : 0;
  const elevatedShare = observations > 0 ? (elevated / observations) * 100 : null;
  const rankedTracks = (trackList.data?.tracks ?? [])
    .filter((track) => track.observed.anomalies > 0)
    .slice(0, 6);
  const sessionRows = sessions.slice(0, 8).map((item) => {
    const total = item.counts.observations;
    const raised = item.counts.levels.Suspicious + item.counts.levels.Irregular;
    return {
      key: item.session,
      label: `${item.source.label ?? "run"} · ${item.session.slice(-6)}`,
      value: total > 0 ? (raised / total) * 100 : 0,
      hint: `${formatNumber(raised)} / ${formatNumber(total)} obs`,
      color: raised > 0 ? "var(--chart-4)" : "var(--chart-1)",
    };
  });

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

  const apiVersion = health.data?.version ?? system.data?.version ?? null;
  const heroLede =
    phase === "offline"
      ? "Analysis service unreachable."
      : phase === "online" && session
        ? `Answering${apiVersion ? ` on v${apiVersion}` : ""} · ${formatNumber(
            session.counts.tracks,
          )} tracked objects and ${formatNumber(elevated)} elevated rows across ${formatNumber(
            observations,
          )} observations.`
        : phase === "online"
          ? "Answering, but no analysis run is loaded — analyse a clip in Video Studio to populate the verdicts."
          : "";

  const systemLoading = system.status === "loading" && !system.data;
  const systemError = system.status === "error" ? "runtime API unreachable" : null;
  const sourcesLoading = sources.status === "loading" && !sources.data;
  const sourcesError = sources.status === "error" ? "source scan unavailable" : null;

  return (
    <>
      <PageHeader
        eyebrow="Surveillance intelligence"
        title="Command Overview"
        lede="The selected run: tracked objects, verdicts and irregular evidence."
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
            <div className="hero__meta">
              <StatusPill tone="accent" size="sm">
                NEURAL COMMAND API
              </StatusPill>
              <StatusPill tone="neutral" size="sm">
                v{health.data?.version ?? system.data?.version ?? "—"}
              </StatusPill>
              <StatusPill
                tone={online || phase === "local" ? "ok" : phase === "offline" ? "bad" : "muted"}
                size="sm"
                dot
                live
              >
                {online
                  ? "Operational"
                  : phase === "local"
                    ? "Browser engine"
                    : phase === "offline"
                      ? "Offline"
                      : "Linking"}
              </StatusPill>
            </div>
            {heroLede ? <p className="hero__lede">{heroLede}</p> : null}
            {session ? (
              <dl className="hero__facts">
                <div className="hero__fact">
                  <dt>Source</dt>
                  <dd className="mono" title={session.source.label ?? undefined}>
                    {truncateMiddle(session.source.label ?? session.source.kind ?? "source", 30)}
                  </dd>
                </div>
                <div className="hero__fact">
                  <dt>Processing</dt>
                  <dd className="mono">
                    {formatResolution(session.processing.width, session.processing.height)} ·{" "}
                    {formatFps(session.processing.fps)}
                  </dd>
                </div>
                <div className="hero__fact">
                  <dt>Frames</dt>
                  <dd className="mono">
                    {formatNumber(session.processing.frames_processed)} processed
                  </dd>
                </div>
              </dl>
            ) : null}
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

          <DetectionCore
            levels={levels}
            tracks={session?.counts.tracks ?? 0}
            observations={observations}
            elevated={elevated}
            online={online}
          />
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
            tone={online ? "ok" : "neutral"}
            loading={phase === "linking"}
          />
          <MetricCard
            label="Python"
            value={system.data?.python}
            loading={systemLoading}
            error={systemError}
          />
          <MetricCard
            label="Session store"
            value={system.data ? formatBytes(system.data.storage.db.bytes) : undefined}
            loading={systemLoading}
            error={systemError}
          />
          <MetricCard
            label="Sample sources"
            value={sources.data?.valid}
            unit={sources.data ? `of ${sources.data.count}` : undefined}
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

      <section className="section" aria-labelledby="overview-pipeline">
        <SectionHeader
          title="Quantum analysis pipeline"
          id="overview-pipeline"
          meta="Five measured stages · no simulated step"
          level={3}
        />
        <Panel title="From photons to a labelled object" sub="The same engine path for files, samples and live frames">
          <QuantumFlow />
        </Panel>
      </section>

      <section className="section" aria-labelledby="overview-intelligence">
        <SectionHeader
          title="Session intelligence"
          id="overview-intelligence"
          meta={session ? `${session.session} · selected run` : "No persisted run selected"}
          level={3}
        />

        {!session ? (
          <Panel title="Nothing to visualise yet" sub="Session required">
            <EmptyState
              compact
              title="No selected session"
              body="Outcome charts, object leaders and run comparison all read a persisted session. Analyse a clip or stop a live capture, then pick it in the top bar."
              code="GET /api/v1/sessions"
              actions={
                <Link className="btn btn--quiet" to="/video-studio">
                  Open source inventory
                </Link>
              }
            />
          </Panel>
        ) : (
          <>
            <RunReport
              session={session}
              tracks={trackList.data?.tracks ?? []}
              tracksTotal={session.counts.tracks}
            />

            <div className="intel-grid">
            <Panel title="Outcome mix" sub={`${formatNumber(observations)} persisted observations`}>
              <div className="donut-row">
                <LevelDonut levels={session.counts.levels} centerLabel="observations" />
                <div className="donut-facts">
                  <div className="donut-fact">
                    <span className="donut-fact__label">Normal share</span>
                    <span className="donut-fact__value mono">
                      {observations > 0
                        ? `${((session.counts.levels.Normal / observations) * 100).toFixed(1)}%`
                        : "—"}
                    </span>
                  </div>
                  <div className="donut-fact">
                    <span className="donut-fact__label">Elevated share</span>
                    <span className="donut-fact__value mono">
                      {elevatedShare === null ? "—" : `${elevatedShare.toFixed(1)}%`}
                    </span>
                  </div>
                  <div className="donut-fact">
                    <span className="donut-fact__label">Objects tracked</span>
                    <span className="donut-fact__value mono">
                      {formatNumber(session.counts.tracks)}
                    </span>
                  </div>
                  <div className="donut-fact">
                    <span className="donut-fact__label">Objects with events</span>
                    <span className="donut-fact__value mono">
                      {formatNumber(
                        (trackList.data?.tracks ?? []).filter(
                          (track) => track.observed.anomalies > 0,
                        ).length,
                      )}
                      <span className="dim"> of {formatNumber(session.counts.tracks)}</span>
                    </span>
                  </div>
                </div>
              </div>
              <StackedLevelBar levels={session.counts.levels} />
              <div className="chart-legend-row">
                <LevelLegend />
                <span className="mono dim">{formatNumber(elevated)} elevated</span>
              </div>
            </Panel>

            <Panel
              title="Elevated object leaders"
              sub="Objects ranked by persisted Suspicious + Irregular rows"
              actions={
                trackList.data ? (
                  <span className="tag">{formatNumber(trackList.data.total)} objects</span>
                ) : undefined
              }
            >
              {trackList.status === "error" ? (
                <ErrorState error={trackList.error} onRetry={trackList.reload} compact />
              ) : trackList.status === "loading" && !trackList.data ? (
                <LoadingRows rows={4} label="Loading object leaders" />
              ) : rankedTracks.length === 0 ? (
                <p className="chart-empty">No elevated observations in this run.</p>
              ) : (
                <BarList
                  ariaLabel="Objects by elevated observations"
                  rows={rankedTracks.map((track) => ({
                    key: String(track.track_id),
                    label: `T${String(track.track_id).padStart(2, "0")} · ${appearanceLabel(track.appearance)}`,
                    value: track.observed.anomalies,
                    color: LEVEL_COLOURS[track.observed.worst_level],
                    hint: `${formatNumber(track.observed.observations)} obs`,
                  }))}
                  formatValue={(value) => `${formatNumber(value)} ev`}
                />
              )}
              <Link className="btn btn--quiet btn--sm" to={`/tracks?session=${encodeURIComponent(session.session)}`}>
                Open this run in Track Explorer
                <span className="btn__icon">
                  <ArrowRightIcon width={12} height={12} />
                </span>
              </Link>
            </Panel>

            <Panel
              className="intel-grid__full"
              title="Run comparison"
              sub="Elevated share per persisted session"
            >
              {sessionRows.length > 1 ? (
                <>
                  <BarList
                    ariaLabel="Elevated observation share by session"
                    rows={sessionRows}
                    max={100}
                    formatValue={(value) => `${value.toFixed(0)}%`}
                  />
                </>
              ) : (
                <EmptyState
                  compact
                  title="Comparison needs a second run"
                  body={
                    sessionRows.length === 1
                      ? "Only one run exists. Analyse another clip to compare."
                      : "No persisted session to compare."
                  }
                  code="POST /api/v1/analyze · one row per persisted session"
                />
              )}
            </Panel>
            </div>
          </>
        )}
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
