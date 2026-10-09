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


def test_accepts_a_complete_conversion_and_direct_native_document() -> None:
    document = SimpleNamespace(pages={})
    assert document_from_docling_conversion(document) is document
    assert (
        document_from_docling_conversion(
            SimpleNamespace(status=Status.SUCCESS, errors=[], document=document)
        )
        is document
    )


@pytest.mark.parametrize(
    "status", [Status.PARTIAL_SUCCESS, "failure", "skipped", "started", "pending", "unknown", None]
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
