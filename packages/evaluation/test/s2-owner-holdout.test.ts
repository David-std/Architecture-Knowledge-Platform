import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { prepareOwnerHoldout } from "../src/s2-owner-holdout.js";
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const blob = (x: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.from("blob " + x.length + "\0"))
    .update(x)
    .digest("hex");
const enc = (x: unknown) => Buffer.from(JSON.stringify(x));
const sources = [
  {
    family: "nodejs",
    path: "doc/a.md",
    local: "nodejs/a.md",
    text: "## A\nTimer delays execution. 😀",
  },
  {
    family: "rust-lang",
    path: "src/b.md",
    local: "rust-lang/b.md",
    text: "## B\nOwnership governs memory. 😀",
  },
];
function fixture() {
  const families = sources.map((s, i) => {
    const bytes = Buffer.from(s.text);
    return {
      publisherFamily: s.family,
      repository: i === 0 ? "nodejs/node" : "rust-lang/book",
      commitSha: (i === 0 ? "a" : "b").repeat(40),
      files: [
        {
          relativePath: s.path,
          localRelativePath: s.local,
          bytes: bytes.length,
          sourceSha256: sha(bytes),
          upstreamGitBlobSha1: blob(bytes),
          upstreamCommitSha: (i === 0 ? "a" : "b").repeat(40),
        },
      ],
    };
  });
  const candidate = {
    schemaVersion: "akp.s2.external-public-source-candidates.v1",
    status: "IMPLEMENTER_SELECTED_SOURCE_CANDIDATES_NOT_INDEPENDENT_HOLDOUT",
    developmentPublisherDenylist: ["mdn"],
    families,
    answerLabelsCreated: false,
    independentSourceCustodianAttested: false,
    publisherDisjointnessSelfReportedOnly: true,
    gateAccepted: false,
  };
  const candidateManifestBytes = enc(candidate);
  const proposed = [];
  for (const family of sources) {
    for (const lang of ["en", "es"] as const) {
      for (const supported of [true, false]) {
        const question = `${family.family}:${lang}:${supported ? "explicit" : "unanswerable"}?`;
        const quote =
          family.family === "nodejs"
            ? "Timer delays execution."
            : "Ownership governs memory.";
        const start = family.text.indexOf(quote);
        proposed.push({
          questionKeySha256: sha(lang + "\0" + question),
          language: lang,
          question,
          sourceFamily: family.family,
          relativePath: family.path,
          proposedDisposition: supported
            ? "EXPLICITLY_DECIDABLE"
            : "NOT_SUPPORTED",
          proposedAnswer: supported ? "Yes." : "",
          proposedQuotes: supported
            ? [{ startUtf16: start, endUtf16: start + quote.length, quote }]
            : [],
        });
      }
    }
  }
  const caseManifest = {
    schemaVersion: "akp.s2.owner-case-proposals.v1",
    candidateManifestSha256: sha(candidateManifestBytes),
    custodianMode: "OWNER_CONTROLLED",
    questionsCreatedBeforeModelExecution: true,
    writerOutputsInspectedBeforeFreeze: false,
    cases: proposed,
  };
  const caseManifestBytes = enc(caseManifest);
  return {
    candidateManifestBytes,
    precommittedCandidateManifestSha256: sha(candidateManifestBytes),
    caseManifestBytes,
    precommittedCaseManifestSha256: sha(caseManifestBytes),
    sourceFiles: sources.map((s) => ({
      localRelativePath: s.local,
      originalBytes: Buffer.from(s.text),
    })),
    privateShuffleSeed: Buffer.alloc(32, 7),
  };
}
describe("owner-controlled source-verified blind holdout preparation", () => {
  it("makes complete X/Y packets without gold, exposes owner role accurately", () => {
    const r = prepareOwnerHoldout(fixture());
    expect(r).toMatchObject({
      status: "OWNER_CUSTODIED_BLIND_PACKETS_PREPARED",
      families: 2,
      originalFiles: 2,
      questions: 8,
      unsupportedQuestions: 4,
      languages: { en: 4, es: 4 },
      externalCustodianAuthenticated: false,
      gateAccepted: false,
    });
    for (const packet of r.packets) {
      expect(packet.cases).toHaveLength(8);
      expect(packet.originals).toHaveLength(2);
      expect(packet.ownerProposedGoldIncluded).toBe(false);
      expect(
        packet.cases.every(
          (c) => c.reviewerDisposition === null && c.reviewerAnswer === null,
        ),
      ).toBe(true);
      expect(JSON.stringify(packet)).not.toContain("proposedDisposition");
      expect(JSON.stringify(packet)).not.toContain(
        'Timer delays execution."}]',
      );
    }
  });
  it("rejects altered original source bytes", () => {
    const x = fixture();
    x.sourceFiles[0]!.originalBytes = Buffer.from("changed");
    expect(() => prepareOwnerHoldout(x)).toThrow(
      "ORIGINAL_FILE_BYTES_NOT_FROZEN",
    );
  });
  it("rejects case edits and unmatched precommit", () => {
    const x = fixture();
    x.precommittedCaseManifestSha256 = sha("modified");
    expect(() => prepareOwnerHoldout(x)).toThrow(
      "MISSING_PRECOMMITTED_MANIFEST_OR_SEED",
    );
  });
  it("rejects positive quote with false UTF16 coordinates", () => {
    const x = fixture();
    const c = JSON.parse(Buffer.from(x.caseManifestBytes).toString());
    c.cases[0].proposedQuotes[0].startUtf16++;
    x.caseManifestBytes = enc(c);
    x.precommittedCaseManifestSha256 = sha(x.caseManifestBytes);
    expect(() => prepareOwnerHoldout(x)).toThrow(
      "GOLD_SOURCE_QUOTE_NOT_EXACT_UTF16",
    );
  });
  it("rejects publisher that has been in development", () => {
    const x = fixture();
    const c = JSON.parse(Buffer.from(x.candidateManifestBytes).toString());
    c.families[1].publisherFamily = "mdn";
    x.candidateManifestBytes = enc(c);
    x.precommittedCandidateManifestSha256 = sha(x.candidateManifestBytes);
    const q = JSON.parse(Buffer.from(x.caseManifestBytes).toString());
    q.candidateManifestSha256 = x.precommittedCandidateManifestSha256;
    x.caseManifestBytes = enc(q);
    x.precommittedCaseManifestSha256 = sha(x.caseManifestBytes);
    expect(() => prepareOwnerHoldout(x)).toThrow("SOURCE_FAMILY_INVALID");
  });
  it("rejects any missing negative/polarity language stratum", () => {
    const x = fixture();
    const q = JSON.parse(Buffer.from(x.caseManifestBytes).toString());
    q.cases[0].proposedDisposition = "EXPLICITLY_DECIDABLE";
    q.cases[1].proposedDisposition = "EXPLICITLY_DECIDABLE";
    q.cases[1].proposedAnswer = "Yes";
    q.cases[1].proposedQuotes = q.cases[0].proposedQuotes;
    x.caseManifestBytes = enc(q);
    x.precommittedCaseManifestSha256 = sha(x.caseManifestBytes);
    expect(() => prepareOwnerHoldout(x)).toThrow(
      "NO_BALANCED_PUBLISHER_LANGUAGE_POLARITY_COVERAGE",
    );
  });
});
