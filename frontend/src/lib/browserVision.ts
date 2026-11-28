/**
 * In-browser vision engine.
 *
 * GitHub Pages can only serve static files, so a deployed console has no Python
 * service to send frames to. This module does the analysis in the tab instead:
 * background subtraction, blob extraction, nearest-centroid tracking, motion
 * features and a rule-based verdict.
 *
 * It is deliberately honest about what it is. It sees *motion*, not object
 * classes, so an object is described by its dominant colour and never labelled
 * "person" or "car". The recorded quantities are the ones it actually measured
 * (pixels, seconds, frame counts) and an unmeasured value stays null.
 *
 * Everything here is pure and deterministic apart from the wall-clock times the
 * caller passes in, which makes the tracker testable without a camera.
 */

import type { Level } from "./types";

/** One connected region of changed pixels, in analysis-frame pixels. */
export interface Blob {
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
  area: number;
}

export interface LocalTrack {
  id: number;
  box: [number, number, number, number];
  centroid: [number, number];
  /** Recent centroids, oldest first, for the drawn trail. */
  trail: [number, number][];
  /** Measured speed in analysis-frame pixels per second. */
  speedPxS: number;
  /** Heading in degrees (0 = right, 90 = down), or null when stationary. */
  directionDeg: number | null;
  level: Level;
  /** Fused 0–1 score from the scene-relative speed deviation. */
  score: number;
  /** Display-only smoothed copy of `score`; the verdict uses the raw value. */
  scoreSmoothed: number;
  /** Verdict from the smoothed score, kept separate from `level`. */
  levelStability: Level;
  frames: number;
  /** Box area as a percentage of the analysis frame. */
  areaPct: number;
  /** Dominant colour of the matched pixels, e.g. "blue". */
  colour: string;
}

export interface LocalFrame {
  frameWidth: number;
  frameHeight: number;
  tracks: LocalTrack[];
  /** Wall-clock milliseconds spent inside `analyse`. */
  processMs: number;
  /** True when the illumination guard discarded the frame. */
  skipped: boolean;
  calibration: { samples: number; needed: number; progress: number };
  /** Mean absolute pixel change (8-bit units) measured for this frame. */
  changeLevel: number;
}

export const ANALYSIS_MIN_SAMPLES = 30;
export const DEFAULT_MIN_BLOB_AREA = 12;

/** Luminance plane from RGBA pixels (Rec. 601 weights, rounded). */
export function toGray(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return gray;
}

/**
 * Running-average background model with the same illumination guard the Python
 * pipeline uses: when most of the frame changes at once (exposure change, lamp
 * switched on) the difference is not motion, so the frame is discarded and the
 * model re-adapts instead of reporting the whole scene as objects.
 */
export class BackgroundModel {
  private mean: Float32Array | null = null;
  /** 0 disables adaptation; 1 replaces the model with the new frame. */
  constructor(
    private readonly alpha = 0.06,
    readonly resetRatio = 0.45,
  ) {}

  reset(): void {
    this.mean = null;
  }

  /** Returns the motion mask, or null when the frame was discarded. */
  update(gray: Uint8Array): { mask: Uint8Array; changeLevel: number; skipped: boolean } {
    if (!this.mean || this.mean.length !== gray.length) {
      this.mean = Float32Array.from(gray);
      return { mask: new Uint8Array(gray.length), changeLevel: 0, skipped: true };
    }
    const mean = this.mean;
    const mask = new Uint8Array(gray.length);
    let changed = 0;
    let totalDelta = 0;
    // A fixed 8-bit threshold is stable across webcams; the guard below handles
    // the one case where a fixed threshold is wrong (a global brightness jump).
    const threshold = 18;
    for (let i = 0; i < gray.length; i += 1) {
      const delta = Math.abs(gray[i] - mean[i]);
      totalDelta += delta;
      if (delta > threshold) {
        mask[i] = 1;
        changed += 1;
      }
    }
    const ratio = changed / Math.max(1, gray.length);
    const changeLevel = totalDelta / Math.max(1, gray.length);
    if (ratio > this.resetRatio) {
      mean.set(gray);
      return { mask: new Uint8Array(gray.length), changeLevel, skipped: true };
    }
    for (let i = 0; i < gray.length; i += 1) {
      mean[i] += (gray[i] - mean[i]) * this.alpha;
    }
    return { mask, changeLevel, skipped: false };
  }
}

/** Square dilation. Radius 1 closes single-pixel gaps; a larger radius also
 *  joins the fragments of one fast object into a single region. */
