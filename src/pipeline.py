"""Phase 6 - full pipeline orchestration.

`TrackingPipeline` is the single integration point of the whole system:

  VideoSource -> Preprocessor -> HSV colour/contour detection
              -> TrackManager (Kalman + Hungarian)
              -> TrackFeatureExtractor (speed/direction/accel)
              -> ScenarioCalibrator (self-calibrated scene baseline)
              -> RuleEngine + IsolationForest + scene-relative scoring
              -> AnomalyFusion (Normal / Suspicious / Irregular)
              -> ResultLogger (SQLite) + visualization

While the video runs it also answers "explain THIS object in words".
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from config.config import load_config
from src.analysis.calibration import ScenarioCalibrator
from src.analysis.features import TrackFeatureExtractor, TrajectoryFeatures
from src.anomaly.fusion import AnomalyFusion, explain
from src.ui.visualization import (draw_calibration_badge, draw_tracked_objects,
                                  draw_zones)
from src.tracking.track_manager import TrackManager, TrackedObject
from src.video.detection import ContourDetector, HSVColorDetector, ShapeDetector
from src.video.preprocessing import Preprocessor


@dataclass
class FrameResult:
    """Everything produced for one frame."""
    frame_idx: int
    annotated_bgr: np.ndarray
    entries: list[dict]           # one dict per tracked object (viz/logging)
    n_detections: int
    calibrated: bool


class TrackingPipeline:
    """Stateful streaming pipeline; instantiate once per video/session."""

    def __init__(self, session: str = "session0", logger=None, detector=None,
                 motion_augment: bool = False,
                 use_object_detector: bool = False):
        cfg = load_config()
        self.cfg = cfg
        self.preprocessor = Preprocessor(cfg.preprocess)
        self.color_detector = HSVColorDetector(cfg.color)
        self.shape_detector = ShapeDetector(cfg.shape)
        self.contour_detector = ContourDetector(
            color_cfg=cfg.color, shape_cfg=cfg.shape,
            color_detector=self.color_detector, shape_detector=self.shape_detector)
        self.tracker = TrackManager(cfg.tracking)
        self.feature_extractor = TrackFeatureExtractor(cfg.features)
        self.calibrator = ScenarioCalibrator(cfg.calibration)
        if detector is None:                     # shared detector + rules engine
            fusion = AnomalyFusion()
        else:
            fusion = AnomalyFusion(detector=detector)
        self.fusion = fusion
        self.logger = logger                     # optional ResultLogger
        self.n_frames = 0
        self._zone_dwell: dict[int, float] = {}  # track_id -> seconds inside a zone
        self._frame_size: tuple[int, int] = (1, 1)   # (w, h) of the current frame
        # Live-only: add a background-subtraction mask so real-world moving
        # objects are found even when they are dark, grey or low-saturation.
        # File runs keep the calibrated colour path unchanged.
        self.motion_augment = bool(motion_augment)
        # Real-camera runs use the pretrained COCO detector so tracks carry a
        # real class (car / truck / person) instead of a colour-shape guess.
        # Synthetic samples and the live colour/motion path keep the tracker's
        # original candidate source.
        self.object_detector = None
        if use_object_detector and cfg.detector.enabled:
            from src.video.object_detector import get_object_detector
            candidate = get_object_detector()
            self.object_detector = candidate if candidate.available else None
        self._bg = (cv2.createBackgroundSubtractorMOG2(
            history=30, varThreshold=25, detectShadows=False)
            if self.motion_augment else None)
        self._bg_frames = 0

    # ---------------------------------------------------------------- facet
    def process_frame(self, bgr: np.ndarray, frame_idx: int, fps: float) -> FrameResult:
        self.n_frames += 1
        h, w = bgr.shape[:2]
        self._frame_size = (w, h)

        if self.object_detector is not None:
            # Real objects only: the detector names each one, so no colour blob
            # from the background can become a track.
            dets = self.object_detector.detect(bgr, frame_idx)
        else:
            pm = self.preprocessor.process(bgr)
            hsv = pm.hsv
            # Candidate mask: any configured colour range OR high-saturation
            # pixels (colour-agnostic fallback), cleaned with morphology.
            color_mask = self.color_detector.mask_any(hsv)
            s, v = hsv[:, :, 1], hsv[:, :, 2]
            sat_mask = ((s > 60) & (v > 60)).astype(np.uint8) * 255
            combined = np.bitwise_or(color_mask, sat_mask)
            if self.motion_augment:
                combined = np.bitwise_or(combined, self._motion_mask(pm.gray))
            combined = self.preprocessor.clean_mask(combined)
            dets = self.contour_detector.detect(frame_idx, hsv, combined)
        tracked = self.tracker.update(dets, frame_idx)
        # A track is only reported after the tracker's debounce, so one-frame
        # false detections never reach the results, the tables or the report.
        tracked = [o for o in tracked if o.confirmed]
        scene_stats = self.calibrator.stats()

        entries = [self._observe_and_classify(o, fps, scene_stats, frame_idx)
                   for o in tracked]
        # calibration learns AFTER scoring this frame's objects
        self.calibrator.update([e["snapshot"] for e in entries], frame_idx, fps)

        annotated = draw_zones(bgr, self.cfg.zone.zones
                               if self.cfg.zone.enabled else [])
        annotated = draw_tracked_objects(annotated, entries)
        annotated = draw_calibration_badge(annotated, scene_stats.ready,
                                           scene_stats.n_samples)
        if self.logger is not None:
            for e in entries:
                self.logger.log_event(frame_idx, e)
        return FrameResult(frame_idx=frame_idx, annotated_bgr=annotated,
                           entries=entries, n_detections=len(dets),
                           calibrated=scene_stats.ready)

    # ---------------------------------------------------- motion support
    def _motion_mask(self, gray: np.ndarray) -> np.ndarray:
        """Moving-foreground mask from a per-pixel background model.

        MOG2 adapts each pixel separately, so a vacated position stops being
        reported after a couple of frames instead of leaving a ghost track,
        while a slow object is not absorbed into the background as quickly as a
        single running average would be. The first frame only seeds the model,
        so a captured stream never invents motion on its opening frame. The
        mask is unioned with the colour mask, so saturated objects are still
        detected while stationary and unsaturated objects while moving.
        """
        if self._bg is None:
            return np.zeros_like(gray)
        self._bg_frames += 1
        mask = self._bg.apply(gray)
        if self._bg_frames <= 1:
            return np.zeros_like(gray)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        return cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    # ------------------------------------------------------- zone state
    def _zone_state(self, track_id: int, centroid: tuple[float, float],
                    fps: float) -> tuple[str, float] | None:
        """Accumulate dwell time inside a configured zone; None when outside.

        Coordinates are stored relative (0..1) so zones scale with any input
        resolution. Dwell resets to 0 as soon as the object leaves.
        """
        zc = self.cfg.zone
        if not zc.enabled or not zc.zones:
            self._zone_dwell.pop(track_id, None)
            return None
        fw, fh = self._frame_size
        hit = None
        for z in zc.zones:
            x1, y1 = float(z["x1"]) * fw, float(z["y1"]) * fh
            x2, y2 = float(z["x2"]) * fw, float(z["y2"]) * fh
            if min(x1, x2) <= centroid[0] <= max(x1, x2) and \
                    min(y1, y2) <= centroid[1] <= max(y1, y2):
                hit = str(z.get("name", "zone"))
                break
        if hit is None:
            self._zone_dwell.pop(track_id, None)
            return None
        dwell = self._zone_dwell.get(track_id, 0.0) + 1.0 / max(fps, 1e-6)
        self._zone_dwell[track_id] = dwell
        return (hit, dwell)

    # ------------------------------------------------------------------
    def _observe_and_classify(self, obj: TrackedObject, fps: float,
                              scene_stats, frame_idx: int) -> dict:
        snap = self.feature_extractor.observe(obj, fps)
        traj_stats = TrajectoryFeatures.from_track(list(obj.trajectory), fps,
                                                   obj.track_id)
        zone_hit = self._zone_state(obj.track_id, obj.centroid, fps)
        signals = self.fusion.rule_engine.evaluate(snap, scene_stats,
                                                   traj=traj_stats,
                                                   zone=zone_hit)
        ml_score, ml_why = self.fusion.detector.score(snap)
        scene_score, scene_why = self.calibrator.scene_relative(snap, scene_stats)
        verdict = self.fusion.fuse(signals, ml_score, scene_score)
        explain(verdict, extra_signal_texts=[ml_why, scene_why])
        # detector stream learns normal patterns (after scoring)
        self.fusion.detector.observe(snap)

        return {
            "frame_idx": frame_idx,
            "track_id": obj.track_id,
            "misses": int(getattr(obj, "misses", 0)),
            "confirmed": bool(getattr(obj, "confirmed", True)),
            "centroid": obj.centroid,
            "bbox_wh": obj.box_wh,
            "color": obj.color,
            "shape": obj.shape,
            "class_name": obj.class_name,
            "speed_px_s": round(snap.speed_px_s, 1),
            "direction_deg": (None if snap.direction_deg is None
                              else round(snap.direction_deg, 1)),
            "trajectory": list(obj.trajectory),
            "level": verdict.level,
            "fused_score": verdict.fused_score,
            "rule_score": verdict.signal_score,
            "ml_score": verdict.ml_score,
            "scene_score": verdict.scene_score,
            "why": verdict.why,
            # structured evidence for the investigation UI / DB
            "rules": [{"rule": s.rule, "severity": round(s.severity, 3),
                       "description": s.description} for s in signals],
            "ml_note": ml_why,
            "scene_note": scene_why,
            "in_zone": (zone_hit[0] if zone_hit else None),
            "zone_dwell_s": (round(zone_hit[1], 2) if zone_hit else 0.0),
            "snapshot": snap,
        }

    # ------------------------------------------------------------- helpers
    def summarize_tracks(self, fps: float) -> list[dict]:
        """Aggregate summaries for all tracks seen so far (used at EOF & UI)."""
        out = []
        stats = self.calibrator.stats()
        for t in self.tracker.all_time_tracks():
            traj_stats = TrajectoryFeatures.from_track(
                list(t.positions), fps, t.id, min_positions=2)
            if traj_stats is None:
                continue
            out.append({
                "track_id": t.id, "color": t.color, "shape": t.shape,
                "class_name": t.class_name,
                "stats": traj_stats, "first_frame": t.first_frame,
                "last_frame": t.last_frame, "scene_ready": stats.ready,
            })
            if self.logger is not None:
                self.logger.log_track_summary(traj_stats, t.color, t.shape,
                                              t.first_frame, t.last_frame)
        return out
