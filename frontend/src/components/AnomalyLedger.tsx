import { useEffect, useMemo, useState } from "react";
import type { AnomalyItem } from "../lib/types";
import {
  ANOMALY_SORTS,
  anomalyRules,
  anomalyTypeLabel,
  anomalyTypeOptions,
  eventTrackIds,
  filterAnomalies,
  sortAnomalies,
  type AnomalyFilters,
  type AnomalySort,
  type EventSeverityFilter,
} from "../lib/anomalies";
import { formatNumber, truncateMiddle } from "../lib/format";
import { formatTrackId, formatUtc } from "../lib/tracks";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { LevelBadge, Pager, Score } from "./SessionBits";
import { AnomalyIcon, SearchIcon } from "./icons";
import { Panel } from "./Panel";

const PAGE_SIZE = 20;

interface AnomalyLedgerProps {
  sessionId: string;
  events: AnomalyItem[];
  status: "loading" | "ready" | "error";
  error: unknown;
  reload: () => void;
  selectedEventId: number | null;
  onSelect: (event: AnomalyItem) => void;
  totalEvents: number;
  truncated: boolean;
}

export function AnomalyLedger({
  sessionId,
  events,
  status,
  error,
  reload,
  selectedEventId,
  onSelect,
  totalEvents,
  truncated,
}: AnomalyLedgerProps) {
  const [severity, setSeverity] = useState<EventSeverityFilter>("all");
  const [trackId, setTrackId] = useState<number | null>(null);
  const [eventType, setEventType] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AnomalySort>("frame_desc");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setSeverity("all");
    setTrackId(null);
    setEventType(null);
    setQuery("");
    setSort("frame_desc");
    setOffset(0);
  }, [sessionId]);

  const trackIds = useMemo(() => eventTrackIds(events), [events]);
  const typeOptions = useMemo(() => anomalyTypeOptions(events), [events]);
  const filters = useMemo<AnomalyFilters>(
    () => ({ severity, trackId, eventType, query }),
    [severity, trackId, eventType, query],
  );
  const visible = useMemo(
    () => sortAnomalies(filterAnomalies(events, filters), sort),
    // filters is derived from its primitives
    [events, filters, sort],
  );

  useEffect(() => {
    if (offset > 0 && offset >= visible.length) setOffset(0);
  }, [offset, visible.length]);

  const page = visible.slice(offset, offset + PAGE_SIZE);
  const selectedVisible = visible.some((event) => event.event_id === selectedEventId);
  const filtersActive =
    severity !== "all" || trackId !== null || eventType !== null || query.trim() !== "";

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setOffset(0);
  };

  const clearFilters = () => {
    setSeverity("all");
    setTrackId(null);
    setEventType(null);
    setQuery("");
    setOffset(0);
  };

  return (
    <Panel
      title="Event ledger"
      sub={`${formatNumber(visible.length)} matching · ${formatNumber(events.length)} loaded`}
      actions={
        <span className="tag" title="The anomaly endpoint returns elevated observations only">
          Suspicious + Irregular
        </span>
      }
      bodyClassName="panel__body--flush"
    >
      <div className="ledger-tools">
        <div className="anomaly-search">
          <span className="anomaly-search__glyph" aria-hidden="true">
            <SearchIcon width={12} height={12} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => change(setQuery)(event.target.value)}
            placeholder="Event, frame, track, rule or timestamp"
            aria-label="Search anomaly events"
          />
        </div>

        <div className="ledger-tools__row">
          <label className="track-filter">
            <span>Track</span>
            <select
              value={trackId === null ? "all" : String(trackId)}
              onChange={(event) =>
                change(setTrackId)(
                  event.target.value === "all" ? null : Number(event.target.value),
                )
              }
              aria-label="Filter anomaly events by track"
              disabled={trackIds.length === 0}
            >
              <option value="all">All tracks</option>
              {trackIds.map((id) => (
                <option key={id} value={id}>
                  {formatTrackId(id)}
                </option>
              ))}
            </select>
          </label>

          <label className="track-filter">
            <span>Event type</span>
            <select
              value={eventType ?? "all"}
              onChange={(event) =>
                change(setEventType)(event.target.value === "all" ? null : event.target.value)
              }
              aria-label="Filter anomaly events by type"
              disabled={typeOptions.length === 0}
            >
              <option value="all">All types</option>
              {typeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <label className="track-filter">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => change(setSort)(event.target.value as AnomalySort)}
              aria-label="Sort anomaly events"
            >
              {ANOMALY_SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="seg" role="group" aria-label="Filter by severity">
            {(["all", "Suspicious", "Irregular"] as EventSeverityFilter[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`seg__item ${severity === option ? "is-active" : ""}`.trim()}
                onClick={() => change(setSeverity)(option)}
                aria-pressed={severity === option}
              >
                {option === "all" ? "All" : option}
              </button>
            ))}
          </div>

          {filtersActive && (
            <button type="button" className="btn btn--quiet btn--sm" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
        <p className="hint hint--flush ledger-scope">
          Normal observations are counted in the summary but are not anomaly events, so this
          ledger cannot list them. Search and filters run across every loaded event.
        </p>
      </div>

      {status === "error" ? (
        <div className="panel__pad">
          <ErrorState
            error={error}
            onRetry={reload}
            compact
            title="Anomaly event ledger unavailable"
          />
        </div>
      ) : status === "loading" && events.length === 0 ? (
        <div className="panel__pad">
          <LoadingRows rows={7} label="Loading anomaly events" />
        </div>
      ) : page.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="table table--events table--anomaly-ledger">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Frame</th>
                  <th>Timestamp</th>
                  <th>Track</th>
                  <th>Level</th>
                  <th>Event type</th>
                  <th>Fused</th>
                  <th>Rule</th>
                  <th>ML</th>
                  <th>Scene</th>
                </tr>
              </thead>
              <tbody>
                {page.map((event) => {
                  const rules = anomalyRules(event);
                  const active = selectedEventId === event.event_id;
                  return (
                    <tr
                      key={event.event_id}
                      className={`is-clickable level-row--${event.level.toLowerCase()} ${
                        active ? "is-active" : ""
                      }`.trim()}
                      tabIndex={0}
                      aria-selected={active}
                      onClick={() => onSelect(event)}
                      onKeyDown={(keyboard) => {
                        if (keyboard.key === "Enter" || keyboard.key === " ") {
                          keyboard.preventDefault();
                          onSelect(event);
                        }
                      }}
                      title={event.summary || "No persisted explanation"}
                    >
                      <td className="mono">
                        <button
                          type="button"
                          className="event-id-button"
                          onClick={(click) => {
                            click.stopPropagation();
                            onSelect(event);
                          }}
                          aria-label={`Open investigation for event ${event.event_id}`}
                        >
                          E{event.event_id}
                        </button>
                      </td>
                      <td className="mono">F{event.frame}</td>
                      <td className="mono table__timestamp" title={event.ts_utc}>
                        {formatUtc(event.ts_utc)}
                      </td>
                      <td className="mono">{formatTrackId(event.track_id)}</td>
                      <td>
                        <LevelBadge level={event.level} />
                      </td>
                      <td
                        className="table__summary"
                        title={
                          rules.length > 0
                            ? rules.join(" · ")
                            : "No rule name is available for this event"
                        }
                      >
                        {truncateMiddle(anomalyTypeLabel(event), 42)}
                      </td>
                      <td>
                        <Score value={event.scores.fused} />
                      </td>
                      <td>
                        <Score value={event.scores.rule} />
                      </td>
                      <td>
                        <Score value={event.scores.ml} />
                      </td>
                      <td>
                        <Score value={event.scores.scene} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel__pad panel__pad--tight">
            <Pager
              total={visible.length}
              limit={PAGE_SIZE}
              offset={offset}
              onChange={setOffset}
              label="events"
            />
            <p className="hint hint--flush ledger-footnote">
              {selectedVisible ? null : "Select a row or an event ID to open its investigation. "}
              {truncated
                ? `Loaded ${formatNumber(events.length)} of ${formatNumber(totalEvents)} reported events; filters and timeline cover only the loaded set.`
                : `All ${formatNumber(events.length)} reported elevated events are loaded.`}
            </p>
          </div>
        </>
      ) : (
        <div className="panel__pad">
          {events.length === 0 ? (
            <EmptyState
              title="No elevated events in this run"
              body="Every persisted observation scored below the suspicious band. No event row or timeline mark is fabricated to fill the space."
              code={`Session ${sessionId}`}
              glyph={<AnomalyIcon width={17} height={17} />}
            />
          ) : (
            <EmptyState
              title="No events match these filters"
              body="The session has elevated events, but none match the current search, track, type and severity selection."
              actions={
                <button type="button" className="btn btn--quiet" onClick={clearFilters}>
                  Clear filters
                </button>
              }
              glyph={<AnomalyIcon width={17} height={17} />}
            />
          )}
        </div>
      )}
    </Panel>
  );
}
