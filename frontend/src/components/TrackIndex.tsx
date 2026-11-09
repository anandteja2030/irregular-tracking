import type { ResourceState } from "../hooks/useResource";
import type { TrackItem, TrackList } from "../lib/types";
import {
  LEVEL_FILTERS,
  TRACK_SORTS,
  filterTracks,
  formatTrackId,
  type TrackLevelFilter,
  type TrackSort,
} from "../lib/tracks";
import { formatDuration, formatNumber } from "../lib/format";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { LevelBadge, LevelMeter } from "./SessionBits";
import { SearchIcon, TrackIcon } from "./icons";

interface TrackIndexProps {
  tracks: ResourceState<TrackList>;
  activeId: number | null;
  query: string;
  onQuery: (value: string) => void;
  levelFilter: TrackLevelFilter;
  onLevelFilter: (value: TrackLevelFilter) => void;
  sort: TrackSort;
  onSort: (value: TrackSort) => void;
  onPick: (trackId: number) => void;
}

function TrackRow({
  track,
  active,
  onPick,
}: {
  track: TrackItem;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`track-row track-row--${track.observed.worst_level.toLowerCase()} ${
        active ? "is-active" : ""
      }`.trim()}
      onClick={onPick}
      aria-pressed={active}
      aria-current={active ? "true" : undefined}
      aria-label={`Track ${formatTrackId(track.track_id)}, ${track.observed.observations} observations, ${track.observed.anomalies} elevated events, worst ${track.observed.worst_level}`}
    >
      <span className="track-row__rail" aria-hidden="true" />
      <span className="track-row__id mono">{formatTrackId(track.track_id)}</span>
      <span className="track-row__body">
        <span className="track-row__line">
          <span className="track-row__color">
            {track.appearance.color ?? "unknown colour"}
            {track.appearance.shape ? ` · ${track.appearance.shape}` : ""}
          </span>
          <span className="track-row__count mono">
            {track.observed.anomalies} ev · {track.observed.observations} obs
          </span>
        </span>
        <LevelMeter levels={track.observed.levels} />
        <span className="track-row__meta mono">
          <LevelBadge level={track.observed.worst_level} />
          <span>{formatDuration(track.observed.duration_s)}</span>
          {track.motion.max_speed_px_s !== null ? (
            <span>{track.motion.max_speed_px_s.toFixed(0)} px/s max</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function TrackIndex({
  tracks,
  activeId,
  query,
  onQuery,
  levelFilter,
  onLevelFilter,
  sort,
  onSort,
  onPick,
}: TrackIndexProps) {
  const visible = tracks.data ? filterTracks(tracks.data.tracks, query) : [];
  const filtered = levelFilter !== "all" || query.trim().length > 0;

  return (
    <>
      <div className="track-tools">
        <label className="track-search">
          <span className="track-search__glyph" aria-hidden="true">
            <SearchIcon width={12} height={12} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="ID, colour, heading"
            aria-label="Search tracks"
          />
          {query && (
            <button
              type="button"
              className="track-search__clear"
              onClick={() => onQuery("")}
              aria-label="Clear track search"
            >
              ×
            </button>
          )}
        </label>
        <div className="track-tools__row">
          <label className="track-filter">
            <span>Show</span>
            <select
              value={levelFilter}
              onChange={(event) => onLevelFilter(event.target.value as TrackLevelFilter)}
              aria-label="Filter tracks by level"
            >
              {LEVEL_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="track-filter">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => onSort(event.target.value as TrackSort)}
              aria-label="Sort tracks"
            >
              {TRACK_SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {tracks.status === "error" ? (
        <ErrorState error={tracks.error} onRetry={tracks.reload} compact title="Track index unavailable" />
      ) : tracks.status === "loading" && !tracks.data ? (
        <LoadingRows rows={5} label="Loading tracks" />
      ) : visible.length > 0 ? (
        <>
          <div className="track-list">
            {visible.map((track) => (
              <TrackRow
                key={track.track_id}
                track={track}
                active={track.track_id === activeId}
                onPick={() => onPick(track.track_id)}
              />
            ))}
          </div>
          <div className="track-index__foot">
            <span className="hint hint--flush">
              {filtered
                ? `${visible.length} of ${formatNumber(tracks.data?.total)} matching objects`
                : `${formatNumber(tracks.data?.total)} tracked objects`}
              {(tracks.data?.total ?? 0) > (tracks.data?.count ?? 0)
                ? ` · first ${formatNumber(tracks.data?.count)} loaded, refine the filter for older objects`
                : ""}
            </span>
          </div>
        </>
      ) : filtered ? (
        <div className="panel__pad">
          <EmptyState
            compact
            title="No track matches"
            body="No object in this session matches that search and level filter."
            glyph={<TrackIcon width={16} height={16} />}
            actions={
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => {
                  onQuery("");
                  onLevelFilter("all");
                }}
              >
                Clear search and filter
              </button>
            }
          />
        </div>
      ) : (
        <div className="panel__pad">
          <EmptyState
            compact
            title="No tracks recorded"
            body="This session contains no tracked objects, so there is nothing to explore."
            glyph={<TrackIcon width={16} height={16} />}
          />
        </div>
      )}
    </>
  );
}

