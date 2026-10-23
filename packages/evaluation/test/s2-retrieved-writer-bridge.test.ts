import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { RetrievalBridgeHit } from "../src/s2-retrieved-writer-bridge.js";
import { freezeWriterFromRetrievedHits } from "../src/s2-retrieved-writer-bridge.js";
const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const vaultId = randomUUID(),
  documentId = randomUUID(),
  revision = "fixture-a1";
const path = "manuals/synthetic.md",
  body = "## Synthetic\nBlue fox protocol mandates two signatures. 😀";
const fileBytes = Buffer.from(body);
const question = "How many signatures are required by the blue fox protocol?";
const hit: RetrievalBridgeHit = {
  documentId,
  vaultId,
  unitId: randomUUID(),
  unitType: "CLAIM",
  parentUnitId: null,
  parentUnitType: null,
  document: { externalId: null, path, title: "Synthetic" },
  revision,
  title: "Synthetic",
  type: "rule",
  trust: "HUMAN_REVIEWED",
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  score: 1,
  reasons: [],
  excerpt: "Blue fox",
  citations: [],
};
const original = {
  vaultId,
  documentId,
  path,
  revision,
  fileSha256: sha(fileBytes),
  fileBytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: body.length,
};
const scope = {
  caseKeySha256: sha("en\0" + question),
  caseManifestSha256: sha("cases"),
  sourceManifestSha256: sha("sources"),
  executedCommitSha: "a".repeat(40),
  sourceFamilySha256: sha("synthetic-family"),
  language: "en" as const,
  question,
  model: "synthetic-model",
  modelDigestSha256: sha("model"),
  systemPrompt: "Only source-backed answers.",
  seed: 1317,
  contextTokens: 4096 as const,
  maxOutputTokens: 512,
  vaultId,
  maxRetrievedDocuments: 2,
};
const build = (
  hits: RetrievalBridgeHit[] = [hit],
  files = [original],
  allowed = true,
) =>
  freezeWriterFromRetrievedHits({
    scope,
    rankedAuthorizedHits: hits,
    originalFiles: files,
    pathAuthorizer: (p, v) => allowed && p === path && v === vaultId,
  });
