import { describe, expect, it } from "vitest";
import { CONFIRMED_FRAMES, LocalVisionEngine } from "./browserVision";

/**
 * Tracking quality on a scene that looks like a camera view: a textured static
 * background with sensor noise and one object moving across it. The failure
 * this guards against is the one users see — dozens of identities for one
 * object, with trails jumping over the whole frame.
 */
const W = 320;
const H = 180;

function noise(seed: number): number {
  // Deterministic pseudo-noise so the test does not flake.
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function frame(timeMs: number, objectX: number, withNoise = true): ImageData {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      // Textured wall: two-tone stripes, so the background is not flat.
      const base = (x >> 5) % 2 === (y >> 4) % 2 ? 92 : 104;
      const jitter = withNoise ? Math.round((noise(x * 31 + y * 17 + Math.round(timeMs)) - 0.5) * 6) : 0;
      data[i] = base + jitter;
      data[i + 1] = base + jitter;
      data[i + 2] = base + jitter + 6;
      data[i + 3] = 255;
    }
  }
  // One 30x40 object moving to the right.
  const left = Math.round(objectX);
  for (let y = 70; y < 110; y += 1) {
    for (let x = left; x < left + 30; x += 1) {
      if (x < 0 || x >= W) continue;
      const i = (y * W + x) * 4;
      // Bright object: clearly separated in luminance from the wall, which is
      // what a real person or vehicle looks like against a background.
      data[i] = 245;
      data[i + 1] = 240;
      data[i + 2] = 235;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data, colorSpace: "srgb" } as ImageData;
}

describe("tracking quality", () => {
  it("keeps one identity for one moving object and reports no phantom tracks", () => {
    const engine = new LocalVisionEngine();
    const seen = new Set<number>();
    let confirmedTotal = 0;
    let peakPerFrame = 0;
    const speeds: number[] = [];

    for (let index = 0; index < 60; index += 1) {
      const result = engine.analyse(frame(index * 100, 20 + index * 2.5), index * 100);
      const confirmed = result.tracks.filter((track) => track.frames >= CONFIRMED_FRAMES);
      confirmedTotal += confirmed.length;
      peakPerFrame = Math.max(
        peakPerFrame,
        result.tracks.filter((track) => track.frames >= CONFIRMED_FRAMES).length,
      );
      for (const track of confirmed) {
        seen.add(track.id);
        speeds.push(track.speedPxS);
      }
    }

    // One object, so at most a couple of identities across the whole clip
    // (the first frames cannot be confirmed yet).
    expect(seen.size).toBeLessThanOrEqual(2);
    expect(peakPerFrame).toBeLessThanOrEqual(1);
    expect(confirmedTotal).toBeGreaterThan(30);

    const settled = speeds.slice(10);
    const average = settled.reduce((sum, value) => sum + value, 0) / settled.length;
    // 2.5 px per 100 ms is 25 px/s; the measurement may smooth early frames.
    expect(average).toBeGreaterThan(15);
    expect(average).toBeLessThan(40);
  });

  it("does not create tracks from a still, noisy frame", () => {
    const engine = new LocalVisionEngine();
    let confirmed = 0;
    for (let index = 0; index < 30; index += 1) {
      const result = engine.analyse(frame(index * 100, 150), index * 100);
      confirmed += result.tracks.filter((track) => track.frames >= CONFIRMED_FRAMES).length;
    }
    // The object itself is static, so no confirmed object may be invented.
    expect(confirmed).toBe(0);
  });
});
