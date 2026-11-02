"""FastAPI application for NEURAL COMMAND.

Run locally:
    .venv/bin/uvicorn src.api.main:app --reload --port 8000

Phase 1 exposes only the foundation - health, system status, configuration and
bundled sources. Analysis jobs, uploads, sessions and media arrive in later
phases; the computer-vision engine and the Streamlit UI are untouched.

Endpoints are documented at the root (`/health`, `/system`, `/config`,
`/sources`) and mirrored under `/api/v1/...` for the future React client. The
versioned mirror is intentionally excluded from the OpenAPI schema so each
operation appears exactly once.
"""
from __future__ import annotations

import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from src.api import API_VERSION
from src.api.routes import anomalies as anomaly_routes
from src.api.routes import config as config_routes
from src.api.routes import evaluation as evaluation_routes
from src.api.routes import jobs as job_routes
from src.api.routes import media as media_routes
from src.api.routes import scene as scene_routes
from src.api.routes import sessions as session_routes
from src.api.routes import sources as source_routes
from src.api.routes import system as system_routes
from src.api.routes import tracks as track_routes
from src.api.routes import videos as video_routes

_DEFAULT_ORIGINS = ("http://localhost:5173,http://127.0.0.1:5173,"
                    "http://localhost:3000,http://127.0.0.1:3000")

_TAGS_METADATA = [
    {"name": "system", "description": "Liveness and measured runtime status."},
    {"name": "config", "description": "Engine configuration: read, patch, reset."},
    {"name": "sources", "description": "Bundled sample footage with real metadata."},
    {"name": "videos", "description": "Validated video uploads."},
    {"name": "jobs", "description": "Background analysis jobs and progress."},
    {"name": "sessions", "description": "Persisted sessions: metadata, counts, summary."},
    {"name": "tracks", "description": "Tracked objects, observations and trajectories."},
    {"name": "anomalies", "description": "Suspicious/Irregular events and evidence."},
    {"name": "media", "description": "Preview frame media and availability metadata."},
    {"name": "scene", "description": "Calibration, movement baseline and deviations."},
    {"name": "evaluation", "description": "Ground-truth metrics, CSV and report exports."},
]


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Sweep expired uploads on start; cancel active jobs on shutdown."""
    from src.api.jobs import manager
    from src.api.uploads import cleanup_stale
    try:
        cleanup_stale(active_refs=manager.active_upload_refs())
    except OSError:
        pass
    yield
    manager.cancel_all()
    manager.wait_idle(timeout=2.0)


def create_app() -> FastAPI:
    app = FastAPI(
        title="NEURAL COMMAND API",
        version=API_VERSION,
        summary="Intelligent surveillance & anomaly intelligence backend",
        description=(
            "Session, track, anomaly, scene, evaluation and media analytics on "
            "top of the existing OpenCV pipeline, Kalman/Hungarian tracking, "
            "scene calibration and rule + Isolation Forest scoring. Every "
            "figure comes from the session's persisted results; fields that "
            "were never recorded are returned as null with an explanation."),
        openapi_tags=_TAGS_METADATA,
        lifespan=_lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )
    app.state.started_monotonic = time.monotonic()

    origins = [o.strip() for o in
               os.environ.get("NEURAL_ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",")
               if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins,
                       allow_methods=["*"], allow_headers=["*"])

    routers = (system_routes.router, config_routes.router, source_routes.router)
    for router in routers:
        app.include_router(router)
    for router in routers:                    # versioned mirror for the SPA
        app.include_router(router, prefix="/api/v1", include_in_schema=False)
    for router in (video_routes.router, job_routes.router):
        app.include_router(router, prefix="/api/v1")
        app.include_router(router, prefix="", include_in_schema=False)
    analytics_routers = (session_routes.router, track_routes.router,
                         anomaly_routes.router, media_routes.router,
                         scene_routes.router, evaluation_routes.router)
    for router in analytics_routers:
        app.include_router(router, prefix="/api/v1")
        app.include_router(router, prefix="", include_in_schema=False)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request,
                                exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={
            "error": {
                "code": "validation_error",
                "message": "Request validation failed.",
                "detail": jsonable_encoder(exc.errors()),
            }
        })

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request,
                          exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, dict) and "error" in detail:
            content = detail
        else:
            content = {"error": {"code": f"http_{exc.status_code}",
                                 "message": str(detail)}}
        return JSONResponse(status_code=exc.status_code,
                            content=jsonable_encoder(content),
                            headers=getattr(exc, "headers", None))

    @app.get("/", include_in_schema=False)
    def root() -> dict:
        return {"name": "NEURAL COMMAND API", "version": API_VERSION,
                "docs": "/docs", "openapi": "/openapi.json",
                "health": "/health"}

    return app


app = create_app()
