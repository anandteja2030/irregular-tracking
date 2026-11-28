import { useCallback, useEffect, useRef, useState } from "react";
import { MetricCard, MetricGrid } from "./MetricCard";
import { Panel } from "./Panel";
import { LevelBadge, LevelMeter } from "./SessionBits";
import { EmptyState } from "./StateViews";
import { PlayIcon, StopIcon } from "./icons";
import {
  COLOUR_HEX,
  LocalVisionEngine,
  headingArrow,
  type LocalFrame,
  type LocalTrack,
} from "../lib/browserVision";
import { cameraErrorMessage, liveElapsed } from "../lib/live";
import { saveLiveSession } from "../lib/local/pipeline";
import type { StoredObservation, StoredPreview } from "../lib/local/store";
import type { Level } from "../lib/types";

type Phase = "idle" | "starting" | "live" | "error";

/** Frames analysed per second. One thread drives both the video element and
 *  this loop, so the budget stays below the camera's own rate. */
const TARGET_FPS = 10;
/** Analysis width: small enough to stay a few milliseconds per frame, wide
 *  enough to resolve a person across a room. */
const ANALYSIS_WIDTH = 320;

const LEVEL_HEX: Record<Level, string> = {
  Normal: "#4fe3ff",
  Suspicious: "#ffc857",
  Irregular: "#ff5d6c",
};

const NO_CAMERA_API =
  "This browser does not expose a camera API. Use a recent Chrome, Edge, Firefox or Safari, and open the page over https or localhost.";

/**
 * Ask for a camera without assuming a device.
 *
 * A single `getUserMedia` call with a device id or `facingMode` fails outright
 * on browsers that treat the constraint as required, and desktop webcams have
 * no `environment` camera at all. Each attempt relaxes the request instead, so
 * a machine with any working camera gets a stream. A permission refusal is not
 * retried: the answer will not change.
 */
export async function openCamera(deviceId: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error(NO_CAMERA_API), { name: "NotSupportedError" });
  }
  const sized = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const attempts: MediaStreamConstraints[] = [];
  if (deviceId) attempts.push({ video: { deviceId: { exact: deviceId }, ...sized }, audio: false });
  attempts.push({ video: { ...sized, facingMode: { ideal: "environment" } }, audio: false });
  attempts.push({ video: { ...sized }, audio: false });
  attempts.push({ video: true, audio: false });

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      const name = (error as { name?: string } | null)?.name ?? "";
      if (name === "NotAllowedError" || name === "SecurityError" || name === "NotReadableError") {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("No camera could be opened.");
}

interface LocalLiveCaptureProps {
  /** Reports capture activity so a host page can disable other intake. */
  onActiveChange?: (active: boolean) => void;
  /** Suppresses the page-level capture protocol copy when hosted elsewhere. */
  title?: string;
  /** Called with the stored session id after “Stop & save”. */
  onFinished?: (sessionId: string) => void;
}

interface Recorder {
  observations: StoredObservation[];
  previews: StoredPreview[];
  frameIndex: number;
  startedMs: number;
  startedTs: string;
  label: string;
  width: number | null;
  height: number | null;
  fps: number | null;
}

/** JPEG of what the operator sees: the frame, optionally with the boxes. */
function stageSnapshot(
  video: HTMLVideoElement,
  tracks: LocalTrack[],
  frameWidth: number,
  frameHeight: number,
  annotate: boolean,
): string | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const width = Math.min(560, sourceWidth);
  const ratio = width / sourceWidth;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(sourceHeight * ratio));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (annotate) {
    const kx = frameWidth > 0 ? canvas.width / frameWidth : 1;
    const ky = frameHeight > 0 ? canvas.height / frameHeight : 1;
    context.lineWidth = 2;
    context.font = "600 11px ui-monospace, monospace";
    for (const track of tracks) {
      if (track.frames < 2) continue;
      const [bx, by, bw, bh] = track.box;
      context.strokeStyle = LEVEL_HEX[track.level];
      context.strokeRect(bx * kx, by * ky, bw * kx, bh * ky);
      context.fillStyle = LEVEL_HEX[track.level];
      context.fillText(`T${String(track.id).padStart(2, "0")}`, bx * kx + 2, Math.max(10, by * ky - 3));
    }
  }
  return canvas.toDataURL("image/jpeg", 0.6);
}

