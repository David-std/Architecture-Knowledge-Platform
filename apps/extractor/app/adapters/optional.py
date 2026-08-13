"""Honest optional adapters for Docling, Marker and Chunkr.

The base image intentionally does not install these providers.  Each adapter
reports that fact and raises ``CAPABILITY_NOT_CONFIGURED`` until a real local
dependency, executable or explicitly configured service is available.  No
deterministic text fallback is returned from an unavailable optional adapter.
"""

from __future__ import annotations

import importlib.util
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any

from ..models import DocumentArtifact
from ..ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
)
from .deterministic import artifact_from_text


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


class DoclingAdapter(DocumentIntelligencePort):
    name = "docling"
    version = "optional"

    def availability(self) -> AdapterAvailability:
        available = _has_module("docling")
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=CapabilityStatus.CONFIGURED if available else CapabilityStatus.CAPABILITY_NOT_CONFIGURED,
            reason=("python-package-installed" if available else "DEPENDENCY_NOT_INSTALLED:docling"),
            media=["pdf", "docx", "pptx", "xlsx", "html", "image"],
            complexities=["digital", "complex", "scanned", "formula", "table-heavy"],
            locators=available,
            structured_output=available,
            local=True,
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        if not _has_module("docling"):
            raise CapabilityNotConfigured("Docling is not installed")
        try:
            from docling.document_converter import (  # type: ignore[import-not-found]
                DocumentConverter,
            )
        except ImportError as error:
            raise CapabilityNotConfigured("Docling converter API is unavailable") from error
        try:
            conversion = DocumentConverter().convert(str(request.source_path))
            document = getattr(conversion, "document", conversion)
            markdown = ""
            if hasattr(document, "export_to_markdown"):
                markdown = document.export_to_markdown()
            elif hasattr(document, "export_to_text"):
                markdown = document.export_to_text()
            if not isinstance(markdown, str) or not markdown.strip():
                raise DocumentIntelligenceError("Docling returned no textual representation")
            artifact = artifact_from_text(
                request,
                markdown,
                extractor=self.name,
                media_type=request.media_type,
                warnings=["DOCLING_STRUCTURED_FIELDS_REDUCED_TO_CANONICAL_MARKDOWN"],
            )
            artifact.configuration.update({"provider": "docling", "conversion": "local"})
            return artifact
        except CapabilityNotConfigured:
            raise
        except Exception as error:  # pragma: no cover - provider-specific API
            raise DocumentIntelligenceError(f"Docling extraction failed: {error}") from error


class MarkerAdapter(DocumentIntelligencePort):
    name = "marker"
    version = "optional"

    def _command(self) -> list[str] | None:
        configured = os.getenv("AKP_MARKER_COMMAND", "").strip()
        if not configured:
            executable = shutil.which("marker_single") or shutil.which("marker")
            return [executable] if executable else None
        command = shlex.split(configured)
        if not command:
            return None
        if shutil.which(command[0]) is None and not Path(command[0]).exists():
            return None
        return command

    def availability(self) -> AdapterAvailability:
        command = self._command()
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=CapabilityStatus.CONFIGURED if command else CapabilityStatus.CAPABILITY_NOT_CONFIGURED,
            reason=("CLI_CONFIGURED" if command else "DEPENDENCY_OR_COMMAND_NOT_CONFIGURED"),
            media=["pdf"],
            complexities=["complex", "scanned", "formula", "table-heavy"],
            locators=bool(command),
            structured_output=bool(command),
            local=True,
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        command = self._command()
        if not command:
            raise CapabilityNotConfigured("Marker executable is not configured")
        try:
            completed = subprocess.run(
                [*command, str(request.source_path)],
                capture_output=True,
                text=True,
                check=False,
                timeout=float(request.configuration.get("timeout_seconds", 300)),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise DocumentIntelligenceError(f"Marker invocation failed: {error}") from error
        if completed.returncode != 0:
            raise DocumentIntelligenceError(
                f"Marker returned exit code {completed.returncode}: {completed.stderr[-500:]}"
            )
        output = completed.stdout.strip()
        if not output:
            raise DocumentIntelligenceError("Marker returned no stdout; output directory integration is not configured")
        return artifact_from_text(
            request,
            output,
            extractor=self.name,
            media_type="application/pdf",
            warnings=["MARKER_CLI_OUTPUT_NORMALIZED_TO_CANONICAL_MARKDOWN"],
        )


class ChunkrAdapter(DocumentIntelligencePort):
    name = "chunkr"
    version = "optional"

    def _endpoint(self) -> str | None:
        endpoint = os.getenv("AKP_CHUNKR_ENDPOINT", "").strip()
        return endpoint or None

    def availability(self) -> AdapterAvailability:
        endpoint = self._endpoint()
        mode = os.getenv("AKP_CHUNKR_MODE", "cloud" if endpoint else "oss")
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=CapabilityStatus.CONFIGURED if endpoint else CapabilityStatus.CAPABILITY_NOT_CONFIGURED,
            reason=("ENDPOINT_CONFIGURED" if endpoint else "OSS_OR_CLOUD_SERVICE_NOT_CONFIGURED"),
            media=["pdf", "docx", "pptx", "image"],
            complexities=["complex", "scanned", "formula", "table-heavy"],
            locators=bool(endpoint),
            structured_output=bool(endpoint),
            local=mode.lower() == "oss",
            provider=f"chunkr-{mode.lower()}",
            benchmark_required=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        endpoint = self._endpoint()
        if not endpoint:
            raise CapabilityNotConfigured("Chunkr OSS/Cloud endpoint is not configured")
        try:
            import httpx

            with httpx.Client(timeout=float(request.configuration.get("timeout_seconds", 300))) as client:
                with request.source_path.open("rb") as stream:
                    response = client.post(
                        endpoint,
                        files={"file": (request.source_path.name, stream, request.media_type)},
                        data={"source_id": request.source_id},
                    )
                response.raise_for_status()
                payload: Any = response.json()
        except Exception as error:  # pragma: no cover - service is opt-in
            raise DocumentIntelligenceError(f"Chunkr request failed: {error}") from error
        if isinstance(payload, dict) and "source_hash" in payload and "blocks" in payload:
            try:
                return DocumentArtifact.model_validate(payload)
            except Exception as error:
                raise DocumentIntelligenceError(f"Chunkr response is not canonical: {error}") from error
        if isinstance(payload, dict) and isinstance(payload.get("text"), str):
            return artifact_from_text(
                request,
                payload["text"],
                extractor=self.name,
                warnings=["CHUNKR_RESPONSE_NORMALIZED_FROM_TEXT", "VERIFY_STRUCTURED_LOCATORS"],
            )
        raise DocumentIntelligenceError(
            "Chunkr response contains neither canonical artifact fields nor text"
        )
