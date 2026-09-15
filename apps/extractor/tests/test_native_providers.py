from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.adapters.chunkr_async import ChunkrAdapter, verify_chunkr_webhook
from app.adapters.docling_native import map_docling_document
from app.adapters.marker_native import map_marker_json
from app.ports import DocumentExtractionRequest, DocumentIntelligenceError


def _request(
    path: Path,
    media_type: str = "application/pdf",
    **configuration: Any,
) -> DocumentExtractionRequest:
    return DocumentExtractionRequest(
        source_path=path,
        source_id=f"fixture:{path.name}",
        source_uri=f"fixture://{path.name}",
        media_type=media_type,
        configuration=configuration,
    )


class _FakeDoclingDocument:
    version = "2-test"

    def __init__(self) -> None:
        prov_heading = SimpleNamespace(
            page_no=1,
            bbox=SimpleNamespace(l=10, t=10, r=200, b=30, coord_origin="TOPLEFT"),
            charspan=(0, 8),
        )
        prov_paragraph = SimpleNamespace(
            page_no=1,
            bbox=SimpleNamespace(l=10, t=40, r=400, b=80, coord_origin="TOPLEFT"),
            charspan=(9, 40),
        )
        prov_table = SimpleNamespace(
            page_no=1,
            bbox=SimpleNamespace(l=10, t=100, r=400, b=220, coord_origin="TOPLEFT"),
            charspan=(41, 80),
        )
        cells = [
            {
                "start_row_offset": 0,
                "end_row_offset": 1,
                "start_col_offset": 0,
                "end_col_offset": 1,
                "text": "Key",
                "column_header": True,
                "row_header": False,
            },
            {
                "start_row_offset": 0,
                "end_row_offset": 1,
                "start_col_offset": 1,
                "end_col_offset": 2,
                "text": "Value",
                "column_header": True,
                "row_header": False,
            },
            {
                "start_row_offset": 1,
                "end_row_offset": 2,
                "start_col_offset": 0,
                "end_col_offset": 1,
                "text": "mode",
                "column_header": False,
                "row_header": False,
            },
            {
                "start_row_offset": 1,
                "end_row_offset": 2,
                "start_col_offset": 1,
                "end_col_offset": 2,
                "text": "native",
                "column_header": False,
                "row_header": False,
            },
        ]
        self.heading = SimpleNamespace(
            self_ref="#/texts/0",
            label="section_header",
            text="Evidence",
            level=1,
            prov=[prov_heading],
            children=[],
            parent=SimpleNamespace(cref="#/body"),
            content_layer="body",
            meta={"language": "en"},
        )
        self.paragraph = SimpleNamespace(
            self_ref="#/texts/1",
            label="text",
            text="Native paragraph",
            prov=[prov_paragraph],
            children=[],
            parent=SimpleNamespace(cref="#/texts/0"),
            content_layer="body",
            meta={},
        )
        self.table = SimpleNamespace(
            self_ref="#/tables/0",
            label="table",
            text=None,
            prov=[prov_table],
            children=[],
            parent=SimpleNamespace(cref="#/texts/0"),
            data=SimpleNamespace(table_cells=cells),
            captions=[],
            references=[],
            footnotes=[],
            content_layer="body",
            meta={},
        )
        self.pages = {
            1: SimpleNamespace(
                size=SimpleNamespace(width=612, height=792),
                image=None,
            )
        }

    def iterate_items(self, *, with_groups: bool, traverse_pictures: bool):
        assert with_groups is True
        assert traverse_pictures is True
        yield self.heading, 1
        yield self.paragraph, 2
        yield self.table, 2

    def export_to_markdown(self) -> str:  # pragma: no cover - should never be called
        raise AssertionError("native Docling mapping must not flatten to Markdown")