/**
 * Live webcam analysis that runs entirely in the browser.
 *
 * The GitHub Pages build has no analysis service behind it, so this component
 * does the work locally: frames are read from the video element into a canvas,
 * measured, and drawn back over the video. Nothing is uploaded; stopping the
 * capture stores the measured run as a session in this browser.
 */
export function LocalLiveCapture({
  onActiveChange,
  title = "Camera",
  onFinished,
}: LocalLiveCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<LocalVisionEngine | null>(null);
  const timerRef = useRef<number | null>(null);
  const runningRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<LocalFrame | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [aspect, setAspect] = useState("16 / 9");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [measuredFps, setMeasuredFps] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const startedAtRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const fpsWindowRef = useRef<number[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const [saving, setSaving] = useState(false);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    stopLoop();
    const stream = streamRef.current;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, [stopLoop]);

  useEffect(
    () => () => {
      stopCamera();
      onActiveChange?.(false);
    },
    [onActiveChange, stopCamera],
  );

  const drawOverlay = useCallback(
    (
      tracks: LocalTrack[],
      frameWidth: number,
      frameHeight: number,
      width: number,
      height: number,
    ) => {
      const canvas = overlayRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      // Track geometry is in analysis-frame pixels, which are smaller than the
      // video: every coordinate, trail point and arrow is scaled up or the boxes
      // land at the wrong size and position.
      const kx = frameWidth > 0 ? width / frameWidth : 1;
      const ky = frameHeight > 0 ? height / frameHeight : 1;
      const point = ([px, py]: [number, number]): [number, number] => [px * kx, py * ky];
      const scale = Math.max(1, canvas.width / 480);
      for (const track of tracks) {
        const colour = LEVEL_HEX[track.level];
        const [bx, by, bw, bh] = track.box;
        const x = bx * kx;
        const y = by * ky;
        const w = bw * kx;
        const h = bh * ky;
        if (track.trail.length > 1) {
          context.save();
          context.strokeStyle = colour;
          context.globalAlpha = 0.55;
          context.lineWidth = Math.max(1.5, 1.6 * scale);
          context.beginPath();
          track.trail.forEach((trailPoint, index) => {
            const [tx, ty] = point(trailPoint);
            if (index === 0) context.moveTo(tx, ty);
            else context.lineTo(tx, ty);
          });
          context.stroke();
          context.restore();
        }
        context.lineWidth = 1.6 * scale;
        context.strokeStyle = colour;
        context.globalAlpha = 0.6;
        context.strokeRect(x, y, w, h);
        context.globalAlpha = 1;
        const [cx, cy] = point(track.centroid);
        context.beginPath();
        context.arc(cx, cy, 3 * scale, 0, Math.PI * 2);
        context.fillStyle = colour;
        context.fill();
        if (track.directionDeg !== null && track.speedPxS > 1) {
          const radians = (track.directionDeg * Math.PI) / 180;
          const length = Math.max(14, Math.min(40, 10 + track.speedPxS / 12)) * scale;
          context.beginPath();
          context.moveTo(cx, cy);
          context.lineTo(cx + Math.cos(radians) * length, cy + Math.sin(radians) * length);
          context.strokeStyle = colour;
          context.lineWidth = 2 * scale;
          context.stroke();
        }
        const label = `T${String(track.id).padStart(2, "0")} · ${track.colour} · ${
          track.level === "Irregular" ? "IRR" : track.level === "Suspicious" ? "SUS" : "NRM"
        } · ${track.score.toFixed(2)}`;
        context.font = `600 ${Math.round(12 * scale)}px "JetBrains Mono", ui-monospace, monospace`;
        const textWidth = context.measureText(label).width;
        const pad = 5 * scale;
        const labelHeight = 18 * scale;
        const labelY = Math.max(0, y - labelHeight - 2 * scale);
        context.fillStyle = "rgba(4, 5, 8, 0.82)";
        context.fillRect(x - scale, labelY, textWidth + pad * 2, labelHeight);
        context.fillStyle = colour;
        context.fillText(label, x + pad - scale, labelY + labelHeight - 5 * scale);
      }
    },
    [],
  );

  const step = useCallback(async () => {
    if (!runningRef.current) return;
    const video = videoRef.current;
    const capture = captureRef.current;
    const engine = engineRef.current;
    if (!video || !capture || !engine || video.readyState < 2) {
      timerRef.current = window.setTimeout(() => void step(), 120);
      return;
    }

    const now = performance.now();
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      timerRef.current = window.setTimeout(() => void step(), 120);
      return;
    }
    const width = Math.min(ANALYSIS_WIDTH, sourceWidth);
    const height = Math.max(2, Math.round((width / sourceWidth) * sourceHeight));
    if (capture.width !== width || capture.height !== height) {
      capture.width = width;
      capture.height = height;
    }
    const context = capture.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);

    try {
      const result = engine.analyse(image, now);
      setFrame(result);
      drawOverlay(
        result.tracks.filter((track) => track.frames >= 2),
        result.frameWidth,
        result.frameHeight,
        sourceWidth,
        sourceHeight,
      );

      // Record the measured frame stream so “Stop & save” can persist a real
      // session: same observations, tracks and levels the panels show.
      const recorder = recorderRef.current;
      if (recorder) {
        const frameIndex = recorder.frameIndex;
        recorder.frameIndex += 1;
        const kx = sourceWidth / width;
        const ky = sourceHeight / height;
        for (const track of result.tracks) {
          if (track.frames < 2) continue;
          recorder.observations.push({
            frame: frameIndex,
            ts: (now - recorder.startedMs) / 1000,
            trackId: track.id,
            level: track.level,
            score: track.score,
            rule: Math.min(1, Math.max(0, track.score * 2)),
            ml: null,
            scene: track.score,
            speed: track.speedPxS * kx,
            direction: track.directionDeg,
            areaPct: track.areaPct,
            colour: track.colour,
            box: [track.box[0] * kx, track.box[1] * ky, track.box[2] * kx, track.box[3] * ky],
            centroid: [track.centroid[0] * kx, track.centroid[1] * ky],
            seen: track.frames,
          });
        }
        recorder.width = sourceWidth;
        recorder.height = sourceHeight;
        const window = fpsWindowRef.current;
        recorder.fps = window.length
          ? window.reduce((sum, value) => sum + value, 0) / window.length
          : null;
        if (frameIndex % 12 === 0 && recorder.previews.length < 40) {
          const annotated = stageSnapshot(video, result.tracks, width, height, true);
          const original = stageSnapshot(video, result.tracks, width, height, false);
          if (annotated && original) {
            recorder.previews.push({
              frame: frameIndex,
              tsS: (now - recorder.startedMs) / 1000,
              annotated,
              original,
            });
          }
        }
      }

      const interval = now - lastFrameAtRef.current;
      lastFrameAtRef.current = now;
      if (interval > 0 && interval < 5000) {
        const window = fpsWindowRef.current;
        window.push(1000 / interval);
        if (window.length > 20) window.shift();
        const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
        setMeasuredFps(mean);
      }
      setElapsed((now - startedAtRef.current) / 1000);
      setNotice(
        result.skipped ? "Illumination change detected — background model re-adapting." : null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Frame analysis failed.");
      setPhase("error");
      stopCamera();
      onActiveChange?.(false);
      return;
    }

    if (!runningRef.current) return;
    const budget = 1000 / TARGET_FPS;
    const spent = performance.now() - now;
    timerRef.current = window.setTimeout(() => void step(), Math.max(0, budget - spent));
  }, [drawOverlay, onActiveChange, stopCamera]);

  const start = useCallback(async () => {
    setError(null);
    setNotice(null);
    setFrame(null);
    setMeasuredFps(null);
    setElapsed(0);
    setPhase("starting");
    onActiveChange?.(true);
    try {
      const stream = await openCamera(deviceId);
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("The video element is not mounted.");
      video.srcObject = stream;
      await video.play();
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width && height) setAspect(`${width} / ${height}`);

      engineRef.current = new LocalVisionEngine();
      recorderRef.current = {
        observations: [],
        previews: [],
        frameIndex: 0,
        startedMs: performance.now(),
        startedTs: new Date().toISOString(),
        label: devices.find((device) => device.deviceId === deviceId)?.label || "Live camera",
        width: null,
        height: null,
        fps: null,
      };
      startedAtRef.current = performance.now();
      lastFrameAtRef.current = startedAtRef.current;
      fpsWindowRef.current = [];
      runningRef.current = true;
      setPhase("live");
      void step();

      try {
        const listed = await navigator.mediaDevices.enumerateDevices();
        setDevices(listed.filter((device) => device.kind === "videoinput"));
      } catch {
        // Device labels are optional; the stream is already running.
      }
    } catch (cause) {
      setError(cameraErrorMessage(cause));
      setPhase("error");
      stopCamera();
      onActiveChange?.(false);
    }
  }, [deviceId, onActiveChange, step, stopCamera]);

  /** Stop the camera and persist what the engine measured as a session. */
  const stopAndSave = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    stopCamera();
    setPhase("idle");
    onActiveChange?.(false);
    const canvas = overlayRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    if (!recorder || recorder.observations.length === 0) return;
    setSaving(true);
    try {
      const session = await saveLiveSession({
        label: recorder.label,
        width: recorder.width,
        height: recorder.height,
        observations: recorder.observations,
        previews: recorder.previews,
        elapsedS: (performance.now() - recorder.startedMs) / 1000,
        startedTs: recorder.startedTs,
        measuredFps: recorder.fps,
      });
      onFinished?.(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The capture could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [onActiveChange, onFinished, stopCamera]);

  useEffect(() => {
    if (phase !== "idle") return;
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((listed) => {
        if (!cancelled) setDevices(listed.filter((device) => device.kind === "videoinput"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // A region seen in a single frame is a candidate, not an object: it is what
  // camera noise and encoder updates look like. Confirm before listing it, and
  // keep the unconfirmed count visible rather than silently dropping it.
  const allTracks = frame?.tracks ?? [];
  const tracks = allTracks.filter((track) => track.frames >= 2);
  const candidates = allTracks.length - tracks.length;
  const counts: Record<Level, number> = { Normal: 0, Suspicious: 0, Irregular: 0 };
  for (const track of tracks) counts[track.level] += 1;

  return (
    <>
      <Panel
        title={title}
        sub="Background subtraction · blob tracking · scene baseline"
        actions={
          phase === "live" || saving ? (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => void stopAndSave()}
              disabled={saving}
            >
              <span className="btn__icon">
                <StopIcon width={13} height={13} />
              </span>
              {saving ? "Saving session…" : "Stop & save"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void start()}
              disabled={phase === "starting"}
            >
              <span className="btn__icon">
                <PlayIcon width={13} height={13} />
              </span>
              {phase === "starting" ? "Starting…" : "Start camera"}
            </button>
          )
        }
      >
        <div className="live-camera">
          <div className="live-stage" style={{ aspectRatio: aspect }}>
            <video
              ref={videoRef}
              className="live-stage__video"
              playsInline
              muted
              autoPlay
              aria-label="Webcam preview"
            />
            <canvas ref={overlayRef} className="live-stage__overlay" aria-hidden="true" />
            <canvas ref={captureRef} style={{ display: "none" }} aria-hidden="true" />
            {phase !== "live" && (
              <div className="live-stage__placeholder">
                <p>
                  {phase === "starting"
                    ? "Waiting for the camera…"
                    : "Start the camera to analyse live frames on this device."}
                </p>
              </div>
            )}
            {phase === "live" && (
              <div className="live-hud mono" aria-live="off">
                <span className="live-hud__dot" aria-hidden="true" />
                {liveElapsed(elapsed)} · {tracks.length} tracks · {measuredFps?.toFixed(1) ?? "—"} fps
              </div>
            )}
          </div>

          <div className="live-setup" aria-label="Capture configuration">
            <label className="live-setup__field">
              <span className="mono">CAMERA</span>
              <select
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                disabled={phase === "live" || phase === "starting"}
              >
                <option value="">Default camera</option>
                {devices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>

            <div className="hint">
              The analysis runs in this tab: it measures motion, colour and speed. It cannot name
              object classes — only the Python pipeline with a trained model can do that.
            </div>

            {notice && <p className="hint">{notice}</p>}
            {error && (
              <p className="hint" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </Panel>

      <MetricGrid columns={4} label="Measured live values">
        <MetricCard
          label="TRACKS"
          value={tracks.length}
          hint={
            frame
              ? `${frame.frameWidth}×${frame.frameHeight} frame${candidates ? ` · ${candidates} candidate` : ""}`
              : "no frame yet"
          }
          tone="accent"
        />
        <MetricCard
          label="FRAME RATE"
          value={measuredFps === null ? undefined : measuredFps.toFixed(1)}
          unit="fps"
          hint={`target ${TARGET_FPS} fps`}
        />
        <MetricCard
          label="PROCESS"
          value={frame ? frame.processMs.toFixed(1) : undefined}
          unit="ms"
          hint="time spent inside the engine for the last frame"
        />
        <MetricCard
          label="BASELINE"
          value={frame ? `${Math.round(frame.calibration.progress * 100)}` : undefined}
          unit="%"
          meter={frame?.calibration.progress ?? 0}
          hint={
            frame
              ? `${frame.calibration.samples}/${frame.calibration.needed} samples`
              : "starts after 3 frames"
          }
        />
      </MetricGrid>

      <Panel
        title="Tracked objects"
        sub={tracks.length ? "Identities, measured speed and verdict" : undefined}
        actions={<LevelMeter levels={counts} />}
      >
        {tracks.length === 0 ? (
          <EmptyState
            compact
            title="No moving objects detected"
            body="The engine reports a track only after a region of the frame changes across frames. Point the camera at something that moves, or check that the scene is lit."
          />
        ) : (
          <div className="live-object-grid">
            {tracks.map((track) => (
              <article
                key={track.id}
                className={`live-object live-object--${track.level.toLowerCase()}`}
              >
                <header>
                  <span className="mono">T{String(track.id).padStart(2, "0")}</span>
                  <LevelBadge level={track.level} />
                </header>
                <div className="mono">
                  <span
                    className="live-object__swatch"
                    style={{ background: COLOUR_HEX[track.colour] ?? COLOUR_HEX.grey }}
                    aria-hidden="true"
                  />
                  {track.colour}
                  <span aria-hidden="true"> · </span>
                  {headingArrow(track.directionDeg)}{" "}
                  {track.directionDeg === null ? "stationary" : `${Math.round(track.directionDeg)}°`}
                </div>
                <dl className="mono">
                  <div>
                    <dt>speed</dt>
                    <dd>{track.speedPxS.toFixed(1)} px/s</dd>
                  </div>
                  <div>
                    <dt>score</dt>
                    <dd>
                      {track.score.toFixed(2)}
                      <span className="muted"> / stable {track.scoreSmoothed.toFixed(2)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>area</dt>
                    <dd>{track.areaPct.toFixed(1)}%</dd>
                  </div>
                  <div>
                    <dt>frames</dt>
                    <dd>{track.frames}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

export { TARGET_FPS as LOCAL_TARGET_FPS };
