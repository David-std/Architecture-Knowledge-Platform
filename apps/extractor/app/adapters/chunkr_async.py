"""Chunkr asynchronous Parse task adapter and native output mapper."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from typing import Any, Mapping
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from ..models import (
    ArtifactItem,
    BoundingBox,
    DocumentArtifact,
    PageArtifact,
    StructuralLocator,
    TableArtifact,
)
from ..ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
)
from .base import infer_media_type, sha256_path

_TERMINAL = {"Succeeded", "Failed", "Cancelled"}
_IN_PROGRESS = {"Starting", "Processing"}


def _endpoint() -> tuple[str, str] | None:
    configured = os.getenv("AKP_CHUNKR_ENDPOINT", "").strip()
    api_key = os.getenv("AKP_CHUNKR_API_KEY", "").strip()
    default_mode = "cloud" if api_key and not configured else "oss"
    mode = os.getenv("AKP_CHUNKR_MODE", default_mode).strip().lower()
    if mode not in {"cloud", "oss"}:
        return None
    if not configured and mode == "cloud" and api_key:
        configured = "https://api.chunkr.ai"
    if not configured:
        return None
    parsed = urlparse(configured)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        return None
    if mode == "cloud" and parsed.scheme != "https":
        return None
    if mode == "cloud" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return None
    return configured.rstrip("/"), mode


def _headers(mode: str) -> dict[str, str]:
    api_key = os.getenv("AKP_CHUNKR_API_KEY", "").strip()
    if mode == "cloud" and not api_key:
        raise CapabilityNotConfigured("Chunkr cloud mode requires AKP_CHUNKR_API_KEY")
    return {"Authorization": api_key} if api_key else {}


def _safe_text(segment: Mapping[str, Any]) -> str | None:
    raw = segment.get("text")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    raw = segment.get("content")
    if isinstance(raw, str) and raw.strip():
        return BeautifulSoup(raw, "html.parser").get_text("\n", strip=True)
    return None


def _segment_kind(segment_type: str) -> str:
    value = segment_type.lower().replace("-", "_")
    if value in {"title", "sectionheader", "section_header", "pageheader", "page_header"}:
        return "heading"
    if value in {"table"}:
        return "table"
    if value in {"picture", "graphicalitem", "graphical_item"}:
        return "figure"
    if value in {"formula"}:
        return "equation"
    if value in {"listitem", "list_item"}:
        return "list-item"
    if value in {
        "caption",
        "footnote",
        "text",
        "legend",
        "pagefooter",
        "page_footer",
        "pagenumber",
        "page_number",
    }:
        return "paragraph"
    if value == "page":
        return "page"
    return "block"


def _bbox(raw: Any) -> BoundingBox | None:
    if not isinstance(raw, dict):
        return None
    try:
        width = float(raw["width"])
        height = float(raw["height"])
        if width <= 0 or height <= 0:
            return None
        return BoundingBox(
            x=max(0.0, float(raw["left"])),
            y=max(0.0, float(raw["top"])),
            width=width,
            height=height,
            unit="pixel",
        )
    except (KeyError, TypeError, ValueError):
        return None


def _table_from_spreadsheet(
    segment: Mapping[str, Any],
) -> tuple[list[str], list[list[str]], dict[str, Any]]:
    cells = segment.get("ss_cells")
    if not isinstance(cells, list) or not cells:
        return [], [], {}
    normalized: list[dict[str, Any]] = []
    for cell in cells:
        if isinstance(cell, dict):
            normalized.append({str(key): value for key, value in cell.items()})
    positioned: list[tuple[int, int, str]] = []
    max_row = 0
    max_col = 0
    for cell in normalized:
        row_raw = cell.get("row", cell.get("row_index"))
        col_raw = cell.get("column", cell.get("column_index", cell.get("col")))
        try:
            row, col = int(row_raw), int(col_raw)
        except (TypeError, ValueError):
            continue
        text = str(cell.get("text", cell.get("value", "")) or "")
        positioned.append((row, col, text))
        max_row, max_col = max(max_row, row + 1), max(max_col, col + 1)
    rows: list[list[str]] = []
    if positioned and max_row > 0 and max_col > 0:
        rows = [["" for _ in range(max_col)] for _ in range(max_row)]
        for row, col, text in positioned:
            rows[row][col] = text
    return [], rows, {"ss_cells": normalized, "ss_range": segment.get("ss_range")}


def map_chunkr_task(
    task: Mapping[str, Any],
    request: DocumentExtractionRequest,
) -> DocumentArtifact:
    status = str(task.get("status", ""))
    if status != "Succeeded":
        raise DocumentIntelligenceError(f"Chunkr task is not successful: {status or 'UNKNOWN'}")
    output = task.get("output")
    if not isinstance(output, dict):
        raise DocumentIntelligenceError("Chunkr successful task has no parse output")

    source_hash = sha256_path(request.source_path)
    source_ref = request.source_uri or request.source_id
    blocks: list[ArtifactItem | TableArtifact] = []
    headings: list[ArtifactItem] = []
    paragraphs: list[ArtifactItem] = []
    lists: list[ArtifactItem] = []
    tables: list[TableArtifact] = []
    figures: list[ArtifactItem] = []
    equations: list[ArtifactItem] = []
    pages: dict[int, PageArtifact] = {}
    reading_order: list[str] = []
    locators: list[StructuralLocator] = [
        StructuralLocator(kind="source", source_hash=source_hash, path=source_ref)
    ]
    boxes: list[BoundingBox] = []
    chunks_meta: list[dict[str, Any]] = []
    confidence_values: list[float] = []

    output_pages = output.get("pages")
    if isinstance(output_pages, list):
        for raw_page in output_pages:
            if not isinstance(raw_page, dict):
                continue
            number_raw = raw_page.get("page_number", raw_page.get("page"))
            try:
                number = int(number_raw)
            except (TypeError, ValueError):
                continue
            if number < 1:
                continue
            locator = StructuralLocator(
                kind="page", source_hash=source_hash, path=source_ref, page=number
            )
            pages[number] = PageArtifact(
                id=f"chunkr-page-{number}",
                page=number,
                locator=locator,
                metadata={
                    "provider": "chunkr",
                    "image": raw_page.get("image"),
                    "page_width": raw_page.get("page_width", raw_page.get("width")),
                    "page_height": raw_page.get("page_height", raw_page.get("height")),
                    "dpi": raw_page.get("dpi"),
                },
            )

    chunks = output.get("chunks")
    if not isinstance(chunks, list):
        raise DocumentIntelligenceError("Chunkr parse output has no chunks array")
    for chunk_index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            continue
        chunk_id = str(chunk.get("chunk_id", chunk.get("id", f"chunk-{chunk_index}")))
        segment_ids: list[str] = []
        segments = chunk.get("segments")
        if not isinstance(segments, list):
            segments = []
        for segment_index, segment in enumerate(segments):
            if not isinstance(segment, dict):
                continue
            segment_id = str(
                segment.get("segment_id")
                or segment.get("id")
                or f"{chunk_id}-segment-{segment_index}"
            )
            segment_ids.append(segment_id)
            segment_type = str(segment.get("segment_type", "Unknown"))
            kind = _segment_kind(segment_type)
            page_raw = segment.get("page_number")
            try:
                page = int(page_raw) if page_raw is not None else None
            except (TypeError, ValueError):
                page = None
            if page is not None and page < 1:
                page = None
            region = _bbox(segment.get("bbox"))
            if region:
                boxes.append(region)
            locator_values: dict[str, Any] = {
                "kind": kind,
                "source_hash": source_hash,
                "path": source_ref,
                "page": page,
                "region": region,
            }
            ss_sheet = segment.get("ss_sheet_name")
            ss_range = segment.get("ss_range")
            if isinstance(ss_sheet, str) and ss_sheet:
                locator_values["sheet"] = ss_sheet
            locator = StructuralLocator.model_validate(
                {key: value for key, value in locator_values.items() if value is not None}
            )
            confidence = segment.get("confidence")
            if isinstance(confidence, (int, float)):
                confidence_values.append(float(confidence))
            metadata = {
                "provider": "chunkr",
                "chunk_id": chunk_id,
                "segment_type": segment_type,
                "confidence": confidence,
                "description": segment.get("description"),
                "embed": segment.get("embed"),
                "image": segment.get("image"),
                "ocr": segment.get("ocr"),
                "page_width": segment.get("page_width"),
                "page_height": segment.get("page_height"),
                "native_content": segment.get("content"),
                "native_text": segment.get("text"),
                "ss_range": ss_range,
                "ss_sheet_name": ss_sheet,
                "ss_cells": segment.get("ss_cells"),
                "untrusted_provider_output": True,
            }
            if kind == "table":
                headers, rows, table_meta = _table_from_spreadsheet(segment)
                item = TableArtifact(
                    id=segment_id,
                    kind="table",
                    text=_safe_text(segment),
                    locator=locator,
                    headers=headers,
                    rows=rows,
                    metadata={**metadata, **table_meta},
                )
                blocks.append(item)
                tables.append(item)
            else:
                item = ArtifactItem(
                    id=segment_id,
                    kind=kind,
                    text=_safe_text(segment),
                    locator=locator,
                    metadata=metadata,
                )
                blocks.append(item)
                if kind == "heading":
                    headings.append(item)
                elif kind == "paragraph":
                    paragraphs.append(item)
                elif kind == "list-item":
                    lists.append(item)
                elif kind == "figure":
                    figures.append(item)
                elif kind == "equation":
                    equations.append(item)
            reading_order.append(segment_id)
            locators.append(locator)
        chunks_meta.append(
            {
                "chunk_id": chunk_id,
                "chunk_length": chunk.get("chunk_length"),
                "content": chunk.get("content"),
                "embed": chunk.get("embed"),
                "segment_ids": segment_ids,
            }
        )

    ordered_pages = [pages[number] for number in sorted(pages)]
    locators.extend(page.locator for page in ordered_pages)
    average_confidence = (
        sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    )
    task_id = str(task.get("task_id", ""))
    ingest_job_id = request.configuration.get("ingest_job_id")
    version_info = task.get("version_info")
    server_version = (
        version_info.get("server_version") if isinstance(version_info, dict) else "runtime"
    )
    task_configuration = task.get("configuration")
    ocr_strategy = (
        task_configuration.get("ocr_strategy")
        if isinstance(task_configuration, dict)
        else None
    )
    return DocumentArtifact(
        source_id=request.source_id,
        source_hash=source_hash,
        media_type=infer_media_type(request.source_path, request.media_type),
        extractor="chunkr",
        extractor_version=str(server_version or "runtime"),
        configuration={
            "provider": "chunkr",
            "task_id": task_id,
            "task_status": status,
            "provider_mode": os.getenv("AKP_CHUNKR_MODE", "cloud"),
            "ingest_job_id": ingest_job_id,
            "mapping": "native-chunkr-output",
            "flattened_before_mapping": False,
            "ocr_strategy": ocr_strategy,
            **request.configuration,
        },
        pages=ordered_pages,
        blocks=blocks,
        headings=headings,
        paragraphs=paragraphs,
        lists=lists,
        tables=tables,
        figures=figures,
        equations=equations,
        bounding_boxes=boxes,
        reading_order=reading_order,
        locators=locators,
        warnings=[] if blocks else ["CHUNKR_NO_STRUCTURED_SEGMENTS"],
        quality="PROVIDER_STRUCTURED",
        quality_metrics={
            "structured_units": len(blocks),
            "pages": int(output.get("page_count", len(ordered_pages)) or len(ordered_pages)),
            "chunks": len(chunks_meta),
            "segments": len(blocks),
            "average_confidence": average_confidence,
        },
        chunks=chunks_meta,
        provider_output_metadata={
            "file_name": output.get("file_name"),
            "mime_type": output.get("mime_type"),
            "page_count": output.get("page_count"),
        },
    )


def verify_chunkr_webhook(
    payload: bytes,
    headers: Mapping[str, str],
    *,
    secret: str | None = None,
    now: int | None = None,
    tolerance_seconds: int = 300,
) -> dict[str, Any]:
    """Verify a Svix-signed Chunkr webhook against the raw request bytes."""

    webhook_secret = (secret or os.getenv("AKP_CHUNKR_WEBHOOK_SECRET", "")).strip()
    if not webhook_secret:
        raise CapabilityNotConfigured("AKP_CHUNKR_WEBHOOK_SECRET is not configured")
    msg_id = headers.get("svix-id") or headers.get("Svix-Id")
    timestamp_raw = headers.get("svix-timestamp") or headers.get("Svix-Timestamp")
    signature_raw = headers.get("svix-signature") or headers.get("Svix-Signature")
    if not msg_id or not timestamp_raw or not signature_raw:
        raise DocumentIntelligenceError("Chunkr webhook is missing Svix signature headers")
    try:
        timestamp = int(timestamp_raw)
    except ValueError as error:
        raise DocumentIntelligenceError("Chunkr webhook timestamp is invalid") from error
    current = int(time.time()) if now is None else now
    if tolerance_seconds < 0 or abs(current - timestamp) > tolerance_seconds:
        raise DocumentIntelligenceError("Chunkr webhook timestamp is outside the allowed window")

    encoded_secret = webhook_secret.removeprefix("whsec_")
    try:
        secret_bytes = base64.b64decode(encoded_secret, validate=True)
    except ValueError as error:
        raise DocumentIntelligenceError("Chunkr webhook secret is not valid base64") from error
    signed = f"{msg_id}.{timestamp}.".encode("utf-8") + payload
    expected = base64.b64encode(
        hmac.new(secret_bytes, signed, hashlib.sha256).digest()
    ).decode("ascii")
    candidates = []
    for entry in signature_raw.split():
        version, separator, value = entry.partition(",")
        if separator and version == "v1" and value:
            candidates.append(value)
    if not candidates or not any(hmac.compare_digest(expected, value) for value in candidates):
        raise DocumentIntelligenceError("Chunkr webhook signature verification failed")

    import json

    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DocumentIntelligenceError("Chunkr webhook payload is not valid JSON") from error
    if not isinstance(value, dict):
        raise DocumentIntelligenceError("Chunkr webhook payload is not an object")
    if value.get("event_type") not in {"task.parse.updated", "task.extract.updated"}:
        raise DocumentIntelligenceError("Chunkr webhook event type is not allowed")
    if not value.get("task_id") or value.get("status") not in (_IN_PROGRESS | _TERMINAL):
        raise DocumentIntelligenceError("Chunkr webhook payload has invalid task state")
    return {str(key): item for key, item in value.items()}


class ChunkrAdapter(DocumentIntelligencePort):
    name = "chunkr"
    version = "async-v1"

    def availability(self) -> AdapterAvailability:
        configured = _endpoint()
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=(
                CapabilityStatus.CONFIGURED
                if configured
                else CapabilityStatus.CAPABILITY_NOT_CONFIGURED
            ),
            reason=(
                "ASYNC_TASK_ENDPOINT_CONFIGURED"
                if configured
                else "OSS_OR_CLOUD_SERVICE_NOT_CONFIGURED"
            ),
            media=["pdf", "docx", "pptx", "xlsx", "image"],
            complexities=["complex", "scanned", "formula", "table-heavy"],
            locators=bool(configured),
            structured_output=bool(configured),
            local=bool(configured and configured[1] == "oss"),
            provider=f"chunkr-{configured[1]}" if configured else None,
            benchmark_required=True,
            async_task_lifecycle=True,
            webhook_verification=bool(os.getenv("AKP_CHUNKR_WEBHOOK_SECRET", "").strip()),
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        configured = _endpoint()
        if not configured:
            raise CapabilityNotConfigured("Chunkr OSS/Cloud endpoint is not configured")
        base_url, mode = configured
        headers = _headers(mode)
        timeout_seconds = float(request.configuration.get("timeout_seconds", 300))
        poll_seconds = float(request.configuration.get("poll_interval_seconds", 0.5))
        poll_seconds = min(max(poll_seconds, 0.05), 10.0)
        data = request.source_path.read_bytes()
        encoded = base64.b64encode(data).decode("ascii")
        media_type = infer_media_type(request.source_path, request.media_type)
        body: dict[str, Any] = {
            "file": f"data:{media_type};base64,{encoded}",
            "file_name": request.source_path.name,
            "ocr_strategy": str(request.configuration.get("ocr_strategy", "Auto")),
            "segmentation_strategy": str(
                request.configuration.get("segmentation_strategy", "LayoutAnalysis")
            ),
            "error_handling": "Fail",
        }
        start = time.monotonic()
        try:
            with httpx.Client(
                timeout=min(timeout_seconds, 60.0),
                follow_redirects=False,
                headers=headers,
            ) as client:
                created = client.post(urljoin(base_url + "/", "tasks/parse"), json=body)
                created.raise_for_status()
                task: Any = created.json()
                if not isinstance(task, dict) or not task.get("task_id"):
                    raise DocumentIntelligenceError("Chunkr create task returned no task_id")
                task_id = str(task["task_id"])
                status = str(task.get("status", ""))
                if status not in (_IN_PROGRESS | _TERMINAL):
                    raise DocumentIntelligenceError(
                        f"Chunkr returned unknown task status: {status}"
                    )
                while status in _IN_PROGRESS:
                    if time.monotonic() - start >= timeout_seconds:
                        raise DocumentIntelligenceError(
                            f"Chunkr task {task_id} exceeded configured deadline"
                        )
                    time.sleep(poll_seconds)
                    detail = client.get(
                        urljoin(base_url + "/", f"tasks/{task_id}/parse"),
                        params={"include_chunks": "true", "base64_urls": "false"},
                    )
                    if detail.status_code == 404:
                        detail = client.get(
                            urljoin(base_url + "/", f"tasks/{task_id}"),
                            params={"include_chunks": "true", "base64_urls": "false"},
                        )
                    detail.raise_for_status()
                    task = detail.json()
                    if not isinstance(task, dict):
                        raise DocumentIntelligenceError("Chunkr task detail is not an object")
                    status = str(task.get("status", ""))
                    if status not in (_IN_PROGRESS | _TERMINAL):
                        raise DocumentIntelligenceError(
                            f"Chunkr returned unknown task status: {status}"
                        )
                if status != "Succeeded":
                    message = task.get("message") if isinstance(task, dict) else None
                    raise DocumentIntelligenceError(
                        f"Chunkr task {task_id} ended as {status}: {message or 'no message'}"
                    )
                detail = client.get(
                    urljoin(base_url + "/", f"tasks/{task_id}/parse"),
                    params={"include_chunks": "true", "base64_urls": "false"},
                )
                if detail.status_code == 404:
                    detail = client.get(
                        urljoin(base_url + "/", f"tasks/{task_id}"),
                        params={"include_chunks": "true", "base64_urls": "false"},
                    )
                detail.raise_for_status()
                final_task = detail.json()
        except DocumentIntelligenceError:
            raise
        except (httpx.HTTPError, ValueError, OSError) as error:
            raise DocumentIntelligenceError(f"Chunkr task lifecycle failed: {error}") from error
        if not isinstance(final_task, dict):
            raise DocumentIntelligenceError("Chunkr final task detail is not an object")
        return map_chunkr_task(final_task, request)
