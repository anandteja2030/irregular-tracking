"""Pretrained object detection (YOLOv4-tiny) for real-camera footage.

The original engine finds objects by thresholding saturated colour and naming
them by contour shape ("red polygon", "blue rectangle"). That works for the
bundled synthetic samples but cannot name a real car or truck, and turns every
saturated patch of a real scene into a track.

This module adds a small, pretrained COCO detector that runs on the raw BGR
frame through OpenCV's DNN module, so no extra Python dependency is needed. It
reports what the object actually is (`car`, `truck`, `bus`, `person`, ...)
together with a confidence, and the pipeline only tracks those classes. When
the model files are not present the detector reports itself unavailable and the
pipeline falls back to the colour/contour engine.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from config.config import DetectorConfig, load_config
from src.video.detection import ObjectDetection

# BGR colours used only to draw a class badge on annotated frames.
_CLASS_COLOURS = {
    "person": (255, 200, 60),
    "bicycle": (60, 220, 220),
    "car": (80, 220, 120),
    "motorcycle": (220, 120, 255),
    "bus": (60, 160, 255),
    "truck": (255, 160, 60),
}


class YoloObjectDetector:
    """YOLOv4-tiny (COCO) detector run through `cv2.dnn`.

    Loading is explicit and non-fatal: if the weights/config/names are missing,
    `available` stays False and every call returns no detections, so a run never
    dies because a model file is absent.
    """

    def __init__(self, config: DetectorConfig | None = None):
        self.cfg = config or load_config().detector
        self._net: cv2.dnn.Net | None = None
        self._out_layers: list[str] = []
        self._names: list[str] = []
        self.error: str | None = None
        self._load()

    # -------------------------------------------------------------- loading
    def _path(self, name: str) -> Path:
        return Path(self.cfg.model_dir) / name

    def _load(self) -> None:
        weights = self._path(self.cfg.weights)
        cfg_file = self._path(self.cfg.config_file)
        names = self._path(self.cfg.names_file)
        missing = [str(p) for p in (weights, cfg_file, names) if not p.is_file()]
        if missing:
            self.error = "model files missing: " + ", ".join(missing)
            return
        try:
            net = cv2.dnn.readNetFromDarknet(str(cfg_file), str(weights))
            net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
            layers = net.getUnconnectedOutLayers().flatten().tolist()
            self._out_layers = [net.getLayerNames()[i - 1] for i in layers]
            self._names = [line.strip() for line in names.read_text().splitlines()
                           if line.strip()]
            self._net = net
        except (cv2.error, OSError, ValueError) as exc:
            self.error = f"model could not be loaded: {exc}"
            self._net = None

    @property
    def available(self) -> bool:
        return self._net is not None

    # -------------------------------------------------------------- facade
    def detect(self, frame_bgr: np.ndarray, frame_idx: int = 0
               ) -> list[ObjectDetection]:
        """Objects in one frame, filtered to the configured real classes."""
        if self._net is None:
            return []
        h, w = frame_bgr.shape[:2]
        size = int(self.cfg.input_size)
        blob = cv2.dnn.blobFromImage(frame_bgr, 1 / 255.0, (size, size),
                                     swapRB=True, crop=False)
        self._net.setInput(blob)
        outputs = self._net.forward(self._out_layers)

        allowed = {name.lower(): name for name in self.cfg.classes}
        boxes: list[list[int]] = []
        confidences: list[float] = []
        class_names: list[str] = []
        for output in outputs:
            for row in output:
                scores = row[5:]
                class_id = int(np.argmax(scores))
                confidence = float(scores[class_id])
                if confidence < self.cfg.confidence:
                    continue
                if class_id >= len(self._names):
                    continue
                name = self._names[class_id].lower()
                if name not in allowed:
                    continue
                cx, cy = float(row[0]) * w, float(row[1]) * h
                bw, bh = float(row[2]) * w, float(row[3]) * h
                if bw <= 0 or bh <= 0:
                    continue
                # Tiny boxes are noise; a box covering most of the frame is a
                # mis-fire, not one object.
                if bw < self.cfg.min_box_px or bh < self.cfg.min_box_px:
                    continue
                if bw * bh > self.cfg.max_box_fraction * w * h:
                    continue
                x = int(round(cx - bw / 2))
                y = int(round(cy - bh / 2))
                boxes.append([max(0, x), max(0, y), int(round(bw)), int(round(bh))])
                confidences.append(confidence)
                class_names.append(name)

        if not boxes:
            return []
        keep = cv2.dnn.NMSBoxes(boxes, confidences, self.cfg.confidence,
                                self.cfg.nms_iou)
        indices = np.array(keep).flatten().tolist() if len(keep) else []
        detections: list[ObjectDetection] = []
        for i in indices[: self.cfg.max_detections]:
            x, y, bw, bh = boxes[i]
            x = min(x, max(0, w - 1))
            y = min(y, max(0, h - 1))
            bw = max(1, min(bw, w - x))
            bh = max(1, min(bh, h - y))
            detections.append(ObjectDetection(
                frame_idx=frame_idx,
                bbox=(x, y, bw, bh),
                centroid=(x + bw / 2.0, y + bh / 2.0),
                area=float(bw * bh),
                color=None,
                shape="rectangle",
                aspect=bw / max(bh, 1),
                contour=None,
                class_name=class_names[i],
                confidence=round(confidences[i], 3),
            ))
        detections.sort(key=lambda d: (d.bbox[1], d.bbox[0]))
        return detections


_CACHE: dict[tuple, YoloObjectDetector] = {}


def get_object_detector() -> YoloObjectDetector:
    """Shared detector for the process (weights load once, not per session)."""
    cfg = load_config().detector
    key = (str(cfg.model_dir), cfg.weights, cfg.config_file, cfg.names_file)
    detector = _CACHE.get(key)
    if detector is None:
        detector = YoloObjectDetector(cfg)
        _CACHE[key] = detector
    return detector


def class_colour(class_name: str | None) -> tuple[int, int, int]:
    return _CLASS_COLOURS.get((class_name or "").lower(), (200, 200, 200))
