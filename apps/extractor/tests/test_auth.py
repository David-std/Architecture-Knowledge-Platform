from pathlib import Path

import pytest
from fastapi import HTTPException

from app.main import extract
from app.models import ExtractRequest


def test_extractor_requires_shared_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source.txt"
    source.write_text("safe fixture", encoding="utf-8")
    monkeypatch.setenv("AKP_EXTRACTOR_TOKEN", "expected")

    with pytest.raises(HTTPException) as denied:
        extract(ExtractRequest(source_uri=str(source)), x_akp_extractor_token="wrong")
    assert denied.value.status_code == 401

    response = extract(
        ExtractRequest(source_uri=str(source)),
        x_akp_extractor_token="expected",
    )
    assert response.artifacts[0].content == "safe fixture"
