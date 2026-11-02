"""Health and runtime/system status."""
from __future__ import annotations

import platform
import sys
import time
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from fastapi import APIRouter, Request

from config.config import load_config
from src.api import API_VERSION
from src.api.probe import VIDEO_EXTENSIONS

router = APIRouter(tags=["system"])


def _pkg(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


@router.get("/health", summary="Liveness probe")
def health(request: Request) -> dict:
    """Always cheap: no disk I/O, no config reads beyond the app start time."""
    started = getattr(request.app.state, "started_monotonic", time.monotonic())
    return {
        "status": "ok",
        "version": API_VERSION,
        "uptime_s": round(time.monotonic() - started, 1),
    }


@router.get("/system", summary="Runtime, dependency and storage status")
def system_status() -> dict:
    """Measured environment facts only - no invented capability flags."""
    cfg = load_config()
    db_path = Path(cfg.paths.db)
    samples_dir = Path(cfg.paths.samples)
    output_dir = Path(cfg.paths.output)

    db_bytes = db_path.stat().st_size if db_path.is_file() else 0
    try:
        samples = sorted(p for p in samples_dir.iterdir()
                         if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS)
    except OSError:
        samples = []
    try:
        output_files = [p for p in output_dir.iterdir() if p.is_file()]
    except OSError:
        output_files = []

    return {
        "version": API_VERSION,
        "python": platform.python_version(),
        "python_implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "packages": {
            "fastapi": _pkg("fastapi"),
            "pydantic": _pkg("pydantic"),
            "numpy": _pkg("numpy"),
            "opencv-python": _pkg("opencv-python")
            or _pkg("opencv-python-headless"),
            "scikit-learn": _pkg("scikit-learn"),
            "pandas": _pkg("pandas"),
            "scipy": _pkg("scipy"),
        },
        "storage": {
            "db": {"path": str(db_path), "exists": db_path.is_file(),
                   "bytes": db_bytes},
            "samples": {"path": str(samples_dir), "exists": samples_dir.is_dir(),
                        "videos": len(samples),
                        "bytes": sum(p.stat().st_size for p in samples)},
            "output": {"path": str(output_dir), "exists": output_dir.is_dir(),
                       "files": len(output_files),
                       "bytes": sum(p.stat().st_size for p in output_files)},
        },
        "runtime": {"executable": sys.executable, "pid": __import__("os").getpid()},
    }
