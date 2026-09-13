from __future__ import annotations

import json
import shutil
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.adapters.ocr_local import TesseractOcrAdapter
from app.adapters.transcription import OpenAICompatibleTranscriptionAdapter
from app.ports import DocumentExtractionRequest


def _request(
    path: Path,
    media_type: str,
    **configuration: Any,
) -> DocumentExtractionRequest:
    return DocumentExtractionRequest(
        source_path=path,
        source_id=f"fixture:{path.name}",
        source_uri=f"fixture://{path.name}",
        media_type=media_type,
        configuration=configuration,
    )


def _font(size: int = 72) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def test_tesseract_ocr_executes_and_returns_text_page_bbox_and_confidence(
    tmp_path: Path,
) -> None:
    if shutil.which("tesseract") is None:
        pytest.skip("tesseract system binary is not installed in this environment")

    source = tmp_path / "ocr.png"
    image = Image.new("RGB", (1400, 320), "white")
    draw = ImageDraw.Draw(image)
    draw.text((60, 90), "AKP EVIDENCE 123", fill="black", font=_font())
    image.save(source)

    artifact = TesseractOcrAdapter().extract(_request(source, "image/png"))

    text = artifact.text_content().upper()
    assert "AKP" in text
    assert "EVIDENCE" in text
    assert artifact.configuration["ocr_executed"] is True
    assert artifact.pages[0].page == 1
    assert artifact.paragraphs
    assert artifact.paragraphs[0].locator.region is not None
    assert artifact.paragraphs[0].metadata["words"]
    assert artifact.quality == "OCR_EXECUTED"
    assert artifact.quality_metrics["ocr_words"] > 0
    assert artifact.quality_metrics["average_confidence"] >= 0


class _TranscriptionHandler(BaseHTTPRequestHandler):
    request_path: str | None = None
    authorization: str | None = None
    content_type: str | None = None
    fields: dict[str, list[str]] = {}
    file_payload: bytes = b""

    def _send(self, payload: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        type(self).request_path = self.path
        type(self).authorization = self.headers.get("Authorization")
        type(self).content_type = self.headers.get("Content-Type")
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        message = BytesParser(policy=default).parsebytes(
            (
                f"Content-Type: {content_type}\r\n"
                "MIME-Version: 1.0\r\n\r\n"
            ).encode("utf-8")
            + body
        )
        fields: dict[str, list[str]] = {}
        file_payload = b""
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            payload = part.get_payload(decode=True) or b""
            if filename:
                file_payload = payload
            elif name:
                fields.setdefault(str(name), []).append(payload.decode("utf-8"))
        type(self).fields = fields
        type(self).file_payload = file_payload
        self._send(
            {
                "text": "Architecture knowledge platform",
                "language": "en",
                "duration": 4.25,
                "segments": [
                    {
                        "id": 10,
                        "start": 0.0,
                        "end": 1.75,
                        "text": "Architecture knowledge",
                        "avg_logprob": -0.10,
                        "no_speech_prob": 0.01,
                    },
                    {
                        "id": 11,
                        "start": 1.75,
                        "end": 4.25,
                        "text": "platform",
                        "confidence": 0.96,
                    },
                ],
            }
        )

    def log_message(self, format: str, *args: Any) -> None:
        return


def test_transcription_adapter_uses_admin_endpoint_and_preserves_timestamp_segments(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _TranscriptionHandler.request_path = None
    _TranscriptionHandler.authorization = None
    _TranscriptionHandler.fields = {}
    _TranscriptionHandler.file_payload = b""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _TranscriptionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source = tmp_path / "clip.wav"
    source.write_bytes(b"RIFF-not-real-audio-but-provider-contract")
    endpoint = f"http://127.0.0.1:{server.server_port}/v1/audio/transcriptions"
    try:
        monkeypatch.setenv("AKP_TRANSCRIPTION_MODE", "local")
        monkeypatch.setenv("AKP_TRANSCRIPTION_ENDPOINT", endpoint)
        monkeypatch.setenv("AKP_TRANSCRIPTION_API_KEY", "secret-test-key")
        monkeypatch.setenv("AKP_TRANSCRIPTION_MODEL", "test-whisper")
        artifact = OpenAICompatibleTranscriptionAdapter().extract(
            _request(source, "audio/wav", language="en")
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert _TranscriptionHandler.request_path == "/v1/audio/transcriptions"
    assert _TranscriptionHandler.authorization == "Bearer secret-test-key"
    assert _TranscriptionHandler.fields["model"] == ["test-whisper"]
    assert _TranscriptionHandler.fields["response_format"] == ["verbose_json"]
    assert _TranscriptionHandler.fields["timestamp_granularities[]"] == ["segment"]
    assert _TranscriptionHandler.file_payload == source.read_bytes()
    assert artifact.configuration["transcription_executed"] is True
    assert artifact.configuration["model"] == "test-whisper"
    assert artifact.paragraphs[0].locator.timestamp_start == 0.0
    assert artifact.paragraphs[0].locator.timestamp_end == 1.75
    assert artifact.paragraphs[1].metadata["confidence"] == pytest.approx(0.96)
    assert artifact.text_content() == "Architecture knowledge\n\nplatform"
    assert artifact.quality_metrics["segments"] == 2


def test_transcription_request_cannot_override_configured_endpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _TranscriptionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source = tmp_path / "clip.wav"
    source.write_bytes(b"wave")
    configured = f"http://127.0.0.1:{server.server_port}/v1/audio/transcriptions"
    try:
        monkeypatch.setenv("AKP_TRANSCRIPTION_MODE", "local")
        monkeypatch.setenv("AKP_TRANSCRIPTION_ENDPOINT", configured)
        artifact = OpenAICompatibleTranscriptionAdapter().extract(
            _request(
                source,
                "audio/wav",
                endpoint="http://169.254.169.254/latest/meta-data",
                provider_url="http://example.invalid/attacker",
            )
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert artifact.paragraphs
    assert _TranscriptionHandler.request_path == "/v1/audio/transcriptions"
