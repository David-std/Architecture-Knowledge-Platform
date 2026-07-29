from pathlib import Path
from urllib.parse import urlparse
from fastapi import FastAPI, HTTPException
from .models import ExtractRequest, ExtractResponse
from .extractors.text import extract_text
from .extractors.pdf import extract_pdf

app = FastAPI(title="AKP Extractor", version="0.1.0")

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "UP"}

@app.post("/v1/extract", response_model=ExtractResponse)
def extract(request: ExtractRequest) -> ExtractResponse:
    parsed = urlparse(request.source_uri)
    if parsed.scheme not in ("", "file"):
        raise HTTPException(
            status_code=501,
            detail="Starter supports local file URIs only; object-store adapter is required.",
        )

    path = Path(parsed.path if parsed.scheme == "file" else request.source_uri).resolve()
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Source file not found")

    media_type = request.media_type or ""
    if path.suffix.lower() == ".pdf" or media_type == "application/pdf":
        artifacts = extract_pdf(path)
        name = "pypdf"
    elif path.suffix.lower() in {".md", ".txt"} or media_type.startswith("text/"):
        artifacts = extract_text(path)
        name = "python-text"
    else:
        raise HTTPException(status_code=415, detail="Unsupported media type in starter")

    return ExtractResponse(
        extractor=name,
        extractor_version="starter-0.1.0",
        source_uri=request.source_uri,
        artifacts=artifacts,
    )