export function dilate(mask: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let ny = y0; ny <= y1; ny += 1) {
        const row = ny * width;
        for (let nx = x0; nx <= x1; nx += 1) out[row + nx] = 1;
      }
    }
  }
  return out;
}

/** Connected components of a binary mask, keeping regions of at least `minArea`. */
export function detectBlobs(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea = DEFAULT_MIN_BLOB_AREA,
): Blob[] {
  const seen = new Uint8Array(mask.length);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[index - 1] && !seen[index - 1]) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] && !seen[index - width]) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && mask[index + width] && !seen[index + width]) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }
    if (area < minArea) continue;
    blobs.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      cx: sumX / area,
      cy: sumY / area,
      area,
    });
  }
  return blobs;
}

const COLOUR_RANGES: { name: string; test: (r: number, g: number, b: number) => boolean }[] = [
  { name: "red", test: (r, g, b) => r > 110 && r > g * 1.45 && r > b * 1.45 },
  { name: "orange", test: (r, g, b) => r > 140 && g > 70 && g < r * 0.85 && b < g * 0.9 },
  { name: "yellow", test: (r, g, b) => r > 140 && g > 130 && b < 110 },
  { name: "green", test: (r, g, b) => g > 100 && g > r * 1.35 && g > b * 1.2 },
  { name: "blue", test: (r, g, b) => b > 100 && b > r * 1.3 && b > g * 1.15 },
  { name: "magenta", test: (r, g, b) => r > 110 && b > 110 && g < r * 0.8 && g < b * 0.9 },
];

/** Dominant colour under a blob's mask region, or "grey" when it has no hue. */
export function dominantColour(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  blob: Blob,
): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const x1 = Math.min(width - 1, blob.x + blob.width);
  const y1 = Math.min(Math.floor(mask.length / width) - 1, blob.y + blob.height);
  for (let y = blob.y; y <= y1; y += 1) {
    for (let x = blob.x; x <= x1; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const p = i * 4;
      r += data[p];
      g += data[p + 1];
      b += data[p + 2];
      count += 1;
    }
  }
  if (count === 0) return "grey";
  const mr = r / count;
  const mg = g / count;
  const mb = b / count;
  for (const range of COLOUR_RANGES) {
    if (range.test(mr, mg, mb)) return range.name;
  }
  return "grey";
}

/**
 * Centroid of the pixels inside `blob` that also changed in this frame.
 *
 * A moving object leaves a trail in a background-difference mask, and the
 * centroid of that whole region advances at roughly half the object's speed.
 * The pixels that are new this frame sit at the object's leading edge and move
 * with it, so they are what the tracker integrates.
 */
export function leadingCentroid(
  mask: Uint8Array,
  previous: Uint8Array | null,
  width: number,
  blob: Blob,
): [number, number] | null {
  if (!previous || previous.length !== mask.length) return null;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const x1 = Math.min(width - 1, blob.x + blob.width);
  const y1 = Math.min(Math.floor(mask.length / width) - 1, blob.y + blob.height);
  for (let y = blob.y; y <= y1; y += 1) {
    for (let x = blob.x; x <= x1; x += 1) {
      const i = y * width + x;
      if (!mask[i] || previous[i]) continue;
      sumX += x;
      sumY += y;
      count += 1;
    }
  }
  if (count < 8) return null;
  return [sumX / count, sumY / count];
}

/** Verdict thresholds on the scene-relative z-score of measured speed. */
export function levelForZScore(z: number): Level {
  if (z >= 3) return "Irregular";
  if (z >= 1.8) return "Suspicious";
  return "Normal";
}

/** Map a z-score onto 0–1 with a logistic centred just below "suspicious". */
export function scoreForZScore(z: number): number {
  const value = 1 / (1 + Math.exp(-(z - 2.1)));
  return Math.min(1, Math.max(0, value));
}

interface TrackState {
  id: number;
  box: [number, number, number, number];
  centroid: [number, number];
  /** Centroid of the pixels that changed this frame (the leading edge). */
  motion: [number, number];
  velocity: [number, number];
  trail: [number, number][];
  speed: number;
  direction: number | null;
  frames: number;
  misses: number;
  scoreSmoothed: number;
  colour: string;
  lastSeen: number;
}

/**
 * Nearest-centroid tracker with constant-velocity prediction.
 *
 * Cost is a greedy match over measured blobs, which is enough for a handful of
 * objects and keeps the whole loop inside one animation frame. An identity
 * survives up to `maxMisses` frames of occlusion before it is dropped.
 */
export class Tracker {
  private tracks: TrackState[] = [];
  private nextId = 1;

