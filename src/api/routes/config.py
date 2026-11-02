"""Configuration read, deep-partial update and reset.

`PUT /config` validates the *merged* document, so a single-section patch like
``{"anomaly": {"threshold_suspicious": 0.4}}`` is checked against every
cross-field invariant before anything is written to the engine singleton.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from src.api.config_store import (ConfigValidationError, apply_patch,
                                  reset_config, serialize_config)

router = APIRouter(tags=["config"])


def _rejected(exc: ConfigValidationError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "error": {
            "code": "config_invalid",
            "message": "Configuration rejected; nothing was changed.",
            "detail": exc.errors,
        }
    })


@router.get("/config", summary="Current engine configuration")
def get_config() -> dict:
    return serialize_config()


@router.put("/config", summary="Apply a deep-partial configuration patch",
            responses={422: {"description": "Invalid configuration"}})
def put_config(patch: dict = Body(
        ..., description="Deep-partial configuration document",
        examples=[{"anomaly": {"threshold_suspicious": 0.4}}])) -> dict:
    try:
        updated, changed = apply_patch(patch)
    except ConfigValidationError as exc:
        raise _rejected(exc) from exc
    return {"config": updated, "applied": changed, "changed": bool(changed)}


@router.post("/config/reset", summary="Restore every default setting")
def post_reset() -> dict:
    updated, changed = reset_config()
    return {"config": updated, "applied": changed,
            "reset_to_defaults": True}
