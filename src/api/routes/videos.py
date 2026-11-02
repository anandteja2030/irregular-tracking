"""Video upload endpoint."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile

from src.api.uploads import UploadError, store_upload

router = APIRouter(prefix="/videos", tags=["videos"])


@router.post("/upload", status_code=201,
             summary="Upload and validate a video file",
             responses={400: {"description": "Empty upload"},
                        413: {"description": "File too large"},
                        415: {"description": "Unsupported type"},
                        422: {"description": "Undecodable video"}})
def upload_video(file: UploadFile = File(
        ..., description="mp4 / avi / mov / mkv / webm")) -> dict:
    """Stream to disk, then validate extension, MIME, container and decode.

    The response carries a server-generated `upload_id` and measured metadata;
    it never exposes filesystem paths.
    """
    try:
        record = store_upload(file.file, filename=file.filename or "",
                              content_type=file.content_type)
    except UploadError as exc:
        raise HTTPException(status_code=exc.status_code, detail={
            "error": {"code": exc.code, "message": exc.message}}) from exc
    return record.public()