  constructor(
    private readonly maxMisses = 8,
    private readonly smoothing = 0.35,
  ) {}

  reset(): void {
    this.tracks = [];
    this.nextId = 1;
  }

  get count(): number {
    return this.tracks.length;
  }

  /** Advance one frame; `timeMs` must increase monotonically. */
  update(
    blobs: Blob[],
    timeMs: number,
    width: number,
    height: number,
    colours: string[] = [],
    leading: [number, number][] = [],
  ): TrackState[] {
    const maxDistance = Math.max(28, 0.22 * Math.hypot(width, height));
    const unmatched = new Set(blobs.map((_, index) => index));
    for (const track of this.tracks) {
      const [px, py] = track.motion;
      const dt = Math.max(1, timeMs - track.lastSeen) / 1000;
      const predicted: [number, number] = [
        px + track.velocity[0] * dt,
        py + track.velocity[1] * dt,
      ];
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (const index of unmatched) {
        const blob = blobs[index];
        const distance = Math.hypot(blob.cx - predicted[0], blob.cy - predicted[1]);
        if (distance < bestDistance && distance <= maxDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      if (bestIndex === -1) {
        track.misses += 1;
        track.velocity = [track.velocity[0] * 0.8, track.velocity[1] * 0.8];
        continue;
      }
      unmatched.delete(bestIndex);
      const blob = blobs[bestIndex];
      const elapsed = Math.max(1, timeMs - track.lastSeen);
      // Velocity comes from the leading edge, not the whole region: an object
      // leaves a trail of changed pixels behind it, and a centroid taken over
      // that trail moves at about half the object's real speed.
      const motion = leading[bestIndex] ?? [blob.cx, blob.cy];
      const vx = ((motion[0] - track.motion[0]) / elapsed) * 1000;
      const vy = ((motion[1] - track.motion[1]) / elapsed) * 1000;
      // The first measurement is the only one that is not a blend: take it as
      // measured instead of smoothing it toward a zero the track never had.
      track.velocity =
        track.frames <= 1
          ? [vx, vy]
          : [track.velocity[0] * 0.6 + vx * 0.4, track.velocity[1] * 0.6 + vy * 0.4];
      track.speed = Math.hypot(track.velocity[0], track.velocity[1]);
      track.direction =
        track.speed > 1 ? (Math.atan2(track.velocity[1], track.velocity[0]) * 180) / Math.PI : null;
      track.centroid = [blob.cx, blob.cy];
      track.motion = [motion[0], motion[1]];
      track.box = [blob.x, blob.y, blob.width, blob.height];
      track.trail = [...track.trail, track.centroid].slice(-24);
      track.frames += 1;
      track.misses = 0;
      track.lastSeen = timeMs;
      if (colours[bestIndex]) track.colour = colours[bestIndex];
    }
    for (const index of unmatched) {
      const blob = blobs[index];
      const track: TrackState = {
        id: this.nextId++,
        box: [blob.x, blob.y, blob.width, blob.height],
        centroid: [blob.cx, blob.cy],
        motion: leading[index] ?? [blob.cx, blob.cy],
        velocity: [0, 0],
        trail: [[blob.cx, blob.cy]],
        speed: 0,
        direction: null,
        frames: 1,
        misses: 0,
        scoreSmoothed: 0,
        colour: colours[index] ?? "grey",
        lastSeen: timeMs,
      };
      this.tracks.push(track);
    }
    this.tracks = this.tracks.filter((track) => track.misses <= this.maxMisses);
    return this.tracks.filter((track) => track.misses === 0);
  }

  /** Record a fused score and return its display-only smoothed value. */
  smooth(track: TrackState, score: number): number {
    track.scoreSmoothed = track.scoreSmoothed * (1 - this.smoothing) + score * this.smoothing;
    return track.scoreSmoothed;
  }
}

/** Scene baseline: how fast objects normally move in this view. */
export class SceneBaseline {
  private samples: number[] = [];

  constructor(private readonly needed = ANALYSIS_MIN_SAMPLES) {}

  reset(): void {
    this.samples = [];
  }

  get count(): number {
    return this.samples.length;
  }

  get progress(): number {
    return Math.min(1, this.samples.length / this.needed);
  }

  /** z-score of a measured speed against the samples collected so far. */
  zScore(speed: number): number {
    if (this.samples.length < 8) return 0;
    const mean = this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
    const variance =
      this.samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / this.samples.length;
    const std = Math.sqrt(variance);
    if (std < 1) return 0;
    return (speed - mean) / std;
  }

  /** Only settled, confirmed movement teaches the baseline. */
  observe(speed: number, frames: number): void {
    if (frames < 3 || speed <= 2) return;
    this.samples.push(speed);
    if (this.samples.length > 600) this.samples.shift();
  }
}

interface EngineOptions {
  minArea?: number;
  maxWidth?: number;
  /** Background adaptation rate; higher forgets a departed object sooner. */
  alpha?: number;
  /** Closing radius applied before connected components. */
  dilateRadius?: number;
}

/**
 * The full per-frame pipeline. One instance per capture: the background model,
 * track identities and the baseline are all stateful across frames.
 */
export class LocalVisionEngine {
  readonly tracker = new Tracker();
  readonly baseline = new SceneBaseline();
  private background: BackgroundModel;
  private readonly minArea: number;
  private readonly dilateRadius: number;
  private previousMask: Uint8Array | null = null;
  private lastFrame: LocalFrame | null = null;

  constructor(options: EngineOptions = {}) {
    this.minArea = options.minArea ?? DEFAULT_MIN_BLOB_AREA;
    this.dilateRadius = options.dilateRadius ?? 2;
    this.background = new BackgroundModel(options.alpha ?? 0.06);
  }

  reset(): void {
    this.background.reset();
    this.tracker.reset();
    this.baseline.reset();
    this.previousMask = null;
    this.lastFrame = null;
  }

  /** Analyse one RGBA frame taken at `timeMs`. */
  analyse(image: ImageData, timeMs: number): LocalFrame {
    const started = performance.now();
    const { width, height, data } = image;
    const gray = toGray(data, width, height);
    const { mask, changeLevel, skipped } = this.background.update(gray);
    if (skipped) {
      const frame: LocalFrame = {
        frameWidth: width,
        frameHeight: height,
        tracks: [],
        processMs: performance.now() - started,
        skipped: true,
        calibration: {
          samples: this.baseline.count,
          needed: ANALYSIS_MIN_SAMPLES,
          progress: this.baseline.progress,
        },
        changeLevel,
      };
      this.lastFrame = frame;
      return frame;
    }

    const closed = dilate(mask, width, height, this.dilateRadius);
    const blobs = detectBlobs(closed, width, height, this.minArea);
    const colours = blobs.map((blob) => dominantColour(data, mask, width, blob));
    const leading = blobs.map((blob) => leadingCentroid(mask, this.previousMask, width, blob));
    this.previousMask = mask;
    const tracked = this.tracker.update(
      blobs,
      timeMs,
      width,
      height,
      colours,
      leading.map((point, index) => point ?? [blobs[index].cx, blobs[index].cy]),
    );
    const frameArea = width * height;

    const tracks: LocalTrack[] = tracked.map((state) => {
      const z = this.baseline.zScore(state.speed);
      const score = scoreForZScore(z);
      const smoothed = this.tracker.smooth(state, score);
      this.baseline.observe(state.speed, state.frames);
      return {
        id: state.id,
        box: state.box,
        centroid: state.centroid,
        trail: state.trail,
        speedPxS: state.speed,
        directionDeg: state.direction,
        level: levelForZScore(z),
        score,
        scoreSmoothed: smoothed,
        levelStability: levelForZScore(Z_FROM_SCORE(smoothed)),
        frames: state.frames,
        areaPct: ((state.box[2] * state.box[3]) / frameArea) * 100,
        colour: state.colour,
      };
    });

    const frame: LocalFrame = {
      frameWidth: width,
      frameHeight: height,
      tracks,
      processMs: performance.now() - started,
      skipped: false,
      calibration: {
        samples: this.baseline.count,
        needed: ANALYSIS_MIN_SAMPLES,
        progress: this.baseline.progress,
      },
      changeLevel,
    };
    this.lastFrame = frame;
    return frame;
  }

  get last(): LocalFrame | null {
    return this.lastFrame;
  }
}

/** Inverse of `scoreForZScore`, used only to label the smoothed display score. */
function Z_FROM_SCORE(score: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, score));
  return 2.1 + Math.log(clamped / (1 - clamped));
}

/** Colour swatch for a measured dominant colour. */
export const COLOUR_HEX: Record<string, string> = {
  red: "#ff5d6c",
  orange: "#ff9f43",
  yellow: "#ffd93d",
  green: "#46dda6",
  blue: "#4f9dff",
  magenta: "#c084fc",
  grey: "#8a94a6",
};

/** Compass arrow for a measured heading. */
export function headingArrow(degrees: number | null): string {
  if (degrees === null) return "·";
  const arrows = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
  const normalised = ((degrees % 360) + 360) % 360;
  return arrows[Math.round(normalised / 45) % 8];
}
