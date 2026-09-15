import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile

from .adapters.base import flatten_document_artifact
from .adapters.chunkr_async import verify_chunkr_webhook
from .models import ExtractRequest, ExtractResponse
from .ports import (
    CapabilityNotConfigured,
    CostPolicy,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    PrivacyPolicy,
    UnsupportedMediaType,
)
from .provider_task_journal import record_provider_task_state
from .registry import default_registry

app = FastAPI(title="AKP Extractor", version="0.3.0")


def _configured_adapter(
    adapters: list[dict[str, Any]], *, name: str | None = None, capability: str | None = None
) -> dict[str, Any] | None:
    for adapter in adapters:
        if adapter.get("status") != "CONFIGURED":
            continue
        if name is not None and adapter.get("adapter") != name:
            continue
        if capability is not None and adapter.get(capability) is not True:
            continue
        return adapter
    return None


@app.get("/v1/capabilities")
def capabilities() -> dict[str, object]:
    adapters = default_registry.capabilities()
    deterministic = next(
        (item for item in adapters if item["adapter"] == "deterministic-baseline"),
        None,
    )
    ocr = _configured_adapter(adapters, capability="ocr")
    transcription = _configured_adapter(
        adapters, name="openai-compatible-transcription"
    )
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
            },
            {
                "media": "document-intelligence-routing",
                "status": "CONFIGURED",
                "benchmark_required_for_optional_default": True,
                "cost_policy": True,
                "privacy_policy": True,
                "ocr_requirement": True,
                "table_requirement": True,
                "formula_requirement": True,
            },
            {
                "media": "image-ocr-vision",
                "status": "CONFIGURED" if ocr else "CAPABILITY_NOT_CONFIGURED",
                "locators": bool(ocr and ocr.get("locators")),
                "ocr": bool(ocr),
                "vision_captioning": False,
                "adapter": ocr.get("adapter") if ocr else None,
            },
            {
                "media": "audio-transcript",
                "status": (
                    "CONFIGURED" if transcription else "CAPABILITY_NOT_CONFIGURED"
                ),
                "timestamps": bool(transcription),
                "locators": bool(transcription and transcription.get("locators")),
                "adapter": transcription.get("adapter") if transcription else None,
            },
            {
                "media": "video-transcript",
                "status": (
                    "CONFIGURED"
                    if transcription and transcription.get("video_demux_available") is True
                    else "CAPABILITY_NOT_CONFIGURED"
                ),
                "timestamps": bool(
                    transcription and transcription.get("video_demux_available") is True
                ),
                "visual_captioning": False,
                "adapter": transcription.get("adapter") if transcription else None,
            },
            {
                # Retained as an explicit negative capability so clients cannot
                # mistake audio-only video transcription for visual analysis.
                "media": "video-transcript-visual",
                "status": "CAPABILITY_NOT_CONFIGURED",
                "timestamps": False,
                "locators": False,
                "visual_captioning": False,
                "reason": "NO_VISION_PROVIDER_CONFIGURED",
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


def _cost_policy(value: object) -> CostPolicy:
    try:
        return CostPolicy(str(value or CostPolicy.STANDARD.value).upper())
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_COST_POLICY"},
        ) from error


def _privacy_policy(value: object) -> PrivacyPolicy:
    try:
        return PrivacyPolicy(str(value or PrivacyPolicy.LOCAL_PREFERRED.value).upper())
    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_PRIVACY_POLICY"},
        ) from error


def _bool_configuration(configuration: dict[str, object], key: str) -> bool:
    value = configuration.get(key)
    return value is True or (isinstance(value, str) and value.lower() == "true")


