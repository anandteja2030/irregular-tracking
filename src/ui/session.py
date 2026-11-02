"""Backward-compatible re-export of the shared analysis service.

The implementation moved to `src.core.analysis_service` so the API no longer
imports the UI package. Everything that used to live here is re-exported from
that module by reference (not copied), so existing imports keep working and
class/exception identity is preserved:

    from src.ui.session import SessionResult, run_analysis   # still fine

New code should import from `src.core.analysis_service` directly. This module
is a shim only: add no logic here.
"""
from __future__ import annotations

from src.core.analysis_service import (
    MAX_PREVIEW_FRAMES,
    OBS_COLS,
    PREVIEW_MAX_W,
    PREVIEW_STRIDE,
    TRACK_COLS,
    UPLOAD_MAX_AGE_S,
    AnalysisCancelled,
    PreviewFrame,
    SessionResult,
    cleanup_stale_uploads,
    delete_session,
    friendly_open_error,
    is_synthetic_source,
    load_history,
    load_session_data,
    run_analysis,
    save_session_to_db,
    upload_path,
)

__all__ = [
    "MAX_PREVIEW_FRAMES",
    "OBS_COLS",
    "PREVIEW_MAX_W",
    "PREVIEW_STRIDE",
    "TRACK_COLS",
    "UPLOAD_MAX_AGE_S",
    "AnalysisCancelled",
    "PreviewFrame",
    "SessionResult",
    "cleanup_stale_uploads",
    "delete_session",
    "friendly_open_error",
    "is_synthetic_source",
    "load_history",
    "load_session_data",
    "run_analysis",
    "save_session_to_db",
    "upload_path",
]
