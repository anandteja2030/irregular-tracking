"""Bundled sample discovery with measured video metadata.

Every number returned here comes from decoding the file with OpenCV. Bundled
samples are synthetic and are labelled as such, matching the disclosure the
Streamlit UI already shows.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from config.config import load_config
from src.api.probe import is_video_file, probe_video

router = APIRouter(tags=["sources"])


@router.get("/sources", summary="Bundled sample videos and their real metadata")
def list_sources() -> dict:
    samples_dir = Path(load_config().paths.samples)
    entries: list[dict] = []
    try:
        candidates = sorted(p for p in samples_dir.iterdir() if is_video_file(p))
    except OSError:
        candidates = []

    for path in candidates:
        probe = probe_video(path)
        entries.append({
            "name": path.name,
            "path": str(path),
            "bytes": path.stat().st_size,
            "kind": "sample",
            "synthetic": True,          # bundled footage is generated, always
            **probe,
        })

    valid = sum(1 for e in entries if e["valid"])
    return {
        "directory": str(samples_dir),
        "count": len(entries),
        "valid": valid,
        "invalid": len(entries) - valid,
        "sources": entries,
    }
