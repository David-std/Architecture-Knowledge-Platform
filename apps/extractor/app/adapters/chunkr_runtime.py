"""Production Chunkr adapter with durable AKP task correlation.

The native mapping and webhook verifier live in ``chunkr_async``. This runtime
adapter adds the AKP-specific durability invariant: once Chunkr returns a task
ID, the owning ingest job must know that task ID before the extractor waits for
completion. Provider state changes are journaled without changing Chunkr's
native task semantics.
"""

from __future__ import annotations

import base64
import time
from typing import Any
from urllib.parse import urljoin
from uuid import UUID

import httpx

from ..models import ArtifactItem, DocumentArtifact, StructuralLocator
from ..ports import (
    CapabilityNotConfigured,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
)
from ..provider_task_journal import record_provider_task_state
from .base import infer_media_type
from .chunkr_async import (
    _IN_PROGRESS,
    _TERMINAL,
    _endpoint,
    _headers,
    map_chunkr_task,
)
from .chunkr_async import (
    ChunkrAdapter as _NativeChunkrAdapter,
)


def _uuid_source_id(value: str) -> str | None:
    try:
        return str(UUID(value))
    except (TypeError, ValueError, AttributeError):
        return None


def _owner(request: DocumentExtractionRequest) -> tuple[str | None, str | None]:
    configured_job = request.ingest_job_id or request.configuration.get("ingest_job_id")
    job_id = str(configured_job).strip() if configured_job else None
    source_id = _uuid_source_id(request.source_id)
    return job_id, source_id


def _journal(
    request: DocumentExtractionRequest,
    *,
    task_id: str,
    status: str,
    task_type: str | None,
    mode: str,
    phase: str,
) -> None:
    job_id, source_id = _owner(request)
    if job_id is None and source_id is None:
        # Standalone extraction/benchmark calls have no durable ingest owner.
        return
    record_provider_task_state(
        ingest_job_id=job_id,
        source_id=source_id,
        provider="chunkr",
        task_id=task_id,
        status=status,
        task_type=task_type,
        mode=mode,
        metadata={"phase": phase},
    )


def _preserve_chunk_hierarchy(artifact: DocumentArtifact) -> DocumentArtifact:
    """Move Chunkr chunk structure into fields retained by the TS contract.

    ``DocumentArtifact`` intentionally stays provider-neutral. Chunks are
    represented as canonical parent blocks, while provider-native chunk fields
    remain metadata. Segment items point to their parent chunk. This avoids
    relying on a Python-only extra field that would be stripped by a strict
    downstream parser.
    """

    extras = artifact.model_extra or {}
    chunks = extras.get("chunks")
    if not isinstance(chunks, list):
        return artifact

    existing = {item.id for item in artifact.blocks if item.id}
    chunk_parents: list[ArtifactItem] = []
    for index, raw_chunk in enumerate(chunks, start=1):
        if not isinstance(raw_chunk, dict):
            continue
        chunk_id = str(raw_chunk.get("chunk_id") or f"chunk-{index}")
        if chunk_id in existing:
            continue
        locator = StructuralLocator(
            kind="chunk",
            source_hash=artifact.source_hash,
            path=artifact.configuration.get("source_uri")
            if isinstance(artifact.configuration.get("source_uri"), str)
            else artifact.source_id,
            index=index,
        )
        chunk_parents.append(
            ArtifactItem(
                id=chunk_id,
                kind="block",
                text=None,
                locator=locator,
                metadata={
                    "provider": "chunkr",
                    "native_kind": "chunk",
                    "chunk_length": raw_chunk.get("chunk_length"),
                    "content": raw_chunk.get("content"),
                    "embed": raw_chunk.get("embed"),
                    "segment_ids": raw_chunk.get("segment_ids", []),
                },
            )
        )

    for item in [
        *artifact.blocks,
        *artifact.headings,
        *artifact.paragraphs,
        *artifact.lists,
        *artifact.tables,
        *artifact.figures,
        *artifact.equations,
        *artifact.code,
    ]:
        parent_chunk_id = item.metadata.get("chunk_id")
        if isinstance(parent_chunk_id, str) and parent_chunk_id:
            item.parent_id = parent_chunk_id

    if chunk_parents:
        artifact.blocks = [*chunk_parents, *artifact.blocks]
    artifact.configuration = {
        **artifact.configuration,
        "native_chunk_count": len(chunks),
        "chunk_hierarchy_preserved": True,
    }
    provider_meta = extras.get("provider_output_metadata")
    if isinstance(provider_meta, dict):
        artifact.configuration["provider_output_metadata"] = provider_meta
    return artifact


class ChunkrAdapter(_NativeChunkrAdapter):
    """Chunkr Parse task lifecycle plus durable platform correlation."""

    version = "async-durable-v1"

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        configured = _endpoint()
        if not configured:
            raise CapabilityNotConfigured("Chunkr OSS/Cloud endpoint is not configured")
        base_url, mode = configured
        headers = _headers(mode)
        try:
            timeout_seconds = float(request.configuration.get("timeout_seconds", 300))
            poll_seconds = float(request.configuration.get("poll_interval_seconds", 0.5))
        except (TypeError, ValueError) as error:
            raise DocumentIntelligenceError(
                "Chunkr timeout and poll interval must be numeric"
            ) from error
        if timeout_seconds <= 0 or timeout_seconds > 3600:
            raise DocumentIntelligenceError("Chunkr timeout_seconds must be in (0, 3600]")
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
        task_id: str | None = None
        status = ""
        task_type: str | None = None
        last_journaled_status: str | None = None
        final_task: Any = None
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
                task_type = str(task.get("task_type")) if task.get("task_type") else None
                if status not in (_IN_PROGRESS | _TERMINAL):
                    raise DocumentIntelligenceError(
                        f"Chunkr returned unknown task status: {status}"
                    )
                _journal(
                    request,
                    task_id=task_id,
                    status=status,
                    task_type=task_type,
                    mode=mode,
                    phase="created",
                )
                last_journaled_status = status

                while status in _IN_PROGRESS:
                    if time.monotonic() - start >= timeout_seconds:
                        _journal(
                            request,
                            task_id=task_id,
                            status=status,
                            task_type=task_type,
                            mode=mode,
                            phase="deadline-exceeded",
                        )
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
                    task_type = (
                        str(task.get("task_type")) if task.get("task_type") else task_type
                    )
                    if status not in (_IN_PROGRESS | _TERMINAL):
                        raise DocumentIntelligenceError(
                            f"Chunkr returned unknown task status: {status}"
                        )
                    if status != last_journaled_status:
                        _journal(
                            request,
                            task_id=task_id,
                            status=status,
                            task_type=task_type,
                            mode=mode,
                            phase="poll",
                        )
                        last_journaled_status = status

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
            raise DocumentIntelligenceError(
                f"Chunkr task lifecycle failed: {error}"
            ) from error

        if not isinstance(final_task, dict):
            raise DocumentIntelligenceError("Chunkr final task detail is not an object")
        artifact = map_chunkr_task(final_task, request)
        return _preserve_chunk_hierarchy(artifact)
