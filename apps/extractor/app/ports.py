"""Ports and capability contracts for document intelligence."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .models import DocumentArtifact


class CapabilityStatus(StrEnum):
    CONFIGURED = "CONFIGURED"
    CAPABILITY_NOT_CONFIGURED = "CAPABILITY_NOT_CONFIGURED"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"


class CostPolicy(StrEnum):
    """Maximum external provider spend a request permits."""

    NO_PAID = "NO_PAID"
    STANDARD = "STANDARD"
    QUALITY = "QUALITY"


class PrivacyPolicy(StrEnum):
    """Network/privacy boundary for document-intelligence routing."""

    LOCAL_ONLY = "LOCAL_ONLY"
    LOCAL_PREFERRED = "LOCAL_PREFERRED"
    REMOTE_ALLOWED = "REMOTE_ALLOWED"


class AdapterAvailability(BaseModel):
    model_config = ConfigDict(extra="allow")

    adapter: str
    version: str
    status: CapabilityStatus
    reason: str | None = None
    media: list[str] = Field(default_factory=list)
    complexities: list[str] = Field(default_factory=list)
    locators: bool = True
    structured_output: bool = True
    local: bool = True
    provider: str | None = None
    benchmark_required: bool = False
    ocr: bool = False
    transcription: bool = False
    paid: bool = False
    external_network: bool = False


class DocumentExtractionRequest(BaseModel):
    """Input passed to every adapter, independent of its provider model."""

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="allow")

    source_path: Path
    source_id: str = Field(min_length=1)
    source_uri: str | None = None
    media_type: str = "application/octet-stream"
    complexity: str | None = None
    ocr_required: bool = False
    tables: bool = False
    formula: bool = False
    cost_policy: CostPolicy = CostPolicy.STANDARD
    privacy_policy: PrivacyPolicy = PrivacyPolicy.LOCAL_PREFERRED
    ingest_job_id: str | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)


class DocumentIntelligenceError(RuntimeError):
    """Base class for extraction failures exposed to API/benchmark callers."""

    code = "EXTRACTOR_FAILURE"


class CapabilityNotConfigured(DocumentIntelligenceError):
    code = "CAPABILITY_NOT_CONFIGURED"


class UnsupportedMediaType(DocumentIntelligenceError):
    code = "UNSUPPORTED_MEDIA_TYPE"


class DocumentIntelligencePort(ABC):
    """Provider-neutral document intelligence port.

    Implementations must either return a validated ``DocumentArtifact`` or
    raise a typed error. Returning a text placeholder for an unavailable
    provider is explicitly forbidden because it makes benchmark results look
    like successful structured extraction.
    """

    name: str = "adapter"
    version: str = "0.0.0"

    @abstractmethod
    def availability(self) -> AdapterAvailability:
        """Report actual dependency/service availability without side effects."""

    @abstractmethod
    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        """Extract a canonical artifact or raise a typed error."""
