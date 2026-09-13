from __future__ import annotations

from pathlib import Path

import pytest

from app.adapters.docling_native import DoclingAdapter
from app.ports import DocumentExtractionRequest


@pytest.mark.provider_runtime
def test_real_docling_provider_preserves_native_html_structure() -> None:
    """Execute the installed Docling provider instead of a synthetic mapper.

    This test intentionally lives behind the ``docling`` optional dependency.
    CI has a dedicated provider job that installs that locked extra. The
    ordinary extractor environment stays lightweight and may skip this test.
    """

    pytest.importorskip("docling")
    repository_root = Path(__file__).resolve().parents[3]
    source = (
        repository_root
        / "test"
        / "fixtures"
        / "document-intelligence"
        / "complex-layout.html"
    )
    assert source.is_file()

    artifact = DoclingAdapter().extract(
        DocumentExtractionRequest(
            source_path=source,
            source_id="docling-runtime-fixture",
            source_uri="fixture://document-intelligence/complex-layout.html",
            media_type="text/html",
            complexity="complex",
            privacy_policy="LOCAL_ONLY",
        )
    )

    assert artifact.extractor == "docling"
    assert artifact.configuration["mapping"] == "native-docling-document"
    assert artifact.configuration["flattened_before_mapping"] is False
    assert artifact.blocks
    assert artifact.reading_order
    assert all(item_id for item_id in artifact.reading_order)

    text = artifact.text_content()
    assert "Reading order" in text
    assert "Evidence block" in text
    assert "A heading before a table" in text
    assert artifact.tables
    assert any(
        "Signal" in cell
        for table in artifact.tables
        for cell in [*table.headers, *(cell for row in table.rows for cell in row)]
    )

    ids = {item.id for item in artifact.blocks if item.id}
    assert set(artifact.reading_order).issubset(ids)
    assert artifact.quality == "PROVIDER_STRUCTURED"
    assert artifact.quality_metrics["structured_units"] > 0
