import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError } from "../lib/api";
import type { Level, LiveFrame, LiveStopResult, LiveTrack } from "../lib/types";
import {
  DEFAULT_LIVE_FILTERS,
  LIVE_JPEG_QUALITY,
  LIVE_TARGET_FPS,
  appearanceColour,
  cameraErrorMessage,
  captureSize,
  classifyLiveTracks,
  confidenceBand,
  headingArrow,
  levelCounts,
  levelShort,
  liveElapsed,
  smoothBox,
  type LiveFilterSettings,
  type LiveTrackView,
} from "../lib/live";
import { formatNumber, truncateMiddle } from "../lib/format";
import { Panel } from "./Panel";
import { MetricCard, MetricGrid } from "./MetricCard";
import { LevelBadge, Score } from "./SessionBits";
import { StatusPill } from "./StatusPill";
import { AlertIcon, PlayIcon, RadioIcon, StopIcon, TrackIcon } from "./icons";
import {
  BarList,
  ChartNote,
  DonutChart,
  LEVEL_COLOURS,
  LEVEL_ORDER,
  MiniTrail,
  Sparkline,
  StackedLevelBar,
} from "./charts";

type Phase = "idle" | "starting" | "live" | "stopping" | "done" | "error";

const LEVEL_HEX: Record<Level, string> = {
  Normal: "#4fe3ff",
  Suspicious: "#ffc857",
  Irregular: "#ff5d6c",
};

const NO_CAMERA_API =
  "This browser does not expose a camera API. Use a recent Chrome, Edge, Firefox or Safari, and open the page over https or localhost.";

interface LiveCameraPanelProps {
  /** Called with the persisted session id after "Stop & analyze" succeeds. */
  onFinished: (sessionId: string) => void;
  /** Reports capture activity so the page can disable other intake. */
  onActiveChange?: (active: boolean) => void;
}

/** Webcam capture surface: real frames, real tracking output, real persistence.
 *
 * Frames are captured at up to `LIVE_TARGET_FPS`, posted one at a time, and the
 * API's per-frame boxes/scores are drawn over the live video. Stopping the
 * capture persists it as a session and hands its id back to the caller. */
