import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  isActiveState,
  isTerminalState,
  jobSocketUrl,
  percentText,
  progressText,
  stageLabel,
  stepPreviewFrame,
  validateVideoFile,
} from "./studio";

const MB = 1024 * 1024;

describe("intake validation", () => {
  it("accepts a decodable-looking mp4", () => {
    expect(validateVideoFile({ name: "anomaly_clip.mp4", size: 2 * MB, type: "video/mp4" })).toEqual({
      ok: true,
      error: null,
    });
  });

  it("accepts a clip whose browser gives no content type", () => {
    expect(validateVideoFile({ name: "clip.mkv", size: MB, type: "" }).ok).toBe(true);
  });

  it("rejects unsupported extensions with the accepted list", () => {
    const result = validateVideoFile({ name: "notes.txt", size: 10, type: "text/plain" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(".mp4");
  });

  it("rejects a file with no extension", () => {
    expect(validateVideoFile({ name: "capture", size: 10 }).error).toContain("no extension");
  });

  it("rejects an empty file", () => {
    expect(validateVideoFile({ name: "empty.mp4", size: 0 }).error).toContain("empty");
  });

  it("rejects a clip above the API's default upload cap", () => {
    const result = validateVideoFile({ name: "huge.mp4", size: MAX_UPLOAD_BYTES + 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("256 MB");
  });

  it("rejects a non-video content type", () => {
    expect(validateVideoFile({ name: "clip.mp4", size: MB, type: "application/pdf" }).ok).toBe(false);
  });
});

describe("job presentation", () => {
  it("labels known stages and humanises unknown ones", () => {
    expect(stageLabel("persisting")).toBe("Persisting session");
    expect(stageLabel("warming_up")).toBe("warming up");
    expect(stageLabel(null)).toBe("—");
  });

  it("never invents a total frame count", () => {
    const unmeasured = { progress: { processed: 84, total: null, percent: null, measured: false } };
    expect(progressText(unmeasured)).toBe("84 frames · total unreported");
    expect(percentText(unmeasured)).toBe("—");

    const measured = { progress: { processed: 50, total: 200, percent: 25, measured: true } };
    expect(progressText(measured)).toBe("50 / 200 frames");
    expect(percentText(measured)).toBe("25.0%");
  });

  it("classifies active and terminal states", () => {
    expect(isActiveState("running")).toBe(true);
    expect(isActiveState("cancellation_requested")).toBe(true);
    expect(isActiveState("completed")).toBe(false);
    expect(isTerminalState("cancelled")).toBe(true);
    expect(isTerminalState("queued")).toBe(false);
  });
});

describe("socket and preview helpers", () => {
  it("derives a ws url from the relative api base", () => {
    expect(jobSocketUrl("job_abc", "/api/v1", "http://127.0.0.1:3000")).toBe(
      "ws://127.0.0.1:3000/api/v1/jobs/job_abc/ws",
    );
  });

  it("upgrades to wss for an https origin", () => {
    expect(jobSocketUrl("job_abc", "/api/v1", "https://console.example.dev")).toBe(
      "wss://console.example.dev/api/v1/jobs/job_abc/ws",
    );
  });

  it("honours an absolute api base and trailing slashes", () => {
    expect(jobSocketUrl("job_abc", "http://api.internal:8000/api/v1/", "https://x.example")).toBe(
      "ws://api.internal:8000/api/v1/jobs/job_abc/ws",
    );
  });

  it("clamps preview navigation to the retained frame set", () => {
    expect(stepPreviewFrame(5, 0, -1)).toBe(0);
    expect(stepPreviewFrame(5, 4, 1)).toBe(4);
    expect(stepPreviewFrame(5, 2, 1)).toBe(3);
    expect(stepPreviewFrame(0, 0, 1)).toBe(0);
  });
});
