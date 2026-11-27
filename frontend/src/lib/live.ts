/** Pure helpers for live webcam capture.
 *
 * The panel asks the browser for a stream, captures frames into a canvas and
 * posts them to the API one at a time. Everything here is deterministic and
 * testable: frame sizing, overlay geometry, level counts and camera errors.
 */
import type { Level, LiveTrack } from "./types";

/** Frames per second requested from the capture loop. */
export const LIVE_TARGET_FPS = 12;
/** Largest frame width posted to the API (larger frames are downscaled). */
export const LIVE_CAPTURE_MAX_WIDTH = 1280;
export const LIVE_JPEG_QUALITY = 0.82;

export type LiveQuality = "auto" | "high" | "balanced" | "fast";
export type LiveProfileKey = Exclude<LiveQuality, "auto">;

export interface CaptureProfile {
  maxWidth: number;
  jpegQuality: number;
  label: string;
  note: string;
}

/**
 * Capture profiles trade image detail against round-trip time. Detail matters:
 * a distant person is only a few dozen pixels wide, and downscaling too far
 * makes detection and re-identification less reliable.
 */
export const LIVE_PROFILES: Record<LiveProfileKey, CaptureProfile> = {
  high: {
    maxWidth: 1280,
    jpegQuality: 0.9,
    label: "High accuracy",
    note: "1280 px · 90% JPEG",
  },
  balanced: {
    maxWidth: 960,
    jpegQuality: 0.85,
    label: "Balanced",
    note: "960 px · 85% JPEG",
  },
  fast: {
    maxWidth: 640,
    jpegQuality: 0.74,
    label: "Fast",
    note: "640 px · 74% JPEG",
  },
};

/** Pick a capture profile; `auto` follows the measured round-trip time. */
export function resolveProfile(
  quality: LiveQuality,
  smoothedRoundTripMs: number,
): { key: LiveProfileKey; profile: CaptureProfile } {
  if (quality !== "auto") return { key: quality, profile: LIVE_PROFILES[quality] };
  if (smoothedRoundTripMs >= 550) return { key: "fast", profile: LIVE_PROFILES.fast };
  if (smoothedRoundTripMs >= 300) return { key: "balanced", profile: LIVE_PROFILES.balanced };
  return { key: "high", profile: LIVE_PROFILES.high };
}

/** 0–100 scene-baseline progress, never above 100. */
export function calibrationPercent(
  calibration: { progress?: number; samples?: number; needed?: number } | null | undefined,
): number {
  if (!calibration) return 0;
  const progress =
    typeof calibration.progress === "number"
      ? calibration.progress
      : (calibration.samples ?? 0) / Math.max(calibration.needed ?? 1, 1);
  if (!Number.isFinite(progress)) return 0;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/**
 * What the engine called the object. The pretrained detector reports real
 * classes ("person", "car"); the colour/shape engine can only describe what it
 * saw, so its description is used verbatim instead of inventing a class.
 */
export function liveObjectName(
  track: Pick<LiveTrack, "class_name" | "color" | "shape">,
): string {
  if (track.class_name) return track.class_name;
  const described = [track.color, track.shape].filter(Boolean).join(" ");
  return described || "unclassified";
}

/** Human label for the engine that actually scored a frame. */
export function engineLabel(engine: "objects" | "motion" | undefined): string {
  if (engine === "objects") return "object detector";
  if (engine === "motion") return "motion + colour";
  return "engine unknown";
}

export interface CaptureSize {
  width: number;
  height: number;
}

/** Even dimensions only: odd sizes are not valid for every encoder. */
export function captureSize(
  videoWidth: number,
  videoHeight: number,
  maxWidth: number = LIVE_CAPTURE_MAX_WIDTH,
): CaptureSize {
  const width = Math.max(0, Math.floor(videoWidth));
  const height = Math.max(0, Math.floor(videoHeight));
  if (width === 0 || height === 0) return { width: 0, height: 0 };
  const scale = width > maxWidth ? maxWidth / width : 1;
  const scaledWidth = Math.max(2, Math.round(width * scale));
  const scaledHeight = Math.max(2, Math.round(height * scale));
  return {
    width: scaledWidth % 2 === 0 ? scaledWidth : scaledWidth - 1,
    height: scaledHeight % 2 === 0 ? scaledHeight : scaledHeight - 1,
  };
}

export interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

/** Convert a pixel box from a frame of `source` size into CSS percentages.
 *
 * The overlay canvas is sized to the same aspect as the video, so percentage
 * geometry stays aligned at any displayed size.
 */
export function overlayBox(
  track: Pick<LiveTrack, "box">,
  sourceWidth: number,
  sourceHeight: number,
): OverlayBox {
  const [x, y, width, height] = track.box;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const left = clampPercent((x / sourceWidth) * 100);
  const top = clampPercent((y / sourceHeight) * 100);
  return {
    left,
    top,
    width: clampPercent((width / sourceWidth) * 100),
    height: clampPercent((height / sourceHeight) * 100),
  };
}

export function levelCounts(tracks: LiveTrack[]): Record<Level, number> {
  const counts: Record<Level, number> = {
    Normal: 0,
    Suspicious: 0,
    Irregular: 0,
  };
  for (const track of tracks) counts[track.level] += 1;
  return counts;
}

/** Compass arrow for a measured heading (screen coordinates, 0° = east). */
export function headingArrow(degrees: number | null): string {
  if (degrees === null || !Number.isFinite(degrees)) return "·";
  const arrows = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
  const normalised = ((degrees % 360) + 360) % 360;
  return arrows[Math.round(normalised / 45) % 8];
}

/** Compact level label for a live overlay chip. */
export function levelShort(level: Level): string {
  if (level === "Irregular") return "IRR";
  if (level === "Suspicious") return "SUS";
  return "NRM";
}

const APPEARANCE_HEX: Record<string, string> = {
  red: "#ff5d6c",
  orange: "#ff9f43",
  yellow: "#ffd93d",
  green: "#46dda6",
  blue: "#4f9dff",
  magenta: "#c084fc",
};

/** Swatch colour for a reported appearance name; unknown names stay muted. */
export function appearanceColour(name: string | null): string {
  if (!name) return "var(--chart-track)";
  return APPEARANCE_HEX[name.toLowerCase()] ?? "var(--chart-track)";
}

/** `mm:ss` for a measured elapsed duration; negative input is never shown. */
export function liveElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** Explain a getUserMedia failure in terms the operator can act on. */
export function cameraErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was blocked. Allow the camera for this page in your browser's site settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No usable camera was found. Connect a webcam and reload the page.";
    case "NotReadableError":
      return "The camera is already in use by another application. Close it and try again.";
    case "AbortError":
      return "The camera stopped before it could start. Try again.";
    default: {
      const message = (error as { message?: string } | null)?.message;
      return message?.trim()
        ? `The camera could not start: ${message}`
        : "The camera could not start. Check the browser's camera permission.";
    }
  }
}

