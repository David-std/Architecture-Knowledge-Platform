from pathlib import Path
from ..models import Artifact

def extract_text(path: Path) -> list[Artifact]:
    content = path.read_text(encoding="utf-8")
    return [
        Artifact(
            kind="text",
            content=content,
            locator={"kind": "file", "path": str(path)},
            quality="EXACT_TEXT",
        )
    ]
