import { describe, expect, it } from "vitest";
import type { EngineConfig } from "./types";
import {
  draftFromConfig,
  draftIsDirty,
  patchFromDraft,
  validateDraft,
} from "./settings";

const CONFIG: EngineConfig = {
  video: { frame_width: 640, frame_height: 480, process_fps: 15 },
  preprocess: { gaussian_blur_ksize: 5, fill_small_blobs_px: 40, morph_kernel_size: 3 },
  shape: { epsilon_factor: 0.02, min_rotation_lock_aspect: 0.7, circularity_target: 0.4 },
  tracking: {
    max_age: 30,
    min_hits: 3,
    iou_gate: 0.3,
    position_gate_px: 80,
    kalman_process_noise: 0.03,
    kalman_measurement_noise: 0.5,
  },
  calibration: { warmup_tracks: 3, tracks_seconds: 20, min_samples: 20, direction_bin_deg: 45 },
  anomaly: {
    contamination: 0.05,
    per_object_window: 50,
    scene_cluster_k_min: 2,
    scene_cluster_k_max: 6,
    threshold_suspicious: 0.55,
    threshold_irregular: 0.75,
    weights: { rule: 0.5, ml: 0.3, scene: 0.2 },
    rule: {
      speed_pctl_fast: 0.9,
      speed_pctl_slow: 0.1,
      max_z: 3,
      loiter_seconds: 4,
      direction_dev_deg: 60,
    },
  },
  zone: { enabled: false, zones: [], dwell_seconds: 3 },
  dashboard: { page_title: "NEURAL COMMAND" },
  paths: { samples: "data/samples", output: "data/output", db: "data/db.sqlite", read_only: true },
};

describe("settings draft", () => {
  it("round-trips a configuration into editable strings", () => {
    const draft = draftFromConfig(CONFIG);
    expect(draft.video.frame_width).toBe("640");
    expect(draft.anomaly.weight_scene).toBe("0.2");
    expect(validateDraft(draft)).toEqual({});
    expect(draftIsDirty(draft, CONFIG)).toBe(false);
  });

  it("keeps nullable source dimensions blank instead of inventing them", () => {
    const draft = draftFromConfig({
      ...CONFIG,
      video: { frame_width: null, frame_height: null, process_fps: null },
    });
    expect(draft.video.frame_width).toBe("");
    expect(draft.video.process_fps).toBe("");
    expect(validateDraft(draft)).toEqual({});
  });

  it("sends only the changed section as a deep patch", () => {
    const draft = draftFromConfig(CONFIG);
    draft.tracking.max_age = "45";
    draft.anomaly.weight_rule = "0.4";
    draft.anomaly.weight_ml = "0.4";

    expect(validateDraft(draft)).toEqual({});
    const patch = patchFromDraft(draft, CONFIG);
    expect(Object.keys(patch)).toEqual(["tracking", "anomaly"]);
    expect(patch.tracking).toMatchObject({ max_age: 45 });
    expect(patch.anomaly).toMatchObject({ weights: { rule: 0.4, ml: 0.4, scene: 0.2 } });
    expect(draftIsDirty(draft, CONFIG)).toBe(true);
  });

  it("requires frame width and height together", () => {
    const draft = draftFromConfig(CONFIG);
    draft.video.frame_width = "";
    expect(validateDraft(draft)["video.frame_width"]).toMatch(/together/);
  });

  it("rejects even OpenCV kernels and non-finite values", () => {
    const draft = draftFromConfig(CONFIG);
    draft.preprocess.gaussian_blur_ksize = "4";
    draft.preprocess.morph_kernel_size = "nope";
    const errors = validateDraft(draft);
    expect(errors["preprocess.gaussian_blur_ksize"]).toMatch(/odd/);
    expect(errors["preprocess.morph_kernel_size"]).toMatch(/finite/);
  });

  it("enforces threshold ordering, cluster ordering and fusion weight sum", () => {
    const draft = draftFromConfig(CONFIG);
    draft.anomaly.threshold_suspicious = "0.8";
    draft.anomaly.scene_cluster_k_min = "8";
    draft.anomaly.scene_cluster_k_max = "4";
    draft.anomaly.weight_rule = "0.7";
    const errors = validateDraft(draft);
    expect(errors["anomaly.threshold_suspicious"]).toMatch(/lower/);
    expect(errors["anomaly.scene_cluster_k_max"]).toMatch(/at least/);
    expect(errors["anomaly.weight_rule"]).toMatch(/sum/);
  });

  it("rejects zero fps and out-of-range tracking values", () => {
    const draft = draftFromConfig(CONFIG);
    draft.video.process_fps = "0";
    draft.tracking.position_gate_px = "0";
    const errors = validateDraft(draft);
    expect(errors["video.process_fps"]).toMatch(/greater than 0/);
    expect(errors["tracking.position_gate_px"]).toMatch(/greater than 0/);
  });
});
