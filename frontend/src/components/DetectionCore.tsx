/** Animated 3D detection core for the Command Overview hero.
 *
 * A perspective scene of the engine's actual detection job: a rotating sensor
 * cube inside a guarded field, a sweep plane crossing the ground grid, and one
 * lock marker per populated verdict band. Every number and marker comes from
 * the selected session; when there is no session the scene rides in standby
 * with the same geometry and no invented counts.
 *
 * Motion is transform/opacity only (no blur, no filter) so it stays cheap, and
 * the global reduced-motion rule in base.css freezes it for users who ask.
 */
import type { Level, LevelCounts } from "../lib/types";
import { LEVEL_COLOURS, LEVEL_ORDER } from "./charts";
import { formatNumber } from "../lib/format";

const BAND_TAG: Record<Level, string> = {
  Normal: "REG",
  Suspicious: "SUS",
  Irregular: "IRR",
};

interface LockMarker {
  level: Level;
  x: number;
  y: number;
  depth: number;
  delay: number;
  scale: number;
}

/** Deterministic marker placement: two locks per band that actually fired. */
function lockMarkers(levels: LevelCounts | null | undefined): LockMarker[] {
  if (!levels) return [];
  const markers: LockMarker[] = [];
  LEVEL_ORDER.forEach((level) => {
    const count = levels[level] ?? 0;
    if (count <= 0) return;
    const slots = Math.min(2, count > 1 ? 2 : 1);
    for (let slot = 0; slot < slots; slot += 1) {
      const index = markers.length;
      const angle = ((-90 + index * 61) * Math.PI) / 180;
      const radius = 0.3 + (index % 3) * 0.11;
      markers.push({
        level,
        x: 50 + Math.cos(angle) * radius * 50,
        y: 50 + Math.sin(angle) * radius * 30,
        depth: -70 + (index % 4) * 48,
        delay: index * 0.65,
        scale: 0.86 + (index % 3) * 0.13,
      });
    }
  });
  return markers;
}

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
  const markers = lockMarkers(levels);
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
          <div className="detector__floor" />
          <div className="detector__horizon" />

          <div className="detector__cone">
            <span className="detector__cone-edge detector__cone-edge--l" />
            <span className="detector__cone-edge detector__cone-edge--r" />
            <span className="detector__cone-face" />
          </div>

          <div className="detector__ring detector__ring--a" />
          <div className="detector__ring detector__ring--b" />
          <div className="detector__ring detector__ring--c" />

          <div className="detector__cube">
            {["front", "back", "right", "left", "top", "bottom"].map((face) => (
              <span
                key={face}
                className={`detector__cube-face detector__cube-face--${face}`}
              />
            ))}
          </div>

          <div className="detector__halo" />
          <div className="detector__sweep" />

          {markers.map((marker, index) => (
            <div
              key={`${marker.level}-${index}`}
              className={`detector__lock detector__lock--${marker.level.toLowerCase()}`}
              style={{
                left: `${marker.x}%`,
                top: `${marker.y}%`,
                transform: `translate(-50%, -50%) translateZ(${marker.depth}px) scale(${marker.scale})`,
                animationDelay: `${marker.delay}s`,
                ["--lock-colour" as string]: LEVEL_COLOURS[marker.level],
              }}
            >
              <span className="detector__lock-corner detector__lock-corner--tl" />
              <span className="detector__lock-corner detector__lock-corner--tr" />
              <span className="detector__lock-corner detector__lock-corner--bl" />
              <span className="detector__lock-corner detector__lock-corner--br" />
              <span className="detector__lock-tag mono">{BAND_TAG[marker.level]}</span>
            </div>
          ))}
        </div>

        <span className="detector__scanline" />
        <span className="detector__crosshair" />
        <span className="detector__reticle" />
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
