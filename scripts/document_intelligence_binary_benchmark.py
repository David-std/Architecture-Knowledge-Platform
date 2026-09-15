#!/usr/bin/env python3
"""Execute the document-intelligence adapters against redistributable binary fixtures.

The fixtures are generated deterministically at execution time so the benchmark can
exercise real PDF/Office/image bytes without checking third-party corpus material
into the product repository. Generated fixtures are evidence of executable format
coverage, not a claim of broad real-world extraction quality.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import document_intelligence_benchmark as base

ROOT = Path(__file__).resolve().parents[1]
SOURCE_FIXTURES = ROOT / "test" / "fixtures" / "document-intelligence"
DEFAULT_REPORT = ROOT / "reports" / "document-intelligence" / "binary-benchmark.json"


def _mb(value: int | None) -> float | None:
    return round(value / (1024 * 1024), 3) if value is not None else None


def _current_rss_bytes() -> int | None:
    """Return this process' resident set on Linux without adding a dependency."""

    statm = Path("/proc/self/statm")
    if statm.exists():
        try:
            fields = statm.read_text(encoding="utf-8").split()
            if len(fields) >= 2:
                return int(fields[1]) * int(os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError):
            return None
    return None


class _RssSampler:
    def __init__(self, interval_seconds: float = 0.01) -> None:
        self.interval_seconds = interval_seconds
        self.baseline = _current_rss_bytes()
        self.peak = self.baseline
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _sample(self) -> None:
        value = _current_rss_bytes()
        if value is not None and (self.peak is None or value > self.peak):
            self.peak = value

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self._sample()

    def __enter__(self) -> _RssSampler:
        self._sample()
        self._thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self._sample()
        self._stop.set()
        self._thread.join(timeout=1)
        self._sample()

    def metrics(self) -> dict[str, float | str | None]:
        final = _current_rss_bytes()
        peak_delta = (
            max(0, self.peak - self.baseline)
            if self.peak is not None and self.baseline is not None
            else None
        )
        return {
            "memory_baseline_mb": _mb(self.baseline),
            "memory_peak_mb": _mb(self.peak),
            "memory_peak_delta_mb": _mb(peak_delta),
            "memory_final_mb": _mb(final),
            "memory_measurement": "PROCESS_RSS_LINUX_PROCFS",
        }


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _write_layout_pdf(
    target: Path,
    text_items: list[tuple[float, float, str]],
    lines: list[tuple[float, float, float, float]] | None = None,
) -> None:
    commands: list[str] = []
    for x, y, text in text_items:
        commands.append(f"BT /F1 11 Tf {x:g} {y:g} Td ({_pdf_escape(text)}) Tj ET")
    for x1, y1, x2, y2 in lines or []:
        commands.append(f"{x1:g} {y1:g} m {x2:g} {y2:g} l S")
    stream = "\n".join(commands).encode("ascii")
    objects = [
        base._pdf_object(1, b"<< /Type /Catalog /Pages 2 0 R >>"),
        base._pdf_object(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        base._pdf_object(
            3,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        ),
        base._pdf_object(
            4,
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        ),
        base._pdf_object(5, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ]
    header = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    body = bytearray(header)
    offsets = [0]
    for obj in objects:
        offsets.append(len(body))
        body.extend(obj)
    xref_offset = len(body)
    body.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    body.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        body.extend(f"{offset:010d} 00000 n \n".encode())
    body.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode()
    )
    target.write_bytes(body)


def _write_scanned_pdf(target: Path) -> None:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1700, 1100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((80, 80, 1620, 1020), outline="black", width=4)
    draw.text((140, 170), "Raster OCR evidence", fill="black")
    draw.text((140, 250), "Publication requires reviewer signoff", fill="black")
    draw.text((140, 330), "This page contains no PDF text layer", fill="black")
    image.save(target, format="PDF", resolution=150.0)


def _load_payload(name: str) -> dict[str, Any]:
    return json.loads((SOURCE_FIXTURES / name).read_text(encoding="utf-8"))


def _build_fixture_matrix(root: Path) -> dict[str, dict[str, Any]]:
    fixtures: list[dict[str, Any]] = []

    simple = root / "simple.pdf"
    _write_layout_pdf(
        simple,
        [
            (72, 720, "Simple PDF evidence"),
            (72, 690, "Canonical knowledge remains in Git"),
        ],
    )
    fixtures.append(
        {
            "id": "simple-pdf",
            "path": simple.name,
            "media_type": "application/pdf",
            "complexity": "simple",
            "expected": {"text": ["Simple PDF evidence"], "page_count": 1},
        }
    )

    columns = root / "two-column.pdf"
    _write_layout_pdf(
        columns,
        [
            (54, 730, "Two column benchmark"),
            (54, 690, "Left column evidence"),
            (54, 665, "Canonical publication"),
            (320, 690, "Right column evidence"),
            (320, 665, "Derived projections"),
        ],
    )
    fixtures.append(
        {
            "id": "two-column-pdf",
            "path": columns.name,
            "media_type": "application/pdf",
            "complexity": "complex",
            "expected": {
                "text": ["Left column evidence", "Right column evidence"],
                "page_count": 1,
            },
        }
    )

    table = root / "table-heavy.pdf"
    table_lines = [
        (60, 700, 550, 700),
        (60, 660, 550, 660),
        (60, 620, 550, 620),
        (60, 580, 550, 580),
        (60, 580, 60, 700),
        (300, 580, 300, 700),
        (550, 580, 550, 700),
    ]
    _write_layout_pdf(
        table,
        [
            (75, 675, "Component"),
            (320, 675, "Status"),
            (75, 635, "Indexer"),
            (320, 635, "Ready"),
            (75, 595, "Reviewer"),
            (320, 595, "Required"),
        ],
        table_lines,
    )
    fixtures.append(
        {
            "id": "table-heavy-pdf",
            "path": table.name,
            "media_type": "application/pdf",
            "complexity": "table-heavy",
            "expected": {
                "text": ["Component", "Indexer", "Reviewer"],
                "table_count": 1,
                "table_rows": 2,
                "page_count": 1,
            },
        }
    )

    formula = root / "formula-scientific.pdf"
    _write_layout_pdf(
        formula,
        [
            (72, 720, "Scientific formula evidence"),
            (72, 680, "E = mc^2"),
            (72, 640, "F = ma"),
        ],
    )
    fixtures.append(
        {
            "id": "formula-scientific-pdf",
            "path": formula.name,
            "media_type": "application/pdf",
            "complexity": "formula",
            "expected": {
                "text": ["Scientific formula evidence", "E = mc^2"],
                "equation_count": 1,
                "page_count": 1,
            },
        }
    )

    scanned = root / "scanned-raster.pdf"
    _write_scanned_pdf(scanned)
    fixtures.append(
        {
            "id": "scanned-raster-pdf",
            "path": scanned.name,
            "media_type": "application/pdf",
            "complexity": "scanned",
            "expected": {
                "text": ["Raster OCR evidence", "reviewer signoff"],
                "page_count": 1,
            },
        }
    )

    docx = root / "structured.docx"
    base._write_docx(docx, _load_payload("structured-docx.json"))
    fixtures.append(
        {
            "id": "structured-docx-binary",
            "path": docx.name,
            "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "complexity": "simple",
            "expected": {
                "text": ["Document heading", "structured paragraph"],
                "heading_count": 1,
                "table_count": 1,
            },
        }
    )

    pptx = root / "slides.pptx"
    base._write_pptx(pptx, _load_payload("slide-deck-pptx.json"))
    fixtures.append(
        {
            "id": "slide-deck-pptx-binary",
            "path": pptx.name,
            "media_type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "complexity": "complex",
            "expected": {
                "text": ["Architecture slide", "speaker note"],
                "page_count": 1,
            },
        }
    )

    xlsx = root / "table-workbook.xlsx"
    base._write_xlsx(xlsx, _load_payload("table-workbook.json"))
    fixtures.append(
        {
            "id": "table-workbook-xlsx-binary",
            "path": xlsx.name,
            "media_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "complexity": "table-heavy",
            "expected": {
                "text": ["architecture", "deterministic"],
                "table_count": 1,
                "table_rows": 2,
            },
        }
    )

    image = root / "diagram.png"
    base._write_png(image, _load_payload("diagram-image.json"))
    fixtures.append(
        {
            "id": "diagram-image-binary",
            "path": image.name,
            "media_type": "image/png",
            "complexity": "complex",
            "expected": {"figure_count": 1},
        }
    )

    manifest = {"schema_version": "1.0", "fixtures": fixtures}
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {entry["id"]: entry for entry in fixtures}


def _adapter_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for row in rows:
        adapter = str(row["adapter"])
        bucket = summary.setdefault(
            adapter,
            {"executed": 0, "failed": 0, "skipped": 0, "failure_rate": None},
        )
        status = str(row["status"]).lower()
        if status in bucket:
            bucket[status] += 1
    for bucket in summary.values():
        attempted = bucket["executed"] + bucket["failed"]
        bucket["failure_rate"] = (
            round(bucket["failed"] / attempted, 6) if attempted else None
        )
    return summary


def run(report: Path, repeats: int) -> dict[str, Any]:
    try:
        from app.adapters.deterministic import DeterministicTextAdapter
        from app.adapters.optional import ChunkrAdapter, DoclingAdapter, MarkerAdapter
        from app.ports import DocumentExtractionRequest
    except Exception as error:  # noqa: BLE001
        result = {
            "schemaVersion": "akp.document-intelligence-binary-benchmark.v1",
            "status": "BLOCKED",
            "reason": f"extractor import failed: {error}",
            "fixtures": [],
            "selection": {"status": "NOT_SELECTED"},
        }
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return result

    adapters = [
        DeterministicTextAdapter(),
        DoclingAdapter(),
        MarkerAdapter(),
        ChunkrAdapter(),
    ]
    rows: list[dict[str, Any]] = []
    device = os.environ.get("AKP_DI_BENCHMARK_DEVICE", "CPU")

    with tempfile.TemporaryDirectory(prefix="akp-di-binary-") as temp:
        fixture_root = Path(temp)
        fixture_manifest = _build_fixture_matrix(fixture_root)
        fixture_evidence = []
        for fixture_id, entry in fixture_manifest.items():
            source = fixture_root / str(entry["path"])
            fixture_evidence.append(
                {
                    "fixture": fixture_id,
                    "media_type": entry["media_type"],
                    "complexity": entry["complexity"],
                    "source_hash": base._digest(source),
                    "source_size_bytes": source.stat().st_size,
                    "origin": "GENERATED_REDISTRIBUTABLE_BINARY",
                }
            )

        for entry in fixture_manifest.values():
            source = fixture_root / str(entry["path"])
            source_hash = base._digest(source)
            for adapter in adapters:
                availability = adapter.availability()
                row: dict[str, Any] = {
                    "fixture": entry["id"],
                    "adapter": adapter.name,
                    "media_type": entry["media_type"],
                    "complexity": entry["complexity"],
                    "source_hash": source_hash,
                    "source_size_bytes": source.stat().st_size,
                    "fixture_origin": "GENERATED_REDISTRIBUTABLE_BINARY",
                    "availability": availability.model_dump(mode="json"),
                    "status": "SKIPPED",
                    "metrics": {},
                }
                if availability.status != "CONFIGURED":
                    row["reason"] = availability.reason or "ADAPTER_NOT_CONFIGURED"
                    rows.append(row)
                    continue
                if not base._media_supported(availability, str(entry["media_type"])):
                    row["reason"] = "MEDIA_NOT_SUPPORTED_BY_ADAPTER"
                    rows.append(row)
                    continue

                request = DocumentExtractionRequest(
                    source_path=source,
                    source_id=f"binary-fixture:{entry['id']}",
                    source_uri=f"binary-fixture://{entry['id']}",
                    media_type=entry["media_type"],
                    complexity=entry["complexity"],
                )
                timings: list[float] = []
                memory_runs: list[dict[str, float | str | None]] = []
                artifact = None
                try:
                    for _ in range(max(1, repeats)):
                        with _RssSampler() as memory:
                            started = time.perf_counter()
                            artifact = adapter.extract(request)
                            timings.append((time.perf_counter() - started) * 1000)
                        memory_runs.append(memory.metrics())
                    metrics = base._metrics(artifact, entry.get("expected", {}))
                    peaks = [
                        value
                        for run_metrics in memory_runs
                        if isinstance((value := run_metrics["memory_peak_mb"]), float)
                    ]
                    deltas = [
                        value
                        for run_metrics in memory_runs
                        if isinstance((value := run_metrics["memory_peak_delta_mb"]), float)
                    ]
                    metrics.update(
                        {
                            "processing_time_ms": round(sum(timings) / len(timings), 3),
                            "processing_time_ms_min": round(min(timings), 3),
                            "processing_time_ms_max": round(max(timings), 3),
                            "memory_peak_mb": max(peaks) if peaks else None,
                            "memory_peak_delta_mb": max(deltas) if deltas else None,
                            "memory_measurement": "PROCESS_RSS_LINUX_PROCFS",
                            "execution_device": device,
                            "provider_cost": 0 if availability.local else None,
                        }
                    )
                    row["status"] = "EXECUTED"
                    row["metrics"] = metrics
                except Exception as error:  # noqa: BLE001
                    row["status"] = "FAILED"
                    row["reason"] = str(error)
                rows.append(row)

    result = {
        "schemaVersion": "akp.document-intelligence-binary-benchmark.v1",
        "status": "EXECUTED",
        "evidenceLevel": "GENERATED_REDISTRIBUTABLE_BINARY_MATRIX",
        "coverageStatus": "PARTIALLY_PROVEN",
        "generatedAt": datetime.now(UTC).isoformat(),
        "runtime": {
            "python": base.platform.python_version(),
            "platform": base.platform.platform(),
            "versions": base._versions(),
            "executionDevice": device,
            "cudaVisibleDevices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        },
        "resourceMeasurement": {
            "memory": "per-extraction process RSS sampled from Linux /proc/self/statm",
            "includes": "Python process and in-process native allocations visible in RSS",
            "excludes": [
                "GPU device memory",
                "provider child-process RSS",
                "strict cold-start isolation between adapter rows",
            ],
            "sampleIntervalMs": 10,
        },
        "fixtureEvidence": fixture_evidence,
        "fixtures": rows,
        "adapterSummary": _adapter_summary(rows),
        "selection": {
            "status": "NOT_SELECTED",
            "configuredSelection": False,
            "reason": "binary benchmark records evidence but does not promote an adapter automatically",
        },
        "limitations": [
            "Fixtures are deterministic generated binaries, not a broad real-world document corpus.",
            "Memory rows share one benchmark process, so retained model residency can affect later rows.",
            "OCR fidelity is measured on a generated raster-only PDF; separate product CI exercises the durable OCR pipeline.",
            "Unavailable optional adapters remain SKIPPED and are not treated as passing quality evidence.",
        ],
    }
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--repeats", type=int, default=1)
    args = parser.parse_args()
    result = run(args.report.resolve(), max(1, args.repeats))
    print(json.dumps({"status": result["status"], "report": str(args.report.resolve())}, indent=2))
    return 0 if result["status"] == "EXECUTED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
