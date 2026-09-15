"""Executable local OCR adapter backed by the Tesseract CLI.

The adapter deliberately shells out to the locally installed binary instead of
pretending image metadata is OCR.  TSV output is retained as word-level
provenance and grouped into provider-neutral line artifacts with page/bbox and
confidence information.
"""

from __future__ import annotations

import csv
import shutil
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image

from ..models import ArtifactItem, BoundingBox, DocumentArtifact, PageArtifact, StructuralLocator
from ..ports import (
    AdapterAvailability,
    CapabilityNotConfigured,
    CapabilityStatus,
    DocumentExtractionRequest,
    DocumentIntelligenceError,
    DocumentIntelligencePort,
)
from .base import infer_media_type, sha256_path


class _OcrWord(dict[str, Any]):
    pass


def _tool(name: str) -> str | None:
    return shutil.which(name)


def _image_dimensions(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def _render_pdf(path: Path, directory: Path, dpi: int) -> list[Path]:
    executable = _tool("pdftoppm")
    if executable is None:
        raise CapabilityNotConfigured("Local PDF OCR requires pdftoppm (poppler-utils)")
    prefix = directory / "page"
    process = subprocess.run(
        [executable, "-png", "-r", str(dpi), str(path), str(prefix)],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if process.returncode != 0:
        raise DocumentIntelligenceError(
            f"PDF rasterization failed: {process.stderr.strip() or 'pdftoppm failed'}"
        )
    pages = sorted(directory.glob("page-*.png"))
    if not pages:
        raise DocumentIntelligenceError("PDF rasterization produced no pages")
    return pages


def _tesseract_tsv(path: Path, *, language: str | None, psm: int) -> list[_OcrWord]:
    executable = _tool("tesseract")
    if executable is None:
        raise CapabilityNotConfigured("Local OCR requires the tesseract binary")
    command = [executable, str(path), "stdout", "--psm", str(psm), "tsv"]
    if language:
        command[3:3] = ["-l", language]
    process = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    if process.returncode != 0:
        raise DocumentIntelligenceError(
            f"Tesseract OCR failed: {process.stderr.strip() or 'unknown error'}"
        )
    reader = csv.DictReader(process.stdout.splitlines(), delimiter="\t")
    words: list[_OcrWord] = []
    for row in reader:
        text = str(row.get("text", "") or "").strip()
        if not text:
            continue
        try:
            confidence = float(row.get("conf", "-1") or -1)
            left = int(row.get("left", "0") or 0)
            top = int(row.get("top", "0") or 0)
            width = int(row.get("width", "0") or 0)
            height = int(row.get("height", "0") or 0)
            block_num = int(row.get("block_num", "0") or 0)
            par_num = int(row.get("par_num", "0") or 0)
            line_num = int(row.get("line_num", "0") or 0)
            word_num = int(row.get("word_num", "0") or 0)
        except ValueError:
            continue
        if width <= 0 or height <= 0:
            continue
        words.append(
            _OcrWord(
                text=text,
                confidence=confidence,
                left=left,
                top=top,
                width=width,
                height=height,
                block_num=block_num,
                par_num=par_num,
                line_num=line_num,
                word_num=word_num,
            )
        )
    return words


def _line_bbox(words: list[_OcrWord]) -> BoundingBox:
    left = min(int(word["left"]) for word in words)
    top = min(int(word["top"]) for word in words)
    right = max(int(word["left"]) + int(word["width"]) for word in words)
    bottom = max(int(word["top"]) + int(word["height"]) for word in words)
    return BoundingBox(
        x=float(max(0, left)),
        y=float(max(0, top)),
        width=float(max(1, right - left)),
        height=float(max(1, bottom - top)),
        unit="pixel",
    )


def _page_items(
    words: list[_OcrWord], *, source_hash: str, source_ref: str, page: int
) -> tuple[list[ArtifactItem], list[BoundingBox], list[float]]:
    grouped: dict[tuple[int, int, int], list[_OcrWord]] = defaultdict(list)
    for word in words:
        key = (int(word["block_num"]), int(word["par_num"]), int(word["line_num"]))
        grouped[key].append(word)
    items: list[ArtifactItem] = []
    boxes: list[BoundingBox] = []
    confidences: list[float] = []
    for index, (key, line_words) in enumerate(sorted(grouped.items()), start=1):
        line_words.sort(key=lambda word: int(word["word_num"]))
        text = " ".join(str(word["text"]) for word in line_words).strip()
        if not text:
            continue
        box = _line_bbox(line_words)
        boxes.append(box)
        valid_confidences = [
            float(word["confidence"])
            for word in line_words
            if float(word["confidence"]) >= 0
        ]
        confidences.extend(valid_confidences)
        confidence = (
            sum(valid_confidences) / len(valid_confidences) if valid_confidences else None
        )
        locator = StructuralLocator(
            kind="paragraph",
            source_hash=source_hash,
            path=source_ref,
            page=page,
            index=index,
            region=box,
        )
        items.append(
            ArtifactItem(
                id=f"ocr-p{page}-l{index}",
                kind="paragraph",
                text=text,
                locator=locator,
                metadata={
                    "provider": "tesseract",
                    "confidence": confidence,
                    "line_key": list(key),
                    "words": [dict(word) for word in line_words],
                },
            )
        )
    return items, boxes, confidences


class TesseractOcrAdapter(DocumentIntelligencePort):
    name = "tesseract-ocr"
    version = "local-cli"

    @staticmethod
    def _available() -> bool:
        return _tool("tesseract") is not None

    def availability(self) -> AdapterAvailability:
        available = self._available()
        return AdapterAvailability(
            adapter=self.name,
            version=self.version,
            status=(
                CapabilityStatus.CONFIGURED
                if available
                else CapabilityStatus.CAPABILITY_NOT_CONFIGURED
            ),
            reason=("LOCAL_TESSERACT_AVAILABLE" if available else "BINARY_NOT_INSTALLED:tesseract"),
            media=["application/pdf", "image/png", "image/jpeg", "image/webp", "image/tiff"],
            complexities=["scanned", "ocr", "image", "unknown"],
            locators=available,
            structured_output=available,
            local=True,
            provider="tesseract",
            benchmark_required=False,
            ocr=True,
        )

    def extract(self, request: DocumentExtractionRequest) -> DocumentArtifact:
        if not self._available():
            raise CapabilityNotConfigured("Tesseract OCR is not installed")
        source_hash = sha256_path(request.source_path)
        source_ref = request.source_uri or request.source_id
        media_type = infer_media_type(request.source_path, request.media_type)
        language_raw = request.configuration.get("ocr_language")
        language = str(language_raw).strip() if language_raw else None
        psm_raw = request.configuration.get("ocr_psm", 6)
        try:
            psm = int(psm_raw)
        except (TypeError, ValueError) as error:
            raise DocumentIntelligenceError("ocr_psm must be an integer") from error
        if psm < 0 or psm > 13:
            raise DocumentIntelligenceError("ocr_psm must be between 0 and 13")
        dpi_raw = request.configuration.get("ocr_pdf_dpi", 200)
        try:
            dpi = int(dpi_raw)
        except (TypeError, ValueError) as error:
            raise DocumentIntelligenceError("ocr_pdf_dpi must be an integer") from error
        if dpi < 72 or dpi > 600:
            raise DocumentIntelligenceError("ocr_pdf_dpi must be between 72 and 600")

        paragraphs: list[ArtifactItem] = []
        pages: list[PageArtifact] = []
        boxes: list[BoundingBox] = []
        confidences: list[float] = []
        page_images: list[Path]
        with tempfile.TemporaryDirectory(prefix="akp-ocr-") as directory:
            temporary = Path(directory)
            if media_type == "application/pdf" or request.source_path.suffix.lower() == ".pdf":
                page_images = _render_pdf(request.source_path, temporary, dpi)
            else:
                page_images = [request.source_path]
            for page_number, page_path in enumerate(page_images, start=1):
                width, height = _image_dimensions(page_path)
                locator = StructuralLocator(
                    kind="page",
                    source_hash=source_hash,
                    path=source_ref,
                    page=page_number,
                )
                pages.append(
                    PageArtifact(
                        id=f"ocr-page-{page_number}",
                        page=page_number,
                        locator=locator,
                        metadata={
                            "provider": "tesseract",
                            "image_width": width,
                            "image_height": height,
                            "dpi": dpi if page_path != request.source_path else None,
                        },
                    )
                )
                page_words = _tesseract_tsv(page_path, language=language, psm=psm)
                items, page_boxes, page_confidences = _page_items(
                    page_words,
                    source_hash=source_hash,
                    source_ref=source_ref,
                    page=page_number,
                )
                paragraphs.extend(items)
                boxes.extend(page_boxes)
                confidences.extend(page_confidences)

        warnings: list[str] = []
        if not paragraphs:
            warnings.append("OCR_NO_TEXT_DETECTED")
        if confidences and min(confidences) < 40:
            warnings.append("OCR_LOW_CONFIDENCE_WORDS_PRESENT")
        average_confidence = (
            sum(confidences) / len(confidences) if confidences else 0.0
        )
        source_locator = StructuralLocator(
            kind="source", source_hash=source_hash, path=source_ref
        )
        locators = [source_locator, *[page.locator for page in pages], *[item.locator for item in paragraphs]]
        return DocumentArtifact(
            source_id=request.source_id,
            source_hash=source_hash,
            media_type=media_type,
            extractor=self.name,
            extractor_version=self.version,
            configuration={
                "provider": "tesseract",
                "ocr_executed": True,
                "ocr_language": language,
                "ocr_psm": psm,
                "ocr_pdf_dpi": dpi,
                **request.configuration,
            },
            pages=pages,
            blocks=list(paragraphs),
            paragraphs=paragraphs,
            bounding_boxes=boxes,
            reading_order=[item.id for item in paragraphs if item.id],
            locators=locators,
            warnings=warnings,
            quality="OCR_EXECUTED",
            quality_metrics={
                "pages": len(pages),
                "ocr_lines": len(paragraphs),
                "ocr_words": len(confidences),
                "average_confidence": average_confidence,
            },
        )
