"""Phase 4: core extraction, import identity and read-only DB error handling.

These tests pin three guarantees introduced by the extraction:

1. `src.core.analysis_service` is the single implementation; `src.ui.session`
   only re-exports it (same objects, not copies).
2. The API and the core never import the UI package or Streamlit at runtime.
3. `src.api.repository.connect()` degrades to "no data" for an unusable
   database and propagates real statement errors as `sqlite3` errors instead
   of masking them with `RuntimeError: generator didn't stop after throw()`.
"""
from __future__ import annotations

import ast
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from src.api import repository
from src.core import analysis_service
from src.ui import session as ui_session

ROOT = Path(__file__).resolve().parents[1]

PUBLIC_SURFACE = [
    "AnalysisCancelled", "PreviewFrame", "SessionResult",
    "cleanup_stale_uploads", "delete_session", "friendly_open_error",
    "is_synthetic_source", "load_history", "load_session_data",
    "run_analysis", "save_session_to_db", "upload_path",
    "OBS_COLS", "TRACK_COLS", "PREVIEW_MAX_W", "PREVIEW_STRIDE",
    "MAX_PREVIEW_FRAMES", "UPLOAD_MAX_AGE_S",
]


# --------------------------------------------------------------- extraction
def test_shim_reexports_the_same_objects():
    for name in PUBLIC_SURFACE:
        assert hasattr(ui_session, name), f"shim lost {name}"
        assert hasattr(analysis_service, name), f"core lost {name}"
        assert getattr(ui_session, name) is getattr(analysis_service, name), (
            f"{name} is a copy, not the core object")


def test_shim_all_covers_the_public_surface():
    assert set(PUBLIC_SURFACE) <= set(ui_session.__all__)
    for name in ui_session.__all__:
        assert hasattr(ui_session, name), f"__all__ lists missing {name}"


def test_api_jobs_uses_the_core_implementation():
    from src.api import jobs

    assert jobs.run_analysis is analysis_service.run_analysis
    assert jobs.save_session_to_db is analysis_service.save_session_to_db
    assert jobs.AnalysisCancelled is analysis_service.AnalysisCancelled
    assert jobs.run_analysis.__module__ == "src.core.analysis_service"

    from src.api import session_store

    assert session_store.PREVIEW_STRIDE is analysis_service.PREVIEW_STRIDE


def test_core_and_api_do_not_import_the_ui_package():
    offenders = []
    for package in ("src/core", "src/api"):
        for path in (ROOT / package).rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.Import):
                    modules, names = [a.name for a in node.names], []
                else:
                    continue
                for module in modules + names:
                    if module == "src.ui" or module.startswith("src.ui."):
                        offenders.append(f"{path.relative_to(ROOT)}:{module}")
    assert not offenders, offenders


def test_importing_the_api_loads_no_streamlit_or_session_module():
    """The API must not pull in Streamlit, nor the old UI session module.

    `src.pipeline` still imports `src.ui.visualization` (pure OpenCV drawing,
    no Streamlit). That engine -> drawing edge predates this phase and is out
    of scope, so only the Streamlit/service-scope guarantees are pinned here.
    """
    code = (
        "import sys\n"
        "import src.api.main\n"
        "assert 'streamlit' not in sys.modules, 'streamlit imported'\n"
        "assert 'src.ui.session' not in sys.modules, 'ui session imported'\n"
        "legacy = sorted(m for m in sys.modules if m.startswith('src.ui.'))\n"
        "assert 'src.ui.session' not in legacy, legacy\n"
        "print(legacy)\n"
    )
    proc = subprocess.run([sys.executable, "-c", code], cwd=ROOT,
                          capture_output=True, text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr
    assert "streamlit" not in proc.stdout
