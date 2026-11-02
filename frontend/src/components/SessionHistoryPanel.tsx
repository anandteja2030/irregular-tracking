import type { SessionItem } from "../lib/types";
import { formatDuration, formatNumber, formatResolution } from "../lib/format";
import { LevelBadge, LevelMeter } from "./SessionBits";

interface SessionHistoryPanelProps {
  sessions: SessionItem[];
  selectedId: string | null;
  onOpen: (sessionId: string) => void;
}

/** Persisted runs, including those written by the CLI or Streamlit. */
export function SessionHistoryPanel({ sessions, selectedId, onOpen }: SessionHistoryPanelProps) {
  if (sessions.length === 0) {
    return (
      <p className="hint hint--flush">
        No persisted sessions yet. The first completed analysis becomes history for every workspace.
      </p>
    );
  }

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
      <p className="hint hint--flush">
        Preview frames and centroid paths are retained in the API process for the most recent runs only.
        Older sessions keep their persisted observations, tracks and events — media for them is reported as
        unavailable rather than substituted.
      </p>
    </>
  );
}
