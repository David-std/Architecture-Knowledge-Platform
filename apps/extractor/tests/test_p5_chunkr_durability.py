from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from app.adapters.chunkr_runtime import ChunkrAdapter
from app.ports import DocumentExtractionRequest, DocumentIntelligenceError


_SEQUENCE: list[str] = []
_JOURNAL_BODIES: list[dict[str, Any]] = []


class _ProviderHandler(BaseHTTPRequestHandler):
    polls = 0

    def _send(self, value: dict[str, Any], status: int = 200) -> None:
        payload = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:  # noqa: N802
        assert self.path == "/tasks/parse"
        _SEQUENCE.append("provider:create")
        length = int(self.headers.get("Content-Length", "0"))
        _ = self.rfile.read(length)
        self._send(
            {
                "task_id": "task-durable",
                "status": "Starting",
                "task_type": "Parse",
            }
        )

    def do_GET(self) -> None:  # noqa: N802
        assert self.path.startswith("/tasks/task-durable")
        type(self).polls += 1
        _SEQUENCE.append(f"provider:poll:{type(self).polls}")
        if type(self).polls == 1:
            self._send(
                {
                    "task_id": "task-durable",
                    "status": "Processing",
                    "task_type": "Parse",
                }
            )
            return
        self._send(
            {
                "task_id": "task-durable",
                "status": "Succeeded",
                "task_type": "Parse",
                "version_info": {"server_version": "durability-test"},
                "configuration": {"ocr_strategy": "Auto"},
                "output": {
                    "file_name": "source.pdf",
                    "mime_type": "application/pdf",
                    "page_count": 1,
                    "pages": [{"page_number": 1, "page_width": 800, "page_height": 1000}],
                    "chunks": [
                        {
                            "chunk_id": "chunk-1",
                            "chunk_length": 12,
                            "content": "native chunk content",
                            "embed": "embedding-placeholder",
                            "segments": [
                                {
                                    "segment_id": "segment-1",
                                    "segment_type": "Text",
                                    "text": "Durable segment",
                                    "page_number": 1,
                                    "confidence": 0.97,
                                    "bbox": {
                                        "left": 10,
                                        "top": 20,
                                        "width": 200,
                                        "height": 40,
                                    },
                                    "ocr": [{"text": "Durable"}],
                                    "image": "https://example.invalid/segment.png",
                                }
                            ],
                        }
                    ],
                },
            }
        )

    def log_message(self, format: str, *args: Any) -> None:
        return


class _JournalHandler(BaseHTTPRequestHandler):
    fail = False

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        _JOURNAL_BODIES.append(body)
        _SEQUENCE.append(f"journal:{body['status']}")
        if type(self).fail:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"journal unavailable")
            return
        assert self.headers.get("x-akp-provider-task-token") == "journal-secret"
        payload = b'{"accepted":true}'
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        return


def _server(handler: type[BaseHTTPRequestHandler]) -> tuple[ThreadingHTTPServer, threading.Thread]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def _request(source: Path, source_id: str) -> DocumentExtractionRequest:
    return DocumentExtractionRequest(
        source_path=source,
        source_id=source_id,
        source_uri="fixture://durable-source.pdf",
        media_type="application/pdf",
        configuration={"poll_interval_seconds": 0.05, "timeout_seconds": 5},
    )


def test_chunkr_task_is_journaled_before_poll_and_preserves_chunk_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _SEQUENCE.clear()
    _JOURNAL_BODIES.clear()
    _ProviderHandler.polls = 0
    _JournalHandler.fail = False
    provider, provider_thread = _server(_ProviderHandler)
    journal, journal_thread = _server(_JournalHandler)
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-durable")
    source_id = str(uuid4())
    try:
        monkeypatch.setenv("AKP_CHUNKR_MODE", "oss")
        monkeypatch.setenv(
            "AKP_CHUNKR_ENDPOINT", f"http://127.0.0.1:{provider.server_port}"
        )
        monkeypatch.setenv(
            "AKP_PROVIDER_TASK_CALLBACK_URL",
            f"http://127.0.0.1:{journal.server_port}/internal/provider-tasks",
        )
        monkeypatch.setenv("AKP_PROVIDER_TASK_CALLBACK_TOKEN", "journal-secret")
        artifact = ChunkrAdapter().extract(_request(source, source_id))
    finally:
        _stop(provider, provider_thread)
        _stop(journal, journal_thread)

    assert _SEQUENCE.index("journal:Starting") < _SEQUENCE.index("provider:poll:1")
    assert [body["status"] for body in _JOURNAL_BODIES] == [
        "Starting",
        "Processing",
        "Succeeded",
    ]
    assert all(body["sourceId"] == source_id for body in _JOURNAL_BODIES)
    assert all(body["taskId"] == "task-durable" for body in _JOURNAL_BODIES)
    assert artifact.configuration["chunk_hierarchy_preserved"] is True
    chunk = next(item for item in artifact.blocks if item.id == "chunk-1")
    segment = next(item for item in artifact.blocks if item.id == "segment-1")
    assert chunk.metadata["chunk_length"] == 12
    assert chunk.metadata["segment_ids"] == ["segment-1"]
    assert segment.parent_id == "chunk-1"
    assert segment.metadata["ocr"]
    assert segment.locator.region is not None


def test_chunkr_does_not_poll_when_durable_journal_rejects_creation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _SEQUENCE.clear()
    _JOURNAL_BODIES.clear()
    _ProviderHandler.polls = 0
    _JournalHandler.fail = True
    provider, provider_thread = _server(_ProviderHandler)
    journal, journal_thread = _server(_JournalHandler)
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-durable")
    try:
        monkeypatch.setenv("AKP_CHUNKR_MODE", "oss")
        monkeypatch.setenv(
            "AKP_CHUNKR_ENDPOINT", f"http://127.0.0.1:{provider.server_port}"
        )
        monkeypatch.setenv(
            "AKP_PROVIDER_TASK_CALLBACK_URL",
            f"http://127.0.0.1:{journal.server_port}/internal/provider-tasks",
        )
        monkeypatch.setenv("AKP_PROVIDER_TASK_CALLBACK_TOKEN", "journal-secret")
        with pytest.raises(DocumentIntelligenceError, match="journal rejected"):
            ChunkrAdapter().extract(_request(source, str(uuid4())))
    finally:
        _stop(provider, provider_thread)
        _stop(journal, journal_thread)
        _JournalHandler.fail = False

    assert _ProviderHandler.polls == 0
    assert _SEQUENCE == ["provider:create", "journal:Starting"]
