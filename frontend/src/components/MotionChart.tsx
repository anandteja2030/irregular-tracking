import { useMemo } from "react";
import type { ObservationItem } from "../lib/types";
import { motionSamples, speedExtent, summarizeDirections, type MotionSample } from "../lib/tracks";
import { formatNumber } from "../lib/format";

const WIDTH = 640;
const PAD = 18;
const SPEED_HEIGHT = 132;
const DIRECTION_HEIGHT = 86;

interface MotionChartProps {
  observations: ObservationItem[];
  totalObservations: number;
  meanSpeed: number | null;
  maxSpeed: number | null;
  fps: number | null;
}

function frameX(frame: number, first: number, last: number): number {
  if (last <= first) return WIDTH / 2;
  return PAD + ((frame - first) / (last - first)) * (WIDTH - PAD * 2);
}

function segmentsFor(
  samples: MotionSample[],
  value: (sample: MotionSample) => number | null,
  y: (raw: number) => number,
): {
  path: string;
  area: string;
  dots: { x: number; y: number; level: string }[];
}[] {
  const segments: {
    path: string;
    area: string;
    dots: { x: number; y: number; level: string }[];
  }[] = [];
  let path = "";
  let dots: { x: number; y: number; level: string }[] = [];
  let firstX: number | null = null;
  let lastX: number | null = null;
  let previousFrame: number | null = null;

  for (const sample of samples) {
    const raw = value(sample);
    if (raw === null || !Number.isFinite(raw)) {
      if (path) {
        segments.push({ path, area: areaPath(path, firstX, lastX), dots });
        path = "";
        dots = [];
        firstX = null;
        lastX = null;
      }
      previousFrame = null;
      continue;
    }
    if (previousFrame !== null && sample.frame - previousFrame > 1 && path) {
      segments.push({ path, area: areaPath(path, firstX, lastX), dots });
      path = "";
      dots = [];
      firstX = null;
      lastX = null;
    }
    const x = frameX(sample.frame, samples[0].frame, samples[samples.length - 1].frame);
    const py = y(raw);
    path += `${path ? "L" : "M"}${x.toFixed(1)} ${py.toFixed(1)} `;
    if (firstX === null) firstX = x;
    lastX = x;
    if (sample.level !== "Normal") {
      dots.push({ x, y: py, level: sample.level });
    }
    previousFrame = sample.frame;
  }
  if (path) segments.push({ path, area: areaPath(path, firstX, lastX), dots });
  return segments;
}

/** Closed fill under a measured segment; gaps stay gaps because each segment
 * is filled only between its own real samples. */
function areaPath(path: string, firstX: number | null, lastX: number | null): string {
  if (firstX === null || lastX === null) return "";
  return `${path}L${lastX.toFixed(1)} ${SPEED_HEIGHT - PAD}L${firstX.toFixed(1)} ${SPEED_HEIGHT - PAD} Z`;
}

