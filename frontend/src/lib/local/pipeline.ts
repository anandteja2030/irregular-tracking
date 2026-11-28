/** Runs the in-browser vision engine over a recorded clip.
 *
 * The Python service decodes a file with OpenCV and persists what it measured.
 * A static deployment cannot, so the tab decodes the file itself (a hidden
 * `<video>` seeked frame by frame onto a canvas), feeds each frame to the same
 * `LocalVisionEngine` the live page uses, and writes one session record.
 *
 * Every number stored here was measured in this tab: speeds are source-video
 * pixels per second, the source frame rate is `null` when the container does
 * not report it, and a value that was not measured is never substituted.
 */
import { CONFIRMED_FRAMES, LocalVisionEngine, ANALYSIS_MIN_SAMPLES } from "../browserVision";
import type { LocalTrack } from "../browserVision";
import type { Level } from "../types";
import { putSession, type StoredObservation, type StoredPreview, type StoredSession } from "./store";

export const VIDEO_SAMPLE_FPS = 10;
export const MAX_ANALYSIS_FRAMES = 600;
const ANALYSIS_WIDTH = 480;
const PREVIEW_TARGET = 24;
const PREVIEW_WIDTH = 640;
const CROP_SIZE = 112;

export interface VideoProbe {
  fps: number | null;
  frames: number | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
}

const LEVEL_HEX: Record<Level, string> = {
  Normal: "#46dda6",
  Suspicious: "#ffd93b",
  Irregular: "#ff5d6c",
};

function waitFor(
  target: HTMLVideoElement,
  event: string,
  timeoutMs = 6_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      target.removeEventListener(event, onEvent);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const onEvent = () => finish();
    target.addEventListener(event, onEvent, { once: true });
    const timer = setTimeout(
      () => finish(new Error(`The browser did not fire "${event}" for this clip.`)),
      timeoutMs,
    );
  });
}

interface LoadedVideo {
  video: HTMLVideoElement;
  url: string;
  width: number;
  height: number;
  durationS: number;
}

async function loadVideo(blob: Blob): Promise<LoadedVideo> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    try {
      await waitFor(video, "loadedmetadata");
    } catch {
      // Some containers only resolve dimensions after the first frame lands.
      video.load();
      await waitFor(video, "loadeddata", 8_000);
    }
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) {
      throw new Error("This file has no decodable video track in this browser.");
    }
    const durationS = Number.isFinite(video.duration) ? video.duration : 0;
    if (durationS <= 0) throw new Error("This clip reports no duration, so it cannot be sampled.");
    return { video, url, width, height, durationS };
  } catch (error) {
    URL.revokeObjectURL(url);
    const message = error instanceof Error ? error.message : "";
    if (/loadedmetadata|loadeddata/.test(message)) {
      // Say *why* in the one case the browser itself knows: a Chromium build
      // without proprietary codecs cannot decode H.264 at all.
      const h264 = document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"');
      throw new Error(
        `This browser did not decode the clip.${
          h264 ? "" : " It reports no H.264/MP4 decoder, which is common in Chromium builds without proprietary codecs."
        } Try an H.264 MP4 or a WebM clip in Chrome, Edge, Firefox or Safari.`,
      );
    }
    throw error;
  }
}

