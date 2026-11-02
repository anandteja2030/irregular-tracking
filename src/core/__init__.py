"""Framework-neutral core services shared by the API, the Streamlit UI and the CLI.

Modules here must not import Streamlit or any other presentation layer: the
API and the dashboard are two front doors onto the same engine. Detection,
tracking, calibration and scoring stay in `src.pipeline` / `src.anomaly`; this
package only orchestrates a single run and its persistence.
"""
from __future__ import annotations

CORE_VERSION = "1.0.0"
