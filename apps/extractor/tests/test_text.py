from pathlib import Path
from app.extractors.text import extract_text

def test_extract_text(tmp_path: Path) -> None:
    source = tmp_path / "source.md"
    source.write_text("# Evidence\nhello", encoding="utf-8")
    artifacts = extract_text(source)
    assert artifacts[0].content == "# Evidence\nhello"
    assert artifacts[0].quality == "EXACT_TEXT"
