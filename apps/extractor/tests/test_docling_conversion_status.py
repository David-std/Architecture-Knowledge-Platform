from __future__ import annotations

import sys
from enum import Enum
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.adapters.docling_native import (
    DoclingAdapter as NativeDoclingAdapter,
)
from app.adapters.docling_native import (
    document_from_docling_conversion,
)
from app.adapters.optional import DoclingAdapter
from app.ports import DocumentExtractionRequest, DocumentIntelligenceError


class Status(str, Enum):
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"


class NumericStatus(Enum):
    SUCCESS = 1
    PARTIAL_SUCCESS = 2
    FAILURE = 3


@pytest.mark.parametrize("status", [Status.SUCCESS, NumericStatus.SUCCESS, "success"])
def test_accepts_a_complete_conversion_and_direct_native_document(status: object) -> None:
    document = SimpleNamespace(pages={})
    assert document_from_docling_conversion(document) is document
    assert (
        document_from_docling_conversion(
            SimpleNamespace(status=status, errors=[], document=document)
        )
        is document
    )


@pytest.mark.parametrize(
    "status",
    [
        Status.PARTIAL_SUCCESS,
        NumericStatus.PARTIAL_SUCCESS,
        NumericStatus.FAILURE,
        "failure",
        "skipped",
        "started",
        "pending",
        "unknown",
        None,
    ]
)
def test_rejects_incomplete_or_unknown_conversion_status(status: object) -> None:
    conversion = SimpleNamespace(status=status, document=SimpleNamespace(pages={}))
    with pytest.raises(DocumentIntelligenceError, match="^DOCLING_CONVERSION_INCOMPLETE$"):
        document_from_docling_conversion(conversion)


def test_complete_status_cannot_hide_provider_errors() -> None:
    conversion = SimpleNamespace(
        status=Status.SUCCESS,
        errors=[SimpleNamespace(error_message="private source bytes and credentials")],
        document=SimpleNamespace(pages={}),
    )
    with pytest.raises(DocumentIntelligenceError, match="^DOCLING_CONVERSION_INCOMPLETE$"):
        document_from_docling_conversion(conversion)


@pytest.mark.parametrize("adapter_type", [NativeDoclingAdapter, DoclingAdapter])
@pytest.mark.parametrize("provider_throws", [False, True])
def test_both_adapters_fail_closed_without_exposing_provider_text(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    adapter_type: type[NativeDoclingAdapter],
    provider_throws: bool,
) -> None:
    def convert(_: str) -> object:
        if provider_throws:
            raise RuntimeError("private source path and provider credential")
        return SimpleNamespace(
            status=Status.PARTIAL_SUCCESS,
            errors=[SimpleNamespace(error_message="private source path and provider credential")],
            document=SimpleNamespace(pages={1: object(), 2: object()}),
        )

    converter = SimpleNamespace(convert=convert)
    monkeypatch.setitem(
        sys.modules,
        "docling.document_converter",
        SimpleNamespace(
            DocumentConverter=lambda: converter,
        ),
    )
    monkeypatch.setattr(adapter_type, "_available", lambda _: True)
    if adapter_type is DoclingAdapter:
        monkeypatch.setattr(DoclingAdapter, "_converter", lambda *_: (converter, False))
    request = DocumentExtractionRequest(
        source_path=tmp_path / "fixture.pdf",
        source_id="fixture",
        media_type="application/pdf",
    )
    expected = "DOCLING_EXTRACTION_FAILED" if provider_throws else "DOCLING_CONVERSION_INCOMPLETE"
    with pytest.raises(DocumentIntelligenceError, match=f"^{expected}$"):
        adapter_type().extract(request)

def test_explicit_tesseract_cli_ocr_is_passed_to_docling_pdf_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The selected CLI OCR must be wired, not merely recorded in metadata."""
    from types import ModuleType

    class Pipeline:
        def __init__(self) -> None:
            self.ocr_options = SimpleNamespace(force_full_page_ocr=False)
            self.do_ocr = False
            self.do_table_structure = False
            self.document_timeout = 0.0

    class CliOptions:
        def __init__(self, *, lang: list[str], scale: float) -> None:
            self.lang = lang
            self.scale = scale
            self.force_full_page_ocr = False

    def module(name: str) -> ModuleType:
        result = ModuleType(name)
        result.__path__ = []  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, name, result)
        return result

    module("docling")
    module("docling.datamodel")
    base_models = module("docling.datamodel.base_models")
    pipeline_options = module("docling.datamodel.pipeline_options")
    converter_module = module("docling.document_converter")
    base_models.InputFormat = SimpleNamespace(PDF="pdf")  # type: ignore[attr-defined]
    pipeline_options.PdfPipelineOptions = Pipeline  # type: ignore[attr-defined]
    pipeline_options.TesseractCliOcrOptions = CliOptions  # type: ignore[attr-defined]
    converter_module.PdfFormatOption = lambda *, pipeline_options: pipeline_options  # type: ignore[attr-defined]
    converter_module.DocumentConverter = lambda **kwargs: kwargs  # type: ignore[attr-defined]
    source = tmp_path / "scanned.pdf"
    source.write_bytes(b"%PDF-synthetic-test-only")
    request = DocumentExtractionRequest(
        source_path=source,
        source_id="tesseract-cli-test",
        media_type="application/pdf",
        complexity="scanned",
        ocr_required=True,
        configuration={
            "ocr_engine": "tesseract_cli",
            "force_full_page_ocr": True,
            "timeout_seconds": 300,
        },
    )
    converter, selected = DoclingAdapter()._converter(request)
    assert selected is True
    configured = converter["format_options"]["pdf"]
    assert configured.do_ocr is True
    assert configured.document_timeout == 300
    assert isinstance(configured.ocr_options, CliOptions)
    assert configured.ocr_options.lang == ["eng"]
    assert configured.ocr_options.force_full_page_ocr is True

    request.configuration["ocr_engine"] = "unsupported-engine"
    with pytest.raises(DocumentIntelligenceError, match="DOCLING_OCR_ENGINE_UNSUPPORTED"):
        DoclingAdapter()._converter(request)

