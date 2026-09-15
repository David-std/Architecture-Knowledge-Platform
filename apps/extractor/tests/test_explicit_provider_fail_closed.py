from pathlib import Path

import pytest

from app.ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
)
from app.registry import build_default_registry


def test_explicit_unavailable_provider_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "complex.pdf"
    source.write_bytes(b"not-a-real-pdf")
    registry = build_default_registry()
    docling = registry.adapter("docling")
    monkeypatch.setattr(
        docling,
        "availability",
        lambda: AdapterAvailability(
            adapter="docling",
            version="test",
            status=CapabilityStatus.CAPABILITY_NOT_CONFIGURED,
            reason="TEST_PROVIDER_UNAVAILABLE",
            media=["application/pdf"],
            complexities=["complex"],
            local=True,
            ocr=True,
            benchmark_required=True,
        ),
    )

    with pytest.raises(CapabilityNotConfigured, match="TEST_PROVIDER_UNAVAILABLE"):
        registry.route(
            DocumentExtractionRequest(
                source_path=source,
                source_id="fixture",
                media_type="application/pdf",
                complexity="complex",
                configuration={"extractor": "docling"},
            )
        )