export function LiveCameraPanel({ onFinished, onActiveChange }: LiveCameraPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const liveIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [aspect, setAspect] = useState("16 / 9");
  const [summary, setSummary] = useState<LiveStopResult | null>(null);
  const [history, setHistory] = useState<{ frame: number; objects: number; peak: number }[]>([]);
  const [filters, setFilters] = useState<LiveFilterSettings>(DEFAULT_LIVE_FILTERS);
  // Frames each identity has been seen in, and the smoothed box we last drew
  // for it. Both are display state: the recorded observations stay untouched.
  const seenRef = useRef<Map<number, number>>(new Map());
  const smoothedRef = useRef<Map<number, [number, number, number, number]>>(new Map());
  const suppressedRef = useRef({ candidate: 0, score: 0, size: 0 });
  const lastFrameRef = useRef<{ frame: LiveFrame; drawn: LiveTrack[] } | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [hiddenNow, setHiddenNow] = useState<LiveTrackView[]>([]);
  const [suppressedTotals, setSuppressedTotals] = useState({
    candidate: 0,
    score: 0,
    size: 0,
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  const drawOverlay = useCallback(
    (drawn: LiveTrack[], candidates: Set<number>, frameWidth: number, frameHeight: number) => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
      canvas.width = frameWidth;
      canvas.height = frameHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(1, canvas.width / 640);
    context.lineWidth = 2 * scale;
    context.textBaseline = "alphabetic";
    context.lineJoin = "round";
    for (const track of drawn) {
      const [x, y, width, height] = track.box;
      const colour = LEVEL_HEX[track.level];
      const isCandidate = candidates.has(track.track_id);

      // Measured path: the recent centroids returned with this frame.
      const trail = track.trail ?? [];
      if (trail.length > 1) {
        context.save();
        context.strokeStyle = colour;
        context.globalAlpha = 0.62;
        context.lineWidth = Math.max(1.5, 2 * scale);
        context.beginPath();
        trail.forEach(([tx, ty], index) => {
          if (index === 0) context.moveTo(tx, ty);
          else context.lineTo(tx, ty);
        });
        context.stroke();
        context.restore();
      }

      // Box with brighter corner brackets so it reads on a busy camera image.
      // An unconfirmed candidate is dashed, so steady and provisional objects
      // never look the same.
      if (isCandidate) context.setLineDash([5 * scale, 4 * scale]);
      context.strokeStyle = colour;
      context.lineWidth = 1.4 * scale;
      context.globalAlpha = 0.55;
      context.strokeRect(x, y, width, height);
      context.globalAlpha = 1;
      const corner = Math.max(6, Math.min(width, height) * 0.22);
      context.lineWidth = 3 * scale;
      context.beginPath();
      // top-left
      context.moveTo(x, y + corner);
      context.lineTo(x, y);
      context.lineTo(x + corner, y);
      // top-right
      context.moveTo(x + width - corner, y);
      context.lineTo(x + width, y);
      context.lineTo(x + width, y + corner);
      // bottom-right
      context.moveTo(x + width, y + height - corner);
      context.lineTo(x + width, y + height);
      context.lineTo(x + width - corner, y + height);
      // bottom-left
      context.moveTo(x + corner, y + height);
      context.lineTo(x, y + height);
      context.lineTo(x, y + height - corner);
      context.stroke();

      // Heading arrow from the measured speed direction.
      if (track.direction_deg !== null && (track.speed_px_s ?? 0) > 1) {
        const radians = (track.direction_deg * Math.PI) / 180;
        const length = Math.max(16, Math.min(46, 12 + (track.speed_px_s ?? 0) / 14)) * scale;
        const cx = track.centroid[0];
        const cy = track.centroid[1];
        const ex = cx + Math.cos(radians) * length;
        const ey = cy + Math.sin(radians) * length;
        context.strokeStyle = colour;
        context.lineWidth = 2 * scale;
        context.beginPath();
        context.moveTo(cx, cy);
        context.lineTo(ex, ey);
        context.stroke();
        context.beginPath();
        context.moveTo(ex, ey);
        context.lineTo(ex - Math.cos(radians - 0.5) * 7 * scale, ey - Math.sin(radians - 0.5) * 7 * scale);
        context.lineTo(ex - Math.cos(radians + 0.5) * 7 * scale, ey - Math.sin(radians + 0.5) * 7 * scale);
        context.closePath();
        context.fillStyle = colour;
        context.fill();
      }

      context.beginPath();
      context.arc(track.centroid[0], track.centroid[1], 3 * scale, 0, Math.PI * 2);
      context.fillStyle = colour;
      context.fill();
      context.setLineDash([]);
      const label = `T${String(track.track_id).padStart(2, "0")} · ${levelShort(track.level)} · ${track.scores.fused.toFixed(2)}${isCandidate ? " · CAND" : ""}`;
      context.font = `600 ${Math.round(13 * scale)}px "JetBrains Mono", ui-monospace, monospace`;
      const measured = context.measureText(label).width;
      const padX = 5 * scale;
      const labelHeight = 19 * scale;
      const labelY = Math.max(0, y - labelHeight - 2 * scale);
      context.fillStyle = "rgba(4, 5, 8, 0.82)";
      context.fillRect(x - 1 * scale, labelY, measured + padX * 2, labelHeight);
      context.fillStyle = colour;
      context.fillText(label, x + padX - 1 * scale, labelY + labelHeight - 5 * scale);
    }
  },
    [],
  );

  const captureOnce = useCallback(async () => {
    const video = videoRef.current;
    const capture = captureRef.current;
    const liveId = liveIdRef.current;
    if (!video || !capture || !liveId) return;
    const { width, height } = captureSize(video.videoWidth, video.videoHeight);
    if (!width || !height) return;
    if (capture.width !== width || capture.height !== height) {
      capture.width = width;
      capture.height = height;
    }
    const context = capture.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      capture.toBlob(resolve, "image/jpeg", LIVE_JPEG_QUALITY);
    });
    if (!blob) return;
    try {
      const result = await api.liveFrame(liveId, blob);
      // Stability state: how long each identity has been visible, and the box
      // we actually draw for it. Filtering happens here, on the display path
      // only — the API still persists every observation it measured.
      const seen = seenRef.current;
      for (const track of result.tracks) {
        const reported = track.frames_seen;
        // The server reports how many frames it has observed this identity in;
        // fall back to a local count only if an older API omits it.
        seen.set(
          track.track_id,
          typeof reported === "number" && reported > 0
            ? Math.max(seen.get(track.track_id) ?? 0, reported)
            : (seen.get(track.track_id) ?? 0) + 1,
        );
      }
      const active = filtersRef.current;
      const { visible, hidden } = classifyLiveTracks(
        result.tracks,
        result.width,
        result.height,
        seen,
        active,
      );
      for (const view of hidden) {
        if (view.suppressed) suppressedRef.current[view.suppressed] += 1;
      }
      const drawn = visible.map((view) => ({
        ...view.track,
        box: smoothBox(
          smoothedRef.current.get(view.track.track_id),
          view.track.box,
          active.smoothing,
        ),
      }));
      for (const track of drawn) smoothedRef.current.set(track.track_id, track.box);
      const candidates = new Set(
        visible.filter((view) => !view.steady).map((view) => view.track.track_id),
      );
      lastFrameRef.current = { frame: result, drawn };
      setHiddenNow(hidden);
      setSuppressedTotals({ ...suppressedRef.current });
      setFrame({ ...result, tracks: drawn });
      setElapsed(result.elapsed_s);
      drawOverlay(drawn, candidates, result.width, result.height);
      setHistory((current) => [
        ...current.slice(-59),
        {
          frame: result.counts.frames,
          objects: drawn.length,
          peak: drawn.reduce(
            (peak, track) => Math.max(peak, track.scores.fused),
            0,
          ),
        },
      ]);
    } catch (caught) {
      clearTimer();
      stopCamera();
      setError(describeError(caught));
      setPhase("error");
    }
  }, [clearTimer, drawOverlay, stopCamera]);

  const start = useCallback(async () => {
    setPhase("starting");
    setError(null);
    setSummary(null);
    setFrame(null);
    setElapsed(0);
    setHistory([]);
    setHiddenNow([]);
    setSuppressedTotals({ candidate: 0, score: 0, size: 0 });
    seenRef.current = new Map();
    smoothedRef.current = new Map();
    suppressedRef.current = { candidate: 0, score: 0, size: 0 };
    lastFrameRef.current = null;
    onActiveChange?.(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error(NO_CAMERA_API), { name: "NotSupportedError" });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: { ideal: "environment" },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("The camera stage is not mounted.");
      video.srcObject = stream;
      await video.play();
      const created = await api.liveStart();
      liveIdRef.current = created.session.live_id;
      setPhase("live");
      clearTimer();
      // Self-pacing: wait for the previous frame to be scored before capturing
      // the next one, so a slow round trip never queues or silently drops
      // frames. The gap is the only delay added on top of the request.
      const gap = Math.round(1000 / LIVE_TARGET_FPS);
      const tick = async () => {
        if (!liveIdRef.current) return;
        await captureOnce();
        if (liveIdRef.current) {
          timerRef.current = window.setTimeout(() => void tick(), gap);
        }
      };
      void tick();
    } catch (caught) {
      liveIdRef.current = null;
      stopCamera();
      setError(cameraErrorMessage(caught));
      setPhase("error");
      onActiveChange?.(false);
    }
  }, [captureOnce, clearTimer, onActiveChange, stopCamera]);

  const stop = useCallback(async () => {
    const liveId = liveIdRef.current;
    if (!liveId) return;
    clearTimer();
    setPhase("stopping");
    try {
      const result = await api.liveStop(liveId);
      liveIdRef.current = null;
      stopCamera();
      setSummary(result.session);
      setPhase("done");
      onActiveChange?.(false);
      onFinished(result.session.session_id);
    } catch (caught) {
      setError(describeError(caught));
      setPhase("error");
      onActiveChange?.(false);
    }
  }, [clearTimer, onActiveChange, onFinished, stopCamera]);

  const discard = useCallback(() => {
    clearTimer();
    const liveId = liveIdRef.current;
    liveIdRef.current = null;
    if (liveId) void api.liveCancel(liveId).catch(() => undefined);
    stopCamera();
    setFrame(null);
    setSummary(null);
    setElapsed(0);
    setHistory([]);
    setHiddenNow([]);
    setSuppressedTotals({ candidate: 0, score: 0, size: 0 });
    seenRef.current = new Map();
    smoothedRef.current = new Map();
    suppressedRef.current = { candidate: 0, score: 0, size: 0 };
    lastFrameRef.current = null;
    setPhase("idle");
    setError(null);
    onActiveChange?.(false);
  }, [clearTimer, onActiveChange, stopCamera]);

  useEffect(
    () => () => {
      clearTimer();
      const liveId = liveIdRef.current;
      liveIdRef.current = null;
      if (liveId) void api.liveCancel(liveId).catch(() => undefined);
      stopCamera();
    },
    [clearTimer, stopCamera],
  );

  const live = phase === "live" || phase === "stopping";
  const tracks = frame?.tracks ?? [];
  const counts = frame
    ? levelCounts(tracks)
    : (summary?.levels ?? { Normal: 0, Suspicious: 0, Irregular: 0 });

  return (
    <Panel
      title="Live camera"
      sub="Webcam frames tracked by the same engine as file runs"
      className="panel--viewport"
      bodyClassName="panel__body--flush"
      actions={
        <StatusPill tone={live ? "bad" : "ok"} size="sm" icon={<RadioIcon width={11} height={11} />} live={live}>
          {live ? "Capturing" : phase === "done" ? "Stopped" : "Camera idle"}
        </StatusPill>
      }
      foot={
        summary ? (
          <>
            <span className="dot dot--ok" />
            Capture persisted as <span className="mono">{summary.session_id}</span> — every results section,
            track and report below now reads this run.
          </>
        ) : (
          <>
            <span className="dot dot--warn" />
            Frames are scored one at a time; nothing is stored until you press “Stop &amp; analyze”.
          </>
        )
      }
    >
      <div className="live-camera">
        <div className="live-stage" style={{ aspectRatio: aspect }}>
          <video
            ref={videoRef}
            className="live-stage__video"
            muted
            playsInline
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth && video.videoHeight) {
                setAspect(`${video.videoWidth} / ${video.videoHeight}`);
              }
            }}
          />
          <canvas ref={overlayRef} className="live-stage__overlay" aria-hidden="true" />
          <canvas ref={captureRef} className="sr-only" aria-hidden="true" />

          {!live && (
            <div className="live-stage__placeholder">
              <RadioIcon width={26} height={26} />
              <p>
                {phase === "done"
                  ? "Capture finished. The session is persisted and selected below."
                  : "Enable the camera to start tracking what it sees."}
              </p>
            </div>
          )}

          {live && (
            <div className="live-hud mono" aria-live="off">
              <span className="live-hud__dot" aria-hidden="true" />
              LIVE · {liveElapsed(elapsed)} · {formatNumber(frame?.counts.frames ?? 0)} frames ·{" "}
              {frame ? `${formatNumber(frame.fps, 1)} fps` : "measuring fps"}
            </div>
          )}

          {live && (
            <div className="live-legend" aria-hidden="true">
              {LEVEL_ORDER.map((level) => (
                <span key={level}>
                  <i style={{ background: LEVEL_HEX[level] }} />
                  {level}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="live-filter" role="group" aria-label="Live detection stability">
          <div className="live-filter__head">
            <span className="live-filter__title mono">DETECTION STABILITY</span>
            <span className="live-filter__note">
              These controls change what is <b>drawn</b>, never what is recorded.
            </span>
            <button
              type="button"
              className="live-filter__reset mono"
              onClick={() => setFilters(DEFAULT_LIVE_FILTERS)}
            >
              reset
            </button>
          </div>
          <div className="live-filter__grid">
            <label className="live-range">
              <span className="live-range__label">
                Steady after <b className="mono">{filters.confirmFrames}f</b>
              </span>
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                value={filters.confirmFrames}
                aria-label="Frames before an object counts as steady"
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    confirmFrames: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="live-range">
              <span className="live-range__label">
                Min score <b className="mono">{filters.minScore.toFixed(2)}</b>
              </span>
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={filters.minScore}
                aria-label="Minimum fused score drawn"
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    minScore: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="live-range">
              <span className="live-range__label">
                Min size <b className="mono">{filters.minAreaPct.toFixed(2)}%</b>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={filters.minAreaPct}
                aria-label="Minimum box area drawn, percent of frame"
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    minAreaPct: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="live-range">
              <span className="live-range__label">
                Box smoothing <b className="mono">{Math.round((1 - filters.smoothing) * 100)}%</b>
              </span>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={filters.smoothing}
                aria-label="Box smoothing strength"
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    smoothing: Number(event.target.value),
                  }))
                }
              />
            </label>
            <label className="live-toggle">
              <input
                type="checkbox"
                checked={filters.showCandidates}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    showCandidates: event.target.checked,
                  }))
                }
              />
              Draw unconfirmed candidates
            </label>
          </div>
        </div>

        <div className="live-clarity" aria-live="off">
          <div className="live-clarity__row">
            <div className="live-clarity__cell live-clarity__cell--accent">
              <span className="live-clarity__key mono">DRAWN NOW</span>
              <span className="live-clarity__value mono">{formatNumber(tracks.length)}</span>
            </div>
            <div className="live-clarity__cell live-clarity__cell--ok">
              <span className="live-clarity__key mono">CONFIRMED</span>
              <span className="live-clarity__value mono">
                {formatNumber(tracks.filter((track) => track.confirmed !== false).length)}
              </span>
            </div>
            <div className="live-clarity__cell live-clarity__cell--warn">
              <span className="live-clarity__key mono">HIDDEN THIS FRAME</span>
              <span className="live-clarity__value mono">{formatNumber(hiddenNow.length)}</span>
            </div>
            <div className="live-clarity__cell">
              <span className="live-clarity__key mono">MEASURED</span>
              <span className="live-clarity__value mono">
                {formatNumber(frame?.counts.objects_now ?? 0)}
              </span>
            </div>
          </div>
          <div className="live-clarity__breaks mono">
            <span>
              hidden: <b>{formatNumber(hiddenNow.filter((view) => view.suppressed === "candidate").length)}</b> unconfirmed
            </span>
            <span>
              <b>{formatNumber(hiddenNow.filter((view) => view.suppressed === "score").length)}</b> below score
            </span>
            <span>
              <b>{formatNumber(hiddenNow.filter((view) => view.suppressed === "size").length)}</b> too small
            </span>
            <span className="live-clarity__totals">
              suppressed so far: {formatNumber(suppressedTotals.candidate + suppressedTotals.score + suppressedTotals.size)} boxes
              · every one still recorded as an observation
            </span>
          </div>
        </div>

        {error && (
          <div className="alert alert--bad" role="alert">
            <AlertIcon width={14} height={14} />
            <div className="alert__body">
              <p className="alert__title">Camera or tracking error</p>
              <p className="alert__text">{error}</p>
            </div>
          </div>
        )}

        <div className="live-controls">
          {phase !== "live" && phase !== "stopping" && phase !== "starting" && (
            <button type="button" className="btn btn--primary" onClick={() => void start()}>
              <span className="btn__icon">
                <PlayIcon width={12} height={12} />
              </span>
              {phase === "done" || phase === "error" ? "Start a new capture" : "Start live tracking"}
            </button>
          )}
          {(phase === "live" || phase === "stopping") && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void stop()}
              disabled={phase === "stopping" || !frame}
            >
              <span className="btn__icon">
                <StopIcon width={12} height={12} />
              </span>
              {phase === "stopping" ? "Saving session…" : "Stop & analyze"}
            </button>
          )}
          {(phase === "starting" || phase === "live" || phase === "stopping") && (
            <button type="button" className="btn btn--quiet btn--sm" onClick={discard}>
              Discard capture
            </button>
          )}
          <span className="hint hint--flush">
            {phase === "starting"
              ? "Waiting for the camera permission prompt…"
              : `Captured as fast as frames are scored · ${LIVE_TARGET_FPS} fps target${frame ? ` · ${formatNumber(frame.fps, 1)} fps measured` : ""}`}
          </span>
        </div>

        <MetricGrid columns={4} label="Live tracking totals">
          <MetricCard
            label="Objects now"
            value={formatNumber(frame?.counts.objects_now ?? tracks.length)}
            hint="measured in this frame"
            tone="accent"
          />
          <MetricCard label="Tracks seen" value={formatNumber(frame?.counts.tracks_seen ?? 0)} tone="accent-2" />
          <MetricCard label="Observations" value={formatNumber(frame?.counts.observations ?? 0)} />
          <MetricCard label="Frames scored" value={formatNumber(frame?.counts.frames ?? 0)} />
        </MetricGrid>

        <div className="live-levels">
          <StackedLevelBar levels={counts} />
          <span className="tag">
            <TrackIcon width={11} height={11} /> {formatNumber(summary?.tracks ?? frame?.counts.tracks_seen ?? 0)} tracks
          </span>
          <span className="tag">{frame?.calibrated ? "scene calibrated" : "calibrating baseline"}</span>
          <span className="mono dim">
            {formatNumber(frame?.detections ?? 0)} detections · {formatNumber(frame?.counts.objects_now ?? 0)} tracked now
          </span>
        </div>

        <div className="live-analytics">
          <div className="live-analytics__card">
            <span className="mini-label">Outcome mix · this capture</span>
            <DonutChart
              size={138}
              centerValue={formatNumber(
                LEVEL_ORDER.reduce((sum, level) => sum + (counts[level] ?? 0), 0),
              )}
              centerLabel="observations"
              ariaLabel={LEVEL_ORDER.map((level) => `${level} ${counts[level] ?? 0}`).join(", ")}
              segments={LEVEL_ORDER.map((level) => ({
                label: level,
                value: counts[level] ?? 0,
                color: LEVEL_COLOURS[level],
              }))}
            />
          </div>
          <div className="live-analytics__card">
            <span className="mini-label">Objects in frame · recent frames</span>
            <Sparkline
              values={history.map((row) => row.objects)}
              color="var(--chart-1)"
              ariaLabel="Objects tracked per recent frame"
            />
            <span className="mini-label">Peak fused score · recent frames</span>
            <Sparkline
              values={history.map((row) => row.peak)}
              color="var(--chart-4)"
              ariaLabel="Highest fused score per recent frame"
            />
          </div>
          <div className="live-analytics__card">
            <span className="mini-label">Object score ranking</span>
            <BarList
              ariaLabel="Live objects by fused score"
              max={1}
              rows={[...tracks]
                .sort((a, b) => b.scores.fused - a.scores.fused)
                .map((track) => ({
                  key: String(track.track_id),
                  label: `T${String(track.track_id).padStart(2, "0")} · ${track.color ?? "—"}`,
                  value: track.scores.fused,
                  color: LEVEL_COLOURS[track.level],
                }))}
              formatValue={(value) => value.toFixed(2)}
              emptyLabel="No object in the latest frame"
            />
          </div>
        </div>

        {tracks.length > 0 ? (
          <div className="live-tracks">
            <p className="note__label">
              Tracked objects in the latest frame — drawn {formatNumber(tracks.length)} of{" "}
              {formatNumber(frame?.counts.objects_now ?? tracks.length)} measured · box, path,
              scores and reason
            </p>
            <ul className="live-object-grid">
              {[...tracks]
                .sort((a, b) => b.scores.fused - a.scores.fused)
                .map((track) => (
                  <li
                    key={track.track_id}
                    className={`live-object live-object--${track.level.toLowerCase()}`}
                  >
                    <div className="live-object__head">
                      <span
                        className="live-object__swatch"
                        style={{ background: appearanceColour(track.color) }}
                        aria-hidden="true"
                      />
                      <span className="mono live-object__id">
                        T{String(track.track_id).padStart(2, "0")}
                      </span>
                      <LevelBadge level={track.level} />
                      <span className="tag">{track.color ?? "colour —"}</span>
                      <span className="tag">{track.shape ?? "shape —"}</span>
                      <span
                        className={`tag tag--${track.confirmed === false ? "warn" : "ok"}`}
                        title="Frames this identity has been observed in"
                      >
                        {track.confirmed === false ? "candidate" : "steady"} ·{" "}
                        {formatNumber(track.frames_seen ?? 0)}f
                      </span>
                    </div>
                    <div className="live-object__body">
                      <MiniTrail
                        points={track.trail ?? []}
                        color={LEVEL_HEX[track.level]}
                        label={`Measured path of object ${track.track_id}`}
                        box={track.box}
                      />
                      <div className="live-object__metrics mono">
                        <span>
                          speed <b>{track.speed_px_s === null ? "—" : `${track.speed_px_s.toFixed(0)} px/s`}</b>
                        </span>
                        <span>
                          heading <b>{headingArrow(track.direction_deg)} {track.direction_deg === null ? "—" : `${track.direction_deg.toFixed(0)}°`}</b>
                        </span>
                        <span>
                          fused <Score value={track.scores.fused} />{" "}
                          <span className="dim">({confidenceBand(track.scores.fused)})</span>
                        </span>
                      </div>
                    </div>
                    <div className="live-object__scores">
                      {(
                        [
                          ["Rule", track.scores.rule],
                          ["ML", track.scores.ml],
                          ["Scene", track.scores.scene],
                        ] as const
                      ).map(([label, value]) => (
                        <div className="live-score-row" key={label}>
                          <span>{label}</span>
                          <span className="live-score-row__track">
                            <span
                              className="live-score-row__fill"
                              style={{
                                width: `${Math.max(1, Math.min(1, value) * 100)}%`,
                                background: LEVEL_HEX[track.level],
                              }}
                            />
                          </span>
                          <span className="mono">{value.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                    <p className="live-object__why">{truncateMiddle(track.why, 170)}</p>
                    {track.rules.length > 0 && (
                      <p className="live-object__rules mono">{track.rules.join(" · ")}</p>
                    )}
                  </li>
                ))}
            </ul>
            <ChartNote>
              cyan Normal · amber Suspicious · red Irregular · dashed box = unconfirmed candidate
            </ChartNote>
          </div>
        ) : (
          <p className="hint hint--flush">
            {live
              ? hiddenNow.length > 0
                ? `${formatNumber(hiddenNow.length)} object${hiddenNow.length === 1 ? "" : "s"} were measured in this frame but hidden by the stability controls (unconfirmed, low score or too small). Lower “Steady after”, lower the score floor, or enable candidates to draw them. Every one is still recorded.`
                : "No object is visible in the latest frame. Live sessions detect both saturated shapes and moving foreground; point the camera at a moving object, or improve the light if the scene is nearly static."
              : "Tracking output appears here while the camera runs."}
          </p>
        )}

        {summary && (
          <div className="rows rows--tight">
            <div className="row">
              <span className="row__key">Session</span>
              <span className="row__value mono">{summary.session_id}</span>
            </div>
            <div className="row">
              <span className="row__key">Frames processed</span>
              <span className="row__value">{formatNumber(summary.frames_processed)}</span>
            </div>
            <div className="row">
              <span className="row__key">Observations</span>
              <span className="row__value">{formatNumber(summary.observations)}</span>
            </div>
            <div className="row">
              <span className="row__key">Tracks</span>
              <span className="row__value">{formatNumber(summary.tracks)}</span>
            </div>
            <div className="row">
              <span className="row__key">Capture duration</span>
              <span className="row__value">{liveElapsed(summary.duration_s)}</span>
            </div>
            <div className="row">
              <span className="row__key">Annotated previews kept</span>
              <span className="row__value">{formatNumber(summary.previews)}</span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
