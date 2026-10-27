"""Phase 6 - OpenCV visualization.

Draws tracked objects and their classification onto the frame:

  * bounding boxes + track id + semantic labels (colour, shape)
  * speed/direction readout
  * trajectory polyline
  * level-tagged annotation colour (Normal = green, Suspicious = amber,
    Irregular = red) matching the fused verdict
  * small HUD strip (frame index, counts, calibration readiness)

Design note: the annotated frame must remain same size as the input BGR frame
so writers/displays can treat them interchangeably.
"""
from __future__ import annotations

import math
from collections import Counter

import cv2
import numpy as np

LEVEL_COLORS = {
    "Normal": (60, 200, 90),        # BGR green
    "Suspicious": (40, 160, 255),   # BGR amber
    "Irregular": (60, 40, 245),     # BGR red
}
FONT = cv2.FONT_HERSHEY_SIMPLEX


def draw_tracked_objects(frame_bgr: np.ndarray, entries: list[dict]) -> np.ndarray:
    """entries: one dict per tracked object this frame with keys
    track_id, centroid(level-tagged), bbox_wh, level, color, shape, why,
    speed_px_s, direction_deg, trajectory.  Returns an annotated copy."""
    out = frame_bgr.copy()
    h, w = out.shape[:2]

    for e in entries:
        level = e.get("level", "Normal")
        box = LEVEL_COLORS.get(level)
        cx, cy = e["centroid"]
        bw, bh = e["bbox_wh"]
        x1, y1 = int(max(0, cx - bw / 2)), int(max(0, cy - bh / 2))
        x2, y2 = int(min(w - 1, cx + bw / 2)), int(min(h - 1, cy + bh / 2))
        cv2.rectangle(out, (x1, y1), (x2, y2), box, 2)

        traj = e.get("trajectory") or []
        if len(traj) >= 2:
            pts = np.array([(int(px), int(py)) for _, px, py in traj], np.int32)
            cv2.polylines(out, [pts], False, box, 1)

        label = (f"#{e['track_id']} {e.get('color') or '?'} {e.get('shape', '?')}"
                 f" | {e.get('speed_px_s', 0):.0f} px/s")
        level_text = e.get("level", "")

        cv2.putText(out, label, (x1, max(12, y1 - 6)), FONT, 0.4, box, 1, cv2.LINE_AA)
        cv2.putText(out, level_text, (x1, y2 + 14), FONT, 0.42, box, 1, cv2.LINE_AA)
        why = e.get("why") or ""
        if why and level != "Normal":
            cv2.putText(out, why[:64], (x1, min(h - 4, y2 + 28)), FONT, 0.34,
                        box, 1, cv2.LINE_AA)

        cv2.circle(out, (int(cx), int(cy)), 2, box, -1)

    # HUD
    counts = Counter(e.get("level", "Normal") for e in entries)
    frame_idx_hud = entries[-1].get("frame_idx", 0) if entries else 0
    hud = (f"f={frame_idx_hud}  "
           f"tracks={len(entries)}  "
           f"N/S/I={counts.get('Normal', 0)}/{counts.get('Suspicious', 0)}"
           f"/{counts.get('Irregular', 0)}")
    cv2.rectangle(out, (4, 2), (min(w - 1, 4 + 10 * len(hud)), 22), (20, 20, 20), -1)
    cv2.putText(out, hud, (8, 17), FONT, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def draw_calibration_badge(frame_bgr: np.ndarray, ready: bool, n_samples: int) -> np.ndarray:
    chip = "CALIBRATED" if ready else f"CALIBRATING... n={n_samples}"
    color = LEVEL_COLORS["Normal"] if ready else LEVEL_COLORS["Suspicious"]
    out = frame_bgr.copy()
    h, w = out.shape[:2]
    chip_pos = (w - 12 - 11 * len(chip), h - 18)
    cv2.putText(out, chip, chip_pos, FONT, 0.45, color, 1, cv2.LINE_AA)
    return out


def contour_debug_frame(preprocess_result, detections: list) -> np.ndarray:
    """Side-by-side debug: HSV mask view raw + detected boxes. Useful live UI."""
    mask = np.zeros(preprocess_result.gray.shape, np.uint8)
    out = cv2.cvtColor(preprocess_result.gray, cv2.COLOR_GRAY2BGR)
    for d in detections:
        x, y, w, h = d.bbox
        cv2.rectangle(out, (x, y), (x + w, y + h), LEVEL_COLORS["Suspicious"], 1)
    return np.hstack([cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR), out])
