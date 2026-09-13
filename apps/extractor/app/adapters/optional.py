"""Honest optional adapters for Docling, Marker and Chunkr.

The base image intentionally does not install these providers. Each adapter
reports that fact and raises ``CAPABILITY_NOT_CONFIGURED`` until a real local
dependency, executable or explicitly configured service is available. No
deterministic text fallback is returned from an unavailable optional adapter.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import shlex
import shutil
import subprocess
from pathlib import Path
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
from .deterministic import artifact_from_text


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "optional"


def _enum_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw or "").strip().lower()


def _docling_kind(item: Any) -> str:
    label = _enum_value(getattr(item, "label", ""))
    class_name = type(item).__name__.lower()
    if label in {"title", "section_header"}:
        return "heading"
    if label in {"list_item"}:
        return "list"
    if label in {"table", "document_index"} or "tableitem" in class_name:
        return "table"
    if label in {"picture"} or "pictureitem" in class_name:
        return "figure"
    if label in {"formula"} or "formula" in class_name:
        return "equation"
    if label in {"code"} or "codeitem" in class_name:
        return "code"
    if label in {
        "text",
        "paragraph",
        "caption",
        "footnote",
        "page_header",
        "page_footer",
        "checkbox_selected",
        "checkbox_unselected",
    }:
        return "paragraph"
    return "block"


def _docling_text(item: Any, document: Any) -> str | None:
    text = getattr(item, "text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    exporter = getattr(item, "export_to_text", None)
    if callable(exporter):
        for call in (
            lambda: exporter(doc=document),
            lambda: exporter(document),
            lambda: exporter(),
        ):
            try:
                value = call()
            except (TypeError, ValueError, AttributeError):
                continue
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _docling_bbox(provenance: Any) -> BoundingBox | None:
    bbox = getattr(provenance, "bbox", None)
    if bbox is None:
        return None
    left = getattr(bbox, "l", None)
    top = getattr(bbox, "t", None)
    right = getattr(bbox, "r", None)
    bottom = getattr(bbox, "b", None)
    if not all(isinstance(value, (int, float)) for value in (left, top, right, bottom)):
        return None
    x = max(0.0, float(min(left, right)))
    y = max(0.0, float(min(top, bottom)))
    width = abs(float(right) - float(left))
    height = abs(float(bottom) - float(top))
    if width <= 0 or height <= 0:
        return None
    return BoundingBox(x=x, y=y, width=width, height=height, unit="point")


def _docling_charspan(provenance: Any) -> tuple[int | None, int | None]:
    span = getattr(provenance, "charspan", None)
    if isinstance(span, (tuple, list)) and len(span) >= 2:
        start, end = span[0], span[1]
        return (
            int(start) if isinstance(start, int) and start >= 0 else None,
            int(end) if isinstance(end, int) and end >= 0 else None,
        )
    return None, None


def _docling_provenance(item: Any) -> list[Any]:
    value = getattr(item, "prov", None)
    if isinstance(value, (tuple, list)):
        return list(value)
    return []


def _docling_locator(
    item: Any,
    *,
    source_hash: str,
    source_ref: str,
    kind: str,
    heading_path: list[str],
    index: int,
) -> tuple[StructuralLocator, list[BoundingBox], list[dict[str, Any]]]:
    provenance = _docling_provenance(item)
    primary = provenance[0] if provenance else None
    page = getattr(primary, "page_no", None) if primary is not None else None
    if not isinstance(page, int) or page <= 0:
        page = None
    start_char, end_char = _docling_charspan(primary) if primary is not None else (None, None)
    region = _docling_bbox(primary) if primary is not None else None
    locator = StructuralLocator(
        kind=kind,
        source_hash=source_hash,
        path=source_ref,
        page=page,
        index=index,
        start_char=start_char,
        end_char=end_char,
        heading_path=heading_path,
        region=region,
    )
    boxes: list[BoundingBox] = []
    metadata: list[dict[str, Any]] = []
    for entry in provenance:
        entry_page = getattr(entry, "page_no", None)
        entry_box = _docling_bbox(entry)
        entry_start, entry_end = _docling_charspan(entry)
        if entry_box is not None:
            boxes.append(entry_box)
        metadata.append(
            {
                "page": entry_page if isinstance(entry_page, int) and entry_page > 0 else None,
                "start_char": entry_start,
                "end_char": entry_end,
                "region": entry_box.model_dump(mode="json") if entry_box is not None else None,
            }
        )
    return locator, boxes, metadata


def _docling_table(item: Any, document: Any) -> tuple[list[str], list[list[str]]]:
    exporter = getattr(item, "export_to_dataframe", None)
    if not callable(exporter):
        return [], []
    dataframe: Any = None
    for call in (lambda: exporter(doc=document), lambda: exporter(document)):
        try:
            dataframe = call()
            break
        except (TypeError, ValueError, AttributeError):
            continue
    if dataframe is None:
        return [], []
    try:
        headers = [str(value) for value in list(dataframe.columns)]
        rows = [
            ["" if value is None else str(value) for value in row]
            for row in dataframe.itertuples(index=False, name=None)
        ]
        return headers, rows
    except (AttributeError, TypeError):
        return [], []


def _docling_caption(item: Any, document: Any) -> str | None:
    caption = getattr(item, "caption_text", None)
    if not callable(caption):
        return None
    for call in (lambda: caption(doc=document), lambda: caption(document)):
        try:
            value = call()
        except (TypeError, ValueError, AttributeError):
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _artifact_from_docling_document(
    request: DocumentExtractionRequest,
    document: Any,
    *,
    version: str,
    ocr_requested: bool,
    ocr_engine: str | None,
) -> DocumentArtifact:
    source_hash = sha256_path(request.source_path)
    source_ref = f"source:{request.source_id}"
    media_type = infer_media_type(request.source_path, request.media_type)
    blocks: list[ArtifactItem] = []
    headings: list[ArtifactItem] = []
    paragraphs: list[ArtifactItem] = []
    lists: list[ArtifactItem] = []
    tables: list[TableArtifact] = []
    figures: list[ArtifactItem] = []
    equations: list[ArtifactItem] = []
    code: list[ArtifactItem] = []
    reading_order: list[str] = []
    locators: list[StructuralLocator] = []
    bounding_boxes: list[BoundingBox] = []
    page_text: dict[int, list[str]] = {}
    heading_stack: list[tuple[int, str]] = []

    iterator = getattr(document, "iterate_items", None)
    if not callable(iterator):
        raise DocumentIntelligenceError("Docling document does not expose native item iteration")

    try:
        native_items = iterator(with_groups=False, traverse_pictures=True)
    except TypeError:
        native_items = iterator()

    for position, entry in enumerate(native_items, start=1):
        if isinstance(entry, tuple) and len(entry) >= 2:
            item, raw_level = entry[0], entry[1]
        else:
            item, raw_level = entry, 0
        level = raw_level if isinstance(raw_level, int) and raw_level >= 0 else 0
        kind = _docling_kind(item)
        text = _docling_text(item, document)

        if kind == "heading" and text:
            heading_stack = [(depth, title) for depth, title in heading_stack if depth < level]
            heading_stack.append((level, text))
        heading_path = [title for _, title in heading_stack]

        locator, boxes, native_provenance = _docling_locator(
            item,
            source_hash=source_hash,
            source_ref=source_ref,
            kind=kind,
            heading_path=heading_path,
            index=position,
        )
        item_id = f"docling-{kind}-{position}"
        metadata = {
            "docling_label": _enum_value(getattr(item, "label", "")),
            "docling_ref": str(getattr(item, "self_ref", "") or ""),
            "docling_level": level,
            "docling_provenance": native_provenance,
        }
        if kind == "table":
            headers, rows = _docling_table(item, document)
            table = TableArtifact(
                id=item_id,
                text=text,
                locator=locator,
                metadata=metadata,
                headers=headers,
                rows=rows,
                caption=_docling_caption(item, document),
            )
            artifact_item: ArtifactItem = table
            tables.append(table)
        else:
            artifact_item = ArtifactItem(
                id=item_id,
                kind=kind,
                text=text,
                locator=locator,
                metadata=metadata,
            )
            if kind == "heading":
                headings.append(artifact_item)
            elif kind == "paragraph":
                paragraphs.append(artifact_item)
            elif kind == "list":
                lists.append(artifact_item)
            elif kind == "figure":
                figures.append(artifact_item)
            elif kind == "equation":
                equations.append(artifact_item)
            elif kind == "code":
                code.append(artifact_item)

        blocks.append(artifact_item)
        reading_order.append(item_id)
        locators.append(locator)
        bounding_boxes.extend(boxes)
        if locator.page is not None and text:
            page_text.setdefault(locator.page, []).append(text)

    if not blocks:
        raise DocumentIntelligenceError("Docling returned no native document items")

    pages = [
        PageArtifact(
            id=f"docling-page-{page_number}",
            text="\n\n".join(texts),
            page=page_number,
            locator=StructuralLocator(
                kind="page",
                source_hash=source_hash,
                path=source_ref,
                page=page_number,
            ),
            metadata={"provider": "docling"},
        )
        for page_number, texts in sorted(page_text.items())
    ]
    locators.extend(page.locator for page in pages)

    return DocumentArtifact(
        source_id=request.source_id,
        source_hash=source_hash,
        media_type=media_type,
        extractor="docling",
        extractor_version=version,
        configuration={
            "provider": "docling",
            "conversion": "local",
            "native_structure": True,
            "ocr_requested": ocr_requested,
            "ocr_engine": ocr_engine or "provider-default",
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
        quality_metrics={
            "native_items": len(blocks),
            "pages_with_provenance": len(pages),
            "tables": len(tables),
            "figures": len(figures),
            "equations": len(equations),
        },
    )


def _docling_converter(request: DocumentExtractionRequest) -> tuple[Any, bool, str | None]:
    try:
        from docling.datamodel.base_models import InputFormat  # type: ignore[import-not-found]
        from docling.datamodel.pipeline_options import (  # type: ignore[import-not-found]
            PdfPipelineOptions,
            TesseractCliOcrOptions,
        )
        from docling.document_converter import (  # type: ignore[import-not-found]
            DocumentConverter,
            PdfFormatOption,
        )
    except ImportError as error:
        raise CapabilityNotConfigured("Docling converter API is unavailable") from error

    media_type = infer_media_type(request.source_path, request.media_type)
    ocr_requested = bool(
        request.configuration.get(
            "ocr",
            request.complexity == "scanned" or media_type.startswith("image/"),
        )
    )
    ocr_engine = str(request.configuration.get("ocr_engine", "")).strip().lower() or None
    format_options: dict[Any, Any] = {}
    if media_type == "application/pdf":
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = ocr_requested
        pipeline_options.do_table_structure = True
        timeout = float(request.configuration.get("timeout_seconds", 300))
        if timeout <= 0:
            raise DocumentIntelligenceError("Docling timeout_seconds must be positive")
        pipeline_options.document_timeout = timeout
        if ocr_requested and ocr_engine == "tesseract-cli":
            pipeline_options.ocr_options = TesseractCliOcrOptions(
                force_full_page_ocr=bool(
                    request.configuration.get("force_full_page_ocr", True)
                )
            )
        format_options[InputFormat.PDF] = PdfFormatOption(
            pipeline_options=pipeline_options
        )
    return DocumentConverter(format_options=format_options), ocr_requested, ocr_engine


class DoclingAdapter(DocumentIntelligencePort):
    name = "docling"
    version = "optional"

    def availability(self) -> AdapterAvailability:
        available = _has_module("docling")
        version = _package_version("docling") if available else self.version
        return AdapterAvailability(
            adapter=self.name,
            version=version,
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
            complexities=[
                "digital",
                "complex",
                "scanned",
                "formula",
                "table-heavy",
            ],
            locators=available,
            structured_output=available,
            local=True,
            provider="docling",
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        if not _has_module("docling"):
            raise CapabilityNotConfigured("Docling is not installed")
        try:
            converter, ocr_requested, ocr_engine = _docling_converter(request)
            conversion = converter.convert(str(request.source_path))
            document = getattr(conversion, "document", conversion)
            return _artifact_from_docling_document(
                request,
                document,
                version=_package_version("docling"),
                ocr_requested=ocr_requested,
                ocr_engine=ocr_engine,
            )
        except (CapabilityNotConfigured, DocumentIntelligenceError):
            raise
        except Exception as error:  # pragma: no cover - provider-specific API
            raise DocumentIntelligenceError(f"Docling extraction failed: {error}") from error


class MarkerAdapter(DocumentIntelligencePort):
    name = "marker"
    version = "optional"

    def _command(self) -> list[str] | None:
        configured = os.getenv("AKP_MARKER_COMMAND", "").strip()
        if not configured:
            executable = shutil.which("marker_single") or shutil.which("marker")
            return [executable] if executable else None
        command = shlex.split(configured)
        if not command:
            return None
        if shutil.which(command[0]) is None and not Path(command[0]).exists():
            return None
        return command

    def availability(self) -> AdapterAvailability:
        command = self._command()
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=(
                CapabilityStatus.CONFIGURED
                if command
                else CapabilityStatus.CAPABILITY_NOT_CONFIGURED
            ),
            reason=(
                "CLI_CONFIGURED"
                if command
                else "DEPENDENCY_OR_COMMAND_NOT_CONFIGURED"
            ),
            media=["pdf"],
            complexities=["complex", "scanned", "formula", "table-heavy"],
            locators=bool(command),
            structured_output=bool(command),
            local=True,
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        command = self._command()
        if not command:
            raise CapabilityNotConfigured("Marker executable is not configured")
        try:
            completed = subprocess.run(
                [*command, str(request.source_path)],
                capture_output=True,
                text=True,
                check=False,
                timeout=float(request.configuration.get("timeout_seconds", 300)),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise DocumentIntelligenceError(f"Marker invocation failed: {error}") from error
        if completed.returncode != 0:
            raise DocumentIntelligenceError(
                f"Marker returned exit code {completed.returncode}: "
                f"{completed.stderr[-500:]}"
            )
        output = completed.stdout.strip()
        if not output:
            raise DocumentIntelligenceError(
                "Marker returned no stdout; output directory integration is not configured"
            )
        return artifact_from_text(
            request,
            output,
            extractor=self.name,
            media_type="application/pdf",
            warnings=["MARKER_CLI_OUTPUT_NORMALIZED_TO_CANONICAL_MARKDOWN"],
        )


class ChunkrAdapter(DocumentIntelligencePort):
    name = "chunkr"
    version = "optional"

    def _endpoint(self) -> str | None:
        endpoint = os.getenv("AKP_CHUNKR_ENDPOINT", "").strip()
        return endpoint or None

    def availability(self) -> AdapterAvailability:
        endpoint = self._endpoint()
        mode = os.getenv("AKP_CHUNKR_MODE", "cloud" if endpoint else "oss")
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=(
                CapabilityStatus.CONFIGURED
                if endpoint
                else CapabilityStatus.CAPABILITY_NOT_CONFIGURED
            ),
            reason=(
                "ENDPOINT_CONFIGURED"
                if endpoint
                else "OSS_OR_CLOUD_SERVICE_NOT_CONFIGURED"
            ),
            media=["pdf", "docx", "pptx", "image"],
            complexities=["complex", "scanned", "formula", "table-heavy"],
            locators=bool(endpoint),
            structured_output=bool(endpoint),
            local=mode.lower() == "oss",
            provider=f"chunkr-{mode.lower()}",
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        endpoint = self._endpoint()
        if not endpoint:
            raise CapabilityNotConfigured("Chunkr OSS/Cloud endpoint is not configured")
        try:
            import httpx

            with httpx.Client(
                timeout=float(request.configuration.get("timeout_seconds", 300))
            ) as client:
                with request.source_path.open("rb") as stream:
                    response = client.post(
                        endpoint,
                        files={
                            "file": (
                                request.source_path.name,
                                stream,
                                request.media_type,
                            )
                        },
                        data={"source_id": request.source_id},
                    )
                response.raise_for_status()
                payload: Any = response.json()
        except Exception as error:  # pragma: no cover - service is opt-in
            raise DocumentIntelligenceError(f"Chunkr request failed: {error}") from error
        if (
            isinstance(payload, dict)
            and "source_hash" in payload
            and "blocks" in payload
        ):
            try:
                return DocumentArtifact.model_validate(payload)
            except Exception as error:
                raise DocumentIntelligenceError(
                    f"Chunkr response is not canonical: {error}"
                ) from error
        if isinstance(payload, dict) and isinstance(payload.get("text"), str):
            return artifact_from_text(
                request,
                payload["text"],
                extractor=self.name,
                warnings=[
                    "CHUNKR_RESPONSE_NORMALIZED_FROM_TEXT",
                    "VERIFY_STRUCTURED_LOCATORS",
                ],
            )
        raise DocumentIntelligenceError(
            "Chunkr response contains neither canonical artifact fields nor text"
        )