"""Central configuration for the Intelligent Irregular Object Tracking project.

All tunables live here so experiments happen by editing one file.

Written in plain Python (no YAML dependency) and loaded ONCE via `load_config()`
which returns the global SETTINGS singleton. Modules import SETTINGS lazily
(inside functions) so tests can override values on the singleton.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
SAMPLES_DIR = PROJECT_ROOT / "samples"
OUTPUT_DIR = PROJECT_ROOT / "output"
DB_PATH = DATA_DIR / "app_data.db"


@dataclass
class VideoConfig:
    """VideoInput settings."""
    # None means auto-fit to the source; else resize every BGR frame to (w, h).
    frame_width: int | None = 1280
    frame_height: int | None = 720
    process_fps: float | None = None      # if None, read source fps; else override


@dataclass
class PreprocessConfig:
    gaussian_blur_ksize: int = 5
    fill_small_blobs_px: int = 150          # remove specks below this area after mask
    morph_kernel_size: int = 3


@dataclass
class ColorDetectionConfig:
    """HSV color segmentation ranges."""
    # Each entry: {color_name: (h_lo, s_lo, v_lo, h_hi, s_hi, v_hi)}
    ranges: dict = field(default_factory=lambda: {
        "red":    (165,  90,  60,  10, 255, 255),   # wraps around 0
        "orange": (10,  120,  60,  28, 255, 255),
        "yellow": (29,  120,  60,  45, 255, 255),
        "green":  (46,   90,  60,  80, 255, 255),
        "magenta":(130,  90,  60, 160, 255, 255),
        "blue":   (81,   90,  60, 130, 255, 255),
    })
    min_area: float = 120.0        # reject blobs smaller than this (px^2)
    max_area: float = 120000.0     # reject blobs larger than this
    min_contour_perimeter: float = 30.0


@dataclass
class ShapeDetectionConfig:
    epsilon_factor: float = 0.02        # approxPolyDP epsilon = factor * perimeter
    min_rotation_lock_aspect: float = 0.15   # |1-aspect| beyond this => non-square
    circularity_target: float = 0.80         # 4*pi*A/P^2 >= this => circle


@dataclass
class TrackingConfig:
    """Kalman tracker + Hungarian matcher."""
    max_age: int = 12            # frames to keep an unmatched track alive
    min_hits: int = 3            # consecutive detections before track is confirmed
    iou_gate: float = 0.15       # Hungarian validity gate on IoU
    position_gate_px: float = 120.0
    kalman_process_noise: float = 2.0
    kalman_measurement_noise: float = 12.0


@dataclass
class FeatureConfig:
    fps_default: float = 30.0       # used when a source has no fps metadata
    traj_min_positions: int = 5     # minimum positions before trajectory stats
    speed_history_limit: int = 120


@dataclass
class CalibrationConfig:
    warmup_tracks: int = 2          # distinct tracks needed before calibration
    tracks_seconds: float = 12.0    # OR observation seconds before auto-calibration
    min_samples: int = 30           # minimum movement observations to calibrate
    direction_bin_deg: int = 30     # rose histogram resolution


@dataclass
class MLAnomalyConfig:
    contamination: float = 0.08
    per_object_window: int = 40     # rolling window of own features for IsolationForest
    scene_cluster_k_min: int = 2
    scene_cluster_k_max: int = 4


@dataclass
class RuleConfig:
    speed_pctl_fast: float = 0.90    # > p90 of calibrated speed distribution => fast rule
    speed_pctl_slow: float = 0.10
    max_z: float = 3.0               # z-score cap per rule evidence
    loiter_seconds: float = 2.0
    direction_dev_deg: float = 45.0  # past this angle off dominant flow => direction rule


@dataclass
class AnomalyConfig(MLAnomalyConfig):
    rule: RuleConfig = field(default_factory=RuleConfig)
    weights: dict = field(default_factory=lambda: {"rule": 0.45, "ml": 0.35, "scene": 0.20})
    threshold_suspicious: float = 0.35
    threshold_irregular: float = 0.65


@dataclass
class DashboardConfig:
    page_title: str = "Intelligent Irregular Object Tracking"
    sidebar_options: dict = field(default_factory=lambda: {
        "live": "Live camera/video",
        "upload": "Upload video file",
        "export": "CSV export / DB inspection",
    })


@dataclass
class AppPaths:
    samples: Path = SAMPLES_DIR
    output: Path = OUTPUT_DIR
    db: Path = DB_PATH


@dataclass
class Settings:
    video: VideoConfig = field(default_factory=VideoConfig)
    preprocess: PreprocessConfig = field(default_factory=PreprocessConfig)
    color: ColorDetectionConfig = field(default_factory=ColorDetectionConfig)
    shape: ShapeDetectionConfig = field(default_factory=ShapeDetectionConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    features: FeatureConfig = field(default_factory=FeatureConfig)
    calibration: CalibrationConfig = field(default_factory=CalibrationConfig)
    anomaly: AnomalyConfig = field(default_factory=AnomalyConfig)
    dashboard: DashboardConfig = field(default_factory=DashboardConfig)
    paths: AppPaths = field(default_factory=AppPaths)


# Global singleton; tests import and mutate in place.
SETTINGS = Settings()

# Ensure writable data/output dirs exist.
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)


def load_config() -> Settings:
    """Return the global SETTINGS singleton (idempotent)."""
    return SETTINGS
