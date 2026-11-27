import { describe, expect, it } from "vitest";
import {
  LIVE_CAPTURE_MAX_WIDTH,
  appearanceColour,
  calibrationPercent,
  cameraErrorMessage,
  captureSize,
  engineLabel,
  headingArrow,
  levelCounts,
  levelShort,
  liveElapsed,
  liveObjectName,
  overlayBox,
  resolveProfile,
} from "./live";
import type { LiveTrack } from "./types";

function track(overrides: Partial<LiveTrack> = {}): LiveTrack {
  return {
    track_id: 0,
    box: [10, 20, 30, 40],
    centroid: [25, 40],
    trail: [
      [10, 20],
      [25, 40],
    ],
    color: "red",
    shape: "circle",
    level: "Normal",
    scores: { fused: 0.1, rule: 0, ml: 0.2, scene: 0.1 },
    speed_px_s: 12,
    direction_deg: 90,
    zone: null,
    why: "",
    rules: [],
    ...overrides,
  };
}

describe("live overlay helpers", () => {
  it("maps a measured heading to a compass arrow", () => {
    expect(headingArrow(0)).toBe("→");
    expect(headingArrow(90)).toBe("↓");
    expect(headingArrow(180)).toBe("←");
    expect(headingArrow(-90)).toBe("↑");
    expect(headingArrow(359)).toBe("→");
    expect(headingArrow(null)).toBe("·");
  });

  it("shortens levels for the overlay chip", () => {
    expect(levelShort("Normal")).toBe("NRM");
    expect(levelShort("Suspicious")).toBe("SUS");
    expect(levelShort("Irregular")).toBe("IRR");
  });

  it("resolves a reported colour name to a swatch, keeping unknown names muted", () => {
    expect(appearanceColour("RED")).toBe("#ff5d6c");
    expect(appearanceColour("blue")).toBe("#4f9dff");
    expect(appearanceColour("teal")).toBe("var(--chart-track)");
    expect(appearanceColour(null)).toBe("var(--chart-track)");
  });
});

describe("captureSize", () => {
  it("keeps a small frame unchanged", () => {
    expect(captureSize(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("downscales wide frames to the capture width", () => {
    expect(captureSize(1920, 1080)).toEqual({
      width: LIVE_CAPTURE_MAX_WIDTH,
      height: 720,
    });
  });

  it("returns zeroes before the video reports dimensions", () => {
    expect(captureSize(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it("never produces an odd width or height", () => {
    const size = captureSize(1001, 777);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });
});

describe("overlayBox", () => {
  it("converts a pixel box to percentages", () => {
    expect(overlayBox({ box: [50, 100, 200, 50] }, 400, 200)).toEqual({
      left: 12.5,
      top: 50,
      width: 50,
      height: 25,
    });
  });

  it("clamps boxes that leave the frame", () => {
    expect(overlayBox({ box: [-20, -10, 500, 400] }, 400, 200)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });

  it("returns zero geometry without a source size", () => {
    expect(overlayBox({ box: [1, 2, 3, 4] }, 0, 0)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("levelCounts", () => {
  it("counts each level and ignores nothing", () => {
    const counts = levelCounts([
      track(),
      track({ level: "Suspicious" }),
      track({ level: "Irregular" }),
      track({ level: "Irregular" }),
    ]);
    expect(counts).toEqual({ Normal: 1, Suspicious: 1, Irregular: 2 });
  });
});

describe("liveElapsed", () => {
  it("formats whole seconds as mm:ss", () => {
    expect(liveElapsed(0)).toBe("00:00");
    expect(liveElapsed(75)).toBe("01:15");
    expect(liveElapsed(3599)).toBe("59:59");
  });

  it("never shows a negative or NaN clock", () => {
    expect(liveElapsed(-10)).toBe("00:00");
    expect(liveElapsed(Number.NaN)).toBe("00:00");
  });
});

describe("cameraErrorMessage", () => {
  it("explains denied permission", () => {
    expect(cameraErrorMessage({ name: "NotAllowedError" })).toContain("blocked");
  });

  it("explains a missing camera", () => {
    expect(cameraErrorMessage({ name: "NotFoundError" })).toContain("No usable camera");
  });

  it("falls back to the browser message", () => {
    expect(cameraErrorMessage(new Error("boom"))).toContain("boom");
  });
});

describe("live capture adaptivity helpers", () => {
  it("steps capture detail down as the measured round trip grows", () => {
    expect(resolveProfile("auto", 120).key).toBe("high");
    expect(resolveProfile("auto", 400).key).toBe("balanced");
    expect(resolveProfile("auto", 900).key).toBe("fast");
    expect(resolveProfile("auto", 400).profile.maxWidth).toBeLessThan(
      resolveProfile("auto", 120).profile.maxWidth,
    );
  });

  it("keeps an explicit capture quality regardless of latency", () => {
    expect(resolveProfile("high", 1200).key).toBe("high");
    expect(resolveProfile("fast", 50).key).toBe("fast");
  });

  it("clamps baseline progress to a whole percentage", () => {
    expect(calibrationPercent({ progress: 0.456 })).toBe(46);
    expect(calibrationPercent({ samples: 15, needed: 30 })).toBe(50);
    expect(calibrationPercent({ progress: 2 })).toBe(100);
    expect(calibrationPercent(null)).toBe(0);
  });

  it("names the engine that actually scored a frame", () => {
    expect(engineLabel("objects")).toContain("object");
    expect(engineLabel("motion")).toContain("motion");
    expect(engineLabel(undefined)).toContain("unknown");
  });

  it("downscales the capture to the profile width, never up", () => {
    expect(captureSize(1920, 1080, 640).width).toBe(640);
    expect(captureSize(320, 240, 960).width).toBe(320);
  });
});

describe("live object naming", () => {
  it("prefers the detector's real class name over a colour description", () => {
    expect(liveObjectName({ class_name: "person", color: "red", shape: "rectangle" })).toBe(
      "person",
    );
    expect(liveObjectName({ class_name: null, color: "red", shape: "circle" })).toBe(
      "red circle",
    );
    expect(liveObjectName({ color: null, shape: null })).toBe("unclassified");
  });
});
