from typing import Any
from pydantic import BaseModel, Field

class ExtractRequest(BaseModel):
    source_uri: str = Field(min_length=1)
    media_type: str | None = None

class Artifact(BaseModel):
    kind: str
    content: str | None = None
    locator: dict[str, Any]
    warnings: list[str] = []
    quality: str = "UNREVIEWED"

class ExtractResponse(BaseModel):
    extractor: str
    extractor_version: str
    source_uri: str
    artifacts: list[Artifact]
    warnings: list[str] = []