def _extract_path(
    path: Path,
    media_type: str,
    source_uri: str,
    *,
    source_id: str | None = None,
    complexity: str | None = None,
    ocr_required: bool = False,
    tables: bool = False,
    formula: bool = False,
    cost_policy: CostPolicy = CostPolicy.STANDARD,
    privacy_policy: PrivacyPolicy = PrivacyPolicy.LOCAL_PREFERRED,
    ingest_job_id: str | None = None,
    configuration: dict[str, object] | None = None,
) -> ExtractResponse:
    request = DocumentExtractionRequest(
        source_path=path,
        source_id=source_id or source_uri or str(path),
        source_uri=source_uri,
        media_type=media_type or "application/octet-stream",
        complexity=complexity,
        ocr_required=ocr_required,
        tables=tables,
        formula=formula,
        cost_policy=cost_policy,
        privacy_policy=privacy_policy,
        ingest_job_id=ingest_job_id,
        configuration=configuration or {},
    )
    try:
        routed = default_registry.extract(request)
    except UnsupportedMediaType as error:
        raise HTTPException(
            status_code=415,
            detail={
                "code": "UNSUPPORTED_MEDIA_TYPE",
                "media_type": media_type,
                "message": str(error),
            },
        ) from error
    except CapabilityNotConfigured as error:
        raise HTTPException(
            status_code=501,
            detail={"code": error.code, "message": str(error)},
        ) from error
    except DocumentIntelligenceError as error:
        raise HTTPException(
            status_code=422,
            detail={
                "code": getattr(error, "code", "EXTRACTOR_FAILURE"),
                "message": str(error),
            },
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

    configuration = request.configuration
    return _extract_path(
        path,
        request.media_type or "",
        request.source_uri,
        source_id=request.source_id,
        complexity=request.complexity,
        ocr_required=_bool_configuration(configuration, "ocr_required"),
        tables=_bool_configuration(configuration, "tables"),
        formula=_bool_configuration(configuration, "formula"),
        cost_policy=_cost_policy(configuration.get("cost_policy")),
        privacy_policy=_privacy_policy(configuration.get("privacy_policy")),
        ingest_job_id=(
            str(configuration["ingest_job_id"])
            if configuration.get("ingest_job_id")
            else None
        ),
        configuration=configuration,
    )


@app.post("/v1/extract-upload", response_model=ExtractResponse)
async def extract_upload(
    file: Annotated[UploadFile, File(...)],
    source_uri: Annotated[str, Form(...)],
    expected_sha256: Annotated[str, Form(min_length=64, max_length=64)],
    media_type: Annotated[str, Form()] = "",
    source_id: Annotated[str | None, Form()] = None,
    complexity: Annotated[str | None, Form()] = None,
    ocr_required: Annotated[bool, Form()] = False,
    tables: Annotated[bool, Form()] = False,
    formula: Annotated[bool, Form()] = False,
    cost_policy: Annotated[str, Form()] = "STANDARD",
    privacy_policy: Annotated[str, Form()] = "LOCAL_PREFERRED",
    ingest_job_id: Annotated[str | None, Form()] = None,
    configuration_json: Annotated[str, Form()] = "{}",
    x_akp_extractor_token: Annotated[str | None, Header()] = None,
) -> ExtractResponse:
    _authorize(x_akp_extractor_token)
    try:
        parsed_configuration = json.loads(configuration_json)
    except json.JSONDecodeError as error:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_EXTRACTION_CONFIGURATION"},
        ) from error
    if not isinstance(parsed_configuration, dict):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_EXTRACTION_CONFIGURATION"},
        )
    configuration = {str(key): value for key, value in parsed_configuration.items()}

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
                    raise HTTPException(
                        status_code=413, detail="Source exceeds configured size limit"
                    )
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
            ocr_required=ocr_required,
            tables=tables,
            formula=formula,
            cost_policy=_cost_policy(cost_policy),
            privacy_policy=_privacy_policy(privacy_policy),
            ingest_job_id=ingest_job_id,
            configuration=configuration,
        )
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


@app.post("/v1/webhooks/chunkr")
async def chunkr_webhook(request: Request) -> dict[str, object]:
    """Verify Chunkr/Svix against raw bytes, then journal the provider state.

    This endpoint intentionally does not use the extractor bearer token: the
    Svix signature is the authentication boundary for the external provider.
    The subsequent AKP API callback uses a separate internal journal token.
    """

    raw_body = await request.body()
    try:
        event = verify_chunkr_webhook(raw_body, dict(request.headers))
    except CapabilityNotConfigured as error:
        raise HTTPException(
            status_code=503,
            detail={"code": error.code, "message": str(error)},
        ) from error
    except DocumentIntelligenceError as error:
        raise HTTPException(
            status_code=401,
            detail={"code": "INVALID_CHUNKR_WEBHOOK", "message": str(error)},
        ) from error

    message_id = request.headers.get("svix-id")
    record_provider_task_state(
        provider="chunkr",
        task_id=str(event["task_id"]),
        status=str(event["status"]),
        task_type=(str(event["task_type"]) if event.get("task_type") else None),
        mode=os.getenv("AKP_CHUNKR_MODE", "cloud").strip().lower() or "cloud",
        metadata={
            "webhookMessageId": message_id,
            "eventType": event.get("event_type"),
            "message": event.get("message"),
        },
        allow_lookup_by_task=True,
    )
    return {
        "accepted": True,
        "provider": "chunkr",
        "taskId": str(event["task_id"]),
        "status": str(event["status"]),
    }
