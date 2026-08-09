from hashlib import sha256
from pathlib import Path

from PIL import Image

from ..models import Artifact


def extract_image(path: Path) -> list[Artifact]:
    raw = path.read_bytes()
    with Image.open(path) as image:
        metadata = {
            "kind": "image",
            "path": str(path),
            "source_hash": sha256(raw).hexdigest(),
            "width": image.width,
            "height": image.height,
            "format": image.format,
            "mode": image.mode,
        }
    return [
        Artifact(
            kind="image-metadata",
            locator=metadata,
            quality="DETERMINISTIC_METADATA",
            warnings=["OCR_NOT_CONFIGURED"],
        )
    ]
