/** Editable settings draft and client-side validation.
 *
 * The API remains the authority: every save is validated again by the merged
 * pydantic document. These checks give immediate feedback and keep obvious
 * invalid values from ever reaching the process-local singleton.
 */
import type { EngineConfig } from "./types";

export interface SettingsDraft {
  video: {
    frame_width: string;
    frame_height: string;
    process_fps: string;
  };
  preprocess: {
    gaussian_blur_ksize: string;
    fill_small_blobs_px: string;
    morph_kernel_size: string;
  };
  tracking: {
    max_age: string;
    min_hits: string;
    iou_gate: string;
    position_gate_px: string;
    kalman_process_noise: string;
    kalman_measurement_noise: string;
  };
  calibration: {
    warmup_tracks: string;
    tracks_seconds: string;
    min_samples: string;
    direction_bin_deg: string;
  };
  anomaly: {
    contamination: string;
    per_object_window: string;
    scene_cluster_k_min: string;
    scene_cluster_k_max: string;
    threshold_suspicious: string;
    threshold_irregular: string;
    weight_rule: string;
    weight_ml: string;
    weight_scene: string;
  };
}

export type SettingsSection = keyof SettingsDraft;

function input(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function draftFromConfig(config: EngineConfig): SettingsDraft {
  return {
    video: {
      frame_width: input(config.video.frame_width),
      frame_height: input(config.video.frame_height),
      process_fps: input(config.video.process_fps),
    },
    preprocess: {
      gaussian_blur_ksize: input(config.preprocess.gaussian_blur_ksize),
      fill_small_blobs_px: input(config.preprocess.fill_small_blobs_px),
      morph_kernel_size: input(config.preprocess.morph_kernel_size),
    },
    tracking: {
      max_age: input(config.tracking.max_age),
      min_hits: input(config.tracking.min_hits),
      iou_gate: input(config.tracking.iou_gate),
      position_gate_px: input(config.tracking.position_gate_px),
      kalman_process_noise: input(config.tracking.kalman_process_noise),
      kalman_measurement_noise: input(config.tracking.kalman_measurement_noise),
    },
    calibration: {
      warmup_tracks: input(config.calibration.warmup_tracks),
      tracks_seconds: input(config.calibration.tracks_seconds),
      min_samples: input(config.calibration.min_samples),
      direction_bin_deg: input(config.calibration.direction_bin_deg),
    },
    anomaly: {
      contamination: input(config.anomaly.contamination),
      per_object_window: input(config.anomaly.per_object_window),
      scene_cluster_k_min: input(config.anomaly.scene_cluster_k_min),
      scene_cluster_k_max: input(config.anomaly.scene_cluster_k_max),
      threshold_suspicious: input(config.anomaly.threshold_suspicious),
      threshold_irregular: input(config.anomaly.threshold_irregular),
      weight_rule: input(config.anomaly.weights.rule),
      weight_ml: input(config.anomaly.weights.ml),
      weight_scene: input(config.anomaly.weights.scene),
    },
  };
}

interface NumberRule {
  min?: number;
  max?: number;
  integer?: boolean;
  exclusiveMin?: boolean;
  label: string;
}

function parse(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function validateNumber(
  errors: Record<string, string>,
  key: string,
  raw: string,
  rule: NumberRule,
) {
  if (raw.trim() === "") {
    errors[key] = `${rule.label} is required.`;
    return;
  }
  const value = parse(raw);
  if (value === null) {
    errors[key] = `${rule.label} must be a finite number.`;
    return;
  }
  if (rule.integer && !Number.isInteger(value)) {
    errors[key] = `${rule.label} must be a whole number.`;
    return;
  }
  if (rule.min !== undefined && (rule.exclusiveMin ? value <= rule.min : value < rule.min)) {
    errors[key] = `${rule.label} must be ${rule.exclusiveMin ? "greater than" : "at least"} ${rule.min}.`;
    return;
  }
  if (rule.max !== undefined && value > rule.max) {
    errors[key] = `${rule.label} must be at most ${rule.max}.`;
  }
}

export function validateDraft(draft: SettingsDraft): Record<string, string> {
  const errors: Record<string, string> = {};

  const width = draft.video.frame_width.trim();
  const height = draft.video.frame_height.trim();
  if (Boolean(width) !== Boolean(height)) {
    const message = "Frame width and height must be set together, or both left blank for source size.";
    if (!width) errors["video.frame_width"] = message;
    if (!height) errors["video.frame_height"] = message;
  } else {
    if (width) validateNumber(errors, "video.frame_width", width, { min: 64, max: 7680, integer: true, label: "Frame width" });
    if (height) validateNumber(errors, "video.frame_height", height, { min: 64, max: 4320, integer: true, label: "Frame height" });
  }
  if (draft.video.process_fps.trim() !== "") {
    validateNumber(errors, "video.process_fps", draft.video.process_fps, {
      min: 0,
      max: 240,
      exclusiveMin: true,
      label: "Process fps",
    });
  }

  validateNumber(errors, "preprocess.gaussian_blur_ksize", draft.preprocess.gaussian_blur_ksize, {
    min: 1,
    max: 31,
    integer: true,
    label: "Gaussian blur",
  });
  validateNumber(errors, "preprocess.morph_kernel_size", draft.preprocess.morph_kernel_size, {
    min: 1,
    max: 31,
    integer: true,
    label: "Morph kernel",
  });
  validateNumber(errors, "preprocess.fill_small_blobs_px", draft.preprocess.fill_small_blobs_px, {
    min: 0,
    max: 1_000_000,
    integer: true,
    label: "Fill small blobs",
  });
  const blur = parse(draft.preprocess.gaussian_blur_ksize);
  if (!errors["preprocess.gaussian_blur_ksize"] && blur !== null && blur % 2 === 0) {
    errors["preprocess.gaussian_blur_ksize"] = "Gaussian blur must be an odd OpenCV kernel size.";
  }
  const morph = parse(draft.preprocess.morph_kernel_size);
  if (!errors["preprocess.morph_kernel_size"] && morph !== null && morph % 2 === 0) {
    errors["preprocess.morph_kernel_size"] = "Morph kernel must be an odd OpenCV kernel size.";
  }

  validateNumber(errors, "tracking.max_age", draft.tracking.max_age, {
    min: 0,
    max: 10_000,
    integer: true,
    label: "Max age",
  });
  validateNumber(errors, "tracking.min_hits", draft.tracking.min_hits, {
    min: 1,
    max: 100,
    integer: true,
    label: "Min hits",
  });
  validateNumber(errors, "tracking.iou_gate", draft.tracking.iou_gate, {
    min: 0,
    max: 1,
    label: "IoU gate",
  });
  validateNumber(errors, "tracking.position_gate_px", draft.tracking.position_gate_px, {
    min: 0,
    max: 5000,
    exclusiveMin: true,
    label: "Position gate",
  });
  validateNumber(errors, "tracking.kalman_process_noise", draft.tracking.kalman_process_noise, {
    min: 0,
    max: 1000,
    exclusiveMin: true,
    label: "Process noise",
  });
  validateNumber(errors, "tracking.kalman_measurement_noise", draft.tracking.kalman_measurement_noise, {
    min: 0,
    max: 10_000,
    exclusiveMin: true,
    label: "Measurement noise",
  });

  validateNumber(errors, "calibration.warmup_tracks", draft.calibration.warmup_tracks, {
    min: 1,
    max: 100,
    integer: true,
    label: "Warm-up tracks",
  });
  validateNumber(errors, "calibration.tracks_seconds", draft.calibration.tracks_seconds, {
    min: 0,
    max: 3600,
    label: "Warm-up time",
  });
  validateNumber(errors, "calibration.min_samples", draft.calibration.min_samples, {
    min: 1,
    max: 100_000,
    integer: true,
    label: "Min samples",
  });
  validateNumber(errors, "calibration.direction_bin_deg", draft.calibration.direction_bin_deg, {
    min: 0,
    max: 180,
    exclusiveMin: true,
    label: "Direction bin",
  });

  validateNumber(errors, "anomaly.contamination", draft.anomaly.contamination, {
    min: 0,
    max: 0.5,
    exclusiveMin: true,
    label: "Contamination",
  });
  validateNumber(errors, "anomaly.per_object_window", draft.anomaly.per_object_window, {
    min: 5,
    max: 10_000,
    integer: true,
    label: "Per-object window",
  });
  validateNumber(errors, "anomaly.scene_cluster_k_min", draft.anomaly.scene_cluster_k_min, {
    min: 1,
    max: 50,
    integer: true,
    label: "Scene clusters min",
  });
  validateNumber(errors, "anomaly.scene_cluster_k_max", draft.anomaly.scene_cluster_k_max, {
    min: 1,
    max: 50,
    integer: true,
    label: "Scene clusters max",
  });
  validateNumber(errors, "anomaly.threshold_suspicious", draft.anomaly.threshold_suspicious, {
    min: 0,
    max: 1,
    label: "Suspicious threshold",
  });
  validateNumber(errors, "anomaly.threshold_irregular", draft.anomaly.threshold_irregular, {
    min: 0,
    max: 1,
    label: "Irregular threshold",
  });
  validateNumber(errors, "anomaly.weight_rule", draft.anomaly.weight_rule, {
    min: 0,
    max: 1,
    label: "Rule weight",
  });
  validateNumber(errors, "anomaly.weight_ml", draft.anomaly.weight_ml, {
    min: 0,
    max: 1,
    label: "ML weight",
  });
  validateNumber(errors, "anomaly.weight_scene", draft.anomaly.weight_scene, {
    min: 0,
    max: 1,
    label: "Scene weight",
  });

  const clusterMin = parse(draft.anomaly.scene_cluster_k_min);
  const clusterMax = parse(draft.anomaly.scene_cluster_k_max);
  if (
    !errors["anomaly.scene_cluster_k_min"] &&
    !errors["anomaly.scene_cluster_k_max"] &&
    clusterMin !== null &&
    clusterMax !== null &&
    clusterMax < clusterMin
  ) {
    errors["anomaly.scene_cluster_k_max"] = "Scene clusters max must be at least the minimum.";
  }

  const suspicious = parse(draft.anomaly.threshold_suspicious);
  const irregular = parse(draft.anomaly.threshold_irregular);
  if (
    !errors["anomaly.threshold_suspicious"] &&
    !errors["anomaly.threshold_irregular"] &&
    suspicious !== null &&
    irregular !== null &&
    suspicious >= irregular
  ) {
    errors["anomaly.threshold_suspicious"] = "Suspicious must be lower than Irregular.";
  }

  const weights = [
    parse(draft.anomaly.weight_rule),
    parse(draft.anomaly.weight_ml),
    parse(draft.anomaly.weight_scene),
  ];
  if (
    !errors["anomaly.weight_rule"] &&
    !errors["anomaly.weight_ml"] &&
    !errors["anomaly.weight_scene"] &&
    weights.every((value) => value !== null)
  ) {
    const total = weights.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    if (Math.abs(total - 1) > 0.001) {
      errors["anomaly.weight_rule"] = `Fusion weights must sum to 1.0 (currently ${total.toFixed(3)}).`;
    }
  }

  return errors;
}

function buildPatch(draft: SettingsDraft): Record<string, unknown> {
  return {
    video: {
      frame_width: parse(draft.video.frame_width),
      frame_height: parse(draft.video.frame_height),
      process_fps: parse(draft.video.process_fps),
    },
    preprocess: {
      gaussian_blur_ksize: parse(draft.preprocess.gaussian_blur_ksize),
      fill_small_blobs_px: parse(draft.preprocess.fill_small_blobs_px),
      morph_kernel_size: parse(draft.preprocess.morph_kernel_size),
    },
    tracking: {
      max_age: parse(draft.tracking.max_age),
      min_hits: parse(draft.tracking.min_hits),
      iou_gate: parse(draft.tracking.iou_gate),
      position_gate_px: parse(draft.tracking.position_gate_px),
      kalman_process_noise: parse(draft.tracking.kalman_process_noise),
      kalman_measurement_noise: parse(draft.tracking.kalman_measurement_noise),
    },
    calibration: {
      warmup_tracks: parse(draft.calibration.warmup_tracks),
      tracks_seconds: parse(draft.calibration.tracks_seconds),
      min_samples: parse(draft.calibration.min_samples),
      direction_bin_deg: parse(draft.calibration.direction_bin_deg),
    },
    anomaly: {
      contamination: parse(draft.anomaly.contamination),
      per_object_window: parse(draft.anomaly.per_object_window),
      scene_cluster_k_min: parse(draft.anomaly.scene_cluster_k_min),
      scene_cluster_k_max: parse(draft.anomaly.scene_cluster_k_max),
      threshold_suspicious: parse(draft.anomaly.threshold_suspicious),
      threshold_irregular: parse(draft.anomaly.threshold_irregular),
      weights: {
        rule: parse(draft.anomaly.weight_rule),
        ml: parse(draft.anomaly.weight_ml),
        scene: parse(draft.anomaly.weight_scene),
      },
    },
  };
}

function changedValues(
  next: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  return Object.keys(next).some(
    (key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]),
  );
}

/** Deep-partial patch containing only sections the user actually changed. */
export function patchFromDraft(
  draft: SettingsDraft,
  baseline: EngineConfig,
): Record<string, unknown> {
  const next = buildPatch(draft);
  const patch: Record<string, unknown> = {};
  const sections: SettingsSection[] = [
    "video",
    "preprocess",
    "tracking",
    "calibration",
    "anomaly",
  ];
  for (const section of sections) {
    const nextSection = next[section] as Record<string, unknown>;
    const currentSection = baseline[section] as unknown as Record<string, unknown>;
    if (changedValues(nextSection, currentSection)) {
      patch[section] = nextSection;
    }
  }
  return patch;
}

export function draftIsDirty(
  draft: SettingsDraft | null,
  baseline: EngineConfig | null,
): boolean {
  if (!draft || !baseline) return false;
  return Object.keys(patchFromDraft(draft, baseline)).length > 0;
}
