from hashlib import sha256
from pathlib import Path

from ..models import Artifact


def extract_text(path: Path) -> list[Artifact]:
    raw = path.read_bytes()
    warnings: list[str] = []
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("utf-8", errors="replace")
        warnings.append("INVALID_UTF8_REPLACED")
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    return [
        Artifact(
            kind="text",
            content=content,
            locator={
                "kind": "file",
                "path": str(path),
                "content_hash": sha256(raw).hexdigest(),
                "start_line": 1,
                "end_line": max(1, content.count("\n") + 1),
            },
            warnings=warnings,
            quality="EXACT_TEXT",
        )
    ]
