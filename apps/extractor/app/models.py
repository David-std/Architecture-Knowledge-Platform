"""Public extractor contracts.

The HTTP API historically returned a list of small ``Artifact`` records.  That
shape is still supported, but new integrations should consume
``DocumentArtifact``.  The latter is deliberately provider-neutral: a parser
may be replaced without making the rest of the platform depend on Docling,
Marker or Chunkr object models.
"""

from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class BoundingBox(BaseModel):
    """A page/slide/image region in source coordinates."""

    model_config = ConfigDict(extra="allow")

    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    unit: str = "pixel"


class StructuralLocator(BaseModel):
    """Provider-neutral source location.

    A locator must contain at least one structural coordinate.  ``path`` is a
    valid coordinate for a source-level item; page/line/sheet/region/timestamp
    coordinates are valid for content-level items.  Extra fields are retained
    so future formats can add coordinates without changing the contract.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    kind: str = Field(min_length=1)
    source_hash: str | None = Field(default=None, min_length=64, max_length=64)
    path: str | None = None
    page: int | None = Field(default=None, gt=0)
    slide: int | None = Field(default=None, gt=0)
    paragraph: int | None = Field(default=None, gt=0)
    table: int | None = Field(default=None, gt=0)
    row: int | None = Field(default=None, gt=0)
    column: int | None = Field(default=None, gt=0)
    sheet: str | None = None
    index: int | None = Field(default=None, gt=0)
    start_line: int | None = Field(default=None, gt=0)
    end_line: int | None = Field(default=None, gt=0)
    start_char: int | None = Field(default=None, ge=0)
    end_char: int | None = Field(default=None, ge=0)
    heading_path: list[str] = Field(default_factory=list)
    region: BoundingBox | None = None
    timestamp_start: float | None = Field(default=None, ge=0)
    timestamp_end: float | None = Field(default=None, ge=0)

    _hash_pattern: ClassVar[str] = r"^[0-9a-fA-F]{64}$"

    @field_validator("source_hash")
    @classmethod
    def _validate_hash(cls, value: str | None) -> str | None:
        if value is not None and not __import__("re").fullmatch(cls._hash_pattern, value):
            raise ValueError("source_hash must be a SHA-256 hexadecimal digest")
        return value.lower() if value else value

    @model_validator(mode="after")
    def _validate_coordinates(self) -> StructuralLocator:
        coordinates = (
            self.path,
            self.page,
            self.slide,
            self.paragraph,
            self.table,
            self.row,
            self.column,
            self.sheet,
            self.index,
            self.start_line,
            self.start_char,
            self.heading_path,
            self.region,
            self.timestamp_start,
        )
        if not any(value not in (None, "", []) for value in coordinates):
            raise ValueError(
                "structural locator requires a path, coordinate, heading, region or timestamp"
            )
        if self.end_line is not None and self.start_line is not None and self.end_line < self.start_line:
            raise ValueError("end_line cannot precede start_line")
        if self.end_char is not None and self.start_char is not None and self.end_char < self.start_char:
            raise ValueError("end_char cannot precede start_char")
        if (
            self.timestamp_end is not None
            and self.timestamp_start is not None
            and self.timestamp_end < self.timestamp_start
        ):
            raise ValueError("timestamp_end cannot precede timestamp_start")
        return self


class ArtifactItem(BaseModel):
    """A structural unit in a canonical document artifact."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str | None = None
    kind: str = "block"
    text: str | None = None
    locator: StructuralLocator
    parent_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TableArtifact(ArtifactItem):
    kind: str = "table"
    headers: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    caption: str | None = None


class PageArtifact(ArtifactItem):
    kind: str = "page"
    page: int | None = Field(default=None, gt=0)


class DocumentArtifact(BaseModel):
    """Canonical, provider-neutral result of document intelligence."""

    model_config = ConfigDict(extra="allow")

    source_id: str = Field(min_length=1)
    source_hash: str = Field(min_length=64, max_length=64)
    media_type: str = Field(min_length=1)
    extractor: str = Field(min_length=1)
    extractor_version: str = Field(min_length=1)
    configuration: dict[str, Any] = Field(default_factory=dict)
    pages: list[PageArtifact] = Field(default_factory=list)
    blocks: list[ArtifactItem] = Field(default_factory=list)
    headings: list[ArtifactItem] = Field(default_factory=list)
    paragraphs: list[ArtifactItem] = Field(default_factory=list)
    lists: list[ArtifactItem] = Field(default_factory=list)
    tables: list[TableArtifact] = Field(default_factory=list)
    figures: list[ArtifactItem] = Field(default_factory=list)
    equations: list[ArtifactItem] = Field(default_factory=list)
    code: list[ArtifactItem] = Field(default_factory=list)
    bounding_boxes: list[BoundingBox] = Field(default_factory=list)
    reading_order: list[str] = Field(default_factory=list)
    locators: list[StructuralLocator] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    quality: str = "UNREVIEWED"
    quality_metrics: dict[str, float | int | str | bool] = Field(default_factory=dict)

    @field_validator("source_hash")
    @classmethod
    def _validate_source_hash(cls, value: str) -> str:
        if not __import__("re").fullmatch(r"[0-9a-fA-F]{64}", value):
            raise ValueError("source_hash must be a SHA-256 hexadecimal digest")
        return value.lower()

    @model_validator(mode="after")
    def _validate_artifact_locators(self) -> DocumentArtifact:
        all_items: list[ArtifactItem] = [
            *self.pages,
            *self.blocks,
            *self.headings,
            *self.paragraphs,
            *self.lists,
            *self.tables,
            *self.figures,
            *self.equations,
            *self.code,
        ]
        for item in all_items:
            if item.locator.source_hash and item.locator.source_hash != self.source_hash:
                raise ValueError(f"locator source_hash mismatch for {item.kind}")
        for locator in self.locators:
            if locator.source_hash and locator.source_hash != self.source_hash:
                raise ValueError("artifact locator source_hash mismatch")
        if self.reading_order:
            known_ids = {item.id for item in all_items if item.id}
            unknown = [item_id for item_id in self.reading_order if item_id not in known_ids]
            if unknown:
                raise ValueError(f"reading_order references unknown item ids: {unknown}")
        return self

    def text_content(self) -> str:
        """Return text in canonical reading order without discarding structure."""

        by_id = {
            item.id: item
            for item in [
                *self.blocks,
                *self.headings,
                *self.paragraphs,
                *self.lists,
                *self.tables,
                *self.figures,
                *self.equations,
                *self.code,
            ]
            if item.id
        }
        ordered = [by_id[item_id] for item_id in self.reading_order if item_id in by_id]
        if not ordered:
            ordered = [item for item in self.blocks if item.text]
        return "\n\n".join(item.text or "" for item in ordered if item.text)


class Artifact(BaseModel):
    """Legacy flattened response item retained for API compatibility."""

    kind: str
    content: str | None = None
    locator: dict[str, Any]
    warnings: list[str] = Field(default_factory=list)
    quality: str = "UNREVIEWED"


class ExtractRequest(BaseModel):
    source_uri: str = Field(min_length=1)
    media_type: str | None = None
    source_id: str | None = None
    complexity: str | None = None
    configuration: dict[str, Any] = Field(default_factory=dict)


class ExtractResponse(BaseModel):
    extractor: str
    extractor_version: str
    source_uri: str
    artifacts: list[Artifact]
    document_artifact: DocumentArtifact | None = None
    routing: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
