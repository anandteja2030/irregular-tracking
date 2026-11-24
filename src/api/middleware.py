"""Small ASGI guards for limits that must apply before route parsing.

Starlette's multipart parser spools an upload to a temporary file before a
route dependency such as ``UploadFile`` is available to the application. A
size check inside the upload handler therefore protects disk contents but not
the request itself: a client can still make the server receive and spool an
arbitrarily large body. This middleware checks the declared Content-Length and
counts streamed chunks, returning the normal API error envelope at 413.
"""
from __future__ import annotations

import json
import re

from src.api.settings import settings

_UPLOAD_PATHS = frozenset({"/videos/upload", "/api/v1/videos/upload"})
# A webcam frame is a small multipart body with a single JPEG part. It is
# bounded separately from ordinary JSON requests, and far below the video
# upload cap, so one frame cannot spool a large body to disk.
_LIVE_FRAME_PATH = re.compile(
    r"^/(?:api/v1/)?live/sessions/[0-9a-zA-Z_]+/frames$")
_LIVE_FRAME_LIMIT_BYTES = 4 * 1024 * 1024
_JSON_LIMIT_BYTES = 1024 * 1024
_MULTIPART_OVERHEAD_BYTES = 1024 * 1024


class _BodyTooLarge(Exception):
    pass


class RequestBodyLimitMiddleware:
    """Bound HTTP request bodies before FastAPI reads or parses them."""

    def __init__(self, app, *, json_limit_bytes: int = _JSON_LIMIT_BYTES,
                 multipart_overhead_bytes: int = _MULTIPART_OVERHEAD_BYTES):
        self.app = app
        self.json_limit_bytes = max(1, int(json_limit_bytes))
        self.multipart_overhead_bytes = max(0, int(multipart_overhead_bytes))

    def _limit_for(self, scope: dict) -> int:
        path = scope.get("path", "")
        if path in _UPLOAD_PATHS:
            # Multipart boundaries and headers are part of the request body,
            # so allow a small fixed envelope above the advertised file cap.
            return settings.max_upload_bytes + self.multipart_overhead_bytes
        if _LIVE_FRAME_PATH.match(path):
            return _LIVE_FRAME_LIMIT_BYTES + self.multipart_overhead_bytes
        return self.json_limit_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        limit = self._limit_for(scope)
        if path in _UPLOAD_PATHS:
            code = "file_too_large"
        elif _LIVE_FRAME_PATH.match(path):
            code = "frame_too_large"
        else:
            code = "request_too_large"
        headers = dict(scope.get("headers") or ())
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                declared = int(raw_length)
            except (TypeError, ValueError):
                declared = None
            if declared is not None and declared > limit:
                await self._reject(send, code)
                return

        received = 0
        response_started = False

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _BodyTooLarge
            return message

        async def tracked_send(message):
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _BodyTooLarge:
            # The parser raises before a route can start a response. If an
            # unusual application already committed headers, do not attempt a
            # second response (that would corrupt the HTTP stream).
            if not response_started:
                await self._reject(send, code)

    @staticmethod
    async def _reject(send, code: str) -> None:
        body = json.dumps({
            "error": {
                "code": code,
                "message": "The request body exceeds the configured limit.",
            }
        }).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"connection", b"close"),
            ],
        })
        await send({"type": "http.response.body", "body": body})
