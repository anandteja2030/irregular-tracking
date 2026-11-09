import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { ResourceState } from "../hooks/useResource";
import type { SessionDetail, TrackList, ZoneRect } from "../lib/types";
import {
  densityGrid,
  spatialPoints,
  zoneActivity,
  zoneLabel,
  type LoadedSceneEvents,
  type SceneTrajectoryLoad,
} from "../lib/scene";
import { formatNumber } from "../lib/format";
import { formatTrackId, trajectoryPaths } from "../lib/tracks";
import { Panel } from "./Panel";
import { EmptyState, ErrorState, LoadingRows } from "./StateViews";
import { ArrowRightIcon, ImageIcon, SceneIcon } from "./icons";

/** Chart accents come from the shared --chart-* tokens; the class only binds
 * one token to a track, so no colour is hard-coded here. */
const TRACK_ACCENTS = [
  "scene-accent--1",
  "scene-accent--2",
  "scene-accent--3",
  "scene-accent--4",
  "scene-accent--5",
  "scene-accent--6",
];

interface SceneSpatialProps {
  sessionId: string;
  session: ResourceState<SessionDetail>;
  tracks: ResourceState<TrackList>;
  trajectories: ResourceState<SceneTrajectoryLoad>;
  events: ResourceState<LoadedSceneEvents>;
  zones: ZoneRect[];
  zonesEnabled: boolean;
}

function trajectoryReason(session: SessionDetail): string {
  return (
    session.limitations.find((line) => /centroid|trajector/i.test(line)) ??
    "Coordinates are only retained for sessions analysed by the current API process."
  );
}

function eventUrl(sessionId: string, eventId: number): string {
  return `/anomalies?session=${encodeURIComponent(sessionId)}&event=${eventId}`;
}