export function MotionChart({
  observations,
  totalObservations,
  meanSpeed,
  maxSpeed,
  fps,
}: MotionChartProps) {
  const samples = useMemo(() => motionSamples(observations), [observations]);
  const directions = useMemo(() => summarizeDirections(observations), [observations]);
  const max = Math.max(speedExtent(samples), 1);
  const first = samples[0]?.frame ?? 0;
  const last = samples[samples.length - 1]?.frame ?? 0;
  const speedMissing = samples.filter((sample) => sample.speed === null).length;
  const directionMissing = directions.missing;

  const speedY = (raw: number) =>
    SPEED_HEIGHT - PAD - (Math.max(0, raw) / max) * (SPEED_HEIGHT - PAD * 2);
  const directionY = (raw: number) =>
    DIRECTION_HEIGHT - PAD - (Math.max(0, Math.min(360, raw)) / 360) * (DIRECTION_HEIGHT - PAD * 2);

  const speedSegments = segmentsFor(samples, (sample) => sample.speed, speedY);
  const directionSegments = segmentsFor(samples, (sample) => sample.direction, directionY);
  const windowLabel =
    totalObservations > observations.length
      ? `first ${formatNumber(observations.length)} of ${formatNumber(totalObservations)} observations`
      : `${formatNumber(observations.length)} observations`;

  if (samples.length === 0) {
    return (
      <p className="hint hint--flush">
        No observation rows were returned for this track, so no movement series can be drawn.
      </p>
    );
  }

  return (
    <div className="motion-chart">
      <div className="motion-chart__head">
        <span className="mini-label">Speed px/s</span>
        <span className="motion-legend">
          <span><i className="motion-dot motion-dot--normal" />Normal</span>
          <span><i className="motion-dot motion-dot--suspicious" />Suspicious</span>
          <span><i className="motion-dot motion-dot--irregular" />Irregular</span>
        </span>
      </div>
      <svg
        className="motion-chart__svg"
        viewBox={`0 0 ${WIDTH} ${SPEED_HEIGHT}`}
        role="img"
        aria-label={`Speed over ${windowLabel}: mean ${meanSpeed?.toFixed(1) ?? "not recorded"} px/s, max ${maxSpeed?.toFixed(1) ?? "not recorded"} px/s`}
      >
        {[0, 0.5, 1].map((share) => (
          <line
            key={`speed-grid-${share}`}
            x1={PAD}
            x2={WIDTH - PAD}
            y1={PAD + share * (SPEED_HEIGHT - PAD * 2)}
            y2={PAD + share * (SPEED_HEIGHT - PAD * 2)}
            className="motion-chart__grid"
          />
        ))}
        <text x={PAD} y={12} className="motion-chart__axis">{max.toFixed(0)} px/s</text>
        <text x={PAD} y={SPEED_HEIGHT - 3} className="motion-chart__axis">0</text>
        {speedSegments.map((segment, index) => (
          <g key={`speed-${index}`}>
            {segment.area && (
              <path d={segment.area} className="motion-chart__area" />
            )}
            <path d={segment.path} className="motion-chart__line motion-chart__line--speed" />
            {segment.dots.map((dot, dotIndex) => (
              <circle
                key={`speed-dot-${dotIndex}`}
                cx={dot.x}
                cy={dot.y}
                r={2.2}
                className={`motion-chart__dot level--${dot.level.toLowerCase()}`}
              />
            ))}
          </g>
        ))}
      </svg>

      <div className="motion-chart__head">
        <span className="mini-label">Heading degrees</span>
        <span className="mono motion-chart__window">{windowLabel}</span>
      </div>
      <svg
        className="motion-chart__svg motion-chart__svg--direction"
        viewBox={`0 0 ${WIDTH} ${DIRECTION_HEIGHT}`}
        role="img"
        aria-label={`Heading over ${windowLabel}; ${directions.changes} changes above ${directions.thresholdDeg} degrees`}
      >
        {[
          { deg: 0, label: "E 0°" },
          { deg: 90, label: "S 90°" },
          { deg: 180, label: "W 180°" },
          { deg: 270, label: "N 270°" },
          { deg: 360, label: "E 360°" },
        ].map((tick) => (
          <g key={`dir-${tick.deg}`}>
            <line
              x1={PAD}
              x2={WIDTH - PAD}
              y1={directionY(tick.deg)}
              y2={directionY(tick.deg)}
              className="motion-chart__grid"
            />
            <text x={WIDTH - PAD} y={directionY(tick.deg) - 3} textAnchor="end" className="motion-chart__axis">
              {tick.label}
            </text>
          </g>
        ))}
        {directionSegments.map((segment, index) => (
          <path
            key={`direction-${index}`}
            d={segment.path}
            className="motion-chart__line motion-chart__line--direction"
          />
        ))}
      </svg>

      <div className="motion-stats">
        <div className="motion-stat">
          <span className="motion-stat__label">Speed samples</span>
          <span className="mono">
            {formatNumber(samples.length - speedMissing)}
            {speedMissing > 0 ? ` · ${formatNumber(speedMissing)} missing` : ""}
          </span>
        </div>
        <div className="motion-stat">
          <span className="motion-stat__label">Heading samples</span>
          <span className="mono">
            {formatNumber(directions.samples)}
            {directionMissing > 0 ? ` · ${formatNumber(directionMissing)} missing` : ""}
          </span>
        </div>
        <div className="motion-stat">
          <span className="motion-stat__label">Changes &gt; {directions.thresholdDeg}°</span>
          <span className="mono">{formatNumber(directions.changes)}</span>
        </div>
        <div className="motion-stat">
          <span className="motion-stat__label">Largest change</span>
          <span className="mono">
            {directions.maxChangeDeg === null ? "—" : `${directions.maxChangeDeg.toFixed(0)}°`}
          </span>
        </div>
      </div>

      <p className="hint hint--flush">
        Frame span F{first}–F{last}
        {fps ? ` · ${((last - first) / fps).toFixed(2)}s at ${fps.toFixed(0)} fps` : ""}. A missing value breaks the
        line; it is never drawn as zero. {totalObservations > observations.length
          ? `The chart covers the first ${formatNumber(observations.length)} observation rows; later rows are not charted.`
          : ""}
      </p>
    </div>
  );
}
