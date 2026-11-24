import type { SessionItem } from "../lib/types";
import { formatDuration, formatNumber, formatResolution } from "../lib/format";
import { MetricCard, MetricGrid } from "./MetricCard";
import { Sparkline } from "./charts";
import { LevelBadge, LevelMeter } from "./SessionBits";

interface SessionHistoryPanelProps {
  sessions: SessionItem[];
  selectedId: string | null;
  onOpen: (sessionId: string) => void;
}

/** Persisted runs, including those written by the CLI or the API. */
export function SessionHistoryPanel({ sessions, selectedId, onOpen }: SessionHistoryPanelProps) {
  if (sessions.length === 0) {
    return (
      <p className="hint hint--flush">
        No persisted sessions yet. The first completed analysis becomes history for every workspace.
      </p>
    );
  }

  const totals = sessions.reduce(
    (sum, session) => {
      sum.observations += session.counts.observations;
      sum.tracks += session.counts.tracks;
      sum.events += session.counts.anomalies;
      sum.levels.Normal += session.counts.levels.Normal;
      sum.levels.Suspicious += session.counts.levels.Suspicious;
      sum.levels.Irregular += session.counts.levels.Irregular;
      return sum;
    },
    {
      observations: 0,
      tracks: 0,
      events: 0,
      levels: { Normal: 0, Suspicious: 0, Irregular: 0 },
    },
  );

  return (
    <>
      <div className="table-wrap">
        <table className="table table--sessions">
          <thead>
            <tr>
              <th>Session</th>
              <th>Source</th>
              <th>Frames</th>
              <th>Tracks</th>
              <th>Events</th>
              <th>Levels</th>
              <th aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const active = session.session === selectedId;
              return (
                <tr key={session.session} className={active ? "is-active" : ""}>
                  <td className="mono">
                    {session.session}
                    {active && <span className="tag tag--inline">open</span>}
                  </td>
                  <td title={session.source.label ?? undefined}>
                    {session.source.label ?? "unrecorded"}
                    <span className="table__sub mono">
                      {session.source.kind ?? "unknown"}
                      {session.source.synthetic ? " · synthetic" : ""}
                    </span>
                  </td>
                  <td className="mono">
                    {formatNumber(session.processing.frames_processed)}
                    <span className="table__sub mono">
                      {formatResolution(session.processing.width, session.processing.height)}
                      {session.processing.wall_s !== null
                        ? ` · ${formatDuration(session.processing.wall_s)}`
                        : ""}
                    </span>
                  </td>
                  <td className="mono">{formatNumber(session.counts.tracks)}</td>
                  <td className="mono">
                    {formatNumber(session.counts.anomalies)}
                    <span className="table__sub mono">
                      <LevelBadge level="Irregular" /> {formatNumber(session.counts.levels.Irregular)}
                    </span>
                  </td>
                  <td>
                    <LevelMeter levels={session.counts.levels} />
                    <span className="table__sub mono">
                      {formatNumber(session.counts.observations)} obs
                      {session.counts.labels > 0 ? ` · ${formatNumber(session.counts.labels)} labels` : ""}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--quiet btn--sm"
                      onClick={() => onOpen(session.session)}
                      aria-label={`Open session ${session.session}`}
                    >
                      {active ? "Selected" : "Open"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="archive-summary">
        <MetricGrid columns={4} label="Archive totals across persisted runs">
          <MetricCard label="Persisted runs" value={formatNumber(sessions.length)} tone="accent" />
          <MetricCard label="Observations" value={formatNumber(totals.observations)} />
          <MetricCard label="Tracks" value={formatNumber(totals.tracks)} tone="accent-2" />
          <MetricCard label="Elevated events" value={formatNumber(totals.events)} tone="warn" />
        </MetricGrid>
        <div className="archive-summary__levels">
          <span className="mini-label">Archive level mix · every persisted observation</span>
          <LevelMeter levels={totals.levels} />
        </div>
        {sessions.length > 1 ? (
          <div className="archive-summary__series">
            <span className="mini-label">Observations per persisted run · oldest → newest</span>
            <Sparkline
              values={[...sessions].reverse().map((session) => session.counts.observations)}
              height={54}
              color="var(--chart-1)"
              ariaLabel="Persisted observations per run, oldest to newest"
            />
          </div>
        ) : (
          <p className="hint hint--flush">
            One persisted run is stored, so there is no archive trend to plot yet.
          </p>
        )}
      </div>
      <p className="hint hint--flush">
        Preview frames and centroid paths are retained in the API process for the most recent runs only.
        Older sessions keep their persisted observations, tracks and events — media for them is reported as
        unavailable rather than substituted.
      </p>
    </>
  );
}
