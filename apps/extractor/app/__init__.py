"""AKP document extraction service."""

from .models import DocumentArtifact, StructuralLocator
from .ports import DocumentIntelligencePort

__all__ = [
    "DocumentArtifact",
    "DocumentIntelligencePort",
    "ExtractorRegistry",
    "StructuralLocator",
    "default_registry",
]


def __getattr__(name: str):
    """Keep lightweight model imports usable when optional parser deps are absent."""

    if name in {"ExtractorRegistry", "default_registry"}:
        from .registry import ExtractorRegistry, default_registry

        return {"ExtractorRegistry": ExtractorRegistry, "default_registry": default_registry}[name]
    raise AttributeError(name)
