import type { ResourceState } from "../hooks/useResource";
import type { EngineConfig, SceneResponse } from "../lib/types";
import { assessCalibration } from "../lib/scene";
import { formatNumber } from "../lib/format";
import { Panel } from "./Panel";
import { LoadingRows } from "./StateViews";

interface SceneCalibrationProps {
  scene: SceneResponse;
  config: ResourceState<EngineConfig>;
}

function sourceLabel(source: string): string {
  if (source === "run_calibration") return "run calibration";
  if (source === "derived_observations" || source === "derived_event_observations") {
    return "derived observations";
  }
  return source.replaceAll("_", " ");
}

export function SceneCalibration({ scene, config }: SceneCalibrationProps) {
  const thresholds = config.data?.calibration ?? null;
  const assessment = assessCalibration(scene, thresholds);
  const calibration = scene.calibration;
  const isHistorical = assessment.state === "historical";
  const isWarming = assessment.state === "warming";
  const isReady = assessment.state === "ready";

  return (
    <Panel
      title="Scene calibration"
      sub="What the engine learned before scoring this run"
      actions={<span className="tag mono">{sourceLabel(scene.source)}</span>}
      foot={
        <span>
          Unavailable calibration is not a failed calibration. The API stores no
          failed-calibration flag; analysis failures remain job-level state.
        </span>
      }
    >
      <div className="scene-calibration">
        <div className={`scene-status scene-status--${assessment.state}`}>
          <span
            className={`scene-status__dot ${
              isReady ? "is-ready" : isHistorical || isWarming ? "is-warn" : "is-muted"
            }`}
            aria-hidden="true"
          />
          <div className="scene-status__text">
            <strong>{assessment.title}</strong>
            <span>
              {calibration.available
                ? `${calibration.ready ? "Readiness gates met" : "Readiness gates not met"} · ${formatNumber(
                    calibration.samples ?? 0,
                  )} samples`
                : isHistorical
                  ? "The calibrator artifact was not persisted for this session."
                  : "The API returned no calibration artifact."}
            </span>
          </div>
          <span className="tag">
            {calibration.available ? "in-process artifact" : "not retained"}
          </span>
        </div>

        <div className="scene-metrics">
          <div className="scene-metric">
            <span className="scene-metric__label">Movement samples</span>
            <strong className="scene-metric__value mono">
              {calibration.samples === null ? "—" : formatNumber(calibration.samples)}
            </strong>
          </div>
          <div className="scene-metric">
            <span className="scene-metric__label">Contributing tracks</span>
            <strong className="scene-metric__value mono">
              {calibration.tracks === null ? "—" : formatNumber(calibration.tracks)}
            </strong>
          </div>
          <div className="scene-metric">
            <span className="scene-metric__label">Observed seconds</span>
            <strong className="scene-metric__value mono">
              {calibration.observed_seconds === null
                ? "—"
                : `${formatNumber(calibration.observed_seconds, 1)} s`}
            </strong>
          </div>
          <div className="scene-metric">
            <span className="scene-metric__label">Readiness coverage</span>
            <strong className="scene-metric__value mono">
              {assessment.coverage === null
                ? "—"
                : `${Math.round(assessment.coverage * 100)}%`}
            </strong>
          </div>
        </div>

        {calibration.available && assessment.gates.length > 0 && (
          <div className="scene-gates">
            {assessment.gates.map((gate) => (
              <div className="scene-gate" key={gate.key}>
                <div className="scene-gate__head">
                  <span>{gate.label}</span>
                  <span className="mono">
                    {gate.actual === null ? "—" : formatNumber(gate.actual, gate.key === "seconds" ? 1 : 0)}{" "}
                    / {formatNumber(gate.required, gate.key === "seconds" ? 1 : 0)}
                  </span>
                </div>
                <div
                  className={`scene-gate__track ${gate.met ? "is-met" : ""}`.trim()}
                  aria-hidden="true"
                >
                  <span
                    className="scene-gate__fill"
                    style={{ width: `${(gate.coverage ?? 0) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {config.status === "loading" && !config.data && calibration.available && (
          <LoadingRows rows={2} label="Loading calibration thresholds" />
        )}
        {config.status === "error" && calibration.available && (
          <p className="hint hint--flush">
            Calibration thresholds could not be read, so gate coverage is unavailable. The
            sample, track and duration values above are still persisted values.
          </p>
        )}

        <div className="scene-confidence">
          <div>
            <span className="mini-label">Calibration confidence</span>
            <strong className="mono">Not exposed</strong>
          </div>
          <p>
            The engine publishes a readiness boolean and its evidence counts, not a
            statistical confidence. Readiness coverage is the narrowest gate above and is
            not a probability.
          </p>
        </div>

        {isWarming && (
          <div className="scene-alert scene-alert--warn">
            <span className="note__label">Not ready — not failed</span>
            <p>
              This run ended before every readiness gate was met
              {assessment.limiting
                ? `; ${assessment.limiting.label.toLowerCase()} is the limiting gate.`
                : "."}{" "}
              The API does not label this state as a calibration failure.
            </p>
          </div>
        )}

        {(isHistorical || assessment.state === "unavailable") && (
          <div className="scene-alert scene-alert--warn">
            <span className="note__label">
              {isHistorical ? "Historical artifact unavailable" : "Calibration unavailable"}
            </span>
            <p>
              {calibration.reason ??
                "No reason was returned for the missing calibration artifact."}
            </p>
            <p>
              {isHistorical
                ? "This is missing history, not a failed calibration. Speed and direction values below are derived from persisted observations and labelled accordingly."
                : "No observation-derived scene baseline is asserted when the API cannot support one."}
            </p>
          </div>
        )}

        <p className="hint hint--flush">
          Observed seconds are movement evidence accumulated across tracks, so they can
          exceed the clip's wall-clock duration. The direction bin is{" "}
          {thresholds ? `${formatNumber(thresholds.direction_bin_deg, 0)}°` : "—"}.
        </p>
      </div>
    </Panel>
  );
}
