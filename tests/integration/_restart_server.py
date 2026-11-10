"""Uvicorn launcher for the two-process restart integration test.

The application has no database-path environment variable: the SQLite location
is the `paths.db` attribute of the config singleton. This launcher points that
singleton at the test's isolated temporary file *before* importing the app, then
runs the real FastAPI application under uvicorn. No application code is mocked.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config.config import load_config  # noqa: E402

load_config().paths.db = Path(os.environ["NEURAL_TEST_DB"])

import uvicorn  # noqa: E402

from src.api.main import app  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(sys.argv[1]),
        log_level="info",
        access_log=False,
    )