/** Read the clip's own dimensions and duration without analysing it. */
export async function probeVideo(blob: Blob): Promise<VideoProbe> {
  const loaded = await loadVideo(blob);
  try {
    return {
      fps: null,
      frames: null,
      width: loaded.width,
      height: loaded.height,
      durationS: loaded.durationS,
    };
  } finally {
    URL.revokeObjectURL(loaded.url);
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot provide a 2D canvas context.");
  return context;
}

/** One annotated JPEG of the frame: every confirmed object boxed and named. */
function annotate(
  source: HTMLCanvasElement,
  tracks: LocalTrack[],
  scale: number,
): string {
  const width = Math.min(PREVIEW_WIDTH, source.width);
  const ratio = width / source.width;
  const canvas = canvasOf(width, Math.max(1, Math.round(source.height * ratio)));
  const context = context2d(canvas);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  context.lineWidth = 2;
  context.font = "600 11px ui-monospace, monospace";
  for (const track of tracks) {
    if (track.frames < CONFIRMED_FRAMES) continue;
    const [x, y, w, h] = track.box.map((value) => value * scale) as [number, number, number, number];
    context.strokeStyle = LEVEL_HEX[track.level] ?? "#8a94a6";
    context.strokeRect(x * ratio, y * ratio, w * ratio, h * ratio);
    const label = `T${String(track.id).padStart(2, "0")}`;
    const textWidth = context.measureText(label).width + 4;
    const top = Math.max(0, y * ratio - 13);
    context.fillStyle = "rgba(6, 10, 18, 0.72)";
    context.fillRect(x * ratio, top, textWidth, 12);
    context.fillStyle = LEVEL_HEX[track.level] ?? "#e6edf7";
    context.fillText(label, x * ratio + 2, top + 9);
  }
  return canvas.toDataURL("image/jpeg", 0.62);
}

function cropOf(
  source: HTMLCanvasElement,
  track: LocalTrack,
  scale: number,
): string {
  const cx = track.centroid[0] * scale;
  const cy = track.centroid[1] * scale;
  const half = CROP_SIZE / 2;
  const canvas = canvasOf(CROP_SIZE, CROP_SIZE);
  const context = context2d(canvas);
  context.drawImage(source, cx - half, cy - half, CROP_SIZE, CROP_SIZE, 0, 0, CROP_SIZE, CROP_SIZE);
  return canvas.toDataURL("image/jpeg", 0.6);
}

export interface AnalyseOptions {
  label: string;
  kind: "upload" | "sample" | "live";
  synthetic?: boolean;
  bytes?: number | null;
  onProgress?: (percent: number, stage: string, framesDone: number) => void;
  signal?: AbortSignal;
  /** Stop after this many analysed frames (the studio's max-frames option). */
  maxFrames?: number | null;
}

function abortError(): DOMException {
  return new DOMException("Analysis cancelled", "AbortError");
}

function sessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `local_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Decode, analyse and package one clip into a session record. */
export async function analyseVideo(
  blob: Blob,
  options: AnalyseOptions,
): Promise<StoredSession> {
  const { onProgress, signal } = options;
  if (signal?.aborted) throw abortError();
  const startedTs = new Date().toISOString();
  const started = performance.now();
      onProgress?.(2, "opening", 0);

  const loaded = await loadVideo(blob);
  const { video, width: sourceWidth, height: sourceHeight, durationS } = loaded;
  try {
    const ratio = sourceHeight / sourceWidth;
    const analysisWidth = Math.min(ANALYSIS_WIDTH, sourceWidth);
    const analysisHeight = Math.max(1, Math.round(analysisWidth * ratio));
    const scale = analysisWidth / sourceWidth;
    const frameCanvas = canvasOf(analysisWidth, analysisHeight);
    const frameContext = context2d(frameCanvas);
    const sourceCanvas = canvasOf(sourceWidth, sourceHeight);
    const sourceContext = context2d(sourceCanvas);

    const sampleCount = Math.max(
      2,
      Math.min(
        options.maxFrames && options.maxFrames > 0 ? options.maxFrames : MAX_ANALYSIS_FRAMES,
        Math.floor(durationS * VIDEO_SAMPLE_FPS),
      ),
    );
    const step = durationS / Math.max(1, sampleCount - 1);
    const previewStride = Math.max(1, Math.ceil(sampleCount / PREVIEW_TARGET));

    const engine = new LocalVisionEngine();
    const observations: StoredObservation[] = [];
    const previews: StoredPreview[] = [];
    const crops: Record<string, string> = {};

    onProgress?.(5, "processing", 0);
    for (let index = 0; index < sampleCount; index += 1) {
      if (signal?.aborted) throw abortError();
      const t = Math.min(durationS - 0.001, index * step);
      video.currentTime = t;
      await waitFor(video, "seeked");
      if (signal?.aborted) throw abortError();

      sourceContext.drawImage(video, 0, 0, sourceWidth, sourceHeight);
      frameContext.drawImage(sourceCanvas, 0, 0, analysisWidth, analysisHeight);
      const image = frameContext.getImageData(0, 0, analysisWidth, analysisHeight);
      const frame = engine.analyse(image, index * (1000 / VIDEO_SAMPLE_FPS));

      for (const track of frame.tracks) {
        if (track.frames < CONFIRMED_FRAMES) continue;
        observations.push({
          frame: index,
          ts: t,
          trackId: track.id,
          level: track.level,
          score: track.score,
          rule: Math.min(1, Math.max(0, track.score * 2)),
          ml: null,
          scene: track.score,
          speed: track.speedPxS / scale,
          direction: track.directionDeg,
          areaPct: track.areaPct,
          colour: track.colour,
          box: [
            track.box[0] / scale,
            track.box[1] / scale,
            track.box[2] / scale,
            track.box[3] / scale,
          ],
          centroid: [track.centroid[0] / scale, track.centroid[1] / scale],
          seen: track.frames,
        });
      }

      if (index % previewStride === 0) {
        previews.push({
          frame: index,
          tsS: t,
          annotated: annotate(sourceCanvas, frame.tracks, scale),
          original: (() => {
            const canvas = canvasOf(
              Math.min(PREVIEW_WIDTH, sourceWidth),
              Math.round(Math.min(PREVIEW_WIDTH, sourceWidth) * ratio),
            );
            context2d(canvas).drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL("image/jpeg", 0.55);
          })(),
        });
        for (const track of frame.tracks) {
          if (track.level !== "Irregular" || track.frames < 3) continue;
          crops[`${index}:${track.id}`] = cropOf(sourceCanvas, track, 1);
        }
      }

      if (index % 3 === 0) {
        onProgress?.(5 + Math.round((90 * index) / sampleCount), "processing", index + 1);
      }
    }

    const wallS = (performance.now() - started) / 1000;
    onProgress?.(97, "persisting", sampleCount);
    const session: StoredSession = {
      id: sessionId(),
      createdTs: new Date().toISOString(),
      startedTs,
      endedTs: new Date().toISOString(),
      source: {
        label: options.label,
        kind: options.kind,
        synthetic: options.synthetic ?? false,
        bytes: options.bytes ?? null,
        fps: null,
        width: sourceWidth,
        height: sourceHeight,
        durationS,
      },
      processing: {
        frames: sampleCount,
        width: sourceWidth,
        height: sourceHeight,
        fps: null,
        wallS,
        processFps: sampleCount / Math.max(0.001, wallS),
        maxFrames: options.maxFrames ?? null,
        videoDurationS: durationS,
      },
      observations,
      previews,
      crops,
      labels: [],
      engine: `in-browser motion engine · ${ANALYSIS_MIN_SAMPLES}-sample scene baseline`,
    };
    onProgress?.(100, "completed", sampleCount);
    return session;
  } finally {
    URL.revokeObjectURL(loaded.url);
  }
}


export interface LiveCaptureSummary {
  /** Camera label, when the browser exposes one. */
  label: string;
  width: number | null;
  height: number | null;
  observations: StoredObservation[];
  previews: StoredPreview[];
  elapsedS: number;
  startedTs: string;
  measuredFps: number | null;
}

/** Persist a finished webcam capture as a session.
 *
 * A live capture has no file and no source frame rate, so those stay `null`
 * instead of being guessed; everything else is the measured frame stream the
 * caller accumulated.
 */
export async function saveLiveSession(summary: LiveCaptureSummary): Promise<StoredSession> {
  const frames = summary.observations.reduce((best, row) => Math.max(best, row.frame), 0) + 1;
  const session: StoredSession = {
    id: sessionId(),
    createdTs: new Date().toISOString(),
    startedTs: summary.startedTs,
    endedTs: new Date().toISOString(),
    source: {
      label: summary.label,
      kind: "live",
      synthetic: false,
      bytes: null,
      fps: summary.measuredFps,
      width: summary.width,
      height: summary.height,
      durationS: summary.elapsedS,
    },
    processing: {
      frames,
      width: summary.width,
      height: summary.height,
      fps: summary.measuredFps,
      wallS: summary.elapsedS,
      processFps: frames / Math.max(0.001, summary.elapsedS),
      maxFrames: null,
      videoDurationS: summary.elapsedS,
    },
    observations: summary.observations,
    previews: summary.previews,
    crops: {},
    labels: [],
    engine: `in-browser motion engine · live camera · ${ANALYSIS_MIN_SAMPLES}-sample scene baseline`,
  };
  await putSession(session);
  return session;
}
