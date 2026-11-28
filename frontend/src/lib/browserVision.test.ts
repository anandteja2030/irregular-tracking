import { describe, expect, it } from "vitest";
import {
  BackgroundModel,
  LocalVisionEngine,
  SceneBaseline,
  Tracker,
  detectBlobs,
  dilate,
  dominantColour,
  headingArrow,
  levelForZScore,
  scoreForZScore,
  toGray,
  type Blob,
} from "./browserVision";

const W = 64;
const H = 48;

function frame(paint: (x: number, y: number) => [number, number, number]): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = paint(x, y);
      const p = (y * W + x) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 255;
    }
  }
  return { data, width: W, height: H } as ImageData;
}

const dark = frame(() => [0, 0, 0]);
const withSquare = (left: number, colour: [number, number, number] = [255, 255, 255]) =>
  frame((x, y) => (x >= left && x < left + 8 && y >= 16 && y < 24 ? colour : [0, 0, 0]));

describe("toGray", () => {
  it("weights channels into one luminance plane", () => {
    const gray = toGray(dark.data, W, H);
    expect(gray).toHaveLength(W * H);
    expect(gray[0]).toBe(0);
    const white = toGray(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
    expect(white[0]).toBe(255);
  });
});

describe("BackgroundModel", () => {
  it("discards the first frame and reports no motion for a still scene", () => {
    const model = new BackgroundModel();
    expect(model.update(toGray(dark.data, W, H)).skipped).toBe(true);
    const still = model.update(toGray(dark.data, W, H));
    expect(still.skipped).toBe(false);
    expect(still.mask.some((value) => value === 1)).toBe(false);
  });

  it("flags pixels that changed", () => {
    const model = new BackgroundModel();
    model.update(toGray(dark.data, W, H));
    const moved = model.update(toGray(withSquare(20).data, W, H));
    expect(moved.skipped).toBe(false);
    expect(moved.mask.filter((value) => value === 1).length).toBeGreaterThan(30);
  });

  it("treats a global brightness jump as illumination, not motion", () => {
    const model = new BackgroundModel();
    model.update(toGray(dark.data, W, H));
    const flash = model.update(toGray(frame(() => [200, 200, 200]).data, W, H));
    expect(flash.skipped).toBe(true);
    expect(flash.mask.every((value) => value === 0)).toBe(true);
  });
});

describe("detectBlobs", () => {
  it("returns one region per connected group, ignoring specks", () => {
    const mask = new Uint8Array(W * H);
    for (let y = 10; y < 20; y += 1) {
      for (let x = 10; x < 20; x += 1) mask[y * W + x] = 1;
    }
    mask[40 * W + 50] = 1; // single isolated pixel, below the minimum area
    const blobs = detectBlobs(mask, W, H, 20);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({ x: 10, y: 10, width: 10, height: 10, area: 100 });
    expect(blobs[0].cx).toBeCloseTo(14.5, 5);
    expect(blobs[0].cy).toBeCloseTo(14.5, 5);
  });

  it("dilation closes a one-pixel gap so one object is one blob", () => {
    const mask = new Uint8Array(W * H);
    for (let y = 10; y < 16; y += 1) {
      for (let x = 10; x < 20; x += 1) mask[y * W + x] = x === 14 ? 0 : 1;
    }
    expect(detectBlobs(mask, W, H, 5)).toHaveLength(2);
    expect(detectBlobs(dilate(mask, W, H), W, H, 5)).toHaveLength(1);
  });
});

describe("dominantColour", () => {
  it("names the colour of the pixels under a blob", () => {
    const red = withSquare(20, [255, 0, 0]);
    const mask = new Uint8Array(W * H);
    for (let y = 16; y < 24; y += 1) for (let x = 20; x < 28; x += 1) mask[y * W + x] = 1;
    const blob = detectBlobs(mask, W, H, 5)[0];
    expect(dominantColour(red.data, mask, W, blob)).toBe("red");
  });
});

describe("Tracker", () => {
  const blobAt = (cx: number): Blob => ({
    x: cx - 4,
    y: 16,
    width: 8,
    height: 8,
    cx,
    cy: 20,
    area: 64,
  });

  it("keeps one identity for a moving object and measures its speed", () => {
    const tracker = new Tracker();
    const first = tracker.update([blobAt(10)], 0, W, H);
    expect(first).toHaveLength(1);
    const id = first[0].id;
    const second = tracker.update([blobAt(14)], 100, W, H);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(id);
    expect(second[0].speed).toBeGreaterThan(20);
    expect(second[0].velocity[0]).toBeGreaterThan(0);
    expect(second[0].trail).toHaveLength(2);
  });

  it("starts a new identity for an object far from the prediction", () => {
    const tracker = new Tracker();
    const first = tracker.update([blobAt(10)], 0, W, H);
    const second = tracker.update([blobAt(60)], 100, W, H);
    expect(second[0].id).not.toBe(first[0].id);
  });

  it("drops a track after the miss budget", () => {
    const tracker = new Tracker(2);
    tracker.update([blobAt(10)], 0, W, H);
    for (let i = 1; i <= 3; i += 1) tracker.update([], i * 100, W, H);
    expect(tracker.count).toBe(0);
  });
});

describe("scoring", () => {
  it("maps z-scores onto the three verdict levels", () => {
    expect(levelForZScore(0)).toBe("Normal");
    expect(levelForZScore(2)).toBe("Suspicious");
    expect(levelForZScore(3.4)).toBe("Irregular");
  });

  it("produces a monotonic 0–1 score", () => {
    expect(scoreForZScore(-5)).toBeLessThan(0.05);
    expect(scoreForZScore(2.1)).toBeCloseTo(0.5, 5);
    expect(scoreForZScore(10)).toBeGreaterThan(0.99);
  });

  it("only learns a baseline from confirmed movement", () => {
    const baseline = new SceneBaseline(4);
    baseline.observe(40, 1); // one frame old: not settled yet
    expect(baseline.count).toBe(0);
    baseline.observe(40, 5);
    expect(baseline.count).toBe(1);
    expect(baseline.progress).toBeCloseTo(0.25, 5);
  });
});

describe("LocalVisionEngine", () => {
  it("measures the true speed of a moving object despite the motion trail", () => {
    // A 4 px move every 100 ms is 40 px/s; the trail behind the square is what
    // makes a plain centroid under-read it, so this is the accuracy check.
    const engine = new LocalVisionEngine({ minArea: 10 });
    let last = engine.analyse(withSquare(4), 0);
    expect(last.skipped).toBe(true); // first frame seeds the background
    for (let i = 1; i < 12; i += 1) {
      last = engine.analyse(withSquare(4 + i * 4), i * 100);
      expect(last.tracks).toHaveLength(1);
    }
    const track = last.tracks[0];
    expect(track.frames).toBeGreaterThanOrEqual(10);
    expect(track.speedPxS).toBeGreaterThan(34);
    expect(track.speedPxS).toBeLessThan(46);
    expect(track.directionDeg).not.toBeNull();
    expect(Math.abs(track.directionDeg ?? 0)).toBeLessThan(5);
    expect(track.box[2]).toBeGreaterThan(0);
    expect(track.areaPct).toBeGreaterThan(0);
    expect(last.processMs).toBeGreaterThanOrEqual(0);
    expect(["Normal", "Suspicious", "Irregular"]).toContain(track.level);
  });

  it("reports baseline progress and resets cleanly", () => {
    const engine = new LocalVisionEngine({ minArea: 10 });
    engine.analyse(withSquare(8), 0);
    const frame = engine.analyse(withSquare(16), 100);
    expect(frame.calibration.needed).toBeGreaterThan(0);
    expect(frame.calibration.progress).toBeGreaterThanOrEqual(0);
    engine.reset();
    expect(engine.last).toBeNull();
  });
});

describe("headingArrow", () => {
  it("maps measured headings to compass arrows", () => {
    expect(headingArrow(0)).toBe("→");
    expect(headingArrow(90)).toBe("↓");
    expect(headingArrow(null)).toBe("·");
  });
});
