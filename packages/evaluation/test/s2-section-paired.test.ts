import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  scoreSectionPairedShadow,
  type SectionPairRun,
} from "../src/s2-section-paired.js";

const sha = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const h = (value: string) => sha(value);
const sha40 = "a".repeat(40);
const first = h("case-one");
const second = h("case-two");
const childOne = h("child-one");
const childTwo = h("child-two");
const sectionOne = h("section-one");
const sectionTwo = h("section-two");

function fixture() {
  const manifest = {
    schemaVersion: "akp.s2.section-paired-manifest.v1",
    executedCommitSha: sha40,
    sourceManifestSha256: h("frozen-source-manifest"),
    cases: [
      {
        caseKeySha256: first,
        scopeSha256: h("scope-a"),
        sourceFamilySha256: h("family-a"),
        language: "en",
      },
      {
        caseKeySha256: second,
        scopeSha256: h("scope-b"),
        sourceFamilySha256: h("family-b"),
        language: "es",
      },
    ],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const run: SectionPairRun = {
    schemaVersion: "akp.s2.section-paired-run.v1",
    executedCommitSha: sha40,
    sourceManifestSha256: manifest.sourceManifestSha256,
    mode: "SHADOW_ONLY",
    captures: [
      {
        caseKeySha256: first,
        scopeSha256: manifest.cases[0]!.scopeSha256,
        childRequestMs: 50,
        childDegraded: false,
        eligibleChildKeysSha256: [childOne],
        sectionLookupMs: 12,
        shadowErrorCode: null,
        sectionCandidates: [
          {
            childKeySha256: childOne,
            sectionKeySha256: sectionOne,
            originalStatus: "FROZEN_FILE_SPAN_MATCHED",
          },
        ],
      },
      {
        caseKeySha256: second,
        scopeSha256: manifest.cases[1]!.scopeSha256,
        childRequestMs: 100,
        childDegraded: false,
        eligibleChildKeysSha256: [childTwo],
        sectionLookupMs: 20,
        shadowErrorCode: null,
        sectionCandidates: [
          {
            childKeySha256: childTwo,
            sectionKeySha256: sectionTwo,
            originalStatus: "NOT_VERIFIED",
          },
        ],
      },
    ],
  };
  return {
    manifestBytes,
    externallyPinnedManifestSha256: sha(manifestBytes),
    run,
  };
}

describe("S2 paired SECTION visibility diagnostic, no gold or admission", () => {
  it("keeps qualified provenance separate from retrieval, correctness and FAR", () => {
    const report = scoreSectionPairedShadow(fixture());
    expect(report).toMatchObject({
      schemaVersion: "akp.s2.section-paired-aggregate.v1",
      status: "DESCRIPTIVE_ONLY_NOT_GATEABLE",
      caseCount: 2,
      distinctFamilyCount: 2,
      languages: { en: 1, es: 1 },
      childEligibleCount: 2,
      parentCandidateCount: 2,
      verifiedParentCount: 1,
      casesWithVerifiedParent: 1,
      casesWithParentButNoVerifiedSpan: 1,
      rejectedParentStatuses: { NOT_VERIFIED: 1 },
      childRequestP95Ms: 100,
      sectionLookupP95Ms: 20,
      sectionFullRequestP95Ms: null,
      semanticPrecision: null,
      falseAdmissionRate: null,
      answerCorrectness: null,
      actualSectionAdmissionMeasured: false,
      groundTruthLoaded: false,
      externalCustodyIndependentlyAttested: false,
      independentHoldoutEstablished: false,
      gateAccepted: false,
    });
    const output = JSON.stringify(report);
    expect(output).not.toContain(first);
    expect(output).not.toContain(childOne);
    expect(output).not.toContain("section-one");
  });
  it("rejects tampering against independently supplied manifest pin", () => {
    const f = fixture();
    f.manifestBytes = new TextEncoder().encode('{"different":true}');
    expect(() => scoreSectionPairedShadow(f)).toThrow("MANIFEST_PIN_MISMATCH");
  });
  it("rejects invented/fraudulent pins and zero-size manifests", () => {
    const f = fixture();
    expect(() =>
      scoreSectionPairedShadow({
        ...f,
        externallyPinnedManifestSha256: "0".repeat(64),
      }),
    ).toThrow("MANIFEST_PIN_MISMATCH");
    const empty = new Uint8Array();
    expect(() =>
      scoreSectionPairedShadow({
        ...f,
        manifestBytes: empty,
        externallyPinnedManifestSha256: sha(empty),
      }),
    ).toThrow("MANIFEST_PIN_MISMATCH");
  });
  it("rejects unknown, missing or duplicated captures", () => {
    const f = fixture();
    f.run.captures.pop();
    expect(() => scoreSectionPairedShadow(f)).toThrow(
      "RUN_IDENTITY_OR_SCOPE_MISMATCH",
    );
    const g = fixture();
    g.run.captures[1] = g.run.captures[0]!;
    expect(() => scoreSectionPairedShadow(g)).toThrow("CAPTURE_INVALID");
  });
  it("rejects a source-scope switch even with the same question identity", () => {
    const f = fixture();
    f.run.captures[0]!.scopeSha256 = h("foreign-scope");
    expect(() => scoreSectionPairedShadow(f)).toThrow("CAPTURE_INVALID");
  });
  it("rejects new labels or unpinned results encoded in a capture", () => {
    const f = fixture();
    (f.run.captures[0] as unknown as Record<string, unknown>).goldAnswer =
      "yes";
    expect(() => scoreSectionPairedShadow(f)).toThrow("CAPTURE_INVALID");
  });
  it("rejects a section unrelated to a recorded authorized child", () => {
    const f = fixture();
    f.run.captures[0]!.sectionCandidates[0]!.childKeySha256 = h(
      "not-an-eligible-child",
    );
    expect(() => scoreSectionPairedShadow(f)).toThrow(
      "SECTION_NOT_TIED_TO_AUTHORIZED_CHILD",
    );
  });
  it("rejects duplicated candidate ids and unexpected status", () => {
    const f = fixture();
    f.run.captures[0]!.sectionCandidates.push({
      ...f.run.captures[0]!.sectionCandidates[0]!,
    });
    expect(() => scoreSectionPairedShadow(f)).toThrow(
      "SECTION_NOT_TIED_TO_AUTHORIZED_CHILD",
    );
    const g = fixture();
    (
      g.run.captures[0]!.sectionCandidates[0] as unknown as Record<
        string,
        unknown
      >
    ).originalStatus = "CLAIMED_GOLD";
    expect(() => scoreSectionPairedShadow(g)).toThrow(
      "SECTION_NOT_TIED_TO_AUTHORIZED_CHILD",
    );
  });
  it("rejects candidates returned with a shadow error code", () => {
    const f = fixture();
    f.run.captures[0]!.shadowErrorCode = "DB_UNAVAILABLE";
    expect(() => scoreSectionPairedShadow(f)).toThrow("CAPTURE_INVALID");
  });
  it("does not permit negative durations or made-up exact token counts", () => {
    const f = fixture();
    f.run.captures[0]!.sectionLookupMs = -1;
    expect(() => scoreSectionPairedShadow(f)).toThrow("CAPTURE_INVALID");
    const g = fixture();
    (g.run.captures[0] as unknown as Record<string, unknown>).approxTokens = 99;
    expect(() => scoreSectionPairedShadow(g)).toThrow("CAPTURE_INVALID");
  });
  it("rejects duplicate manifest questions and invalid language", () => {
    const f = fixture();
    const decoded = JSON.parse(new TextDecoder().decode(f.manifestBytes));
    decoded.cases.push(decoded.cases[0]);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(decoded));
    expect(() =>
      scoreSectionPairedShadow({
        ...f,
        manifestBytes,
        externallyPinnedManifestSha256: sha(manifestBytes),
      }),
    ).toThrow("DUPLICATE_CASE");
    decoded.cases.pop();
    decoded.cases[0].language = "xx";
    const corrupt = new TextEncoder().encode(JSON.stringify(decoded));
    expect(() =>
      scoreSectionPairedShadow({
        ...f,
        manifestBytes: corrupt,
        externallyPinnedManifestSha256: sha(corrupt),
      }),
    ).toThrow("MANIFEST_INVALID");
  });
  it("prevents parent change from being mistaken for an observed full request", () => {
    const report = scoreSectionPairedShadow(fixture());
    expect(report.sectionFullRequestP95Ms).toBeNull();
    expect(report.actualSectionAdmissionMeasured).toBe(false);
  });
});