def test_docling_mapper_preserves_native_hierarchy_table_bbox_and_charspan(
    tmp_path: Path,
) -> None:
    source = tmp_path / "doc.pdf"
    source.write_bytes(b"provider-fixture")
    artifact = map_docling_document(_FakeDoclingDocument(), _request(source))

    assert artifact.extractor == "docling"
    assert artifact.configuration["mapping"] == "native-docling-document"
    assert artifact.configuration["flattened_before_mapping"] is False
    assert artifact.reading_order == ["#/texts/0", "#/texts/1", "#/tables/0"]
    assert artifact.paragraphs[0].parent_id == "#/texts/0"
    assert artifact.paragraphs[0].locator.page == 1
    assert artifact.paragraphs[0].locator.start_char == 9
    assert artifact.paragraphs[0].locator.end_char == 40
    assert artifact.paragraphs[0].locator.region is not None
    assert artifact.tables[0].headers == ["Key", "Value"]
    assert artifact.tables[0].rows == [["mode", "native"]]
    assert artifact.tables[0].metadata["docling_table_cells"]
    assert artifact.pages[0].page == 1


def test_marker_mapper_walks_json_tree_and_preserves_provider_metadata(
    tmp_path: Path,
) -> None:
    source = tmp_path / "marker.pdf"
    source.write_bytes(b"marker-fixture")
    rendered = {
        "block_type": "Document",
        "metadata": {"pages": 1},
        "children": [
            {
                "id": "title-1",
                "block_type": "SectionHeader",
                "text": "Architecture",
                "page_id": 0,
                "bbox": {"x": 10, "y": 10, "width": 200, "height": 30},
                "metadata": {"level": 1},
                "children": [
                    {
                        "id": "text-1",
                        "block_type": "Text",
                        "text": "Preserved child",
                        "page_id": 0,
                        "bbox": {"x": 10, "y": 50, "width": 300, "height": 40},
                        "metadata": {"source": "native-json"},
                    }
                ],
            },
            {
                "id": "formula-1",
                "block_type": "Equation",
                "text": "x = y + 1",
                "page_id": 0,
                "metadata": {},
            },
        ],
    }

    artifact = map_marker_json(rendered, _request(source))
    assert artifact.extractor == "marker"
    assert artifact.configuration["renderer"] == "json"
    assert artifact.configuration["flattened_before_mapping"] is False
    assert artifact.headings[0].text == "Architecture"
    assert artifact.paragraphs[0].parent_id == "title-1"
    assert artifact.paragraphs[0].metadata["provider_metadata"]["source"] == "native-json"
    assert artifact.equations[0].text == "x = y + 1"
    assert artifact.pages[0].page == 1


