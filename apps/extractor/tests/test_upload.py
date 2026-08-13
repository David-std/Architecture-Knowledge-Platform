import hashlib

from fastapi.testclient import TestClient

from app.main import app


def test_authenticated_upload_verifies_hash_and_extracts(monkeypatch) -> None:
    monkeypatch.setenv("AKP_EXTRACTOR_TOKEN", "expected")
    content = b"# Uploaded evidence\nexact body"
    digest = hashlib.sha256(content).hexdigest()
    client = TestClient(app)

    denied = client.post(
        "/v1/extract-upload",
        files={"file": ("evidence.md", content, "text/markdown")},
        data={
            "source_uri": "file:///captured/evidence.md",
            "source_id": "source-upload-123",
            "media_type": "text/markdown",
            "expected_sha256": digest,
        },
        headers={"x-akp-extractor-token": "wrong"},
    )
    assert denied.status_code == 401

    mismatch = client.post(
        "/v1/extract-upload",
        files={"file": ("evidence.md", content, "text/markdown")},
        data={
            "source_uri": "file:///captured/evidence.md",
            "source_id": "source-upload-123",
            "media_type": "text/markdown",
            "expected_sha256": "0" * 64,
        },
        headers={"x-akp-extractor-token": "expected"},
    )
    assert mismatch.status_code == 409

    response = client.post(
        "/v1/extract-upload",
        files={"file": ("evidence.md", content, "text/markdown")},
        data={
            "source_uri": "file:///captured/evidence.md",
            "source_id": "source-upload-123",
            "media_type": "text/markdown",
            "expected_sha256": digest,
        },
        headers={"x-akp-extractor-token": "expected"},
    )
    assert response.status_code == 200
    assert response.json()["source_uri"] == "file:///captured/evidence.md"
    assert response.json()["artifacts"][0]["content"] == content.decode()
    assert response.json()["document_artifact"]["source_id"] == "source-upload-123"