function DensityMap({
  sessionId,
  tracks,
  width,
  height,
  zones,
  zonesEnabled,
}: {
  sessionId: string;
  tracks: SceneTrajectoryLoad;
  width: number;
  height: number;
  zones: ZoneRect[];
  zonesEnabled: boolean;
}) {
  const drawable = tracks.tracks.filter((track) => track.available && track.points.length > 0);
  const flattened = useMemo(
    () => spatialPoints(drawable.map((track) => ({ trackId: track.trackId, points: track.points })), width, height),
    [drawable, width, height],
  );
  const density = useMemo(
    () => densityGrid(flattened.points, width, height),
    [flattened.points, width, height],
  );
  const accentByTrack = new Map(
    drawable.map((track, index) => [track.trackId, TRACK_ACCENTS[index % TRACK_ACCENTS.length]]),
  );
  const peak = density.peak;

  return (
    <div className="scene-map">
      <div className="scene-map__stage">
        <span className="scene-map__reticle scene-map__reticle--tl" aria-hidden="true" />
        <span className="scene-map__reticle scene-map__reticle--tr" aria-hidden="true" />
        <span className="scene-map__reticle scene-map__reticle--bl" aria-hidden="true" />
        <span className="scene-map__reticle scene-map__reticle--br" aria-hidden="true" />
        <svg
          className="scene-map__svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Retained centroid density for ${drawable.length} tracks: ${formatNumber(
            flattened.points.length,
          )} points in ${density.columns} by ${density.rows} cells, peak ${formatNumber(
            density.maxCount,
          )} points`}
        >
          <g className="scene-map__heat">
            {density.cells.map((cell) => {
              if (cell.count === 0) return null;
              const ratio = cell.count / Math.max(density.maxCount, 1);
              return (
                <rect
                  key={`${cell.column}-${cell.row}`}
                  className="scene-map__cell"
                  x={cell.x}
                  y={cell.y}
                  width={cell.width}
                  height={cell.height}
                  fillOpacity={Math.min(1, 0.1 + ratio * 0.9)}
                >
                  <title>
                    {`Column ${cell.column + 1}, row ${cell.row + 1}: ${cell.count} retained point${
                      cell.count === 1 ? "" : "s"
                    }`}
                  </title>
                </rect>
              );
            })}
          </g>

          <g className="scene-map__paths">
            {drawable.map((track) => {
              const paths = trajectoryPaths(track.points);
              const accent = accentByTrack.get(track.trackId) ?? TRACK_ACCENTS[0];
              return paths.segments.map((segment, index) => (
                <path
                  key={`${track.trackId}-${index}`}
                  className={`scene-map__path ${accent}`}
                  d={segment
                    .map(
                      (point, pointIndex) =>
                        `${pointIndex === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
                    )
                    .join(" ")}
                  fill="none"
                  strokeWidth={Math.max(1.2, width / 900)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ));
            })}
          </g>

          {zones.map((zone) => (
            <g className="scene-map__zone" key={zoneLabel(zone)}>
              <rect
                x={zone.x1 * width}
                y={zone.y1 * height}
                width={(zone.x2 - zone.x1) * width}
                height={(zone.y2 - zone.y1) * height}
              />
              <text x={zone.x1 * width + 8} y={zone.y1 * height + 16}>
                {zoneLabel(zone)}
              </text>
            </g>
          ))}
        </svg>

        <div className="scene-map__legend mono">
          <span className="scene-map__legend-scale" aria-hidden="true" />
          <span>low retained-point density</span>
          <span>high</span>
        </div>
        <span className="scene-map__stamp mono">
          {formatNumber(width)}×{formatNumber(height)} px · {formatNumber(flattened.points.length)} points ·{" "}
          {density.touchedCells} of {density.columns * density.rows} cells touched
        </span>
      </div>

      <div className="scene-map__facts">
        <div className="scene-map__fact">
          <span className="mini-label">Density basis</span>
          <p>
            Counts of retained centroid points per {density.columns}×{density.rows} frame cell.
            This is not occupancy, dwell time, optical density or a calibrated camera view.
          </p>
        </div>
        <div className="scene-map__fact">
          <span className="mini-label">Peak cell</span>
          <p className="mono">
            {peak
              ? `x ${formatNumber(peak.x, 0)}–${formatNumber(peak.x + peak.width, 0)} · y ${formatNumber(
                  peak.y,
                  0,
                )}–${formatNumber(peak.y + peak.height, 0)} · ${formatNumber(peak.count)} points`
              : "No point landed inside the frame bounds."}
          </p>
        </div>
      </div>

      {flattened.excluded > 0 && (
        <p className="hint hint--flush">
          {formatNumber(flattened.excluded)} retained coordinates fell outside the recorded
          source frame and are excluded from the map.
        </p>
      )}

      <div className="scene-track-legend">
        <span className="mini-label scene-track-legend__title">Retained track paths</span>
        {drawable.map((track) => (
          <Link
            className="scene-track-legend__row"
            key={track.trackId}
            to={`/tracks?session=${encodeURIComponent(sessionId)}&track=${track.trackId}`}
          >
            <span
              className={`scene-track-legend__swatch ${
                accentByTrack.get(track.trackId) ?? TRACK_ACCENTS[0]
              }`}
              aria-hidden="true"
            />
            <span className="mono">{formatTrackId(track.trackId)}</span>
            <span className="mono">{formatNumber(track.points.length)} points</span>
            <ArrowRightIcon width={11} height={11} />
          </Link>
        ))}
      </div>

      <div className="scene-zones-configured">
        <span className="mini-label">
          Configured zones · {zonesEnabled ? "scoring enabled" : "scoring disabled"}
        </span>
        {zones.length > 0 ? (
          zones.map((zone) => (
            <div className="scene-zone-row" key={zoneLabel(zone)}>
              <span>{zoneLabel(zone)}</span>
              <span className="mono">
                {zone.x1.toFixed(2)},{zone.y1.toFixed(2)} → {zone.x2.toFixed(2)},{zone.y2.toFixed(2)}
              </span>
            </div>
          ))
        ) : (
          <p className="hint hint--flush">
            No zone rectangles are configured. No zone geometry or activity is drawn.
          </p>
        )}
        <p className="hint hint--flush">
          Rectangles are configuration, not observed activity. They are drawn only as reference
          outlines.
        </p>
      </div>
    </div>
  );
}

