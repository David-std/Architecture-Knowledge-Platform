import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assessS2CompleteAnswer,
  S2_RELATION_FACETS,
  type S2SourceBoundRelationFacetReview,
  type S2WholeAnswerCheck,
} from "../src/s2-complete-answer-evidence.js";
import type { S2SemanticProbe } from "../src/s2-semantic-evidence.js";

const evidence1 = "The vessel named Orion docks in harbor B.";
const evidence2 = "Orion's inspection certificate expires in 2031.";
const body = "# Vessel register\n" + evidence1 + "\n" + evidence2 + "\n";
const bytes = Buffer.from(body);
const original = {
  assignedSourceId: "S1",
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  exactUtf8Bytes: bytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: body.length,
};
const claim1 = "Orion docks in harbor B.";
const claim2 = "Its certificate expires in 2031.";
const answer = claim1 + " " + claim2;
const input = {
  originalQuestion:
    "Where does Orion dock and when does its certificate expire?",
  abstained: false,
  answerText: answer,
  claims: [
    {
      startUtf16: 0,
      endUtf16: claim1.length,
      claimText: claim1,
      evidenceQuote: evidence1,
      claimedSourceId: "S9",
    },
    {
      startUtf16: claim1.length + 1,
      endUtf16: answer.length,
      claimText: claim2,
      evidenceQuote: evidence2,
      claimedSourceId: "S1",
    },
  ],
};
const q = (id: string): S2SemanticProbe => ({
  id,
  verify: vi.fn(async ({ exactQuote }) => ({
    decision: "SUPPORTS" as const,
    reason: "MODEL_SUPPORT",
    evidenceSpan: { startUtf16: 0, endUtf16: exactQuote.length },
  })),
});
const w = (
  id: string,
  verdict: "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT" = "SUPPORTS",
): S2WholeAnswerCheck => ({
  id,
  verify: vi.fn(async () => verdict),
});
const cfg = () => ({
  semantic: {
    questionRelevanceProbe: q("QA@fixed"),
    claimEntailmentProbe: q("NLI@fixed"),
    timeoutMs: 100,
  },
  sourceContextVerifier: w("context@fixed"),
  atomicityVerifier: w("atomic@fixed"),
  consistencyVerifier: w("consistency@fixed"),
});
describe("S2 complete multi-claim answer proof in shadow", () => {
  it("fails closed when verified nearby source text reverses the quoted condition", async () => {
    const conf = {
      ...cfg(),
      sourceContextVerifier: {
        id: "context@conditional-v1",
        verify: vi.fn(
          async (packet: {
            boundAttributions: readonly {
              localSourceContext: string;
              exactQuote: string;
            }[];
          }) => {
            expect(packet.boundAttributions[0]?.localSourceContext).toContain(
              "harbor B",
            );
            expect(packet.boundAttributions[0]?.exactQuote).toBe(evidence1);
            return "CONTRADICTS" as const;
          },
        ),
      },
    };
    const out = await assessS2CompleteAnswer(input, [original], conf);
    expect(out).toMatchObject({
      status: "CONTRADICTED",
      reason: "SOURCE_CONTEXT_CONTRADICTS",
      sourceContextCheck: "CONTRADICTS",
    });
    expect(conf.atomicityVerifier.verify).not.toHaveBeenCalled();
  });
  it("does not approve a semantic check with the same identity reused for context and consistency", async () => {
    const conf = cfg();
    conf.sourceContextVerifier = conf.consistencyVerifier;
    expect((await assessS2CompleteAnswer(input, [original], conf)).status).toBe(
      "REJECTED",
    );
  });

  it("requires each claim plus independent atomicity and cross-claim checks", async () => {
    const conf = cfg();
    const out = await assessS2CompleteAnswer(input, [original], conf);
    expect(out).toMatchObject({
      status: "COMPLETE_SUPPORTED_CANDIDATE",
      productionAdmission: false,
      releaseGateAccepted: false,
      atomicityCheck: "SUPPORTS",
      consistencyCheck: "SUPPORTS",
      sourceContextCheck: "SUPPORTS",
    });
    expect(out.claimResults).toHaveLength(2);
    expect(out.claimResults[0]?.attribution).toMatchObject({
      assignedSourceId: "S1",
      modelSourceIdRepairedByLiteralProof: true,
    });
    expect(conf.consistencyVerifier.verify).toHaveBeenCalledTimes(1);
    expect(conf.sourceContextVerifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        boundAttributions: expect.arrayContaining([
          expect.objectContaining({
            exactQuote: evidence1,
            localSourceContext: expect.stringContaining("harbor B"),
          }),
        ]),
      }),
    );
  });
  it("prevents dropping an ungrounded suffix outside all claim spans", async () => {
    const out = await assessS2CompleteAnswer(
      { ...input, answerText: answer + " Unknown extra fact." },
      [original],
      cfg(),
    );
    expect(out.reason).toBe("CLAIM_COVERAGE_OR_CHECK_CONFIGURATION_INVALID");
  });
  it("rejects fabricated claim not equal to the exact source answer span", async () => {
    const out = await assessS2CompleteAnswer(
      {
        ...input,
        claims: [
          { ...input.claims[0]!, claimText: "Wrong text" },
          input.claims[1]!,
        ],
      },
      [original],
      cfg(),
    );
    expect(out.status).toBe("REJECTED");
  });
  it("detects gaps, overlaps and invalid UTF-16 half-surrogate spans", async () => {
    const wrong = [
      [{ ...input.claims[0]!, endUtf16: 4 }, input.claims[1]!],
      [input.claims[0]!, { ...input.claims[1]!, startUtf16: 5 }],
      [{ ...input.claims[0]!, startUtf16: -1 }, input.claims[1]!],
    ];
    for (const claims of wrong) {
      expect(
        (await assessS2CompleteAnswer({ ...input, claims }, [original], cfg()))
          .status,
      ).toBe("REJECTED");
    }
    const smile = "Fact 😀.";
    const out = await assessS2CompleteAnswer(
      {
        ...input,
        answerText: smile,
        claims: [
          {
            claimText: smile.slice(0, 6),
            startUtf16: 0,
            endUtf16: 6,
            evidenceQuote: evidence1,
            claimedSourceId: "S1",
          },
        ],
      },
      [original],
      cfg(),
    );
    expect(out.status).toBe("REJECTED");
  });
  it("fails when an individual claim contradicts the evidence", async () => {
    const conf = cfg();
    conf.semantic.claimEntailmentProbe = {
      id: "NLI@fixed",
      verify: vi.fn(async ({ answerClaim, exactQuote }) => ({
        decision: answerClaim.includes("2031")
          ? ("CONTRADICTS" as const)
          : ("SUPPORTS" as const),
        reason: "TEST_PROBE",
        evidenceSpan: { startUtf16: 0, endUtf16: exactQuote.length },
      })),
    };
    const out = await assessS2CompleteAnswer(input, [original], conf);
    expect(out.status).toBe("CONTRADICTED");
    expect(conf.atomicityVerifier.verify).not.toHaveBeenCalled();
  });
  it("blocks incomplete atomic decomposition and cross-source conflicts", async () => {
    expect(
      (
        await assessS2CompleteAnswer(input, [original], {
          ...cfg(),
          atomicityVerifier: w("atomic@v1", "INSUFFICIENT"),
        })
      ).reason,
    ).toBe("ATOMICITY_INSUFFICIENT");
    expect(
      (
        await assessS2CompleteAnswer(input, [original], {
          ...cfg(),
          consistencyVerifier: w("consistency@v1", "CONTRADICTS"),
        })
      ).reason,
    ).toBe("CROSS_CLAIM_CONTRADICTS");
  });
  it("does not let the same unpinned model satisfy both whole-answer checks", async () => {
    const both = w("same@v1");
    expect(
      (
        await assessS2CompleteAnswer(input, [original], {
          ...cfg(),
          atomicityVerifier: both,
          consistencyVerifier: both,
        })
      ).status,
    ).toBe("REJECTED");
  });
  it("fails closed when cross-claim model errors or times out", async () => {
    const conf = {
      ...cfg(),
      consistencyVerifier: {
        id: "consistency@v1",
        verify: async () => new Promise<"SUPPORTS">(() => {}),
      },
    };
    expect((await assessS2CompleteAnswer(input, [original], conf)).status).toBe(
      "ERROR",
    );
  });
  it("does not incorrectly certify an empty abstention as justified", async () => {
    const conf = cfg();
    const out = await assessS2CompleteAnswer(
      {
        ...input,
        answerText: "",
        claims: [],
        abstained: true,
      },
      [original],
      conf,
    );
    expect(out).toMatchObject({
      status: "ABSTENTION_UNVERIFIED",
      reason: "EMPTY_ABSTENTION_NOT_ADJUDICATED",
      releaseGateAccepted: false,
      productionAdmission: false,
    });
    expect(conf.atomicityVerifier.verify).not.toHaveBeenCalled();
    expect(conf.semantic.questionRelevanceProbe.verify).not.toHaveBeenCalled();
  });
  it("rejects a blank-question abstention rather than silently accepting it", async () => {
    const out = await assessS2CompleteAnswer(
      {
        ...input,
        originalQuestion: "",
        answerText: "",
        claims: [],
        abstained: true,
      },
      [original],
      cfg(),
    );
    expect(out.status).toBe("REJECTED");
  });

  const shaText = (v: string) =>
    createHash("sha256").update(v, "utf8").digest("hex");
  const facetPackets = (): S2SourceBoundRelationFacetReview[] =>
    input.claims.map((claim, i) => ({
      claimIndex: i,
      questionSha256: shaText(input.originalQuestion),
      claimSha256: shaText(claim.claimText),
      exactQuoteSha256: shaText(claim.evidenceQuote),
      sourceSha256: original.sourceSha256,
      reviewerId: "development-annotation@frozen-v1",
      facets: S2_RELATION_FACETS.map((facet) => ({
        facet,
        applicability: (["subject", "predicate", "answerRole"].includes(facet)
          ? "APPLICABLE"
          : "NOT_APPLICABLE") as const,
        modelObservation: (["subject", "predicate", "answerRole"].includes(
          facet,
        )
          ? "ALIGNED"
          : "UNKNOWN") as const,
      })),
    }));

  it("an optional source-bound applicability packet observes only applicable facets without promoting the claim", async () => {
    const conf = { ...cfg(), sourceBoundRelationFacetReviews: facetPackets() };
    const out = await assessS2CompleteAnswer(input, [original], conf);
    expect(out).toMatchObject({
      status: "COMPLETE_SUPPORTED_CANDIDATE",
      relationFacetAudit: "ALL_APPLICABLE_FACETS_ALIGNED_PROPOSAL_ONLY",
      relationFacetIndependentAdjudicationVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(out.claimResults).toHaveLength(2);
  });
  it("refuses applicable UNKNOWN or CONFLICT despite positive F3 and atomicity proposals", async () => {
    for (const [observation, expected] of [
      ["UNKNOWN", "APPLICABLE_OBSERVATION_UNCERTAIN"],
      ["CONFLICT", "RELATION_CONFLICT_PROPOSED"],
    ] as const) {
      const p = facetPackets();
      p[1] = {
        ...p[1]!,
        facets: p[1]!.facets.map((x) =>
          x.facet === "predicate" ? { ...x, modelObservation: observation } : x,
        ),
      };
      const conf = { ...cfg(), sourceBoundRelationFacetReviews: p };
      const out = await assessS2CompleteAnswer(input, [original], conf);
      expect(out).toMatchObject({
        status: "INSUFFICIENT",
        relationFacetAudit: expected,
        relationFacetIndependentAdjudicationVerified: false,
      });
      expect(conf.atomicityVerifier.verify).not.toHaveBeenCalled();
    }
  });
  it("requires explicit applicability, never silently treats UNKNOWN or all-N/A as source support", async () => {
    for (const scope of ["UNRESOLVED", "NOT_APPLICABLE"] as const) {
      const p = facetPackets();
      p[0] = {
        ...p[0]!,
        facets: p[0]!.facets.map((x) => ({
          ...x,
          applicability: scope,
          modelObservation: "UNKNOWN",
        })),
      };
      if (scope === "NOT_APPLICABLE") {
        p[1] = {
          ...p[1]!,
          facets: p[1]!.facets.map((x) => ({
            ...x,
            applicability: scope,
            modelObservation: "UNKNOWN",
          })),
        };
      }
      const out = await assessS2CompleteAnswer(input, [original], {
        ...cfg(),
        sourceBoundRelationFacetReviews: p,
      });
      expect(out.relationFacetAudit).toBe("APPLICABILITY_REVIEW_REQUIRED");
      expect(out.productionAdmission).toBe(false);
    }
  });
  it("does not let an all-N/A claim borrow facet coverage from another claim", async () => {
    // Two individually source-bound claims: all claims must be audited.
    // This is a fixture assertion, not independent judgment of Orion facts.
    for (const missingClaimIndex of [0, 1]) {
      const packets = facetPackets();
      packets[missingClaimIndex] = {
        ...packets[missingClaimIndex]!,
        facets: packets[missingClaimIndex]!.facets.map((item) => ({
          ...item,
          applicability: "NOT_APPLICABLE" as const,
          modelObservation: "UNKNOWN" as const,
        })),
      };
      const conf = { ...cfg(), sourceBoundRelationFacetReviews: packets };
      const result = await assessS2CompleteAnswer(input, [original], conf);
      expect(result).toMatchObject({
        status: "INSUFFICIENT",
        relationFacetAudit: "APPLICABILITY_REVIEW_REQUIRED",
        productionAdmission: false,
        releaseGateAccepted: false,
      });
      expect(conf.consistencyVerifier.verify).not.toHaveBeenCalled();
      expect(conf.atomicityVerifier.verify).not.toHaveBeenCalled();
    }
  });

  it("binds each annotation to the exact question, claim, original source and quote, not merely a reviewer label", async () => {
    for (const mutation of [
      "claim",
      "question",
      "source",
      "quote",
      "facets",
      "index",
      "id",
    ] as const) {
      const p = facetPackets();
      const first = p[0]!;
      const changes = {
        claim: { claimSha256: shaText("unrelated writer claim") },
        question: { questionSha256: shaText("different question") },
        source: { sourceSha256: "0".repeat(64) },
        quote: { exactQuoteSha256: shaText("similar paraphrase") },
        facets: { facets: [...first.facets.slice(1), first.facets[1]!] },
        index: { claimIndex: 1 },
        id: { reviewerId: "" },
      };
      p[0] = { ...first, ...changes[mutation] };
      const conf = { ...cfg(), sourceBoundRelationFacetReviews: p };
      const out = await assessS2CompleteAnswer(input, [original], conf);
      expect(out).toMatchObject({
        status: "INSUFFICIENT",
        relationFacetAudit: "SOURCE_OR_REVIEW_BINDING_INVALID",
        productionAdmission: false,
      });
      expect(conf.consistencyVerifier.verify).not.toHaveBeenCalled();
    }
  });
  it("holds a threshold-changing complete answer when an applicable condition is disputed", async () => {
    const sourceText =
      "Mesa-2 may open only above 14 bar; at 14 bar or below it stays closed.";
    const sourceBytes = Buffer.from(sourceText);
    const sourceOriginal = {
      assignedSourceId: "SRC-MESA",
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      exactUtf8Bytes: sourceBytes,
      bodyStartUtf16: 0,
      bodyEndUtf16: sourceText.length,
    };
    const claimText = "Mesa-2 may open at 14 bar.";
    const questionText = "At which pressure may Mesa-2 open?";
    const answerInput = {
      originalQuestion: questionText,
      answerText: claimText,
      abstained: false,
      claims: [
        {
          claimText,
          startUtf16: 0,
          endUtf16: claimText.length,
          evidenceQuote: sourceText,
          claimedSourceId: "SRC-MESA",
        },
      ],
    };
    const facetReview: S2SourceBoundRelationFacetReview = {
      claimIndex: 0,
      questionSha256: shaText(questionText),
      claimSha256: shaText(claimText),
      exactQuoteSha256: shaText(sourceText),
      sourceSha256: sourceOriginal.sourceSha256,
      reviewerId: "illustrative-dev-review@not-independent",
      facets: S2_RELATION_FACETS.map((facet) => ({
        facet,
        applicability: facet === "conditions" ? "APPLICABLE" : "NOT_APPLICABLE",
        modelObservation: facet === "conditions" ? "CONFLICT" : "UNKNOWN",
      })),
    };
    // The mock F3 claims SUPPORTS even for the wrong >14 versus =14 answer.
    // This tests diagnostic stage custody, NOT a trained semantic detector.
    const observed = await assessS2CompleteAnswer(
      answerInput,
      [sourceOriginal],
      { ...cfg(), sourceBoundRelationFacetReviews: [facetReview] },
    );
    expect(observed).toMatchObject({
      status: "INSUFFICIENT",
      relationFacetAudit: "RELATION_CONFLICT_PROPOSED",
      productionAdmission: false,
      relationFacetIndependentAdjudicationVerified: false,
    });
  });
  it("refuses unauthorised or changed source SHA before whole-answer checks", async () => {
    const conf = cfg();
    const out = await assessS2CompleteAnswer(
      input,
      [{ ...original, sourceSha256: "0".repeat(64) }],
      conf,
    );
    expect(out).toMatchObject({
      status: "REJECTED",
      reason: "INDIVIDUAL_CLAIM_REJECTED",
    });
    expect(conf.consistencyVerifier.verify).not.toHaveBeenCalled();
  });
});
