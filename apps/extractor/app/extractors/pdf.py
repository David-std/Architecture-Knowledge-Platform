from hashlib import sha256
from pathlib import Path

from pypdf import PdfReader

from ..models import Artifact


def extract_pdf(path: Path) -> list[Artifact]:
    source_hash = sha256(path.read_bytes()).hexdigest()
    reader = PdfReader(str(path))
    artifacts: list[Artifact] = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        warnings = [] if text.strip() else ["NO_TEXT_EXTRACTED"]
        artifacts.append(
            Artifact(
                kind="pdf-page-text",
                content=text,
                locator={"kind": "pdf", "page": index, "source_hash": source_hash},
                warnings=warnings,
                quality="MACHINE_EXTRACTED",
            )
        )
    return artifacts