function ZoneEvidenceTable({
  sessionId,
  rows,
}: {
  sessionId: string;
  rows: ReturnType<typeof zoneActivity>;
}) {
  const maxDwell = Math.max(0, ...rows.map((row) => row.maxDwellS ?? 0));
  const dwellWidth = (value: number | null): number =>
    value === null || maxDwell <= 0 ? 0 : Math.max(2, Math.min(100, (value / maxDwell) * 100));

  return (
    <div className="table-wrap">
      <table className="table table--scene-zones">
        <thead>
          <tr>
            <th>Zone</th>
            <th>Elevated events</th>
            <th>Tracks</th>
            <th>Median dwell</th>
            <th>Max dwell</th>
            <th>First event</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.zone}>
              <td className="mono scene-zone-cell">{row.zone}</td>
              <td className="mono">{formatNumber(row.events)}</td>
              <td className="mono">{formatNumber(row.tracks)}</td>
              <td>
                <span className="scene-dwell">
                  <span className="scene-dwell__text mono">
                    {row.medianDwellS === null ? "—" : `${row.medianDwellS.toFixed(2)} s`}
                  </span>
                  <span className="scene-dwell__track" aria-hidden="true">
                    <span
                      className="scene-dwell__fill"
                      style={{ width: `${dwellWidth(row.medianDwellS)}%` }}
                    />
                  </span>
                </span>
              </td>
              <td>
                <span className="scene-dwell">
                  <span className="scene-dwell__text mono">
                    {row.maxDwellS === null ? "—" : `${row.maxDwellS.toFixed(2)} s`}
                  </span>
                  <span className="scene-dwell__track" aria-hidden="true">
                    <span
                      className="scene-dwell__fill scene-dwell__fill--max"
                      style={{ width: `${dwellWidth(row.maxDwellS)}%` }}
                    />
                  </span>
                </span>
              </td>
              <td>
                <Link className="row-link row-link--inline" to={eventUrl(sessionId, row.firstEventId)}>
                  <span className="mono">E{row.firstEventId}</span>
                  <ArrowRightIcon width={11} height={11} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SceneSpatial({
  sessionId,
  session,
  tracks,
  trajectories,
  events,
  zones,
  zonesEnabled,
}: SceneSpatialProps) {
  const zoneRows = useMemo(() => zoneActivity(events.data?.rows ?? []), [events.data]);

  let mapBody;
  if (session.status === "error") {
    mapBody = (
      <ErrorState
        error={session.error}
        onRetry={session.reload}
        compact
        title="Spatial retention status unavailable"
      />
    );
  } else if (session.status === "loading" && !session.data) {
    mapBody = <LoadingRows rows={6} label="Loading spatial retention status" />;
  } else if (!session.data?.artifacts.trajectories) {
    mapBody = (
      <EmptyState
        compact
        title="Trajectory coordinates not persisted"
        body={session.data ? trajectoryReason(session.data) : "No retained coordinates are available for this session."}
        glyph={<ImageIcon width={17} height={17} />}
      />
    );
  } else if (tracks.status === "error") {
    mapBody = (
      <ErrorState
        error={tracks.error}
        onRetry={tracks.reload}
        compact
        title="Track coordinates unavailable"
      />
    );
  } else if (tracks.status === "loading" && !tracks.data) {
    mapBody = <LoadingRows rows={5} label="Loading tracks for spatial density" />;
  } else if (trajectories.status === "error") {
    mapBody = (
      <ErrorState
        error={trajectories.error}
        onRetry={trajectories.reload}
        compact
        title="Trajectory request failed"
      />
    );
  } else if (trajectories.status === "loading" || !trajectories.data) {
    mapBody = <LoadingRows rows={6} label="Loading retained trajectories" />;
  } else {
    const width = session.data.processing.width;
    const height = session.data.processing.height;
    const available = trajectories.data.tracks.filter(
      (track) => track.available && track.points.length > 0,
    );
    if (width === null || height === null || width <= 0 || height <= 0) {
      mapBody = (
        <EmptyState
          compact
          title="Source resolution unavailable"
          body="Retained coordinates exist, but the session does not record a frame size, so no spatial map can be scaled honestly."
          glyph={<SceneIcon width={17} height={17} />}
        />
      );
    } else if (available.length === 0) {
      mapBody = (
        <EmptyState
          compact
          title="No retained coordinates"
          body={
            trajectories.data.tracks.find((track) => track.reason)?.reason ??
            "Track responses contained no drawable centroid points."
          }
          glyph={<SceneIcon width={17} height={17} />}
        />
      );
    } else {
      mapBody = (
        <>
          <DensityMap
            sessionId={sessionId}
            tracks={trajectories.data}
            width={width}
            height={height}
            zones={zones}
            zonesEnabled={zonesEnabled}
          />
          {trajectories.data.failed > 0 && (
            <p className="hint hint--flush">
              {formatNumber(trajectories.data.failed)} of{" "}
              {formatNumber(trajectories.data.requested)} trajectory requests failed. The map
              shows only the successful responses.
            </p>
          )}
          {trajectories.data.totalTracks > trajectories.data.requested && (
            <p className="hint hint--flush">
              Showing the first {formatNumber(trajectories.data.requested)} tracks by elevated
              event count; {formatNumber(trajectories.data.totalTracks)} tracks exist in the
              session. No unrequested coordinates are implied.
            </p>
          )}
        </>
      );
    }
  }

  return (
    <div className="scene-spatial">
      <div className="scene-spatial__grid">
        <Panel
          title="Spatial intelligence"
          sub="Retained centroid density in source-frame coordinates"
          actions={<span className="tag">retained preview only</span>}
        >
          {mapBody}
        </Panel>

        <Panel
          title="Zone evidence"
          sub="Retained evidence on elevated events"
          actions={<span className="tag">{formatNumber(zoneRows.length)} zones observed</span>}
          bodyClassName="panel__body--flush"
        >
          {events.status === "error" ? (
            <div className="panel__pad">
              <ErrorState
                error={events.error}
                onRetry={events.reload}
                compact
                title="Zone evidence unavailable"
              />
            </div>
          ) : events.status === "loading" && !events.data ? (
            <div className="panel__pad">
              <LoadingRows rows={4} label="Loading retained zone evidence" />
            </div>
          ) : zoneRows.length > 0 ? (
            <>
              <ZoneEvidenceTable sessionId={sessionId} rows={zoneRows} />
              <div className="panel__pad panel__pad--tight">
                <p className="hint hint--flush">
                  Scope: {formatNumber(zoneRows.reduce((sum, row) => sum + row.events, 0))} elevated
                  events with retained structured zone evidence. Normal observations and
                  historical rows without evidence cannot contribute to this table.
                  {events.data?.truncated
                    ? ` Loaded ${formatNumber(events.data.rows.length)} of ${formatNumber(
                        events.data.total,
                      )} reported events; zone evidence covers loaded rows only.`
                    : ""}
                </p>
              </div>
            </>
          ) : !session.data || session.data.artifacts.structured_evidence ? (
            <div className="panel__pad">
              <EmptyState
                compact
                title="No retained zone evidence"
                body={
                  zones.length > 0
                    ? "Zones are configured, but no elevated event carries retained zone or dwell evidence. Configuration is not activity."
                    : "No zones are configured and no elevated event carries retained zone evidence. No zone activity is asserted."
                }
                glyph={<SceneIcon width={17} height={17} />}
              />
            </div>
          ) : (
            <div className="panel__pad">
              <EmptyState
                compact
                title="Zone evidence not retained"
                body="Structured evidence was not persisted for this historical session. This is missing evidence, not proof that no zone activity occurred."
                glyph={<SceneIcon width={17} height={17} />}
              />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
