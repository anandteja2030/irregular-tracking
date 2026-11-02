"""API runtime settings (environment-configurable, never exposed verbatim).

Only *display-safe* values ever leave the API; these paths stay server-side.
Tests monkeypatch `settings` attributes directly.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from config.config import PROJECT_ROOT


def _int_env(name: str, default: int, minimum: int = 1) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(raw))
    except ValueError:
        return default


@dataclass
class ApiSettings:
    upload_dir: Path = field(default_factory=lambda: Path(
        os.environ.get("NEURAL_UPLOAD_DIR",
                       str(PROJECT_ROOT / "output" / "uploads"))))
    max_upload_bytes: int = field(
        default_factory=lambda: _int_env("NEURAL_MAX_UPLOAD_MB", 256) * 1024 * 1024)
    upload_ttl_s: int = field(
        default_factory=lambda: _int_env("NEURAL_UPLOAD_TTL_HOURS", 24) * 3600)
    max_workers: int = field(
        default_factory=lambda: _int_env("NEURAL_JOB_WORKERS", 1))
    max_frames_cap: int = field(
        default_factory=lambda: _int_env("NEURAL_MAX_FRAMES_CAP", 5000))
    chunk_bytes: int = 1024 * 1024


settings = ApiSettings()


def upload_dir() -> Path:
    """Ensure and return the upload directory (created on first use)."""
    path = settings.upload_dir
    path.mkdir(parents=True, exist_ok=True)
    return path