class _ChunkrHandler(BaseHTTPRequestHandler):
    gets = 0
    seen_create: dict[str, Any] | None = None

    def _send(self, payload: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path != "/tasks/parse":
            self._send({"error": "not found"}, 404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        type(self).seen_create = body
        self._send(
            {
                "task_id": "task-123",
                "status": "Starting",
                "task_type": "Parse",
                "completed": False,
            }
        )

    def do_GET(self) -> None:
        if not self.path.startswith("/tasks/task-123/parse"):
            self._send({"error": "not found"}, 404)
            return
        type(self).gets += 1
        if type(self).gets == 1:
            self._send(
                {
                    "task_id": "task-123",
                    "status": "Processing",
                    "task_type": "Parse",
                    "completed": False,
                }
            )
            return
        self._send(_chunkr_success())

    def log_message(self, format: str, *args: Any) -> None:
        return


def _chunkr_success() -> dict[str, Any]:
    return {
        "task_id": "task-123",
        "status": "Succeeded",
        "task_type": "Parse",
        "completed": True,
        "version_info": {"server_version": "test-server"},
        "configuration": {"ocr_strategy": "Auto"},
        "output": {
            "file_name": "source.pdf",
            "mime_type": "application/pdf",
            "page_count": 1,
            "pages": [
                {
                    "page_number": 1,
                    "page_width": 1000,
                    "page_height": 1400,
                    "dpi": 144,
                    "image": "https://example.invalid/page.png",
                }
            ],
            "chunks": [
                {
                    "chunk_id": "chunk-a",
                    "chunk_length": 5,
                    "content": "native chunk",
                    "segments": [
                        {
                            "segment_id": "seg-title",
                            "segment_type": "Title",
                            "content": "<h1>Native title</h1>",
                            "bbox": {"left": 50, "top": 40, "width": 500, "height": 60},
                            "page_number": 1,
                            "page_width": 1000,
                            "page_height": 1400,
                            "confidence": 0.99,
                            "ocr": [
                                {
                                    "text": "Native",
                                    "bbox": {
                                        "left": 50,
                                        "top": 40,
                                        "width": 100,
                                        "height": 40,
                                    },
                                }
                            ],
                            "image": "https://example.invalid/title.png",
                        },
                        {
                            "segment_id": "seg-table",
                            "segment_type": "Table",
                            "content": "<table><tr><td>1</td></tr></table>",
                            "bbox": {"left": 50, "top": 120, "width": 600, "height": 250},
                            "page_number": 1,
                            "confidence": 0.9,
                            "ss_sheet_name": "Sheet1",
                            "ss_range": "A1:B2",
                            "ss_cells": [
                                {
                                    "row": 0,
                                    "column": 0,
                                    "text": "A",
                                    "formula": None,
                                    "value": "A",
                                },
                                {
                                    "row": 0,
                                    "column": 1,
                                    "text": "B",
                                    "formula": None,
                                    "value": "B",
                                },
                            ],
                        },
                    ],
                }
            ],
        },
    }


def test_chunkr_adapter_executes_async_task_lifecycle_and_maps_segments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ChunkrHandler.gets = 0
    _ChunkrHandler.seen_create = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ChunkrHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    source = tmp_path / "source.pdf"
    source.write_bytes(b"%PDF-test")
    try:
        monkeypatch.setenv("AKP_CHUNKR_MODE", "oss")
        monkeypatch.setenv("AKP_CHUNKR_ENDPOINT", f"http://127.0.0.1:{server.server_port}")
        artifact = ChunkrAdapter().extract(
            _request(
                source,
                poll_interval_seconds=0.05,
                timeout_seconds=5,
                ingest_job_id="job-42",
            )
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert _ChunkrHandler.gets >= 3
    assert _ChunkrHandler.seen_create is not None
    assert str(_ChunkrHandler.seen_create["file"]).startswith("data:application/pdf;base64,")
    assert _ChunkrHandler.seen_create["segmentation_strategy"] == "LayoutAnalysis"
    assert artifact.configuration["task_id"] == "task-123"
    assert artifact.configuration["ingest_job_id"] == "job-42"
    assert artifact.configuration["flattened_before_mapping"] is False
    assert artifact.headings[0].id == "seg-title"
    assert artifact.headings[0].locator.region is not None
    assert artifact.headings[0].metadata["ocr"]
    assert artifact.tables[0].locator.sheet == "Sheet1"
    assert artifact.tables[0].metadata["ss_cells"][0]["text"] == "A"
    assert artifact.chunks[0]["segment_ids"] == ["seg-title", "seg-table"]


def _svix_signature(payload: bytes, *, secret: str, msg_id: str, timestamp: int) -> str:
    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{msg_id}.{timestamp}.".encode() + payload
    value = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode("ascii")
    return f"v1,{value}"


def test_chunkr_webhook_verification_uses_raw_body_and_rejects_tampering() -> None:
    secret = "whsec_" + base64.b64encode(b"test-secret-32-bytes-material!!!!").decode("ascii")
    payload = json.dumps(
        {
            "event_type": "task.parse.updated",
            "task_id": "task-123",
            "status": "Succeeded",
            "message": None,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    timestamp = 1_800_000_000
    headers = {
        "svix-id": "msg_test",
        "svix-timestamp": str(timestamp),
        "svix-signature": _svix_signature(
            payload, secret=secret, msg_id="msg_test", timestamp=timestamp
        ),
    }

    verified = verify_chunkr_webhook(payload, headers, secret=secret, now=timestamp)
    assert verified["task_id"] == "task-123"

    with pytest.raises(DocumentIntelligenceError, match="signature"):
        verify_chunkr_webhook(payload + b" ", headers, secret=secret, now=timestamp)


def test_chunkr_webhook_rejects_stale_delivery() -> None:
    secret = "whsec_" + base64.b64encode(b"another-test-secret-material-123").decode("ascii")
    payload = b'{"event_type":"task.parse.updated","task_id":"task-1","status":"Processing"}'
    timestamp = 1_700_000_000
    headers = {
        "svix-id": "msg_old",
        "svix-timestamp": str(timestamp),
        "svix-signature": _svix_signature(
            payload, secret=secret, msg_id="msg_old", timestamp=timestamp
        ),
    }
    with pytest.raises(DocumentIntelligenceError, match="timestamp"):
        verify_chunkr_webhook(
            payload,
            headers,
            secret=secret,
            now=timestamp + 1000,
            tolerance_seconds=300,
        )
