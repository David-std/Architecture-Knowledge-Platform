"""Native Docling -> DocumentArtifact mapping.

This module intentionally maps Docling's provider-native object graph directly.
It never serializes the document to Markdown/text and then reparses it.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

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


def _enum_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw or "").strip()


def _ref_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        raw = value.get("$ref") or value.get("cref") or value.get("ref")
        return str(raw) if raw else None
    raw = getattr(value, "cref", None) or getattr(value, "ref", None)
    if raw:
        return str(raw)
    if hasattr(value, "model_dump"):
        payload = value.model_dump(mode="json", by_alias=True, exclude_none=True)
        return _ref_value(payload)
    return None


def _safe_payload(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_safe_payload(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _safe_payload(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return _safe_payload(value.model_dump(mode="json", by_alias=True, exclude_none=True))
    return str(value)


def _bbox(provenance: Any) -> tuple[BoundingBox | None, dict[str, Any]]:
    box = getattr(provenance, "bbox", None)
    if box is None and isinstance(provenance, dict):
        box = provenance.get("bbox")
    if box is None:
        return None, {}
    if hasattr(box, "model_dump"):
        raw = box.model_dump(mode="json", exclude_none=True)
    elif isinstance(box, dict):
        raw = box
    else:
        raw = {
            "l": getattr(box, "l", None),
            "t": getattr(box, "t", None),
            "r": getattr(box, "r", None),
            "b": getattr(box, "b", None),
            "coord_origin": getattr(box, "coord_origin", None),
        }
    try:
        left = float(raw["l"])
        top = float(raw["t"])
        right = float(raw["r"])
        bottom = float(raw["b"])
    except (KeyError, TypeError, ValueError):
        return None, {"provider_bbox": _safe_payload(raw)}
    width = abs(right - left)
    height = abs(bottom - top)
    if width <= 0 or height <= 0:
        return None, {"provider_bbox": _safe_payload(raw)}
    region = BoundingBox(
        x=max(0.0, min(left, right)),
        y=max(0.0, min(top, bottom)),
        width=width,
        height=height,
        unit="pt",
    )
    origin = raw.get("coord_origin")
    return region, {
        "provider_bbox": _safe_payload(raw),
        "coordinate_origin": _enum_value(origin) if origin is not None else None,
    }


def _first_provenance(item: Any) -> Any | None:
    value = getattr(item, "prov", None)
    if value is None and isinstance(item, dict):
        value = item.get("prov")
    if isinstance(value, list) and value:
        return value[0]
    return None


def _locator(
    item: Any,
    *,
    source_hash: str,
    source_ref: str,
    kind: str,
    heading_path: list[str] | None = None,
) -> tuple[StructuralLocator, dict[str, Any]]:
    provenance = _first_provenance(item)
    page: int | None = None
    start_char: int | None = None
    end_char: int | None = None
    region: BoundingBox | None = None
    metadata: dict[str, Any] = {}

    if provenance is not None:
        if isinstance(provenance, dict):
            page_raw = provenance.get("page_no")
            charspan = provenance.get("charspan")
        else:
            page_raw = getattr(provenance, "page_no", None)
            charspan = getattr(provenance, "charspan", None)
        if isinstance(page_raw, int) and page_raw > 0:
            page = page_raw
        if isinstance(charspan, (list, tuple)) and len(charspan) == 2:
            if isinstance(charspan[0], int) and charspan[0] >= 0:
                start_char = charspan[0]
            if isinstance(charspan[1], int) and charspan[1] >= (start_char or 0):
                end_char = charspan[1]
        region, bbox_meta = _bbox(provenance)
        metadata.update({key: value for key, value in bbox_meta.items() if value is not None})

    values: dict[str, Any] = {
        "kind": kind,
        "source_hash": source_hash,
        "path": source_ref,
        "page": page,
        "start_char": start_char,
        "end_char": end_char,
        "heading_path": heading_path or [],
        "region": region,
    }
    locator = StructuralLocator.model_validate(
        {key: value for key, value in values.items() if value is not None}
    )
    return locator, metadata


def _text(item: Any) -> str | None:
    for field in ("text", "orig", "content"):
        value = getattr(item, field, None)
        if value is None and isinstance(item, dict):
            value = item.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _children(item: Any) -> list[str]:
    value = getattr(item, "children", None)
    if value is None and isinstance(item, dict):
        value = item.get("children")
    if not isinstance(value, list):
        return []
    return [ref for child in value if (ref := _ref_value(child))]


def _parent(item: Any) -> str | None:
    value = getattr(item, "parent", None)
    if value is None and isinstance(item, dict):
        value = item.get("parent")
    return _ref_value(value)


def _refs(item: Any, field: str) -> list[str]:
    value = getattr(item, field, None)
    if value is None and isinstance(item, dict):
        value = item.get(field)
    if not isinstance(value, list):
        return []
    return [ref for entry in value if (ref := _ref_value(entry))]


def _self_ref(item: Any, fallback: str) -> str:
    value = getattr(item, "self_ref", None)
    if value is None and isinstance(item, dict):
        value = item.get("self_ref")
    ref = _ref_value(value)
    return ref or fallback


def _label(item: Any) -> str:
    value = getattr(item, "label", None)
    if value is None and isinstance(item, dict):
        value = item.get("label")
    return _enum_value(value).lower().replace("-", "_")


def _kind(label: str) -> str:
    if label in {"title", "section_header", "field_heading"}:
        return "heading"
    if label in {"list_item"}:
        return "list-item"
    if label in {"table"}:
        return "table"
    if label in {"picture", "chart"}:
        return "figure"
    if label in {"formula"}:
        return "equation"
    if label in {"code"}:
        return "code"
    if label in {"page"}:
        return "page"
    if label in {"paragraph", "text", "caption", "footnote", "field_value"}:
        return "paragraph"
    return "block"


def _table_data(item: Any) -> tuple[list[str], list[list[str]], dict[str, Any]]:
    data = getattr(item, "data", None)
    if data is None and isinstance(item, dict):
        data = item.get("data")
    cells = getattr(data, "table_cells", None) if data is not None else None
    if cells is None and isinstance(data, dict):
        cells = data.get("table_cells")
    if not isinstance(cells, list):
        return [], [], {"docling_table_data": _safe_payload(data)}

    normalized: list[dict[str, Any]] = []
    max_row = 0
    max_col = 0
    for cell in cells:
        payload = (
            cell.model_dump(mode="json", by_alias=True, exclude_none=True)
            if hasattr(cell, "model_dump")
            else dict(cell) if isinstance(cell, dict) else {}
        )
        row_span = payload.get("row_span")
        row_fallback = row_span[0] if isinstance(row_span, list) and row_span else 0
        row_start = int(payload.get("start_row_offset", row_fallback) or 0)
        row_end = int(payload.get("end_row_offset", row_start + 1) or row_start + 1)
        col_span = payload.get("col_span")
        col_fallback = col_span[0] if isinstance(col_span, list) and col_span else 0
        col_start = int(payload.get("start_col_offset", col_fallback) or 0)
        col_end = int(payload.get("end_col_offset", col_start + 1) or col_start + 1)
        text = str(payload.get("text", "") or "")
        max_row = max(max_row, row_end)
        max_col = max(max_col, col_end)
        normalized.append(
            {
                "row_start": row_start,
                "row_end": row_end,
                "col_start": col_start,
                "col_end": col_end,
                "text": text,
                "column_header": bool(payload.get("column_header", False)),
                "row_header": bool(payload.get("row_header", False)),
                "raw": _safe_payload(payload),
            }
        )

    if max_row <= 0 or max_col <= 0:
        return [], [], {"docling_table_cells": normalized}

    matrix = [["" for _ in range(max_col)] for _ in range(max_row)]
    for cell in normalized:
        for row in range(max(0, cell["row_start"]), min(max_row, cell["row_end"])):
            for column in range(max(0, cell["col_start"]), min(max_col, cell["col_end"])):
                if not matrix[row][column]:
                    matrix[row][column] = cell["text"]

    header_rows = {
        cell["row_start"]
        for cell in normalized
        if cell["column_header"] and cell["row_start"] < max_row
    }
    if header_rows:
        header_index = min(header_rows)
        headers = matrix[header_index]
        rows = [row for index, row in enumerate(matrix) if index != header_index]
    else:
        headers = []
        rows = matrix
    return headers, rows, {"docling_table_cells": normalized}


def _page_artifacts(
    document: Any, *, source_hash: str, source_ref: str
) -> list[PageArtifact]:
    pages = getattr(document, "pages", {}) or {}
    if not isinstance(pages, dict):
        return []
    result: list[PageArtifact] = []
    for raw_number, page in sorted(pages.items(), key=lambda pair: int(pair[0])):
        try:
            number = int(raw_number)
        except (TypeError, ValueError):
            continue
        if number <= 0:
            continue
        size = getattr(page, "size", None)
        if size is None and isinstance(page, dict):
            size = page.get("size")
        metadata = {"docling_page": _safe_payload(page)}
        if size is not None:
            metadata["size"] = _safe_payload(size)
        locator = StructuralLocator(
            kind="page",
            source_hash=source_hash,
            path=source_ref,
            page=number,
        )
        result.append(
            PageArtifact(
                id=f"docling-page-{number}",
                page=number,
                locator=locator,
                metadata=metadata,
            )
        )
    return result


def map_docling_document(
    document: Any,
    request: DocumentExtractionRequest,
) -> DocumentArtifact:
    """Map a ``DoclingDocument`` object graph without any text/Markdown round trip."""

    source_hash = sha256_path(request.source_path)
    source_ref = request.source_uri or request.source_id
    blocks: list[ArtifactItem | TableArtifact] = []
    headings: list[ArtifactItem] = []
    paragraphs: list[ArtifactItem] = []
    lists: list[ArtifactItem] = []
    tables: list[TableArtifact] = []
    figures: list[ArtifactItem] = []
    equations: list[ArtifactItem] = []
    code: list[ArtifactItem] = []
    reading_order: list[str] = []
    locators: list[StructuralLocator] = [
        StructuralLocator(kind="source", source_hash=source_hash, path=source_ref)
    ]
    bounding_boxes: list[BoundingBox] = []
    heading_stack: list[str] = []

    iterator = getattr(document, "iterate_items", None)
    if not callable(iterator):
        raise DocumentIntelligenceError("DoclingDocument does not expose iterate_items()")

    seen: set[str] = set()
    try:
        entries: Iterable[tuple[Any, int]] = iterator(
            with_groups=True,
            traverse_pictures=True,
        )
        for sequence, (item, level) in enumerate(entries, start=1):
            ref = _self_ref(item, f"docling-{sequence}")
            if ref in seen:
                continue
            seen.add(ref)
            label = _label(item)
            kind = _kind(label)
            text = _text(item)
            if kind == "heading" and text:
                heading_level = getattr(item, "level", None)
                if not isinstance(heading_level, int) or heading_level < 1:
                    heading_level = max(1, int(level or 1))
                heading_stack = heading_stack[: heading_level - 1] + [text]

            locator, provenance_meta = _locator(
                item,
                source_hash=source_hash,
                source_ref=source_ref,
                kind=kind,
                heading_path=heading_stack,
            )
            if locator.region:
                bounding_boxes.append(locator.region)
            metadata: dict[str, Any] = {
                "provider": "docling",
                "docling_label": label,
                "docling_ref": ref,
                "tree_level": level,
                "children": _children(item),
                "parent": _parent(item),
                "captions": _refs(item, "captions"),
                "references": _refs(item, "references"),
                "footnotes": _refs(item, "footnotes"),
                **provenance_meta,
            }
            content_layer = getattr(item, "content_layer", None)
            if content_layer is not None:
                metadata["content_layer"] = _enum_value(content_layer)
            raw_meta = getattr(item, "meta", None)
            if raw_meta is not None:
                metadata["provider_metadata"] = _safe_payload(raw_meta)

            if kind == "table":
                headers, rows, table_meta = _table_data(item)
                table = TableArtifact(
                    id=ref,
                    text=text,
                    locator=locator,
                    parent_id=_parent(item),
                    headers=headers,
                    rows=rows,
                    caption=None,
                    metadata={**metadata, **table_meta},
                )
                blocks.append(table)
                tables.append(table)
                reading_order.append(ref)
                locators.append(locator)
                continue

            artifact_item = ArtifactItem(
                id=ref,
                kind=kind,
                text=text,
                locator=locator,
                parent_id=_parent(item),
                metadata=metadata,
            )
            blocks.append(artifact_item)
            locators.append(locator)
            if kind != "block" or text:
                reading_order.append(ref)
            if kind == "heading":
                headings.append(artifact_item)
            elif kind == "paragraph":
                paragraphs.append(artifact_item)
            elif kind == "list-item":
                lists.append(artifact_item)
            elif kind == "figure":
                figures.append(artifact_item)
            elif kind == "equation":
                equations.append(artifact_item)
            elif kind == "code":
                code.append(artifact_item)
    except DocumentIntelligenceError:
        raise
    except Exception as error:
        raise DocumentIntelligenceError(
            f"Docling native structure mapping failed: {error}"
        ) from error

    pages = _page_artifacts(document, source_hash=source_hash, source_ref=source_ref)
    locators.extend(page.locator for page in pages)
    doc_version = getattr(document, "version", None)
    warnings: list[str] = []
    if not blocks:
        warnings.append("DOCLING_NO_STRUCTURED_ITEMS")

    return DocumentArtifact(
        source_id=request.source_id,
        source_hash=source_hash,
        media_type=infer_media_type(request.source_path, request.media_type),
        extractor="docling",
        extractor_version=str(doc_version or "runtime"),
        configuration={
            "provider": "docling",
            "mapping": "native-docling-document",
            "flattened_before_mapping": False,
            **request.configuration,
        },
        pages=pages,
        blocks=blocks,
        headings=headings,
        paragraphs=paragraphs,
        lists=lists,
        tables=tables,
        figures=figures,
        equations=equations,
        code=code,
        bounding_boxes=bounding_boxes,
        reading_order=reading_order,
        locators=locators,
        warnings=warnings,
        quality="PROVIDER_STRUCTURED",
        quality_metrics={
            "structured_units": len(blocks),
            "locator_count": len(locators),
            "pages": len(pages),
            "tables": len(tables),
            "figures": len(figures),
        },
    )


class DoclingAdapter(DocumentIntelligencePort):
    name = "docling"
    version = "optional"

    @staticmethod
    def _available() -> bool:
        try:
            import importlib.util

            return importlib.util.find_spec("docling") is not None
        except (ImportError, AttributeError):
            return False

    def availability(self) -> AdapterAvailability:
        available = self._available()
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=(
                CapabilityStatus.CONFIGURED
                if available
                else CapabilityStatus.CAPABILITY_NOT_CONFIGURED
            ),
            reason=(
                "python-package-installed"
                if available
                else "DEPENDENCY_NOT_INSTALLED:docling"
            ),
            media=["pdf", "docx", "pptx", "xlsx", "html", "image"],
            complexities=["simple", "digital", "complex", "scanned", "formula", "table-heavy"],
            locators=available,
            structured_output=available,
            local=True,
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        if not self._available():
            raise CapabilityNotConfigured("Docling is not installed")
        try:
            from docling.document_converter import (  # type: ignore[import-not-found]
                DocumentConverter,
            )
        except ImportError as error:
            raise CapabilityNotConfigured("Docling converter API is unavailable") from error
        try:
            conversion = DocumentConverter().convert(str(request.source_path))
            document = getattr(conversion, "document", conversion)
            return map_docling_document(document, request)
        except DocumentIntelligenceError:
            raise
        except Exception as error:
            raise DocumentIntelligenceError(f"Docling extraction failed: {error}") from error
