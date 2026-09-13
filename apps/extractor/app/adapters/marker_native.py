"""Marker Python-API adapter with native JSON renderer mapping."""

from __future__ import annotations

import importlib.util
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


def _payload(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_payload(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _payload(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        return _payload(value.model_dump(mode="json", exclude_none=True))
    return str(value)


def _block_type(block: dict[str, Any]) -> str:
    raw = block.get("block_type") or block.get("blockType") or block.get("type") or "block"
    return str(getattr(raw, "value", raw)).strip().lower().replace("-", "_")


def _kind(block_type: str) -> str:
    if any(
        token in block_type
        for token in ("title", "sectionheader", "section_header", "heading")
    ):
        return "heading"
    if "table" in block_type:
        return "table"
    if any(token in block_type for token in ("picture", "figure", "image", "chart")):
        return "figure"
    if any(token in block_type for token in ("equation", "formula")):
        return "equation"
    if "code" in block_type:
        return "code"
    if "list" in block_type:
        return "list-item"
    if any(token in block_type for token in ("text", "paragraph", "caption", "footnote")):
        return "paragraph"
    if "page" in block_type:
        return "page"
    return "block"


def _text(block: dict[str, Any]) -> str | None:
    for key in ("text", "content", "html", "markdown"):
        value = block.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _bbox(block: dict[str, Any]) -> BoundingBox | None:
    raw = block.get("bbox") or block.get("polygon")
    if isinstance(raw, dict):
        if {"x", "y", "width", "height"} <= raw.keys():
            try:
                width = float(raw["width"])
                height = float(raw["height"])
                if width > 0 and height > 0:
                    return BoundingBox(
                        x=max(0.0, float(raw["x"])),
                        y=max(0.0, float(raw["y"])),
                        width=width,
                        height=height,
                        unit=str(raw.get("unit", "pixel")),
                    )
            except (TypeError, ValueError):
                pass
        if {"l", "t", "r", "b"} <= raw.keys():
            try:
                left, top, right, bottom = (
                    float(raw["l"]),
                    float(raw["t"]),
                    float(raw["r"]),
                    float(raw["b"]),
                )
                width = abs(right - left)
                height = abs(bottom - top)
                if width > 0 and height > 0:
                    return BoundingBox(
                        x=max(0.0, min(left, right)),
                        y=max(0.0, min(top, bottom)),
                        width=width,
                        height=height,
                        unit=str(raw.get("unit", "pixel")),
                    )
            except (TypeError, ValueError):
                pass
    if isinstance(raw, list) and len(raw) >= 4:
        try:
            xs = [
                float(point[0])
                for point in raw
                if isinstance(point, (list, tuple)) and len(point) >= 2
            ]
            ys = [
                float(point[1])
                for point in raw
                if isinstance(point, (list, tuple)) and len(point) >= 2
            ]
            if xs and ys:
                return BoundingBox(
                    x=max(0.0, min(xs)),
                    y=max(0.0, min(ys)),
                    width=max(xs) - min(xs),
                    height=max(ys) - min(ys),
                    unit="pixel",
                )
        except (TypeError, ValueError):
            pass
    return None


def _page_number(block: dict[str, Any]) -> int | None:
    for key in ("page", "page_id", "page_number", "page_no"):
        value = block.get(key)
        if isinstance(value, int) and value >= 0:
            return value + 1 if key == "page_id" else max(1, value)
    metadata = block.get("metadata")
    if isinstance(metadata, dict):
        return _page_number(metadata)
    return None


def _table(block: dict[str, Any]) -> tuple[list[str], list[list[str]], dict[str, Any]]:
    metadata = block.get("metadata")
    cells = block.get("cells")
    if cells is None and isinstance(metadata, dict):
        cells = metadata.get("cells")
    if not isinstance(cells, list):
        return [], [], {}
    normalized: list[dict[str, Any]] = []
    max_row = 0
    max_col = 0
    for raw_cell in cells:
        if not isinstance(raw_cell, dict):
            continue
        row = raw_cell.get("row", raw_cell.get("row_id", raw_cell.get("row_idx", 0)))
        col = raw_cell.get(
            "col",
            raw_cell.get(
                "column",
                raw_cell.get("col_id", raw_cell.get("col_idx", 0)),
            ),
        )
        if row is None or col is None:
            continue
        try:
            row_i, col_i = int(row), int(col)
        except (TypeError, ValueError):
            continue
        text = str(raw_cell.get("text", raw_cell.get("content", "")) or "")
        max_row = max(max_row, row_i + 1)
        max_col = max(max_col, col_i + 1)
        normalized.append({"row": row_i, "column": col_i, "text": text, "raw": _payload(raw_cell)})
    if not normalized:
        return [], [], {}
    matrix = [["" for _ in range(max_col)] for _ in range(max_row)]
    for cell in normalized:
        matrix[cell["row"]][cell["column"]] = cell["text"]
    return [], matrix, {"marker_cells": normalized}


def map_marker_json(rendered: Any, request: DocumentExtractionRequest) -> DocumentArtifact:
    """Map Marker's JSON renderer tree directly into the canonical artifact."""

    root = (
        rendered.model_dump(mode="json", exclude_none=True)
        if hasattr(rendered, "model_dump")
        else rendered
    )
    if not isinstance(root, dict):
        raise DocumentIntelligenceError("Marker JSON renderer returned a non-object result")
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
    pages: dict[int, PageArtifact] = {}
    reading_order: list[str] = []
    locators: list[StructuralLocator] = [
        StructuralLocator(kind="source", source_hash=source_hash, path=source_ref)
    ]
    boxes: list[BoundingBox] = []

    def walk(block: dict[str, Any], *, parent_id: str | None, path: tuple[int, ...]) -> None:
        block_type = _block_type(block)
        kind = _kind(block_type)
        item_id = str(
            block.get("id")
            or block.get("block_id")
            or block.get("blockId")
            or f"marker-{'-'.join(map(str, path))}"
        )
        page = _page_number(block)
        region = _bbox(block)
        if page is not None and page not in pages:
            page_locator = StructuralLocator(
                kind="page",
                source_hash=source_hash,
                path=source_ref,
                page=page,
            )
            pages[page] = PageArtifact(
                id=f"marker-page-{page}",
                page=page,
                locator=page_locator,
                metadata={"provider": "marker"},
            )
        values: dict[str, Any] = {
            "kind": kind,
            "source_hash": source_hash,
            "path": source_ref,
            "page": page,
            "region": region,
        }
        locator = StructuralLocator.model_validate(
            {key: value for key, value in values.items() if value is not None}
        )
        metadata = block.get("metadata")
        provider_metadata = _payload(metadata) if metadata is not None else {}
        item_metadata: dict[str, Any] = {
            "provider": "marker",
            "marker_block_type": block_type,
            "provider_metadata": provider_metadata,
            "native_path": list(path),
        }
        if "images" in block:
            item_metadata["images"] = _payload(block["images"])
        if region:
            boxes.append(region)

        if kind == "table":
            headers, rows, table_metadata = _table(block)
            table_item = TableArtifact(
                id=item_id,
                kind="table",
                text=_text(block),
                locator=locator,
                parent_id=parent_id,
                headers=headers,
                rows=rows,
                metadata={**item_metadata, **table_metadata},
            )
            blocks.append(table_item)
            tables.append(table_item)
        else:
            artifact_item = ArtifactItem(
                id=item_id,
                kind=kind,
                text=_text(block),
                locator=locator,
                parent_id=parent_id,
                metadata=item_metadata,
            )
            blocks.append(artifact_item)
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
        reading_order.append(item_id)
        locators.append(locator)
        children = block.get("children")
        if isinstance(children, list):
            for index, child in enumerate(children):
                if isinstance(child, dict):
                    walk(child, parent_id=item_id, path=(*path, index))

    children = root.get("children")
    if isinstance(children, list):
        for index, child in enumerate(children):
            if isinstance(child, dict):
                walk(child, parent_id=None, path=(index,))
    else:
        walk(root, parent_id=None, path=(0,))

    ordered_pages = [pages[number] for number in sorted(pages)]
    locators.extend(page.locator for page in ordered_pages)
    warnings: list[str] = []
    if not blocks:
        warnings.append("MARKER_NO_STRUCTURED_ITEMS")

    return DocumentArtifact(
        source_id=request.source_id,
        source_hash=source_hash,
        media_type=infer_media_type(request.source_path, request.media_type),
        extractor="marker",
        extractor_version="runtime",
        configuration={
            "provider": "marker",
            "renderer": "json",
            "mapping": "native-marker-json",
            "flattened_before_mapping": False,
            "ocr_mode": request.configuration.get("ocr_mode", "provider-default"),
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
        code=code,
        bounding_boxes=boxes,
        reading_order=reading_order,
        locators=locators,
        warnings=warnings,
        quality="PROVIDER_STRUCTURED",
        quality_metrics={
            "structured_units": len(blocks),
            "pages": len(ordered_pages),
            "tables": len(tables),
            "figures": len(figures),
        },
    )


class MarkerAdapter(DocumentIntelligencePort):
    name = "marker"
    version = "optional"

    @staticmethod
    def _available() -> bool:
        return importlib.util.find_spec("marker") is not None

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
            reason="PYTHON_API_CONFIGURED" if available else "DEPENDENCY_NOT_INSTALLED:marker-pdf",
            media=["pdf"],
            complexities=["complex", "scanned", "formula", "table-heavy"],
            locators=available,
            structured_output=available,
            local=True,
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        if not self._available():
            raise CapabilityNotConfigured("Marker Python package is not installed")
        try:
            from marker.config.parser import ConfigParser  # type: ignore[import-not-found]
            from marker.converters.pdf import PdfConverter  # type: ignore[import-not-found]
            from marker.models import create_model_dict  # type: ignore[import-not-found]
        except ImportError as error:
            raise CapabilityNotConfigured("Marker Python API is unavailable") from error

        marker_options = request.configuration.get("marker")
        config: dict[str, Any] = {"output_format": "json"}
        if isinstance(marker_options, dict):
            for key, value in marker_options.items():
                if key not in {"output_dir", "filepath", "file", "source"}:
                    config[str(key)] = value
        try:
            parser = ConfigParser(config)
            converter = PdfConverter(
                config=parser.generate_config_dict(),
                artifact_dict=create_model_dict(),
                processor_list=parser.get_processors(),
                renderer=parser.get_renderer(),
                llm_service=parser.get_llm_service(),
            )
            rendered = converter(str(request.source_path))
            return map_marker_json(rendered, request)
        except DocumentIntelligenceError:
            raise
        except Exception as error:
            raise DocumentIntelligenceError(f"Marker extraction failed: {error}") from error
