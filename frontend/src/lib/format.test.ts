import { describe, expect, it } from "vitest";
import {
  basename,
  formatBytes,
  formatDuration,
  formatResolution,
  formatUptime,
  truncateMiddle,
} from "./format";

describe("formatBytes", () => {
  it("scales through units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.00 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
  });

  it("keeps unknown values explicit", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });
});

describe("formatUptime", () => {
  it("picks the widest meaningful unit", () => {
    expect(formatUptime(12)).toBe("12s");
    expect(formatUptime(125)).toBe("2m 5s");
    expect(formatUptime(3_725)).toBe("1h 2m");
    expect(formatUptime(90_000)).toBe("1d 1h");
  });
});

describe("formatDuration", () => {
  it("formats sub-hour and beyond-hour durations", () => {
    expect(formatDuration(4.25)).toBe("4.3s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3_900)).toBe("1h 05m");
  });
});

describe("formatResolution", () => {
  it("refuses to invent missing dimensions", () => {
    expect(formatResolution(1280, 720)).toBe("1280×720");
    expect(formatResolution(null, 720)).toBe("—");
    expect(formatResolution(0, 0)).toBe("—");
  });
});

describe("path helpers", () => {
  it("shortens long middle segments", () => {
    const long = "/workspace/chats/3f59254/project/data/app_data.db";
    expect(truncateMiddle(long, 20)).toContain("…");
    expect(truncateMiddle("short", 20)).toBe("short");
  });

  it("takes the basename on either separator", () => {
    expect(basename("/a/b/clip.mp4")).toBe("clip.mp4");
    expect(basename("C:\\clips\\clip.mp4")).toBe("clip.mp4");
  });
});
