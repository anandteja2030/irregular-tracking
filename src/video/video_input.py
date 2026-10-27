"""Phase 1 - video input.

`VideoSource` wraps cv2.VideoCapture behind a small iterator-style API so the
rest of the pipeline is agnostic to whether frames come from a webcam, a file,
or a synthetic test source. It also makes frame-fetching testable by allowing
any callable that yields BGR np arrays to be injected (dependency-injection
pattern used across the project).
"""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Callable

import cv2
import numpy as np

from config.config import VideoConfig, load_config


@dataclass
class VideoFrame:
    """One processed frame handed to the rest of the pipeline."""
    index: int           # 0-based counter of frames consumed from this source
    bgr: np.ndarray      # original-resolution BGR image
    fps: float           # reported or overridden fps; FeatureConfig uses this


class VideoSource:
    """Uniform webcam / video-file / callable frame source.

    Usage
    -----
    >>> with VideoSource(src=0) as vs:           # webcam
    ...     for frame in vs: ...                 # VideoFrame objects

    >>> vs = VideoSource(src="clip.mp4")         # file path
    >>> vs = VideoSource(src=callable_iter)      # injected frame iterator (tests)
    """

    def __init__(self, src, config: VideoConfig | None = None,
                 loop: bool = False, name: str = "source"):
        self.src = src
        self.cfg = config or load_config().video
        self.loop = loop
        self.name = name
        self._iter: Iterator[np.ndarray] | None = None
        self._cap: cv2.VideoCapture | None = None
        self.frame_index = -1
        self._fps = float(load_config().features.fps_default)

    # ------------------------------------------------------------------ open
    def _open(self) -> None:
        if callable(self.src):
            self._iter = iter(self.src())
            self._fps = self._override_or(self._fps)
            return
        if isinstance(self.src, (int,)) or isinstance(self.src, str):
            self._cap = cv2.VideoCapture(self.src)
            if not self._cap.isOpened():
                raise IOError(f"Could not open video source: {self.src!r}")
            # Webcam (int) often reports 0 fps; default to a sane value.
            reported = self._cap.get(cv2.CAP_PROP_FPS)
            fallback = load_config().features.fps_default
            self._fps = self._override_or(
                reported if reported and reported > 1 else fallback
            )
            return
        raise TypeError(f"Unsupported source type: {type(self.src)!r}")

    def _override_or(self, fps: float) -> float:
        """Allow config.process_fps to override the underlying source fps."""
        if self.cfg.process_fps is None:
            return fps
        return self.cfg.process_fps

    # ------------------------------------------------------------- iteration
    def __enter__(self) -> "VideoSource":
        self._open()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __iter__(self) -> Iterator[VideoFrame]:
        if self._cap is None and self._iter is None:
            self._open()
        while True:
            frame = self._read_one()
            if frame is None:
                if self.loop and self._cap is not None:
                    self._cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                return
            self.frame_index += 1
            # Respect configured rescale (None -> keep source resolution).
            tw, th = self.cfg.frame_width, self.cfg.frame_height
            if tw is not None and th is not None:
                frame = cv2.resize(
                    frame, (tw, th),
                    interpolation=cv2.INTER_AREA if (tw * th) < (frame.shape[0] * frame.shape[1]) else cv2.INTER_NEAREST,
                )
            yield VideoFrame(index=self.frame_index, bgr=frame, fps=self._fps)

    def _read_one(self) -> np.ndarray | None:
        if self._cap is not None:
            ok, frame = self._cap.read()
            return frame if ok else None
        try:
            return next(self._iter)          # type: ignore[arg-type]
        except StopIteration:
            # Callable sources: re-create the iterator when looping is enabled.
            if self.loop and callable(self.src):
                self._iter = iter(self.src())
                try:
                    return next(self._iter)
                except StopIteration:
                    return None
            return None

    def frame_index_reset(self) -> None:
        self.frame_index = -1

    # -------------------------------------------------------------- metadata
    @property
    def fps(self) -> float:
        return self._fps

    def frame_count(self) -> int | None:
        if self._cap is None:
            return None
        n = int(self._cap.get(cv2.CAP_PROP_FRAME_COUNT))
        return n if n > 0 else None

    def source_kind(self) -> str:
        if callable(self.src):
            return "callable"
        if isinstance(self.src, int):
            return "webcam"
        return "file"

    def close(self) -> None:
        if self._cap is not None and self._cap.isOpened():
            self._cap.release()
        self._cap = None
        self._iter = None


def make_callable_source(frames: list[np.ndarray]) -> Callable[[], Iterator[np.ndarray]]:
    """Helper for tests: wrap a fixed list of frames into an infinite callable."""
    def _gen():
        yield from frames
    return _gen
