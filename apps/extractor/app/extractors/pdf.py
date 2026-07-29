from pathlib import Path
from pypdf import PdfReader
from ..models import Artifact

def extract_pdf(path: Path) -> list[Artifact]:
    reader = PdfReader(str(path))
    artifacts: list[Artifact] = []
    for index, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        warnings = [] if text.strip() else ["NO_TEXT_EXTRACTED"]
        artifacts.append(
            Artifact(
                kind="pdf-page-text",
                content=text,
                locator={"kind": "pdf", "page": index},
                warnings=warnings,
                quality="MACHINE_EXTRACTED",
            )
        )
    return artifacts
