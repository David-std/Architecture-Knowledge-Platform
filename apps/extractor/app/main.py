import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from .adapters.base import flatten_document_artifact
from .models import ExtractRequest, ExtractResponse
from .ports import DocumentExtractionRequest, DocumentIntelligenceError, UnsupportedMediaType
from .registry import default_registry

app = FastAPI(title="AKP Extractor", version="0.3.0")


@app.get("/v1/capabilities")
def capabilities() -> dict[str, object]:
    adapters = default_registry.capabilities()
    deterministic = next(
        (item for item in adapters if item["adapter"] == "deterministic-baseline"),
        None,
    )
    docling = next(
        (item for item in adapters if item["adapter"] == "docling"),
        None,
    )
    docling_configured = bool(docling and docling.get("status") == "CONFIGURED")
    aliases = {
        "text/markdown": "markdown-text",
        "text/plain": "markdown-text",
        "text/html": "html-snapshot",
        "application/pdf": "pdf",
        "image/png": "image-metadata",
        "image/jpeg": "image-metadata",
        "image/webp": "image-metadata",
        "image/gif": "image-metadata",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    }
    media_entries = [
        {
            "media": aliases.get(media, media),
            "status": "CONFIGURED",
            "locators": True,
            "structured_artifact": True,
            "adapter": "deterministic-baseline",
        }
        for media in dict.fromkeys((deterministic or {}).get("media", []))
    ]
    media_entries.extend(
        [
            {
                "media": "authenticated-multipart-upload",
                "status": "CONFIGURED",
                "sha256_verification": True,
                "routing_controls": True,
            },
            {
                "media": "document-intelligence-routing",
                "status": "CONFIGURED",
                "benchmark_required_for_optional_default": True,
            },
            {
                "media": "document-image-ocr",
                "status": (
                    "CONFIGURED"
                    if docling_configured
                    else "CAPABILITY_NOT_CONFIGURED"
                ),
                "locators": bool(docling_configured and docling and docling.get("locators")),
                "structured_artifact": bool(
                    docling_configured and docling and docling.get("structured_output")
                ),
                "adapter": "docling" if docling_configured else None,
                "explicit_or_benchmark_selection_required": True,
            },
            {
                "media": "image-visual-reasoning",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "locators": False,
                "reason": "OCR is not equivalent to multimodal visual reasoning",
            },
            {
                "media": "audio-transcript",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "timestamps": False,
                "locators": False,
            },
            {
                "media": "video-transcript-visual",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "timestamps": False,
                "locators": False,
            },
        ]
    )
    return {
        "extractor_version": "0.3.0",
        "capabilities": media_entries,
        "adapters": adapters,
        "routing": {
            "benchmark_selection_configured": bool(
                os.getenv("AKP_DOCUMENT_INTELLIGENCE_SELECTION", "").strip()
            ),
            "optional_defaults_disabled_until_benchmark": True,
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "UP"}


def _authorize(token: str | None) -> None:
    expected_token = os.getenv("AKP_EXTRACTOR_TOKEN")
    if not expected_token or token != expected_token:
        raise HTTPException(status_code=401, detail="Extractor authentication required")


def _parse_upload_configuration(value: str | None) -> dict[str, object]:
    if value is None or not value.strip():
        return {}
    if len(value) > 16_384:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_EXTRACTOR_CONFIGURATION", "reason": "too_large"},
        )
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_EXTRACTOR_CONFIGURATION", "reason": "invalid_json"},
        ) from error
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_EXTRACTOR_CONFIGURATION", "reason": "object_required"},
        )
    return {str(key): child for key, child in parsed.items()}


def _extract_path(
    path: Path,
    media_type: str,
    source_uri: str,
    *,
    source_id: str | None = None,
    complexity: str | None = None,
    configuration: dict[str, object] | None = None,
) -> ExtractResponse:
    if media_type.startswith(("audio/", "video/")) or path.suffix.lower() in {
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
    request = DocumentExtractionRequest(
        source_path=path,
        source_id=source_id or source_uri or str(path),
        source_uri=source_uri,
        media_type=media_type or "application/octet-stream",
        complexity=complexity,
        configuration=configuration or {},
    )
    try:
        routed = default_registry.extract(request)
    except UnsupportedMediaType as error:
        raise HTTPException(
            status_code=415,
            detail={"code": "UNSUPPORTED_MEDIA_TYPE", "media_type": media_type, "message": str(error)},
        ) from error
    except DocumentIntelligenceError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": getattr(error, "code", "EXTRACTOR_FAILURE"), "message": str(error)},
        ) from error
    artifact = routed.artifact
    return ExtractResponse(
        extractor=artifact.extractor,
        extractor_version=artifact.extractor_version,
        source_uri=source_uri,
        artifacts=flatten_document_artifact(artifact),
        document_artifact=artifact,
        routing=routed.decision.model_dump(mode="json"),
        warnings=[*artifact.warnings, *routed.decision.warnings],
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

    return _extract_path(
        path,
        request.media_type or "",
        request.source_uri,
        source_id=request.source_id,
        complexity=request.complexity,
        configuration=request.configuration,
    )


@app.post("/v1/extract-upload", response_model=ExtractResponse)
async def extract_upload(
    file: Annotated[UploadFile, File(...)],
    source_uri: Annotated[str, Form(...)],
    expected_sha256: Annotated[str, Form(min_length=64, max_length=64)],
    media_type: Annotated[str, Form()] = "",
    source_id: Annotated[str | None, Form()] = None,
    complexity: Annotated[str | None, Form()] = None,
    configuration: Annotated[str | None, Form()] = None,
    x_akp_extractor_token: Annotated[str | None, Header()] = None,
) -> ExtractResponse:
    _authorize(x_akp_extractor_token)
    extraction_configuration = _parse_upload_configuration(configuration)
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
        return _extract_path(
            temporary_path,
            media_type,
            source_uri,
            source_id=source_id or source_uri,
            complexity=complexity,
            configuration=extraction_configuration,
        )
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
