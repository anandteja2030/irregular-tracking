/** Animated 3D detection core for the Command Overview hero.
 *
 * One perspective object — the detection cube — turning above the measured
 * tallies. Every number comes from the selected session; with no session the
 * cube rides in standby and the counts read "—" rather than invented values.
 *
 * Motion is transform/opacity only (no blur, no filter) so it stays cheap, and
 * the global reduced-motion rule in base.css freezes it for users who ask.
 */
import type { LevelCounts } from "../lib/types";
import { LEVEL_COLOURS, LEVEL_ORDER } from "./charts";
import { formatNumber } from "../lib/format";

const FACES = ["front", "back", "right", "left", "top", "bottom"] as const;

/** A miniature wireframe cube: one per satellite orbiting the core. */
function Satellite({ className }: { className: string }) {
  return (
    <span className={`detector__sat ${className}`}>
      <span className="detector__sat-cube">
        {FACES.map((face) => (
          <span
            key={face}
            className={`detector__sat-face detector__sat-face--${face}`}
          />
        ))}
      </span>
    </span>
  );
}

/** The eight corners of the cube, in half-extents on each axis. */
const VERTICES = [
  [-1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [-1, 1, 1],
  [1, -1, -1],
  [1, -1, 1],
  [1, 1, -1],
  [1, 1, 1],
] as const;

export function DetectionCore({
  levels,
  tracks,
  observations,
  elevated,
  online,
}: {
  levels?: LevelCounts | null;
  tracks: number;
  observations: number;
  elevated: number;
  online: boolean;
}) {
  const total = observations;

  return (
    <div
      className={`detector ${online ? "is-live" : "is-standby"}`.trim()}
      role="img"
      aria-label={
        levels
          ? `Detection core: ${formatNumber(tracks)} tracked objects across ${formatNumber(
              observations,
            )} observations, ${formatNumber(elevated)} elevated`
          : "Detection core in standby, no session selected"
      }
    >
      <header className="detector__head">
        <span className="detector__eyebrow mono">
          <span className="detector__pulse" aria-hidden="true" />
          Detection core
        </span>
        <span className="detector__state mono">
          {online ? (levels ? "field locked" : "awaiting run") : "offline"}
        </span>
      </header>

      <div className="detector__stage" aria-hidden="true">
        <div className="detector__world">
          <div className="detector__halo" />

          <div className="detector__plane">
            <div className="detector__orbit detector__orbit--a">
              <Satellite className="detector__sat--a" />
              <Satellite className="detector__sat--b" />
              <Satellite className="detector__sat--e" />
              <span className="detector__ringlet detector__ringlet--a" />
            </div>
            <div className="detector__orbit detector__orbit--b">
              <Satellite className="detector__sat--c" />
              <Satellite className="detector__sat--d" />
              <span className="detector__ringlet detector__ringlet--b" />
            </div>
          </div>

          <div className="detector__cube">
            {FACES.map((face) => (
              <span
                key={face}
                className={`detector__cube-face detector__cube-face--${face}`}
              />
            ))}
            {VERTICES.map(([x, y, z]) => (
              <span
                key={`${x}:${y}:${z}`}
                className="detector__vertex"
                style={{
                  transform: `translate3d(calc(var(--det-cube) / 2 * ${x}), calc(var(--det-cube) / 2 * ${y}), calc(var(--det-cube) / 2 * ${z}))`,
                }}
              />
            ))}
          </div>

          <span className="detector__mark detector__mark--a" />
          <span className="detector__mark detector__mark--b" />
          <span className="detector__mark detector__mark--c" />
          <span className="detector__mark detector__mark--d" />

          <span className="detector__mote detector__mote--a" />
          <span className="detector__mote detector__mote--b" />
          <span className="detector__mote detector__mote--c" />
          <span className="detector__mote detector__mote--d" />
          <span className="detector__mote detector__mote--e" />
          <span className="detector__mote detector__mote--f" />
          <span className="detector__mote detector__mote--g" />
          <span className="detector__mote detector__mote--h" />
        </div>
      </div>

      <footer className="detector__hud">
        <span className="detector__tallies">
          <span className="detector__tally">
            <span className="detector__tally-value mono">{formatNumber(tracks)}</span>
            <span className="detector__tally-label">objects</span>
          </span>
          <span className="detector__tally">
            <span className="detector__tally-value mono">{formatNumber(total)}</span>
            <span className="detector__tally-label">observations</span>
          </span>
          <span className="detector__tally">
            <span className="detector__tally-value mono">{formatNumber(elevated)}</span>
            <span className="detector__tally-label">elevated</span>
          </span>
        </span>

        <span className="detector__bands">
          {LEVEL_ORDER.map((level) => {
            const count = levels?.[level] ?? null;
            return (
              <span
                key={level}
                className="detector__band"
                style={{ ["--band-colour" as string]: LEVEL_COLOURS[level] }}
              >
                <i aria-hidden="true" />
                {level}
                <span className="mono dim">{count === null ? "—" : formatNumber(count)}</span>
              </span>
            );
          })}
        </span>
      </footer>
    </div>
  );
}
