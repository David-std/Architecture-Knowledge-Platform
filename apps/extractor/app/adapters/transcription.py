"""Provider-neutral audio/video transcription adapter.

The runtime endpoint is administrator-controlled through environment variables;
request content can never select an arbitrary network destination.  Video is
reduced to an audio track with local ffmpeg, then sent to an OpenAI-compatible
transcription endpoint.  Returned time segments are normalized to canonical
paragraph items with timestamp locators.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from ..models import ArtifactItem, DocumentArtifact, StructuralLocator
from ..ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
)
from .base import infer_media_type, sha256_path

_AUDIO_SUFFIXES = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
_VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}


def _configured_endpoint() -> tuple[str, str] | None:
    endpoint = os.getenv("AKP_TRANSCRIPTION_ENDPOINT", "").strip()
    if not endpoint:
        return None
    mode = os.getenv("AKP_TRANSCRIPTION_MODE", "remote").strip().lower()
    if mode not in {"local", "remote"}:
        return None
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.username or parsed.password:
        return None
    if mode == "remote" and parsed.scheme != "https":
        return None
    if mode == "remote" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return None
    return endpoint, mode


def _ffmpeg_audio(source: Path, destination: Path) -> None:
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise CapabilityNotConfigured("Video transcription requires local ffmpeg")
    process = subprocess.run(
        [
            executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if process.returncode != 0:
        raise DocumentIntelligenceError(
            f"ffmpeg audio extraction failed: {process.stderr.strip() or 'unknown error'}"
        )


def _confidence(segment: dict[str, Any]) -> float | None:
    direct = segment.get("confidence")
    if isinstance(direct, (int, float)):
        return max(0.0, min(1.0, float(direct)))
    probability = segment.get("avg_logprob")
    if isinstance(probability, (int, float)):
        # Do not mislabel avg_logprob as calibrated probability. Preserve it
        # separately and leave canonical confidence absent.
        return None
    return None


def _segments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("segments")
    if isinstance(raw, list) and raw:
        normalized: list[dict[str, Any]] = []
        for index, segment in enumerate(raw):
            if not isinstance(segment, dict):
                continue
            text = str(segment.get("text", "") or "").strip()
            try:
                start = float(segment.get("start", 0.0) or 0.0)
                end = float(segment.get("end", start) or start)
            except (TypeError, ValueError):
                continue
            if not text or start < 0 or end < start:
                continue
            normalized.append(
                {
                    "id": segment.get("id", index),
                    "start": start,
                    "end": end,
                    "text": text,
                    "confidence": _confidence(segment),
                    "avg_logprob": segment.get("avg_logprob"),
                    "no_speech_prob": segment.get("no_speech_prob"),
                    "speaker": segment.get("speaker"),
                }
            )
        if normalized:
            return normalized
    text = str(payload.get("text", "") or "").strip()
    duration = payload.get("duration")
    if not text:
        return []
    try:
        end = max(0.0, float(duration)) if duration is not None else 0.0
    except (TypeError, ValueError):
        end = 0.0
    return [{"id": 0, "start": 0.0, "end": end, "text": text, "confidence": None}]


class OpenAICompatibleTranscriptionAdapter(DocumentIntelligencePort):
    name = "openai-compatible-transcription"
    version = "v1"

    def availability(self) -> AdapterAvailability:
        configured = _configured_endpoint()
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=(
                CapabilityStatus.CONFIGURED
                if configured
                else CapabilityStatus.CAPABILITY_NOT_CONFIGURED
            ),
            reason=("TRANSCRIPTION_ENDPOINT_CONFIGURED" if configured else "TRANSCRIPTION_ENDPOINT_NOT_CONFIGURED"),
            media=["audio/*", "video/*"],
            complexities=["simple", "media", "unknown"],
            locators=bool(configured),
            structured_output=bool(configured),
            local=bool(configured and configured[1] == "local"),
            provider="openai-compatible",
            benchmark_required=True,
            timestamps=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        configured = _configured_endpoint()
        if not configured:
            raise CapabilityNotConfigured("Transcription endpoint is not configured")
        endpoint, mode = configured
        model = os.getenv("AKP_TRANSCRIPTION_MODEL", "whisper-1").strip() or "whisper-1"
        api_key = os.getenv("AKP_TRANSCRIPTION_API_KEY", "").strip()
        timeout_raw = request.configuration.get("transcription_timeout_seconds", 300)
        try:
            timeout = float(timeout_raw)
        except (TypeError, ValueError) as error:
            raise DocumentIntelligenceError("transcription_timeout_seconds must be numeric") from error
        if timeout <= 0 or timeout > 1800:
            raise DocumentIntelligenceError("transcription_timeout_seconds must be in (0, 1800]")

        media_type = infer_media_type(request.source_path, request.media_type)
        suffix = request.source_path.suffix.lower()
        is_video = media_type.startswith("video/") or suffix in _VIDEO_SUFFIXES
        is_audio = media_type.startswith("audio/") or suffix in _AUDIO_SUFFIXES
        if not (is_video or is_audio):
            raise DocumentIntelligenceError(f"Transcription does not support {media_type}")

        source_hash = sha256_path(request.source_path)
        source_ref = request.source_uri or request.source_id
        temporary_audio: Path | None = None
        try:
            upload_path = request.source_path
            if is_video:
                handle = tempfile.NamedTemporaryFile(
                    prefix="akp-transcript-", suffix=".wav", delete=False
                )
                handle.close()
                temporary_audio = Path(handle.name)
                _ffmpeg_audio(request.source_path, temporary_audio)
                upload_path = temporary_audio

            headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
            data: list[tuple[str, str]] = [
                ("model", model),
                ("response_format", "verbose_json"),
                ("timestamp_granularities[]", "segment"),
            ]
            language = request.configuration.get("language")
            if language:
                data.append(("language", str(language)))
            prompt = request.configuration.get("transcription_prompt")
            if prompt:
                # Prompt is provider context only; it grants no tool/runtime permissions.
                data.append(("prompt", str(prompt)[:4000]))
            with upload_path.open("rb") as stream:
                response = httpx.post(
                    endpoint,
                    headers=headers,
                    data=data,
                    files={"file": (upload_path.name, stream, "audio/wav" if is_video else media_type)},
                    timeout=timeout,
                    follow_redirects=False,
                )
            response.raise_for_status()
            payload = response.json()
        except CapabilityNotConfigured:
            raise
        except DocumentIntelligenceError:
            raise
        except (httpx.HTTPError, OSError, ValueError, json.JSONDecodeError) as error:
            raise DocumentIntelligenceError(f"Transcription provider failed: {error}") from error
        finally:
            if temporary_audio is not None:
                temporary_audio.unlink(missing_ok=True)

        if not isinstance(payload, dict):
            raise DocumentIntelligenceError("Transcription provider response is not an object")
        segments = _segments(payload)
        if not segments:
            raise DocumentIntelligenceError("Transcription provider returned no usable transcript")

        items: list[ArtifactItem] = []
        locators: list[StructuralLocator] = [
            StructuralLocator(kind="source", source_hash=source_hash, path=source_ref)
        ]
        confidence_values: list[float] = []
        for index, segment in enumerate(segments, start=1):
            locator = StructuralLocator(
                kind="paragraph",
                source_hash=source_hash,
                path=source_ref,
                timestamp_start=float(segment["start"]),
                timestamp_end=float(segment["end"]),
            )
            confidence = segment.get("confidence")
            if isinstance(confidence, float):
                confidence_values.append(confidence)
            item = ArtifactItem(
                id=f"transcript-segment-{index}",
                kind="paragraph",
                text=str(segment["text"]),
                locator=locator,
                metadata={
                    "provider": "openai-compatible-transcription",
                    "model": model,
                    "language": payload.get("language") or request.configuration.get("language"),
                    "confidence": confidence,
                    "avg_logprob": segment.get("avg_logprob"),
                    "no_speech_prob": segment.get("no_speech_prob"),
                    "speaker": segment.get("speaker"),
                    "provider_segment_id": segment.get("id"),
                },
            )
            items.append(item)
            locators.append(locator)

        warnings: list[str] = []
        if is_video:
            warnings.append("VIDEO_TRANSCRIPT_ONLY_NO_VISUAL_CAPTIONING")
        if mode == "remote":
            warnings.append("REMOTE_TRANSCRIPTION_PROVIDER_USED")
        return DocumentArtifact(
            source_id=request.source_id,
            source_hash=source_hash,
            media_type=media_type,
            extractor=self.name,
            extractor_version=self.version,
            configuration={
                "provider": "openai-compatible-transcription",
                "provider_mode": mode,
                "model": model,
                "language": payload.get("language") or request.configuration.get("language"),
                "transcription_executed": True,
                "timestamp_granularity": "segment",
                "video_audio_extracted_with_ffmpeg": is_video,
                **request.configuration,
            },
            blocks=list(items),
            paragraphs=items,
            reading_order=[item.id for item in items if item.id],
            locators=locators,
            warnings=warnings,
            quality="PROVIDER_TRANSCRIPT",
            quality_metrics={
                "segments": len(items),
                "duration_seconds": max(float(segment["end"]) for segment in segments),
                "average_confidence": (
                    sum(confidence_values) / len(confidence_values)
                    if confidence_values
                    else 0.0
                ),
            },
        )
