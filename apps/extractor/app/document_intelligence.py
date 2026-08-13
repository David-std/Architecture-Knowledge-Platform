"""Stable import surface for the document-intelligence port and registry."""

from .adapters.deterministic import DeterministicTextAdapter
from .adapters.optional import ChunkrAdapter, DoclingAdapter, MarkerAdapter
from .models import DocumentArtifact, StructuralLocator
from .ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
)
from .registry import ExtractorRegistry, RoutingDecision, default_registry

__all__ = [
    "AdapterAvailability",
    "CapabilityNotConfigured",
    "CapabilityStatus",
    "ChunkrAdapter",
    "DeterministicTextAdapter",
    "DoclingAdapter",
    "DocumentArtifact",
    "DocumentExtractionRequest",
    "DocumentIntelligenceError",
    "DocumentIntelligencePort",
    "ExtractorRegistry",
    "MarkerAdapter",
    "RoutingDecision",
    "StructuralLocator",
    "default_registry",
]
