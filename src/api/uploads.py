"""Video upload validation and storage.

Security model
--------------
* The client filename is **never** used for storage. Files land under a
  server-generated name (``<24 hex>.<ext>``) inside the configured upload
  directory, so traversal segments and collisions are structurally impossible.
* Validation happens in layers, each able to fail independently:
  extension allowlist -> declared MIME allowlist -> magic-byte container
  signature -> extension/container agreement -> real OpenCV decode.
* The size cap is enforced *while streaming*, so an oversized body is never
  written in full.
* Nothing about the on-disk path is returned to the client.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Iterable

from src.api.probe import probe_video
from src.api.settings import settings, upload_dir

# extension -> container family detected from magic bytes
ALLOWED_EXTENSIONS: dict[str, str] = {
    ".mp4": "mp4", ".m4v": "mp4", ".mov": "mp4",
    ".avi": "avi",
    ".mkv": "matroska", ".webm": "matroska",
}
ALLOWED_MIME_TYPES = {
    "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska",
    "video/webm", "video/mp4v-es", "application/octet-stream",
}

_REGISTRY: dict[str, "UploadRecord"] = {}
_LOCK = threading.Lock()


class UploadError(Exception):
    """Validation/storage failure with an HTTP status and stable code."""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass
class UploadRecord:
    upload_id: str
    original_name: str          # sanitised display name only
    content_type: str | None
    path: Path                  # internal; never serialised
    bytes: int
    created_ts: float
    video: dict

    def public(self) -> dict:
        return {
            "upload_id": self.upload_id,
            "filename": self.original_name,
            "bytes": self.bytes,
            "content_type": self.content_type,
            "created_ts": datetime.fromtimestamp(
                self.created_ts, timezone.utc).isoformat(timespec="seconds"),
            "video": dict(self.video),
        }


def _display_name(name: str | None) -> str:
    base = Path(name or "").name                       # strip any directories
    cleaned = "".join(ch for ch in base
                      if ch.isalnum() or ch in " ._-").strip()
    return (cleaned or "video")[:120]


def _container_family(head: bytes) -> str | None:
    """Detect the container from the first bytes; None when unrecognised."""
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "mp4"
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return "avi"
    if head[:4] == b"\x1aE\xdf\xa3":
        return "matroska"
    return None


def store_upload(stream: BinaryIO, filename: str,
                 content_type: str | None) -> UploadRecord:
    """Validate and persist one upload; raises `UploadError` on any failure."""
    extension = Path(filename or "").suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise UploadError(
            415, "unsupported_type",
            f"Unsupported file extension {extension or '(none)'!r}. "
            f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}.")

    declared = (content_type or "").split(";")[0].strip().lower()
    if declared and declared not in ALLOWED_MIME_TYPES:
        raise UploadError(
            415, "unsupported_mime",
            f"Declared content type {declared!r} is not an accepted video type.")

    directory = upload_dir()
    upload_id = secrets.token_hex(12)                 # 24 hex chars
    temp = directory / f".incoming_{upload_id}"
    size = 0
    head = b""

    try:
        with temp.open("wb") as out:
            while True:
                chunk = stream.read(settings.chunk_bytes)
                if not chunk:
                    break
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise UploadError(
                        413, "file_too_large",
                        "Upload exceeds the configured size limit "
                        f"({settings.max_upload_bytes // (1024 * 1024)} MB).")
                if len(head) < 64:
                    head += chunk[:64 - len(head)]
                out.write(chunk)

        if size == 0:
            raise UploadError(400, "empty_file", "The uploaded file is empty.")

        family = _container_family(head)
        if family is None:
            raise UploadError(
                422, "unreadable_video",
                "The file does not contain a recognised video container.")
        if family != ALLOWED_EXTENSIONS[extension]:
            raise UploadError(
                422, "extension_mismatch",
                f"The .{extension.lstrip('.')} extension does not match the "
                f"actual {family} container.")

        probe = probe_video(temp)
        if not probe.get("valid"):
            raise UploadError(
                422, "unreadable_video",
                "OpenCV could not decode this video: "
                f"{probe.get('error') or 'unknown error'}.")

        final = directory / f"{upload_id}{extension}"
        os.replace(temp, final)
    except UploadError:
        temp.unlink(missing_ok=True)
        raise
    except OSError as exc:
        temp.unlink(missing_ok=True)
        raise UploadError(500, "storage_error",
                          f"The upload could not be stored: {exc}") from exc

    record = UploadRecord(
        upload_id=upload_id, original_name=_display_name(filename),
        content_type=content_type or None, path=final, bytes=size,
        created_ts=time.time(), video=dict(probe))
    with _LOCK:
        _REGISTRY[upload_id] = record
    return record


def get_upload(upload_id: str) -> UploadRecord | None:
    with _LOCK:
        record = _REGISTRY.get(upload_id)
    if record is None or not record.path.is_file():
        return None
    return record


def cleanup_stale(active_refs: Iterable[str] | None = None) -> int:
    """Delete upload files past their TTL that no active job still needs."""
    keep = set(active_refs or ())
    directory = upload_dir()
    cutoff = time.time() - settings.upload_ttl_s
    removed = 0
    try:
        candidates = list(directory.iterdir())
    except OSError:
        return 0
    for path in candidates:
        if not path.is_file():
            continue
        stem = path.stem.replace(".incoming_", "")
        if stem in keep:
            continue
        try:
            if path.stat().st_mtime >= cutoff:
                continue
            path.unlink()
            removed += 1
        except OSError:
            continue
    if removed:
        with _LOCK:
            for upload_id in [k for k, r in _REGISTRY.items()
                              if not r.path.is_file()]:
                _REGISTRY.pop(upload_id, None)
    return removed
