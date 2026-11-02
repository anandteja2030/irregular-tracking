"""FastAPI backend for NEURAL COMMAND (Phase 1: system, config, sources).

The API is a *second* front door onto the existing engine: it reads the same
`config.config.SETTINGS` singleton, the same sample videos and (in later
phases) the same SQLite database. Nothing here re-implements detection,
tracking or scoring - those modules stay untouched.
"""
from __future__ import annotations

API_VERSION = "1.0.0"
