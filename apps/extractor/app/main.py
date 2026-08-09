import hashlib
import os
import tempfile
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from .extractors.docx import extract_docx
from .extractors.html import extract_html
from .extractors.image import extract_image
from .extractors.pdf import extract_pdf
from .extractors.pptx import extract_pptx
from .extractors.text import extract_text
from .models import ExtractRequest, ExtractResponse

app = FastAPI(title="AKP Extractor", version="0.2.0")


@app.get("/v1/capabilities")
def capabilities() -> dict[str, object]:
    return {
        "extractor_version": "0.2.0",
        "capabilities": [
            {"media": "markdown-text", "status": "CONFIGURED", "locators": True},
            {"media": "pdf", "status": "CONFIGURED", "locators": True},
            {"media": "html-snapshot", "status": "CONFIGURED", "locators": True},
            {"media": "image-metadata", "status": "CONFIGURED", "locators": True},
            {"media": "docx", "status": "CONFIGURED", "locators": True},
            {"media": "pptx", "status": "CONFIGURED", "locators": True},
            {
                "media": "authenticated-multipart-upload",
                "status": "CONFIGURED",
                "sha256_verification": True,
            },
            {
                "media": "image-ocr-vision",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "locators": False,
            },
            {
                "media": "audio-transcript",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "timestamps": False,
            },
            {
                "media": "video-transcript-visual",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "timestamps": False,
            },
        ],
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "UP"}


def _authorize(token: str | None) -> None:
    expected_token = os.getenv("AKP_EXTRACTOR_TOKEN")
    if not expected_token or token != expected_token:
        raise HTTPException(status_code=401, detail="Extractor authentication required")


def _extract_path(path: Path, media_type: str, source_uri: str) -> ExtractResponse:
    if path.suffix.lower() == ".pdf" or media_type == "application/pdf":
        artifacts = extract_pdf(path)
        name = "pypdf"
    elif path.suffix.lower() in {".html", ".htm"} or media_type == "text/html":
        artifacts = extract_html(path)
        name = "beautifulsoup"
    elif path.suffix.lower() in {".md", ".txt"} or media_type.startswith("text/"):
        artifacts = extract_text(path)
        name = "python-text"
    elif path.suffix.lower() in {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
    } or media_type.startswith("image/"):
        artifacts = extract_image(path)
        name = "pillow"
    elif path.suffix.lower() == ".docx" or media_type == (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ):
        artifacts = extract_docx(path)
        name = "python-docx"
    elif path.suffix.lower() == ".pptx" or media_type == (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ):
        artifacts = extract_pptx(path)
        name = "python-pptx"
    elif media_type.startswith(("audio/", "video/")) or path.suffix.lower() in {
        ".mp3",
        ".wav",
        ".m4a",
        ".mp4",
        ".mov",
        ".webm",
    }:
        raise HTTPException(
            status_code=501,
            detail={
                "code": "CAPABILITY_NOT_CONFIGURED",
                "capability": (
                    "audio-transcript"
                    if media_type.startswith("audio/")
                    else "video-transcript-visual"
                ),
            },
        )
    else:
        raise HTTPException(
            status_code=415,
            detail={"code": "UNSUPPORTED_MEDIA_TYPE", "media_type": media_type},
        )

    return ExtractResponse(
        extractor=name,
        extractor_version="0.2.0",
        source_uri=source_uri,
        artifacts=artifacts,
    )


@app.post("/v1/extract", response_model=ExtractResponse)
def extract(
    request: ExtractRequest,
    x_akp_extractor_token: str | None = Header(default=None),
) -> ExtractResponse:
    _authorize(x_akp_extractor_token)
    parsed = urlparse(request.source_uri)
    windows_drive_path = (
        len(parsed.scheme) == 1
        and len(request.source_uri) > 2
        and request.source_uri[1] == ":"
    )
    if parsed.scheme not in ("", "file") and not windows_drive_path:
        raise HTTPException(
            status_code=501,
            detail="Extractor supports captured local files only; remote URLs require a snapshot.",
        )

    path = Path(
        parsed.path
        if parsed.scheme == "file" and not windows_drive_path
        else request.source_uri
    ).resolve()
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Source file not found")
    allowed_roots = [
        Path(root).resolve()
        for root in os.getenv("AKP_EXTRACTOR_ROOTS", tempfile.gettempdir()).split(
            os.pathsep
        )
        if root.strip()
    ]
    if not any(path == root or path.is_relative_to(root) for root in allowed_roots):
        raise HTTPException(status_code=403, detail="Source path is outside extractor roots")
    maximum_bytes = int(os.getenv("AKP_MAX_SOURCE_BYTES", str(512 * 1024 * 1024)))
    if path.stat().st_size > maximum_bytes:
        raise HTTPException(status_code=413, detail="Source exceeds configured size limit")

    return _extract_path(path, request.media_type or "", request.source_uri)


@app.post("/v1/extract-upload", response_model=ExtractResponse)
async def extract_upload(
    file: Annotated[UploadFile, File(...)],
    source_uri: Annotated[str, Form(...)],
    expected_sha256: Annotated[str, Form(min_length=64, max_length=64)],
    media_type: Annotated[str, Form()] = "",
    x_akp_extractor_token: Annotated[str | None, Header()] = None,
) -> ExtractResponse:
    _authorize(x_akp_extractor_token)
    suffix = Path(file.filename or "source.bin").suffix[:20]
    maximum_bytes = int(os.getenv("AKP_MAX_SOURCE_BYTES", str(512 * 1024 * 1024)))
    digest = hashlib.sha256()
    bytes_written = 0
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="akp-upload-", suffix=suffix, delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            while chunk := await file.read(1024 * 1024):
                bytes_written += len(chunk)
                if bytes_written > maximum_bytes:
                    raise HTTPException(status_code=413, detail="Source exceeds configured size limit")
                digest.update(chunk)
                handle.write(chunk)
        if digest.hexdigest() != expected_sha256.lower():
            raise HTTPException(
                status_code=409,
                detail={"code": "IMMUTABLE_OBJECT_HASH_MISMATCH"},
            )
        return _extract_path(temporary_path, media_type, source_uri)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
