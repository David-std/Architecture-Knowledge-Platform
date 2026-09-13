"""Compatibility/runtime surface for optional document-intelligence providers.

Provider-native mappers live in dedicated modules. This module only wires
runtime configuration that belongs to the optional provider boundary; it never
flattens provider output before constructing ``DocumentArtifact``.
"""

from __future__ import annotations

from typing import Any

from ..models import DocumentArtifact
from ..ports import (
    CapabilityNotConfigured,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
)
from .base import infer_media_type
from .chunkr_runtime import ChunkrAdapter
from .docling_native import DoclingAdapter as _NativeDoclingAdapter
from .docling_native import map_docling_document
from .marker_native import MarkerAdapter


class DoclingAdapter(_NativeDoclingAdapter):
    """Docling runtime with explicit OCR/table policy and native mapping."""

    def _converter(self, request: DocumentExtractionRequest) -> tuple[Any, bool]:
        try:
            from docling.datamodel.base_models import InputFormat  # type: ignore[import-not-found]
            from docling.datamodel.pipeline_options import (  # type: ignore[import-not-found]
                PdfPipelineOptions,
            )
            from docling.document_converter import (  # type: ignore[import-not-found]
                DocumentConverter,
                PdfFormatOption,
            )
        except ImportError as error:
            raise CapabilityNotConfigured("Docling converter API is unavailable") from error

        media_type = infer_media_type(request.source_path, request.media_type)
        ocr_requested = bool(
            request.ocr_required
            or request.complexity == "scanned"
            or media_type.startswith("image/")
        )
        if media_type != "application/pdf":
            return DocumentConverter(), ocr_requested

        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = ocr_requested
        pipeline_options.do_table_structure = True
        timeout = float(request.configuration.get("timeout_seconds", 300))
        if timeout <= 0 or timeout > 900:
            raise DocumentIntelligenceError(
                "Docling timeout_seconds must be between 1 and 900"
            )
        pipeline_options.document_timeout = timeout

        force_full_page = request.configuration.get("force_full_page_ocr")
        ocr_options = getattr(pipeline_options, "ocr_options", None)
        if force_full_page is not None and ocr_options is not None and hasattr(
            ocr_options, "force_full_page_ocr"
        ):
            ocr_options.force_full_page_ocr = bool(force_full_page)

        return (
            DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_options=pipeline_options,
                    )
                }
            ),
            ocr_requested,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        if not self._available():
            raise CapabilityNotConfigured("Docling is not installed")
        try:
            converter, ocr_requested = self._converter(request)
            conversion = converter.convert(str(request.source_path))
            document = getattr(conversion, "document", conversion)
            artifact = map_docling_document(document, request)
            artifact.configuration.update(
                {
                    "native_structure": True,
                    "ocr_requested": ocr_requested,
                    "ocr_engine": "provider-default" if ocr_requested else None,
                }
            )
            return artifact
        except (CapabilityNotConfigured, DocumentIntelligenceError):
            raise
        except Exception as error:  # pragma: no cover - provider-specific API
            raise DocumentIntelligenceError(f"Docling extraction failed: {error}") from error


__all__ = ["ChunkrAdapter", "DoclingAdapter", "MarkerAdapter"]
