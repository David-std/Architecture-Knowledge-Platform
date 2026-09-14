from __future__ import annotations

from pathlib import Path

import pytest

from app.adapters.deterministic import DeterministicTextAdapter
from app.models import DocumentArtifact
from app.ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    CostPolicy,
    DocumentExtractionRequest,
    DocumentIntelligencePort,
    PrivacyPolicy,
)
from app.registry import ExtractorRegistry


class _CapabilityAdapter(DocumentIntelligencePort):
    def __init__(
        self,
        name: str,
        *,
        local: bool,
        ocr: bool = False,
        transcription: bool = False,
        benchmark_required: bool = False,
        paid: bool = False,
        external_network: bool = False,
    ) -> None:
        self.name = name
        self.version = "test"
        self._availability = AdapterAvailability(
            adapter=name,
            version="test",
            status=CapabilityStatus.CONFIGURED,
            media=["application/pdf", "audio/*", "video/*"],
            complexities=["complex", "scanned", "media"],
            local=local,
            ocr=ocr,
            transcription=transcription,
            benchmark_required=benchmark_required,
            paid=paid,
            external_network=external_network,
        )

    def availability(self) -> AdapterAvailability:
        return self._availability

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        raise AssertionError("routing tests must not execute providers")


def _source(tmp_path: Path, suffix: str = ".pdf") -> Path:
    source = tmp_path / f"fixture{suffix}"
    source.write_bytes(b"fixture")
    return source


def _registry(*adapters: DocumentIntelligencePort) -> ExtractorRegistry:
    registry = ExtractorRegistry()
    registry.register(
        DeterministicTextAdapter(),
        media={"application/pdf"},
        complexities={"complex", "scanned"},
        priority=100,
    )
    for index, adapter in enumerate(adapters, start=1):
        registry.register(
            adapter,
            media={"application/pdf", "audio/*", "video/*"},
            complexities={"complex", "scanned", "media"},
            priority=10 + index,
        )
    return registry


def test_local_only_rejects_explicit_remote_provider(tmp_path: Path) -> None:
    registry = _registry(
        _CapabilityAdapter("chunkr", local=False, external_network=True)
    )
    with pytest.raises(CapabilityNotConfigured, match="PRIVACY_POLICY_LOCAL_ONLY"):
        registry.route(
            DocumentExtractionRequest(
                source_path=_source(tmp_path),
                source_id="fixture",
                media_type="application/pdf",
                complexity="complex",
                privacy_policy=PrivacyPolicy.LOCAL_ONLY,
                configuration={"extractor": "chunkr"},
            )
        )


def test_no_paid_rejects_remote_provider_even_when_explicit(tmp_path: Path) -> None:
    registry = _registry(
        _CapabilityAdapter(
            "chunkr", local=False, paid=True, external_network=True
        )
    )
    with pytest.raises(CapabilityNotConfigured, match="COST_POLICY_NO_PAID"):
        registry.route(
            DocumentExtractionRequest(
                source_path=_source(tmp_path),
                source_id="fixture",
                media_type="application/pdf",
                complexity="complex",
                cost_policy=CostPolicy.NO_PAID,
                privacy_policy=PrivacyPolicy.REMOTE_ALLOWED,
                configuration={"extractor": "chunkr"},
            )
        )


def test_chunkr_requires_explicit_opt_in_and_then_becomes_eligible(
    tmp_path: Path,
) -> None:
    registry = _registry(
        _CapabilityAdapter("chunkr", local=False, external_network=True)
    )
    source = _source(tmp_path)
    default_decision = registry.route(
        DocumentExtractionRequest(
            source_path=source,
            source_id="fixture",
            media_type="application/pdf",
            complexity="complex",
            privacy_policy=PrivacyPolicy.REMOTE_ALLOWED,
        )
    )
    assert default_decision.selected_adapter == "deterministic-baseline"
    assert (
        default_decision.rejected_candidates["chunkr"]
        == "CHUNKR_REQUIRES_EXPLICIT_OPT_IN"
    )

    opted_in = registry.route(
        DocumentExtractionRequest(
            source_path=source,
            source_id="fixture",
            media_type="application/pdf",
            complexity="complex",
            privacy_policy=PrivacyPolicy.REMOTE_ALLOWED,
            configuration={"chunkr_opt_in": True},
        )
    )
    assert opted_in.selected_adapter == "chunkr"


def test_required_ocr_cannot_fall_back_to_non_ocr_baseline(tmp_path: Path) -> None:
    registry = _registry()
    with pytest.raises(CapabilityNotConfigured, match="OCR_CAPABILITY_NOT_CONFIGURED"):
        registry.route(
            DocumentExtractionRequest(
                source_path=_source(tmp_path),
                source_id="fixture",
                media_type="application/pdf",
                complexity="scanned",
                ocr_required=True,
            )
        )


def test_required_ocr_selects_local_ocr_capability(tmp_path: Path) -> None:
    registry = _registry(
        _CapabilityAdapter("tesseract-ocr", local=True, ocr=True)
    )
    decision = registry.route(
        DocumentExtractionRequest(
            source_path=_source(tmp_path),
            source_id="fixture",
            media_type="application/pdf",
            complexity="scanned",
            ocr_required=True,
            privacy_policy=PrivacyPolicy.LOCAL_ONLY,
        )
    )
    assert decision.selected_adapter == "tesseract-ocr"
    assert decision.selection_reason == "local-ocr-required"


def test_installed_docling_remains_non_default_until_benchmark_or_explicit_choice(
    tmp_path: Path,
) -> None:
    registry = _registry(
        _CapabilityAdapter(
            "docling", local=True, ocr=True, benchmark_required=True
        )
    )
    source = _source(tmp_path)
    default_decision = registry.route(
        DocumentExtractionRequest(
            source_path=source,
            source_id="fixture",
            media_type="application/pdf",
            complexity="complex",
        )
    )
    assert default_decision.selected_adapter == "deterministic-baseline"
    assert default_decision.rejected_candidates["docling"] == "BENCHMARK_SELECTION_REQUIRED"
    assert default_decision.selection_reason == "deterministic-baseline-until-benchmark"
    assert "OPTIONAL_DEFAULT_NOT_SELECTED_WITHOUT_BENCHMARK" in default_decision.warnings

    explicit_decision = registry.route(
        DocumentExtractionRequest(
            source_path=source,
            source_id="fixture",
            media_type="application/pdf",
            complexity="complex",
            configuration={"extractor": "docling"},
        )
    )
    assert explicit_decision.selected_adapter == "docling"
    assert explicit_decision.selection_reason == "explicit-or-benchmark-selection"


def test_audio_transcription_is_selected_when_it_is_the_required_media_capability(
    tmp_path: Path,
) -> None:
    registry = ExtractorRegistry()
    registry.register(
        _CapabilityAdapter(
            "openai-compatible-transcription",
            local=True,
            transcription=True,
            benchmark_required=True,
        ),
        media={"audio/*", "video/*"},
        complexities={"media"},
        priority=10,
    )
    decision = registry.route(
        DocumentExtractionRequest(
            source_path=_source(tmp_path, ".wav"),
            source_id="fixture",
            media_type="audio/wav",
            complexity="media",
            privacy_policy=PrivacyPolicy.LOCAL_ONLY,
        )
    )
    assert decision.selected_adapter == "openai-compatible-transcription"
    assert decision.selection_reason == "media-transcription"
