import { describe, expect, it } from "vitest";
import {
  AuditExportLimitError,
  buildAuditBundle,
  renderAuditZip,
} from "../src/index.js";

const metadata = {
  schema_version: "1.0",
  vault_id: "vault-1",
  vault_key: "synthetic",
  platform_commit: "platform-commit",
  vault_revision: "vault-commit",
  corpus_revision: "corpus-1",
  index_revisions: { lexical_revision: "lex-1" },
  retrieval_config: { mode: "lexical+graph" },
  generated_at: "2026-08-10T00:00:00.000Z",
};

describe("audit export", () => {
  it("renders sorted, metadata-only manifests and redacts sensitive fields", () => {
    const bundle = buildAuditBundle({
      metadata,
      vaultManifest: [{ vault_id: "vault-1", path: "vault" }],
      sources: [
        {
          id: "source-2",
          sha256: "b",
          object_key: "secret-object",
          objectKey: "also-secret",
          localPath: "C:\\licensed\\original.pdf",
        },
        {
          id: "source-1",
          sha256: "a",
          metadata: {
            apiToken: "do-not-export",
            privateKey: "do-not-export",
            sourceUri: "file:///licensed/original.pdf",
            path: "C:\\licensed\\original.pdf",
          },
        },
      ],
      documents: [
        {
          id: "doc-1",
          path: "10-sources/a.md",
          body_cache: "private body",
          bodyCache: "private body",
          local_path: "C:\\licensed\\original.md",
        },
      ],
      relations: [{ id: "relation-1", relation_type: "supports" }],
      evidence: [
        {
          id: "evidence-2",
          locator: { kind: "pdf", page: 2 },
          excerpt: "second",
        },
        {
          id: "evidence-1",
          locator: { kind: "pdf", page: 1 },
          excerpt: "first",
        },
      ],
      validationResults: { runs: [{ id: "lint-1", token: "no" }] },
      retrievalBenchmark: { runs: [{ id: "eval-1" }] },
      gapsAndContradictions: { contradictions: [] },
      sampleContextPackets: [
        { id: "packet-1", packet: { citations: ["evidence-1"] } },
      ],
      locatorFilters: [{ kind: "pdf", page: 1 }],
    });

    expect(bundle.metadata.bundle_hash).toBe(bundle.hash);
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).toContain('"id":"source-1"');
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain("object_key");
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain("objectKey");
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain("localPath");
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain("apiToken");
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain("privateKey");
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain("sourceUri");
    expect(bundle.files["SOURCE_MANIFEST.jsonl"]).not.toContain(
      "C:\\\\licensed",
    );
    expect(bundle.files["DOCUMENTS.jsonl"]).not.toContain("bodyCache");
    expect(bundle.files["DOCUMENTS.jsonl"]).not.toContain("local_path");
    expect(bundle.files["EVIDENCE_INDEX.jsonl"]).toContain('"page":1');
    expect(bundle.files["EVIDENCE_INDEX.jsonl"]).not.toContain('"page":2');
    expect(bundle.files["SAMPLE_CONTEXT_PACKETS/packet-1.json"]).toBeDefined();
  });

  it("redacts nested sensitive metadata, including required revision fields", () => {
    const bundle = buildAuditBundle({
      metadata: {
        ...metadata,
        index_revisions: { lexical_revision: "lex-1", token: "secret" },
        retrieval_config: { mode: "lexical", body: "licensed text" },
      },
      vaultManifest: [],
      sources: [],
      documents: [],
      relations: [],
      evidence: [],
      validationResults: {},
      retrievalBenchmark: {},
      gapsAndContradictions: {},
    });
    expect(bundle.files["BUNDLE_METADATA.json"]).toContain("lexical_revision");
    expect(bundle.files["BUNDLE_METADATA.json"]).not.toContain('"token"');
    expect(bundle.files["BUNDLE_METADATA.json"]).not.toContain('"body"');
    expect(bundle.files["BUNDLE_METADATA.json"]).not.toContain("licensed text");
  });

  it("produces byte-identical ZIPs for identical input", () => {
    const input = {
      metadata,
      vaultManifest: [],
      sources: [],
      documents: [],
      relations: [],
      evidence: [],
      validationResults: {},
      retrievalBenchmark: {},
      gapsAndContradictions: {},
    };
    const first = renderAuditZip(buildAuditBundle(input));
    const second = renderAuditZip(buildAuditBundle(input));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(Buffer.from(first).subarray(0, 2).toString()).toBe("PK");
  });

  it("includes metadata revisions and timestamp in the bundle hash", () => {
    const input = {
      metadata,
      vaultManifest: [],
      sources: [],
      documents: [],
      relations: [],
      evidence: [],
      validationResults: {},
      retrievalBenchmark: {},
      gapsAndContradictions: {},
    };
    const first = buildAuditBundle(input);
    const second = buildAuditBundle({
      ...input,
      metadata: { ...metadata, generated_at: "2026-08-10T00:00:01.000Z" },
    });
    expect(first.hash).not.toBe(second.hash);
  });

  it("enforces hard total-byte limits", () => {
    expect(() =>
      buildAuditBundle({
        metadata,
        vaultManifest: [],
        sources: [],
        documents: [],
        relations: [],
        evidence: [],
        validationResults: { long: "x".repeat(100) },
        retrievalBenchmark: {},
        gapsAndContradictions: {},
        limits: { maxTotalBytes: 10 },
      }),
    ).toThrowError(AuditExportLimitError);
  });
});
