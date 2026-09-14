"""Media/complexity routing for document intelligence adapters."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, Field

from .adapters.base import infer_media_type
from .adapters.deterministic import DeterministicTextAdapter
from .adapters.optional import ChunkrAdapter, DoclingAdapter, MarkerAdapter
from .models import DocumentArtifact
from .ports import (
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
    UnsupportedMediaType,
)


class RoutingDecision(BaseModel):
    media_type: str
    complexity: str
    candidates: list[str] = Field(default_factory=list)
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
    """Registry with deterministic baseline and opt-in benchmark selections."""

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

    def _configured_preference(
        self,
        *,
        adapter_name: str,
        reason: str,
        media_type: str,
        complexity: str,
        candidates: list[str],
    ) -> RoutingDecision:
        if adapter_name not in candidates:
            raise UnsupportedMediaType(
                f"{reason} adapter {adapter_name!r} is not a candidate for "
                f"{media_type} ({complexity})"
            )
        availability = self._adapters[adapter_name].availability()
        if availability.status != CapabilityStatus.CONFIGURED:
            detail = availability.reason or str(availability.status)
            raise CapabilityNotConfigured(
                f"{reason} adapter {adapter_name!r} is not configured: {detail}"
            )
        return RoutingDecision(
            media_type=media_type,
            complexity=complexity,
            candidates=candidates,
            selected_adapter=adapter_name,
            selection_reason=reason,
        )

    def route(self, request: DocumentExtractionRequest) -> RoutingDecision:
        media_type = infer_media_type(request.source_path, request.media_type)
        complexity = infer_complexity(request)
        rules = self._matching_rules(media_type, complexity)
        candidates: list[str] = []
        for rule in rules:
            if rule.adapter not in candidates:
                candidates.append(rule.adapter)
        if not candidates:
            raise UnsupportedMediaType(
                f"no adapter route for {media_type} ({complexity})"
            )

        requested = str(request.configuration.get("extractor", "")).strip()
        if requested:
            return self._configured_preference(
                adapter_name=requested,
                reason="explicit-configuration",
                media_type=media_type,
                complexity=complexity,
                candidates=candidates,
            )

        benchmark_candidate = self._benchmark_selection.get(
            complexity
        ) or self._benchmark_selection.get(media_type)
        if benchmark_candidate:
            return self._configured_preference(
                adapter_name=benchmark_candidate,
                reason="benchmark-selection",
                media_type=media_type,
                complexity=complexity,
                candidates=candidates,
            )

        warnings: list[str] = []
        deterministic = next(
            (name for name in candidates if name == "deterministic-baseline"),
            None,
        )
        configured = [
            name
            for name in candidates
            if self._adapters[name].availability().status
            == CapabilityStatus.CONFIGURED
        ]
        selected = deterministic or (configured[0] if configured else candidates[0])
        if selected == "deterministic-baseline":
            reason = "deterministic-baseline-until-benchmark"
            warnings.append("OPTIONAL_DEFAULT_NOT_SELECTED_WITHOUT_BENCHMARK")
        elif selected != "deterministic-baseline":
            reason = "configured-candidate"
        else:
            reason = "deterministic-baseline"
        return RoutingDecision(
            media_type=media_type,
            complexity=complexity,
            candidates=candidates,
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
            if decision.selection_reason in {
                "explicit-configuration",
                "benchmark-selection",
            }:
                raise
            deterministic = self._adapters.get("deterministic-baseline")
            if adapter.name == "deterministic-baseline" or deterministic is None:
                raise
            fallback = deterministic.extract(request)
            fallback.warnings.append(f"OPTIONAL_ADAPTER_SKIPPED:{adapter.name}")
            decision = decision.model_copy(
                update={
                    "selected_adapter": deterministic.name,
                    "selection_reason": "deterministic-fallback-after-capability-unavailable",
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
        media={"application/pdf", "image/png", "image/jpeg"},
        complexities={"complex", "scanned", "formula", "table-heavy"},
        priority=70,
    )
    return registry


default_registry = build_default_registry()