/* ------------------------------------------------------------------ filtering
 * Live detection is noisier than a file run: a single frame can carry a
 * one-frame blob, a tiny far-away speck or a low-score guess. These helpers
 * decide what is *drawn* without ever changing what is recorded — the API
 * persists every observation, and the panel reports both numbers so the
 * difference is visible instead of hidden.
 */

export interface LiveFilterSettings {
  /** Also draw objects the engine has not confirmed yet. */
  showCandidates: boolean;
  /** Minimum fused score for a box to be drawn. */
  minScore: number;
  /** Minimum box area as a percentage of the frame area. */
  minAreaPct: number;
  /** Frames an object must be seen before it counts as steady. */
  confirmFrames: number;
  /** How strongly a new box position replaces the smoothed one (0 = frozen). */
  smoothing: number;
}

export const DEFAULT_LIVE_FILTERS: LiveFilterSettings = {
  showCandidates: false,
  minScore: 0,
  minAreaPct: 0.1,
  confirmFrames: 3,
  smoothing: 0.45,
};

export type LiveSuppression = "candidate" | "score" | "size";

export interface LiveTrackView {
  track: LiveTrack;
  /** Frames this identity has been observed in (client count or server count). */
  framesSeen: number;
  /** Box area as a percentage of the whole frame. */
  areaPct: number;
  /** Engine-confirmed or seen for at least `confirmFrames` frames. */
  steady: boolean;
  /** Why the box is not drawn, or null when it is. */
  suppressed: LiveSuppression | null;
}

function seenCount(track: LiveTrack, seen: Map<number, number>): number {
  return Math.max(seen.get(track.track_id) ?? 0, track.frames_seen ?? 0);
}

export function boxAreaPct(
  track: Pick<LiveTrack, "box">,
  frameWidth: number,
  frameHeight: number,
): number {
  const frameArea = frameWidth * frameHeight;
  if (frameArea <= 0) return 0;
  const [, , width, height] = track.box;
  return (Math.max(0, width) * Math.max(0, height) * 100) / frameArea;
}

/** Classify every object in the latest frame into drawn and suppressed sets. */
export function classifyLiveTracks(
  tracks: LiveTrack[],
  frameWidth: number,
  frameHeight: number,
  seen: Map<number, number>,
  filters: LiveFilterSettings,
): { views: LiveTrackView[]; visible: LiveTrackView[]; hidden: LiveTrackView[] } {
  const views = tracks.map((track) => {
    const frames = seenCount(track, seen);
    const steady = track.confirmed === true || frames >= filters.confirmFrames;
    const areaPct = boxAreaPct(track, frameWidth, frameHeight);
    let suppressed: LiveSuppression | null = null;
    if (areaPct < filters.minAreaPct) suppressed = "size";
    else if (track.scores.fused < filters.minScore) suppressed = "score";
    else if (!steady && !filters.showCandidates) suppressed = "candidate";
    return { track, framesSeen: frames, areaPct, steady, suppressed };
  });
  return {
    views,
    visible: views.filter((view) => view.suppressed === null),
    hidden: views.filter((view) => view.suppressed !== null),
  };
}

/** Exponential smoothing of a measured box; keeps the drawn box steady while
 *  the underlying measurement still moves. A weight of 1 draws raw. */
export function smoothBox(
  previous: [number, number, number, number] | undefined,
  next: [number, number, number, number],
  weight: number,
): [number, number, number, number] {
  const w = Math.min(1, Math.max(0.05, weight));
  if (!previous) return next;
  return [
    previous[0] + (next[0] - previous[0]) * w,
    previous[1] + (next[1] - previous[1]) * w,
    previous[2] + (next[2] - previous[2]) * w,
    previous[3] + (next[3] - previous[3]) * w,
  ];
}

/** Confidence band label from the measured fused score. */
export function confidenceBand(score: number): "high" | "medium" | "low" {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}
