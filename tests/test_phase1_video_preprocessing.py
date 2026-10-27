"""Phase 1 unit tests: video input + preprocessing."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.video.video_input import VideoSource, make_callable_source
from src.video.preprocessing import Preprocessor
from config.config import PreprocessConfig, VideoConfig


# ---------------------------------------------------------------- fixtures
def _solid_frame(w=320, h=240, color=(40, 40, 40)):
    return np.full((h, w, 3), color, dtype=np.uint8)


# ---------------------------------------------------------------- VideoSource
def test_callable_source_yields_frames_with_index_and_fps():
    cfg = VideoConfig(frame_width=None, frame_height=None)   # keep source size
    frames = [_solid_frame(), _solid_frame(), _solid_frame()]
    with VideoSource(src=make_callable_source(frames), config=cfg) as vs:
        got = list(vs)
    assert len(got) == 3
    assert [f.index for f in got] == [0, 1, 2]
    assert got[0].bgr.shape == (240, 320, 3)
    assert vs.fps > 0


def test_loop_mode_replays_callable_source():
    frames = [_solid_frame(), _solid_frame()]
    with VideoSource(src=make_callable_source(frames), loop=True) as vs:
        got = [f for _, f in zip(range(5), vs)]
    assert len(got) == 5
    assert [f.index for f in got] == [0, 1, 2, 3, 4]


def test_frame_resize_is_applied():
    cfg = VideoConfig(frame_width=160, frame_height=120)
    with VideoSource(src=make_callable_source([_solid_frame(640, 480)]), config=cfg) as vs:
        f = next(iter(vs))
    assert f.bgr.shape == (120, 160, 3)


def test_missing_file_raises_ioerror():
    with pytest.raises(IOError):
        VideoSource(src="/nonexistent/path/video.mp4")._open()


def test_unsupported_source_type_raises():
    with pytest.raises(TypeError):
        VideoSource(src=object())._open()


# ---------------------------------------------------------------- Preprocessor
def test_process_produces_hsv_gray_lab_same_shape():
    frame = _solid_frame()
    res = Preprocessor().process(frame)
    assert res.bgr.shape == frame.shape
    assert res.hsv.shape == frame.shape
    assert res.gray.shape == frame.shape[:2]
    assert res.blurred_lab.shape == frame.shape
    # HSV hue of pure gray stays 0
    assert res.hsv[0, 0, 0] == 0


def test_blur_reduces_single_pixel_noise():
    frame = _solid_frame()
    frame[100, 100] = (255, 255, 255)      # one bright pixel
    res = Preprocessor().process(frame)
    assert int(res.bgr[100, 100].max()) < 100         # heavily smoothed
    assert abs(int(res.bgr[110, 110].mean()) - 40) <= 2  # background untouched


def test_clean_mask_removes_small_blobs():
    mask = np.zeros((200, 200), dtype=np.uint8)
    mask[50:56, 50:56] = 255     # 6x6 = 36 px blob -> below 150 px threshold
    mask[100:125, 100:120] = 255  # ~25x20 = 500 px blob -> kept
    cleaned = Preprocessor().clean_mask(mask)
    assert cleaned[110, 110] == 255
    assert cleaned[52, 52] == 0


def test_clean_mask_uses_config_threshold():
    prec = Preprocessor(PreprocessConfig(fill_small_blobs_px=10))
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[40:44, 40:44] = 255          # 4x4 = 16 px >= 10 -> kept now
    assert prec.clean_mask(mask)[41, 41] == 255


def test_process_is_pure_does_not_mutate_input():
    frame = _solid_frame()
    before = frame.copy()
    Preprocessor().process(frame)
    assert np.array_equal(frame, before)
