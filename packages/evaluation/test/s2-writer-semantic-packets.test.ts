import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildBlindedWriterReviewPackets } from "../src/s2-writer-semantic-packets.js";
const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const doc = "40000000-0000-4000-8000-000000000001";
const a = "What is verified?",
  b = "Is result 299?";
const keyA = sha("en\0" + a),
  keyB = sha("en\0" + b);
const header = "---\r\ntitle: test\r\n---\r\n";
const file = header + "## Evidence\r\n\r\nThe result is verified. 😀";
function fixture() {
  const sourceManifest = {
    schemaVersion: "akp.s2.section-frozen-manifest.v1",
    files: [
      {
        documentId: doc,
        vaultId: "v",
        path: "test/doc.md",
        revision: "frozen",
        fileSha256: sha(file),
        bodyStartUtf16: header.length,
        bodyEndUtf16: file.length,
      },
    ],
  };
  const sourceManifestBytes = bytes(sourceManifest);
  const pinnedSourceManifestSha256 = sha(sourceManifestBytes);
  const caseManifest = {
    schemaVersion: "akp.s2.section-paired-manifest.v1",
    sourceManifestSha256: pinnedSourceManifestSha256,
    executedCommitSha: "a".repeat(40),
    cases: [
      {
        caseKeySha256: keyA,
        scopeSha256: sha("scope"),
        sourceFamilySha256: sha("family"),
        language: "en",
      },
      {
        caseKeySha256: keyB,
        scopeSha256: sha("scope"),
        sourceFamilySha256: sha("family"),
        language: "en",
      },
    ],
  };
  const caseManifestBytes = bytes(caseManifest);
  const writerRun = {
    readerRows: [
      {
        caseKeySha256: keyA,
        sourceSha256: pinnedSourceManifestSha256,
        verifiedSectionCount: 1,
        outputs: [
          {
            arm: "CHILD_ONLY",
            status: "ABSTAIN",
            answer: "",
            citations: [],
            providerError: null,
            citationIdsValid: true,
          },
          {
            arm: "VERIFIED_SECTION_ENRICHED",
            status: "ANSWER",
            answer: "The result is verified.",
            citations: ["SECTION1"],
            providerError: null,
            citationIdsValid: true,
          },
        ],
      },
      {
        caseKeySha256: keyB,
        sourceSha256: pinnedSourceManifestSha256,
        verifiedSectionCount: 0,
        outputs: [
          {
            arm: "CHILD_ONLY",
            status: "ABSTAIN",
            answer: "",
            citations: [],
            providerError: null,
            citationIdsValid: true,
          },
        ],
      },
    ],
  };
  return {
    sourceManifestBytes,
    pinnedSourceManifestSha256,
    caseManifestBytes,
    pinnedCaseManifestSha256: sha(caseManifestBytes),
    sourceFiles: [{ documentId: doc, bytes: new TextEncoder().encode(file) }],
    questions: [
      {
        questionKeySha256: keyA,
        documentId: doc,
        language: "en" as const,
        question: a,
      },
      {
        questionKeySha256: keyB,
        documentId: doc,
        language: "en" as const,
        question: b,
      },
    ],
    writerRunBytes: bytes(writerRun),
    privateOwnerSeed: new Uint8Array(32).fill(17),
  };
}
describe("blinded writer evidence review packet preparation", () => {
  it("builds 2 sealed reviewer views, blind to A/B source gold and arm allocation", () => {
    const r = buildBlindedWriterReviewPackets(fixture());
    expect(r).toMatchObject({
      expectedResponseCount: 3,
      sourceCount: 1,
      independentSemanticReviewCompleted: false,
      gateAccepted: false,
    });
    for (const p of r.packets) {
      expect(p.cases.length).toBe(3);
      expect(p.sourceDocuments.length).toBe(1);
      expect(p).toMatchObject({
        armAllocationRevealed: false,
        originalReviewerVerdictsIncluded: false,
        fullModelCitationSourceMappingAvailable: false,
        originalSourceSemanticJudgmentsOnly: true,
        gateAccepted: false,
      });
      expect(
        p.cases.every((c) => c.annotation.answerFaithfulness === null),
      ).toBe(true);
      expect(JSON.stringify(p)).not.toContain("VERIFIED_SECTION_ENRICHED");
      expect(JSON.stringify(p)).not.toContain("SECTION1");
      expect(
        p.cases.every((c) =>
          c.reportedCitationIds.every((id) => /^CIT[1-9][0-9]*$/u.test(id)),
        ),
      ).toBe(true);
      expect(JSON.stringify(p)).not.toContain('"claimPolarityReview"');
    }
    expect(new Set(r.privateArmMap.map((x) => x.responseKeySha256)).size).toBe(
      3,
    );
    expect(
      r.privateArmMap.filter((x) => x.arm === "VERIFIED_SECTION_ENRICHED")
        .length,
    ).toBe(1);
  });
  it("rejects modified source bytes under pinned manifest", () => {
    const x = fixture();
    x.sourceFiles[0]!.bytes = bytes(file + " changed");
    expect(() => buildBlindedWriterReviewPackets(x)).toThrow(
      "SOURCE_BYTES_OR_IDENTITY_MISMATCH",
    );
  });
  it("rejects different case pin even when a valid JSON object exists", () => {
    const x = fixture();
    x.pinnedCaseManifestSha256 = sha("wrong");
    expect(() => buildBlindedWriterReviewPackets(x)).toThrow(
      "FROZEN_INPUT_PIN_OR_SEED_INVALID",
    );
  });
  it("refuses question drift, invented case ids and missing records", () => {
    const x = fixture();
    x.questions[0]!.question = "Edited!";
    expect(() => buildBlindedWriterReviewPackets(x)).toThrow(
      "QUESTION_FROZEN_IDENTITY_MISMATCH",
    );
    const y = fixture();
    y.questions.pop();
    expect(() => buildBlindedWriterReviewPackets(y)).toThrow(
      "QUESTION_OR_WRITER_RUN_SCOPE",
    );
  });
  it("rejects duplicate, missing or incompatible arms", () => {
    const x = fixture();
    const row = JSON.parse(new TextDecoder().decode(x.writerRunBytes));
    row.readerRows[0].outputs.push(row.readerRows[0].outputs[0]);
    expect(() =>
      buildBlindedWriterReviewPackets({ ...x, writerRunBytes: bytes(row) }),
    ).toThrow("WRITER_ROW_NOT_PINNED");
    row.readerRows[0].outputs = [row.readerRows[0].outputs[0]];
    expect(() =>
      buildBlindedWriterReviewPackets({ ...x, writerRunBytes: bytes(row) }),
    ).toThrow("SECTION_WRITER_ARM_SCOPE_INCONSISTENT");
  });
  it("rejects purported writer answers without citation id or invalid abstention shape", () => {
    const x = fixture();
    const row = JSON.parse(new TextDecoder().decode(x.writerRunBytes));
    row.readerRows[0].outputs[1].citations = [];
    expect(() =>
      buildBlindedWriterReviewPackets({ ...x, writerRunBytes: bytes(row) }),
    ).toThrow("WRITER_RESPONSE_INVALID");
    row.readerRows[0].outputs[1].citations = ["SECTION1"];
    row.readerRows[0].outputs[0].answer = "secret";
    expect(() =>
      buildBlindedWriterReviewPackets({ ...x, writerRunBytes: bytes(row) }),
    ).toThrow("WRITER_RESPONSE_INVALID");
  });
  it("enforces 32 bytes of private per-run seed", () => {
    const x = fixture();
    x.privateOwnerSeed = new Uint8Array(31);
    expect(() => buildBlindedWriterReviewPackets(x)).toThrow(
      "FROZEN_INPUT_PIN_OR_SEED_INVALID",
    );
  });
});
