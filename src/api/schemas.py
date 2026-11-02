"""Pydantic v2 schemas mirroring `config.config`.

These models exist only to validate HTTP payloads. The engine keeps reading
the same mutable `Settings` singleton it always has, so every constraint here
is a *guard rail* in front of that singleton, never a second source of truth.

Design notes
------------
* ``extra="forbid"`` everywhere: a typo in a config key is a 422, not a
  silently ignored setting.
* Cross-field invariants (threshold ordering, weight normalisation, odd kernel
  sizes, paired frame dimensions, zone rectangles) are enforced with
  ``model_validator`` so a request either applies completely or not at all.
* ``PUT /config`` accepts a deep partial patch: the body is merged into the
  current configuration and the *merged document* is validated by
  ``SettingsModel``. That keeps one validation path for full and partial
  updates.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

_STRICT = ConfigDict(extra="forbid")


class VideoModel(BaseModel):
    model_config = _STRICT

    frame_width: int | None = Field(default=None, ge=64, le=7680)
    frame_height: int | None = Field(default=None, ge=64, le=4320)
    process_fps: float | None = Field(default=None, gt=0, le=240)

    @model_validator(mode="after")
    def _paired_dimensions(self) -> "VideoModel":
        if (self.frame_width is None) != (self.frame_height is None):
            raise ValueError(
                "frame_width and frame_height must be set together "
                "(both ints to resize, or both null to keep source size)")
        return self


class PreprocessModel(BaseModel):
    model_config = _STRICT

    gaussian_blur_ksize: int = Field(ge=1, le=31)
    fill_small_blobs_px: int = Field(ge=0, le=1_000_000)
    morph_kernel_size: int = Field(ge=1, le=31)

    @model_validator(mode="after")
    def _odd_kernels(self) -> "PreprocessModel":
        if self.gaussian_blur_ksize % 2 == 0:
            raise ValueError("gaussian_blur_ksize must be odd (OpenCV kernel)")
        if self.morph_kernel_size % 2 == 0:
            raise ValueError("morph_kernel_size must be odd (OpenCV kernel)")
        return self


class ColorModel(BaseModel):
    """HSV ranges use OpenCV's H in 0..179 and S/V in 0..255.

    A range with ``h_lo > h_hi`` is the red hue wrap-around and stays valid.
    """

    model_config = _STRICT

    ranges: dict[str, tuple[int, int, int, int, int, int]]
    min_area: float = Field(gt=0, le=10_000_000)
    max_area: float = Field(gt=0, le=100_000_000)
    min_contour_perimeter: float = Field(ge=0, le=100_000)

    @model_validator(mode="after")
    def _check_ranges(self) -> "ColorModel":
        if not self.ranges:
            raise ValueError("at least one colour range is required")
        if self.max_area <= self.min_area:
            raise ValueError("max_area must be greater than min_area")
        for name, rng in self.ranges.items():
            h_lo, s_lo, v_lo, h_hi, s_hi, v_hi = rng
            if not (0 <= h_lo <= 179 and 0 <= h_hi <= 179):
                raise ValueError(f"{name}: hue bounds must be within 0..179")
            for channel in (s_lo, s_hi, v_lo, v_hi):
                if not 0 <= channel <= 255:
                    raise ValueError(f"{name}: saturation/value bounds must be 0..255")
        return self


class ShapeModel(BaseModel):
    model_config = _STRICT

    epsilon_factor: float = Field(gt=0, le=0.5)
    min_rotation_lock_aspect: float = Field(ge=0, le=1)
    circularity_target: float = Field(gt=0, le=1)


class TrackingModel(BaseModel):
    model_config = _STRICT

    max_age: int = Field(ge=0, le=10_000)
    min_hits: int = Field(ge=1, le=100)
    iou_gate: float = Field(ge=0, le=1)
    position_gate_px: float = Field(gt=0, le=5000)
    kalman_process_noise: float = Field(gt=0, le=1000)
    kalman_measurement_noise: float = Field(gt=0, le=10_000)


class FeatureModel(BaseModel):
    model_config = _STRICT

    fps_default: float = Field(gt=0, le=240)
    traj_min_positions: int = Field(ge=2, le=500)
    speed_history_limit: int = Field(ge=8, le=10_000)


class CalibrationModel(BaseModel):
    model_config = _STRICT

    warmup_tracks: int = Field(ge=1, le=100)
    tracks_seconds: float = Field(ge=0, le=3600)
    min_samples: int = Field(ge=1, le=100_000)
    direction_bin_deg: float = Field(gt=0, le=180)


class RuleModel(BaseModel):
    model_config = _STRICT

    speed_pctl_fast: float = Field(ge=0, le=1)
    speed_pctl_slow: float = Field(ge=0, le=1)
    max_z: float = Field(gt=0, le=20)
    loiter_seconds: float = Field(ge=0, le=3600)
    direction_dev_deg: float = Field(gt=0, le=180)

    @model_validator(mode="after")
    def _percentile_order(self) -> "RuleModel":
        if self.speed_pctl_fast <= self.speed_pctl_slow:
            raise ValueError(
                "speed_pctl_fast must be greater than speed_pctl_slow")
        return self


class WeightsModel(BaseModel):
    """Fusion weights must stay a convex combination of the three streams."""

    model_config = _STRICT

    rule: float = Field(ge=0, le=1)
    ml: float = Field(ge=0, le=1)
    scene: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _normalised(self) -> "WeightsModel":
        total = self.rule + self.ml + self.scene
        if abs(total - 1.0) > 1e-3:
            raise ValueError(
                f"fusion weights must sum to 1.0 (got {total:.4f})")
        return self


class AnomalyModel(BaseModel):
    model_config = _STRICT

    contamination: float = Field(gt=0, le=0.5)
    per_object_window: int = Field(ge=5, le=10_000)
    scene_cluster_k_min: int = Field(ge=1, le=50)
    scene_cluster_k_max: int = Field(ge=1, le=50)
    rule: RuleModel
    weights: WeightsModel
    threshold_suspicious: float = Field(ge=0, le=1)
    threshold_irregular: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _thresholds(self) -> "AnomalyModel":
        if self.threshold_suspicious >= self.threshold_irregular:
            raise ValueError(
                "threshold_suspicious must be lower than threshold_irregular")
        if self.scene_cluster_k_max < self.scene_cluster_k_min:
            raise ValueError(
                "scene_cluster_k_max must be >= scene_cluster_k_min")
        return self


class ZoneItemModel(BaseModel):
    model_config = _STRICT

    name: str = Field(min_length=1, max_length=40)
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)
    x2: float = Field(ge=0, le=1)
    y2: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def _non_degenerate(self) -> "ZoneItemModel":
        if self.x1 == self.x2 or self.y1 == self.y2:
            raise ValueError(f"zone {self.name!r} has zero area")
        return self


class ZoneModel(BaseModel):
    model_config = _STRICT

    enabled: bool
    zones: list[ZoneItemModel] = Field(max_length=8)
    dwell_seconds: float = Field(ge=0, le=3600)


class DashboardModel(BaseModel):
    model_config = _STRICT

    page_title: str = Field(min_length=1, max_length=120)


class SettingsModel(BaseModel):
    """Full configuration document (the shape returned by GET /config).

    ``paths`` is deliberately absent: filesystem locations are read-only from
    the API's point of view, so a patch containing them fails validation.
    """

    model_config = _STRICT

    video: VideoModel
    preprocess: PreprocessModel
    color: ColorModel
    shape: ShapeModel
    tracking: TrackingModel
    features: FeatureModel
    calibration: CalibrationModel
    anomaly: AnomalyModel
    zone: ZoneModel
    dashboard: DashboardModel
