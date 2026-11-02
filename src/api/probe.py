"""Real media probing for the sources endpoint.

Metadata is measured with OpenCV (fps, frame count, decoded first-frame size),
never guessed from filenames. Results are cached per (path, mtime, size) so the
endpoint stays cheap to poll while still reflecting a regenerated sample.
"""
from __future__ import annotations

import threading
from pathlib import Path

import cv2

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".webm"}

_CACHE: dict[str, tuple[tuple[int, int], dict]] = {}
_LOCK = threading.Lock()


def _probe(path: Path) -> dict:
    cap = None
    try:
        cap = cv2.VideoCapture(str(path))
        if not cap.isOpened():
            return {"valid": False, "error": "OpenCV could not open this file"}
        ok, frame = cap.read()
        if not ok or frame is None:
            return {"valid": False, "error": "opened but no decodable frame"}
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        height, width = frame.shape[:2]
        duration = round(frames / fps, 2) if (fps > 1 and frames > 0) else None
        return {
            "valid": True,
            "error": None,
            "fps": round(fps, 3) if fps > 0 else None,
            "frames": frames if frames > 0 else None,
            "width": int(width),
            "height": int(height),
            "duration_s": duration,
        }
    except (cv2.error, OSError, ValueError) as exc:
        return {"valid": False, "error": str(exc)}
    finally:
        if cap is not None:
            cap.release()


def probe_video(path: Path | str) -> dict:
    """Measure one video file; never raises for unreadable input."""
    path = Path(path)
    try:
        stat = path.stat()
    except OSError as exc:
        return {"valid": False, "error": f"cannot stat file: {exc}"}
    key = str(path.resolve())
    signature = (stat.st_mtime_ns, stat.st_size)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is not None and cached[0] == signature:
            return dict(cached[1])
    result = _probe(path)
    with _LOCK:
        _CACHE[key] = (signature, dict(result))
    return result


def is_video_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