describe("S2 retrieved writer bridge (no gold oracle)", () => {
  it("uses ranked actual authorized hit; freezes literal full source with original offsets", () => {
    const out = build();
    expect(out.status).toBe("RETRIEVAL_BOUND_WRITER_READY");
    expect(out.selectedEvidence).toHaveLength(1);
    expect(out.selectedEvidence[0]).toMatchObject({
      hitRank: 0,
      sourceSha256: sha(fileBytes),
      bodyStartUtf16: 0,
      bodyEndUtf16: body.length,
      passageId: "SRC1",
    });
    expect(out.exactProviderRequest?.freeze.sourcePassages[0]?.source).toBe(
      "ORIGINAL_LITERAL_MATCH",
    );
    const parsed = JSON.parse(
      Buffer.from(out.exactProviderRequest!.requestBytes).toString(),
    );
    expect(parsed.messages[1].content).toContain(body);
    expect(parsed.messages[1].content).toContain(question);
    expect(out).toMatchObject({
      ownerGoldLoaded: false,
      applicationHttpP95Measured: false,
      semanticCitationEntailmentVerified: false,
      gateAccepted: false,
    });
  });
  it("freezes small original windows of an otherwise overlimit full document", () => {
    const longText =
      "Header. " + "a".repeat(22000) + " Answer: two signatures.";
    const longBytes = Buffer.from(longText);
    const longOriginal = {
      ...original,
      fileBytes: longBytes,
      fileSha256: sha(longBytes),
      bodyEndUtf16: longText.length,
    };
    const windowStart = longText.indexOf("Answer:");
    const window = {
      vaultId,
      documentId,
      path,
      revision,
      startUtf16: windowStart,
      endUtf16: longText.length,
    };
    expect(build([hit], [longOriginal]).status).toBe(
      "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
    );
    const out = freezeWriterFromRetrievedHits({
      scope,
      rankedAuthorizedHits: [hit],
      originalFiles: [longOriginal],
      sourceWindows: [window],
      pathAuthorizer: (p, v) => p === path && v === vaultId,
    });
    expect(out.status).toBe("RETRIEVAL_BOUND_WRITER_READY");
    expect(out.sourceSelection).toBe(
      "RANKED_AUTHORIZED_QUERY_KNOWLEDGE_WINDOWS_ONLY",
    );
    expect(out.selectedEvidence).toMatchObject([
      { bodyStartUtf16: windowStart, bodyEndUtf16: longText.length },
    ]);
    const payload = JSON.parse(
      Buffer.from(out.exactProviderRequest!.requestBytes).toString(),
    );
    expect(payload.messages[1].content).toContain("Answer: two signatures.");
    expect(payload.messages[1].content).not.toContain("a".repeat(22000));
    expect(out.exactProviderRequest?.freeze.sourcePassages).toMatchObject([
      { source: "ORIGINAL_LITERAL_MATCH" },
    ]);
    expect(out.gateAccepted).toBe(false);
  });

  it("cannot promote windows for unadmitted or stale hits", () => {
    const window = {
      vaultId,
      documentId,
      path,
      revision,
      startUtf16: 0,
      endUtf16: 13,
    };
    const selection = (hits: RetrievalBridgeHit[]) =>
      freezeWriterFromRetrievedHits({
        scope,
        rankedAuthorizedHits: hits,
        originalFiles: [original],
        sourceWindows: [window],
        pathAuthorizer: (p, v) => p === path && v === vaultId,
      });
    expect(selection([]).status).toBe("NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE");
    expect(selection([{ ...hit, revision: "stale" }]).status).toBe(
      "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
    );
    expect(selection([{ ...hit, vaultId: randomUUID() }]).status).toBe(
      "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
    );
  });

  it("fails closed for forged, duplicate, oversized and broken UTF-16 windows", () => {
    const base = {
      vaultId,
      documentId,
      path,
      revision,
      startUtf16: 0,
      endUtf16: 13,
    };
    const attempt = (windows: (typeof base)[]) =>
      freezeWriterFromRetrievedHits({
        scope,
        rankedAuthorizedHits: [hit],
        originalFiles: [original],
        sourceWindows: windows,
        pathAuthorizer: (p, v) => p === path && v === vaultId,
      });
    expect(() => attempt([{ ...base, vaultId: randomUUID() }])).toThrow(
      "SOURCE_WINDOW_NOT_ORIGINAL_BOUND",
    );
    expect(() => attempt([{ ...base, revision: "stale" }])).toThrow(
      "SOURCE_WINDOW_NOT_ORIGINAL_BOUND",
    );
    expect(() => attempt([{ ...base, endUtf16: body.length + 1 }])).toThrow(
      "SOURCE_WINDOW_NOT_ORIGINAL_BOUND",
    );
    expect(() => attempt([base, base])).toThrow("DUPLICATE_SOURCE_WINDOW");
    const emoji = body.indexOf("😀");
    expect(() => attempt([{ ...base, startUtf16: emoji + 1 }])).toThrow(
      "SOURCE_WINDOW_NOT_ORIGINAL_BOUND",
    );
  });

  it("does not fabricate evidence from an empty result", () => {
    expect(build([])).toMatchObject({
      status: "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
      exactProviderRequest: null,
      selectedEvidence: [],
      candidateCount: 0,
    });
  });
  it("refuses denied authorization and stale document revision", () => {
    expect(build([hit], [original], false).status).toBe(
      "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
    );
    expect(build([{ ...hit, revision: "wrong" }]).status).toBe(
      "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
    );
    expect(
      build([{ ...hit, refreshStatus: "STALE" } as RetrievalBridgeHit]).status,
    ).toBe("NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE");
  });
  it("fails if original file bytes were tampered", () => {
    expect(() =>
      build([hit], [{ ...original, fileBytes: Buffer.from("tampered") }]),
    ).toThrow("FROZEN_ORIGINAL_NOT_TRUSTWORTHY");
  });
  it("does not duplicate a source on two distinct matched units", () => {
    const out = build([hit, { ...hit, unitId: randomUUID(), score: 0.7 }]);
    expect(out.selectedEvidence).toHaveLength(1);
    expect(out.candidateCount).toBe(2);
  });
  it("cannot treat unauthorised hit or unpinned original as evidence", () => {
    expect(build([{ ...hit, vaultId: randomUUID() }]).status).toBe(
      "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
    );
    expect(build([hit], []).status).toBe("NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE");
  });
});
