import { useMemo } from "react";
import type { TrajectoryPoint } from "../lib/types";
import { formatTrackId, formatUtc, trajectoryPaths } from "../lib/tracks";
import { formatNumber } from "../lib/format";

interface TrajectoryCanvasProps {
  trackId: number;
  points: TrajectoryPoint[];
  width: number;
  height: number;
  selectedFrame: number | null;
  onSelectFrame: (frame: number) => void;
  /** Persisted observation timestamps by source frame. */
  timestamps: Map<number, string>;
}

/** Draws only retained centroid coordinates. Missing points split the line;
 * nothing is interpolated across a gap. */
export function TrajectoryCanvas({
  trackId,
  points,
  width,
  height,
  selectedFrame,
  onSelectFrame,
  timestamps,
}: TrajectoryCanvasProps) {
  const paths = useMemo(() => trajectoryPaths(points), [points]);
  const selected = useMemo(
    () => points.find((point) => point.frame === selectedFrame) ?? null,
    [points, selectedFrame],
  );
  const strokeWidth = Math.max(1.2, Math.max(width, height) / 700);
  const pointRadius = Math.max(1.8, Math.max(width, height) / 260);

  const selectedAngle =
    selected && selected.direction_deg !== null
      ? (selected.direction_deg * Math.PI) / 180
      : null;
  const arrowLength = Math.max(width, height) / 36;

  return (
    <div className="trajectory trajectory--interactive">
      <span className="trajectory__grid" aria-hidden="true" />
      <svg
        className="trajectory__svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Persisted centroid path for track ${formatTrackId(trackId)}: ${paths.points} points in ${paths.segments.length} segment${paths.segments.length === 1 ? "" : "s"}`}
      >
        {paths.segments.map((segment, segmentIndex) => (
          <path
            key={`segment-${segmentIndex}`}
            className="trajectory__path"
            strokeWidth={strokeWidth}
            d={segment
              .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
              .join(" ")}
          />
        ))}

        {paths.segments.flatMap((segment) =>
          segment.map((point) => {
            const isSelected = selectedFrame === point.frame;
            return (
              <g key={`point-${point.frame}`}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={isSelected ? pointRadius * 2.6 : pointRadius}
                  className={`trajectory__point ${
                    point.level ? `level--${point.level.toLowerCase()}` : "level--unknown"
                  } ${isSelected ? "trajectory__point--selected" : ""}`.trim()}
                >
                  <title>
                    {`F${point.frame} · x ${point.x.toFixed(0)}, y ${point.y.toFixed(0)}${
                      point.speed_px_s !== null ? ` · ${point.speed_px_s.toFixed(0)} px/s` : " · speed not recorded"
                    }${point.direction_deg !== null ? ` · ${point.direction_deg.toFixed(0)}°` : " · heading not recorded"}`}
                  </title>
                </circle>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={Math.max(pointRadius * 3, 6)}
                  className="trajectory__hit"
                  onClick={() => onSelectFrame(point.frame)}
                >
                  <title>{`Inspect frame ${point.frame}`}</title>
                </circle>
              </g>
            );
          }),
        )}

        {paths.segments.length > 0 && (
          <g>
            <circle
              cx={paths.segments[0][0].x}
              cy={paths.segments[0][0].y}
              r={Math.max(width, height) / 90}
              className="trajectory__marker trajectory__marker--start"
              strokeWidth={strokeWidth * 1.4}
            />
            <circle
              cx={paths.segments[paths.segments.length - 1].slice(-1)[0].x}
              cy={paths.segments[paths.segments.length - 1].slice(-1)[0].y}
              r={Math.max(width, height) / 90}
              className="trajectory__marker trajectory__marker--end"
              strokeWidth={strokeWidth * 1.4}
            />
          </g>
        )}

        {selected && selected.x !== null && selected.y !== null && selectedAngle !== null && (
          <g className="trajectory__direction">
            <line
              x1={selected.x as number}
              y1={selected.y as number}
              x2={(selected.x as number) + Math.cos(selectedAngle) * arrowLength}
              y2={(selected.y as number) + Math.sin(selectedAngle) * arrowLength}
              strokeWidth={strokeWidth * 1.6}
            />
            <circle
              cx={(selected.x as number) + Math.cos(selectedAngle) * arrowLength}
              cy={(selected.y as number) + Math.sin(selectedAngle) * arrowLength}
              r={Math.max(pointRadius * 1.5, 3)}
            />
          </g>
        )}
      </svg>

      <span className="trajectory__legend" aria-hidden="true">
        <span>
          <i className="motion-dot motion-dot--normal" />Normal
        </span>
        <span>
          <i className="motion-dot motion-dot--suspicious" />Suspicious
        </span>
        <span>
          <i className="motion-dot motion-dot--irregular" />Irregular
        </span>
        <span className="trajectory__legend-path">start → end</span>
      </span>

      <div className="trajectory__readout">
        {selected && selected.x !== null && selected.y !== null ? (
          <>
            <span className="trajectory__readout-frame mono">F{String(selected.frame).padStart(5, "0")}</span>
            <span className="trajectory__readout-level">
              <span className={`level level--${(selected.level ?? "Normal").toLowerCase()}`}>
                {selected.level ?? "Unknown"}
              </span>
            </span>
            <span className="mono">{formatUtc(timestamps.get(selected.frame))}</span>
            <span className="mono">x {selected.x.toFixed(0)} · y {selected.y.toFixed(0)}</span>
            <span className="mono">
              {selected.speed_px_s === null ? "speed —" : `${selected.speed_px_s.toFixed(0)} px/s`}
            </span>
            <span className="mono">
              {selected.direction_deg === null
                ? "heading —"
                : `${selected.direction_deg.toFixed(0)}°`}
            </span>
          </>
        ) : (
          <span className="trajectory__readout-hint">
            Click a recorded point to inspect that observation
          </span>
        )}
      </div>

      <span className="trajectory__stamp mono">
        {formatNumber(paths.points)} points · {paths.segments.length} path
        {paths.segments.length === 1 ? "" : "s"}
        {paths.gaps > 0 ? ` · ${paths.gaps} frame gap${paths.gaps === 1 ? "" : "s"}` : ""}
        {paths.missing > 0 ? ` · ${paths.missing} without coordinates` : ""}
      </span>
    </div>
  );
}
