"""Capability/policy routing for document intelligence adapters."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

from .adapters.base import infer_media_type
from .adapters.deterministic import DeterministicTextAdapter
from .adapters.ocr_local import TesseractOcrAdapter
from .adapters.optional import ChunkrAdapter, DoclingAdapter, MarkerAdapter
from .adapters.transcription import OpenAICompatibleTranscriptionAdapter
from .models import DocumentArtifact
from .ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    CostPolicy,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
    PrivacyPolicy,
    UnsupportedMediaType,
)


class RoutingDecision(BaseModel):
    media_type: str
    complexity: str
    ocr_required: bool = False
    tables: bool = False
    formula: bool = False
    cost_policy: CostPolicy = CostPolicy.STANDARD
    privacy_policy: PrivacyPolicy = PrivacyPolicy.LOCAL_PREFERRED
    candidates: list[str] = Field(default_factory=list)
    configured_candidates: list[str] = Field(default_factory=list)
    rejected_candidates: dict[str, str] = Field(default_factory=dict)
    selected_adapter: str
    selection_reason: str
    fallback: bool = False
    warnings: list[str] = Field(default_factory=list)


class RoutedExtraction(BaseModel):
    artifact: DocumentArtifact
    decision: RoutingDecision


@dataclass(frozen=True)
class _RouteRule:
    adapter: str
    media: frozenset[str]
    complexities: frozenset[str]
    priority: int


def infer_complexity(request: DocumentExtractionRequest) -> str:
    """Infer a conservative routing class without pretending to understand layout."""

    if request.complexity:
        return request.complexity.lower()
    if request.ocr_required:
        return "scanned"
    if request.formula:
        return "formula"
    if request.tables:
        return "table-heavy"
    media = infer_media_type(request.source_path, request.media_type).lower()
    if media.startswith(("audio/", "video/")):
        return "media"
    if media.startswith("image/"):
        return "scanned"
    name = request.source_path.name.lower()
    hints = {
        "scanned": "scanned",
        "ocr": "scanned",
        "formula": "formula",
        "equation": "formula",
        "table": "table-heavy",
        "complex": "complex",
        "academic": "complex",
        "scientific": "formula",
        "slide": "complex",
    }
    for token, value in hints.items():
        if token in name:
            return value
    suffix = request.source_path.suffix.lower()
    if suffix in {
        ".md",
        ".markdown",
        ".txt",
        ".html",
        ".htm",
        ".docx",
        ".pptx",
        ".xlsx",
    }:
        return "simple"
    if suffix == ".pdf":
        return "digital"
    return "unknown"


class ExtractorRegistry:
    """Registry whose decisions are capability-, cost- and privacy-aware."""

    def __init__(self, *, benchmark_selection: dict[str, str] | None = None) -> None:
        self._adapters: dict[str, DocumentIntelligencePort] = {}
        self._rules: list[_RouteRule] = []
        self._benchmark_selection = benchmark_selection or self._selection_from_env()

    @staticmethod
    def _selection_from_env() -> dict[str, str]:
        raw = os.getenv("AKP_DOCUMENT_INTELLIGENCE_SELECTION", "").strip()
        if not raw:
            return {}
        try:
            value = json.loads(raw)
            if isinstance(value, dict):
                return {str(key).lower(): str(adapter) for key, adapter in value.items()}
        except json.JSONDecodeError:
            pass
        return {}

    def register(
        self,
        adapter: DocumentIntelligencePort,
        *,
        media: set[str] | frozenset[str],
        complexities: set[str] | frozenset[str] | None = None,
        priority: int = 100,
    ) -> None:
        self._adapters[adapter.name] = adapter
        self._rules.append(
            _RouteRule(
                adapter=adapter.name,
                media=frozenset(value.lower() for value in media),
                complexities=frozenset(
                    value.lower() for value in (complexities or {"*"})
                ),
                priority=priority,
            )
        )

    def adapter(self, name: str) -> DocumentIntelligencePort:
        try:
            return self._adapters[name]
        except KeyError as error:
            raise UnsupportedMediaType(
                f"extractor adapter is not registered: {name}"
            ) from error

    def capabilities(self) -> list[dict[str, Any]]:
        return [
            adapter.availability().model_dump(mode="json")
            for adapter in self._adapters.values()
        ]

    def _matching_rules(self, media_type: str, complexity: str) -> list[_RouteRule]:
        media = media_type.lower()
        suffix_candidates = {media}
        if "/" in media:
            suffix_candidates.add(media.split("/", maxsplit=1)[0] + "/*")
        rules = [
            rule
            for rule in self._rules
            if (rule.media & suffix_candidates)
            and ("*" in rule.complexities or complexity in rule.complexities)
        ]
        return sorted(rules, key=lambda rule: rule.priority)

    @staticmethod
    def _is_paid_remote(availability: AdapterAvailability) -> bool:
        if availability.paid:
            return True
        # Conservative default: an external network provider counts as paid for
        # NO_PAID unless it explicitly declares itself local.
        return not availability.local

    @staticmethod
    def _chunkr_opt_in(request: DocumentExtractionRequest, preferred: str) -> bool:
        return (
            preferred == "chunkr"
            or request.configuration.get("chunkr_opt_in") is True
        )

    def _policy_rejection(
        self,
        name: str,
        availability: AdapterAvailability,
        request: DocumentExtractionRequest,
        preferred: str,
    ) -> str | None:
        if availability.status != CapabilityStatus.CONFIGURED:
            return availability.reason or str(availability.status)
        if request.privacy_policy == PrivacyPolicy.LOCAL_ONLY and not availability.local:
            return "PRIVACY_POLICY_LOCAL_ONLY"
        if request.cost_policy == CostPolicy.NO_PAID and self._is_paid_remote(availability):
            return "COST_POLICY_NO_PAID"
        if name == "chunkr" and not self._chunkr_opt_in(request, preferred):
            return "CHUNKR_REQUIRES_EXPLICIT_OPT_IN"
        # Docling and Marker are serious but heavyweight structured providers.
        # Merely installing the extra must not silently change the default
        # extraction semantics. A benchmark selection or explicit per-request
        # provider choice is required. Chunkr has its own explicit opt-in gate;
        # transcription is allowed when it is the requested media capability.
        if (
            name in {"docling", "marker"}
            and availability.benchmark_required
            and preferred != name
        ):
            return "BENCHMARK_SELECTION_REQUIRED"
        return None

    @staticmethod
    def _needs_ocr(
        request: DocumentExtractionRequest,
        media_type: str,
        complexity: str,
    ) -> bool:
        return (
            request.ocr_required
            or complexity == "scanned"
            or media_type.startswith("image/")
        )

    @staticmethod
    def _supports_ocr(name: str, availability: AdapterAvailability) -> bool:
        return availability.ocr or name in {"tesseract-ocr", "docling", "marker"}

    @staticmethod
    def _rank(
        rule: _RouteRule,
        *,
        request: DocumentExtractionRequest,
        media_type: str,
        complexity: str,
        preferred: str,
        availability: AdapterAvailability,
    ) -> tuple[int, int, str]:
        name = rule.adapter
        if preferred == name:
            return (-10_000, rule.priority, "explicit-or-benchmark-selection")
        if (
            media_type.startswith(("audio/", "video/"))
            and name == "openai-compatible-transcription"
        ):
            return (-9_000, rule.priority, "media-transcription")

        needs_ocr = ExtractorRegistry._needs_ocr(request, media_type, complexity)
        if needs_ocr and ExtractorRegistry._supports_ocr(name, availability):
            if name == "tesseract-ocr":
                return (-8_000, rule.priority, "local-ocr-required")
            if name == "docling":
                return (-7_500, rule.priority, "structured-ocr-required")
            if name == "marker":
                return (-7_400, rule.priority, "structured-ocr-required")
        if request.formula or complexity == "formula":
            if name == "marker":
                return (-7_000, rule.priority, "formula-capability")
            if name == "docling":
                return (-6_800, rule.priority, "formula-capability")
        if request.tables or complexity == "table-heavy":
            if name == "docling":
                return (-6_500, rule.priority, "table-structure-capability")
            if name == "marker":
                return (-6_300, rule.priority, "table-structure-capability")
        if complexity in {"complex", "scanned"}:
            if name == "docling":
                return (-6_000, rule.priority, "complex-structure-capability")
            if name == "marker":
                return (-5_900, rule.priority, "complex-structure-capability")
        if media_type in {"text/plain", "text/markdown", "text/html"} or media_type.startswith(
            ("application/json", "application/xml", "application/javascript")
        ):
            if name == "deterministic-baseline":
                return (-5_500, rule.priority, "deterministic-native-text")
        if media_type in {
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        } and complexity in {"simple", "digital"}:
            if name == "docling":
                return (-5_000, rule.priority, "configured-structured-document-provider")
        if name == "chunkr":
            return (-4_800, rule.priority, "explicit-chunkr-capability")
        if name == "deterministic-baseline":
            return (-1_000, rule.priority, "deterministic-fallback")
        return (0, rule.priority, "configured-candidate")

    def route(self, request: DocumentExtractionRequest) -> RoutingDecision:
        media_type = infer_media_type(request.source_path, request.media_type)
        complexity = infer_complexity(request)
        rules = self._matching_rules(media_type, complexity)
        candidates: list[str] = []
        rule_by_name: dict[str, _RouteRule] = {}
        for rule in rules:
            if rule.adapter not in candidates:
                candidates.append(rule.adapter)
                rule_by_name[rule.adapter] = rule
        if not candidates:
            raise UnsupportedMediaType(
                f"no adapter route for {media_type} ({complexity})"
            )

        requested = str(request.configuration.get("extractor", "")).strip()
        benchmark_candidate = self._benchmark_selection.get(
            complexity
        ) or self._benchmark_selection.get(media_type)
        preferred = requested or benchmark_candidate or ""
        if requested and requested not in candidates:
            raise UnsupportedMediaType(
                f"requested adapter {requested} cannot handle {media_type} ({complexity})"
            )

        configured: list[str] = []
        rejected: dict[str, str] = {}
        availabilities: dict[str, AdapterAvailability] = {}
        for name in candidates:
            availability = self._adapters[name].availability()
            availabilities[name] = availability
            rejection = self._policy_rejection(name, availability, request, preferred)
            if rejection:
                rejected[name] = rejection
            else:
                configured.append(name)

        if requested and requested in rejected:
            raise CapabilityNotConfigured(
                f"requested adapter {requested} is unavailable: {rejected[requested]}"
            )

        needs_ocr = self._needs_ocr(request, media_type, complexity)
        semantic_candidates = configured
        if needs_ocr:
            semantic_candidates = [
                name
                for name in configured
                if self._supports_ocr(name, availabilities[name])
            ]
        if media_type.startswith(("audio/", "video/")):
            semantic_candidates = [
                name
                for name in configured
                if availabilities[name].transcription
                or name == "openai-compatible-transcription"
            ]

        if not semantic_candidates:
            requirement = (
                "OCR"
                if needs_ocr
                else "TRANSCRIPTION"
                if media_type.startswith(("audio/", "video/"))
                else "EXTRACTION"
            )
            detail = ", ".join(
                f"{name}={reason}" for name, reason in rejected.items()
            )
            raise CapabilityNotConfigured(
                f"{requirement}_CAPABILITY_NOT_CONFIGURED for {media_type}; "
                f"{detail or 'no configured candidates'}"
            )

        ranked = [
            (
                self._rank(
                    rule_by_name[name],
                    request=request,
                    media_type=media_type,
                    complexity=complexity,
                    preferred=preferred,
                    availability=availabilities[name],
                ),
                name,
            )
            for name in semantic_candidates
        ]
        ranked.sort(key=lambda entry: entry[0][:2])
        rank, selected = ranked[0]
        reason = rank[2]
        warnings = [f"{name}:{rejection}" for name, rejection in rejected.items()]
        optional_structured_candidates = {
            name for name in candidates if name in {"docling", "marker", "chunkr"}
        }
        if (
            optional_structured_candidates
            and not requested
            and not benchmark_candidate
            and selected == "deterministic-baseline"
        ):
            reason = "deterministic-baseline-until-benchmark"
            warnings.append("OPTIONAL_DEFAULT_NOT_SELECTED_WITHOUT_BENCHMARK")
        if benchmark_candidate and benchmark_candidate in rejected and not requested:
            warnings.append(
                f"BENCHMARK_SELECTION_UNAVAILABLE:{benchmark_candidate}:"
                f"{rejected[benchmark_candidate]}"
            )
        if request.privacy_policy == PrivacyPolicy.LOCAL_PREFERRED:
            local_ranked = [
                entry for entry in ranked if availabilities[entry[1]].local
            ]
            if (
                local_ranked
                and not availabilities[selected].local
                and preferred != selected
            ):
                rank, selected = local_ranked[0]
                reason = f"local-preferred:{rank[2]}"

        return RoutingDecision(
            media_type=media_type,
            complexity=complexity,
            ocr_required=needs_ocr,
            tables=request.tables,
            formula=request.formula,
            cost_policy=request.cost_policy,
            privacy_policy=request.privacy_policy,
            candidates=candidates,
            configured_candidates=configured,
            rejected_candidates=rejected,
            selected_adapter=selected,
            selection_reason=reason,
            warnings=warnings,
        )

    def extract(self, request: DocumentExtractionRequest) -> RoutedExtraction:
        decision = self.route(request)
        adapter = self._adapters[decision.selected_adapter]
        try:
            artifact = adapter.extract(request)
            return RoutedExtraction(artifact=artifact, decision=decision)
        except CapabilityNotConfigured as error:
            # Availability may change between route() and extract(). Never turn
            # required OCR/transcription into a false-success deterministic artifact.
            if decision.ocr_required or decision.media_type.startswith(
                ("audio/", "video/")
            ):
                raise
            if request.configuration.get("extractor"):
                raise
            deterministic = self._adapters.get("deterministic-baseline")
            if deterministic is None or deterministic.name == adapter.name:
                raise
            fallback_availability = deterministic.availability()
            rejection = self._policy_rejection(
                deterministic.name,
                fallback_availability,
                request,
                "",
            )
            if rejection:
                raise
            fallback = deterministic.extract(request)
            fallback.warnings.append(f"OPTIONAL_ADAPTER_SKIPPED:{adapter.name}")
            decision = decision.model_copy(
                update={
                    "selected_adapter": deterministic.name,
                    "selection_reason": "explicit-deterministic-fallback-after-capability-race",
                    "fallback": True,
                    "warnings": [*decision.warnings, str(error)],
                }
            )
            return RoutedExtraction(artifact=fallback, decision=decision)
        except DocumentIntelligenceError:
            raise


def build_default_registry() -> ExtractorRegistry:
    registry = ExtractorRegistry()
    deterministic = DeterministicTextAdapter()
    registry.register(
        deterministic,
        media={
            "text/markdown",
            "text/plain",
            "text/*",
            "text/html",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "application/json",
            "application/xml",
            "application/javascript",
            "application/x-yaml",
            "application/yaml",
        },
        complexities={
            "simple",
            "digital",
            "complex",
            "scanned",
            "formula",
            "table-heavy",
            "unknown",
        },
        priority=100,
    )
    registry.register(
        TesseractOcrAdapter(),
        media={
            "application/pdf",
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/tiff",
        },
        complexities={"scanned", "ocr", "image", "unknown"},
        priority=40,
    )
    registry.register(
        DoclingAdapter(),
        media={
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/html",
            "image/png",
            "image/jpeg",
        },
        complexities={
            "simple",
            "digital",
            "complex",
            "scanned",
            "formula",
            "table-heavy",
        },
        priority=50,
    )
    registry.register(
        MarkerAdapter(),
        media={"application/pdf"},
        complexities={"complex", "scanned", "formula", "table-heavy"},
        priority=60,
    )
    registry.register(
        ChunkrAdapter(),
        media={
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "image/png",
            "image/jpeg",
        },
        complexities={
            "simple",
            "digital",
            "complex",
            "scanned",
            "formula",
            "table-heavy",
        },
        priority=70,
    )
    registry.register(
        OpenAICompatibleTranscriptionAdapter(),
        media={"audio/*", "video/*"},
        complexities={"simple", "media", "unknown"},
        priority=40,
    )
    return registry


default_registry = build_default_registry()
