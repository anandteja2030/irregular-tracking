"""Consistent error envelope shared by the analytics routes.

Every error the API returns has the same shape::

    {"error": {"code": "...", "message": "...", ...extra}}

Phase 1/2 handlers already produce this envelope; this helper just removes the
duplication from the new routers.
"""
from __future__ import annotations

from fastapi import HTTPException


def api_error(status_code: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status_code,
                         detail={"error": {"code": code, "message": message,
                                           **extra}})
