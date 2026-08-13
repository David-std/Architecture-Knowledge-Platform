"""Shared helpers for canonical artifact adapters."""

from __future__ import annotations

import hashlib
import mimetypes
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from ..models import Artifact, ArtifactItem, DocumentArtifact, StructuralLocator, TableArtifact


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def infer_media_type(path: Path, declared: str | None = None) -> str:
    if declared and declared != "application/octet-stream":
        return declared
    guessed, _ = mimetypes.guess_type(path.name)
    if guessed:
        return guessed
    if path.suffix.lower() in {".md", ".markdown"}:
        return "text/markdown"
    if path.suffix.lower() == ".txt":
        return "text/plain"
    return "application/octet-stream"


def locator_dict(locator: StructuralLocator) -> dict[str, Any]:
    return locator.model_dump(exclude_none=True)


def flatten_document_artifact(document: DocumentArtifact) -> list[Artifact]:
    """Create the pre-canonical list consumed by existing API clients."""

    flattened: list[Artifact] = []
    page_kind = {
        "text/markdown": "text",
        "text/plain": "text",
        "text/html": "html-text",
        "application/pdf": "pdf-page-text",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx-slide-text",
    }.get(document.media_type, f"{document.media_type}-page-text")
    for page in document.pages:
        flattened.append(
            Artifact(
                kind=page_kind,
                content=page.text,
                locator=locator_dict(page.locator),
                warnings=document.warnings,
                quality=document.quality,
            )
        )
    semantic_items: Iterable[ArtifactItem | TableArtifact] = (
        *document.blocks,
        *document.tables,
        *document.figures,
    )
    for item in semantic_items:
        content = item.text
        legacy_kind = item.kind
        if document.media_type.endswith("wordprocessingml.document"):
            legacy_kind = {
                "paragraph": "docx-paragraph-text",
                "heading": "docx-paragraph-text",
                "table": "docx-table-row-text",
            }.get(item.kind, item.kind)
        elif document.media_type.endswith("presentationml.presentation"):
            legacy_kind = "pptx-slide-text"
        if isinstance(item, TableArtifact):
            rows = [item.headers, *item.rows] if item.headers else item.rows
            content = "\n".join(" | ".join(row) for row in rows) or content
        flattened.append(
            Artifact(
                kind=legacy_kind,
                content=content,
                locator=locator_dict(item.locator),
                warnings=document.warnings,
                quality=document.quality,
            )
        )
    if not flattened:
        flattened.append(
            Artifact(
                kind="document-empty",
                locator={"kind": "document", "path": document.source_id, "source_hash": document.source_hash},
                warnings=[*document.warnings, "NO_STRUCTURED_CONTENT"],
                quality=document.quality,
            )
        )
    return flattened
