import { describe, expect, it } from "vitest";
import {
  buildAuditBundle,
  renderAuditZip,
  renderAuditZipChunks,
} from "../src/index.js";

function bundleWithContradictions() {
  return buildAuditBundle({
    metadata: {
      schema_version: "1.0",
      vault_id: "vault-test",
      vault_key: "test",
      platform_commit: "a".repeat(40),
      vault_revision: "vault-r1",
      corpus_revision: "corpus-r1",
      index_revisions: {},
      retrieval_config: {},
      generated_at: "2026-09-27T00:00:00.000Z",
    },
    vaultManifest: [],
    sources: [],
    documents: [],
    relations: [],
    evidence: [],
    validationResults: {},
    retrievalBenchmark: {},
    gapsAndContradictions: {
      contradictions: [
        {
          id: "cluster-1",
          members: [
            { document_id: "doc-1", authority: "A", scope: "one" },
            { document_id: "doc-2", authority: "B", scope: "two" },
          ],
        },
        {
          id: "cluster-2",
          members: [
            { document_id: "doc-3", authority: "C", scope: "three" },
          ],
        },
      ],
      openErrors: [],
    },
    limits: {
      maxContradictions: 1,
      maxContradictionMembers: 1,
    },
  });
}

describe("bounded deterministic audit ZIP", () => {
  it("records contradiction and member truncation instead of hiding it", () => {
    const bundle = bundleWithContradictions();
    expect(bundle.metadata.counts).toMatchObject({
      contradictions: 1,
      contradiction_members: 1,
    });
    expect(bundle.metadata.truncated).toMatchObject({
      contradictions: true,
      contradiction_members: true,
    });

    const gaps = JSON.parse(bundle.files["GAPS_AND_CONTRADICTIONS.json"]!);
    expect(gaps.contradictions).toHaveLength(1);
    expect(gaps.contradictions[0].id).toBe("cluster-1");
    expect(gaps.contradictions[0].members).toHaveLength(1);
  });

  it("streams exactly the same deterministic ZIP bytes as the compatibility renderer", () => {
    const bundle = bundleWithContradictions();
    const streamed = Buffer.concat(
      [...renderAuditZipChunks(bundle)].map((chunk) => Buffer.from(chunk)),
    );
    expect(streamed.equals(Buffer.from(renderAuditZip(bundle)))).toBe(true);
    expect(streamed.subarray(0, 4).toString("hex")).toBe("504b0304");
  });
});
