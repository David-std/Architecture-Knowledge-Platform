from __future__ import annotations

from pathlib import Path

import pytest

from app.adapters.optional import DoclingAdapter
from app.ports import DocumentExtractionRequest


@pytest.mark.provider_runtime
def test_real_docling_provider_preserves_native_html_structure() -> None:
    """Execute the installed Docling provider instead of a synthetic mapper."""

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
    assert artifact.configuration["native_structure"] is True
    assert artifact.configuration["ocr_requested"] is False
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


@pytest.mark.provider_runtime
def test_real_docling_provider_ocr_preserves_scanned_pdf_provenance(
    tmp_path: Path,
) -> None:
    """Force OCR over a raster-only PDF and require grounded native output."""

    pytest.importorskip("docling")
    pytest.importorskip("PIL")
    from PIL import Image, ImageDraw, ImageFont

    source = tmp_path / "scanned-ocr.pdf"
    image = Image.new("RGB", (1654, 2339), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        64,
    )
    draw.multiline_text(
        (120, 260),
        "AKP OCR PROBE 739241\n"
        "Durable document intelligence\n"
        "Native provenance must survive extraction.",
        fill="black",
        font=font,
        spacing=36,
    )
    image.save(source, "PDF", resolution=150.0)

    artifact = DoclingAdapter().extract(
        DocumentExtractionRequest(
            source_path=source,
            source_id="docling-ocr-runtime-fixture",
            source_uri="fixture://document-intelligence/scanned-ocr.pdf",
            media_type="application/pdf",
            complexity="scanned",
            ocr_required=True,
            privacy_policy="LOCAL_ONLY",
            configuration={
                "force_full_page_ocr": True,
                "timeout_seconds": 300,
            },
        )
    )

    normalized = " ".join(artifact.text_content().upper().split())
    assert artifact.extractor == "docling"
    assert artifact.configuration["mapping"] == "native-docling-document"
    assert artifact.configuration["flattened_before_mapping"] is False
    assert artifact.configuration["native_structure"] is True
    assert artifact.configuration["ocr_requested"] is True
    assert artifact.configuration["ocr_engine"] == "provider-default"
    assert "AKP OCR PROBE 739241" in normalized
    assert "DURABLE DOCUMENT INTELLIGENCE" in normalized
    assert artifact.blocks
    assert artifact.pages
    assert any(item.locator.page == 1 for item in artifact.blocks)
    assert any(item.locator.region is not None for item in artifact.blocks)
