import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
} from "@akp/retrieval";
import { buildS2AdmissionShadowObservation } from "../src/s2-admission-shadow.js";
import {
  rebindS2AdmissionToSource,
  type S2AuthorizedSourceSnapshot,
} from "../src/s2-source-rebind.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const excerpt = "  🔋 M-7 battery measured 63%.  ";
const sourceText = "First line\n🔋 M-7 battery measured 63%.\nLast line";
const hit = {
  vaultId: "vault-7",
  documentId: "document-7",
  unitId: "unit-7",
  document: {
    externalId: "synthetic",
    path: "synthetic.md",
    title: "Synthetic",
  },
  title: "Synthetic",
  unitType: "PARAGRAPH",
  type: "concept",
  trust: "HUMAN_REVIEWED",
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  score: 1,
  reasons: ["test"],
  fusionContributions: [],
  citations: [],
  revision: "rev-7",
  excerpt,
} as SearchHit;

const scenario = (admitted = true) => {
  const baseline = assessRetrievalAnswerability([hit], "What is M-7 battery?");
  const trimmed = excerpt.trim();
  const spanStart = trimmed.indexOf("63%");
  const observation = buildS2AdmissionShadowObservation({
    surface: "search",
    mode: "LAYERED",
    query: "What is M-7 battery?",
    authorizedVaultIds: [hit.vaultId],
    pool: [hit],
    admissionElapsedMs: 1.25,
    assessment: {
      ...baseline,
      supported: admitted,
      supportedCandidateKeys: admitted
        ? [retrievalAnswerabilityCandidateKey(hit)]
        : [],
      candidateSignals: baseline.candidateSignals.map((signal) => ({
        ...signal,
        queryConditionedEvidence: {
          verifierId: "reader:synthetic",
          mode: "LAYERED" as const,
          decision: "SUPPORTS" as const,
          score: null,
          reason: "SPAN_SUPPORTED",
          evidenceSpan: {
            startOffset: spanStart,
            endOffset: spanStart + 3,
          },
        },
      })),
    },
  });
  const snapshot: S2AuthorizedSourceSnapshot = {
    query: "What is M-7 battery?",
    authorizedVaultIds: [hit.vaultId],
    candidates: [
      {
        vaultId: hit.vaultId,
        documentId: hit.documentId,
        unitId: hit.unitId ?? null,
        revision: hit.revision,
        excerpt,
        sourceUnitText: sourceText,
        sourceUnitSha256: sha256(sourceText),
      },
    ],
  };
  return { observation, snapshot };
};

describe("S2 authorized source rebinding", () => {
  it("rebases exact UTF-16 quote bytes to the only matching original unit", () => {
    const { observation, snapshot } = scenario();
    const result = rebindS2AdmissionToSource(observation, snapshot);
    const start = sourceText.indexOf("63%");
    expect(result).toMatchObject({
      admittedCount: 1,
      admittedWithSourceReboundSpan: 1,
      admittedWithoutSourceReboundSpan: 0,
      sourceProvenanceExternallyVerified: false,
      gateAccepted: false,
    });
    expect(result.results[0]).toMatchObject({
      status: "SOURCE_SPAN_REBOUND",
      sourceSpan: {
        startOffsetUtf16: start,
        endOffsetUtf16: start + 3,
        quoteSha256: sha256("63%"),
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("battery measured");
    expect(serialized).not.toContain("What is M-7");
    expect(serialized).not.toContain("vault-7");
  });

  it("never counts a shadow reader quote as application admission", () => {
    const { observation, snapshot } = scenario(false);
    expect(rebindS2AdmissionToSource(observation, snapshot)).toMatchObject({
      admittedCount: 0,
      admittedWithSourceReboundSpan: 0,
      results: [{ status: "NOT_ADMITTED", sourceSpan: null }],
    });
  });

  it("fails closed on changed identity, scope, revision, excerpt or source pin", () => {
    for (const mutation of [
      (s: S2AuthorizedSourceSnapshot) => {
        s.query += "?";
      },
      (s: S2AuthorizedSourceSnapshot) => {
        s.authorizedVaultIds = ["other"];
      },
      (s: S2AuthorizedSourceSnapshot) => {
        s.candidates[0]!.revision += "x";
      },
      (s: S2AuthorizedSourceSnapshot) => {
        s.candidates[0]!.excerpt += "x";
      },
      (s: S2AuthorizedSourceSnapshot) => {
        s.candidates[0]!.sourceUnitText += "x";
      },
      (s: S2AuthorizedSourceSnapshot) => {
        s.candidates[0]!.unitId = "other";
      },
      (s: S2AuthorizedSourceSnapshot) => {
        s.candidates = [];
      },
    ]) {
      const { observation, snapshot } = scenario();
      mutation(snapshot);
      expect(() => rebindS2AdmissionToSource(observation, snapshot)).toThrow(
        /S2_REBIND_/u,
      );
    }
  });

  it("does not guess a source offset for absent or repeated excerpts", () => {
    const { observation, snapshot } = scenario();
    snapshot.candidates[0]!.sourceUnitText = "unrelated source";
    snapshot.candidates[0]!.sourceUnitSha256 = sha256("unrelated source");
    expect(
      rebindS2AdmissionToSource(observation, snapshot).results[0],
    ).toMatchObject({
      status: "SOURCE_EXCERPT_MISSING",
    });
    snapshot.candidates[0]!.sourceUnitText = `${sourceText}\n${sourceText}`;
    snapshot.candidates[0]!.sourceUnitSha256 = sha256(
      snapshot.candidates[0]!.sourceUnitText,
    );
    expect(
      rebindS2AdmissionToSource(observation, snapshot).results[0],
    ).toMatchObject({
      status: "SOURCE_EXCERPT_AMBIGUOUS",
    });
  });

  it("rejects a corrupt quote digest or a surrogate-splitting source span", () => {
    const { observation, snapshot } = scenario();
    observation.candidates[0]!.evidenceSpan!.quoteSha256 = sha256("false");
    expect(
      rebindS2AdmissionToSource(observation, snapshot).results[0],
    ).toMatchObject({
      status: "SOURCE_SPAN_HASH_MISMATCH",
    });
    const next = scenario();
    next.observation.candidates[0]!.evidenceSpan!.startOffsetUtf16 = 1;
    next.observation.candidates[0]!.evidenceSpan!.endOffsetUtf16 = 2;
    expect(
      rebindS2AdmissionToSource(next.observation, next.snapshot).results[0],
    ).toMatchObject({
      status: "INVALID_EXCERPT_SPAN",
    });
  });
});
