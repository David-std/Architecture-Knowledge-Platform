from hashlib import sha256
from pathlib import Path

from bs4 import BeautifulSoup

from ..models import Artifact


def extract_html(path: Path) -> list[Artifact]:
    raw = path.read_bytes()
    soup = BeautifulSoup(raw, "html.parser")
    for element in soup(["script", "style", "noscript"]):
        element.decompose()
    text = "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())
    return [
        Artifact(
            kind="html-text",
            content=text,
            locator={
                "kind": "web-snapshot",
                "path": str(path),
                "snapshot_hash": sha256(raw).hexdigest(),
            },
            quality="MACHINE_EXTRACTED",
        )
    ]
