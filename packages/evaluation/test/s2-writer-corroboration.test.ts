import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { assessS2QuoteSemantics } from "../src/s2-semantic-evidence.js";
import { reconcileS2CorroboratedWriterCitations } from "../src/s2-writer-citation-reconciliation.js";
import type { NativeWriterObservation } from "../src/s2-native-structured-writer.js";
const quote =
  "The config key is used to grant permissions to the workflow token.";
const source = Buffer.from(
  "## Background\n\n" + quote + "\n\nAdditional context.",
);
const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const original = {
  assignedSourceId: "SRC1",
  sourceSha256: sha(source),
  exactUtf8Bytes: source,
  bodyStartUtf16: 0,
  bodyEndUtf16: source.toString().length,
};
const writer = (citations = ["SRC1"]) =>
  ({
    status: "STRUCTURALLY_VALID",
    gateAccepted: false,
    abstained: false,
    answerText: "the config key",
    citations,
    requestSha256: sha("model request"),
  }) as NativeWriterObservation;
async function assessment(decision: "SUPPORTS" | "INSUFFICIENT" = "SUPPORTS") {
  return assessS2QuoteSemantics(
    "What grants permissions? ",
    {
      answerText: "The config key grants permissions to the workflow token.",
      evidenceQuote: quote,
      sourceId: "SRC1",
      abstained: false,
    },
    [original],
    {
      questionRelevanceProbe: {
        id: "test-question@pinned",
        verify: async () => ({
          decision: "SUPPORTS",
          reason: "QUESTION_HAS_RELEVANT_SOURCE",
          evidenceSpan: { startUtf16: 0, endUtf16: quote.length },
        }),
      },
      claimEntailmentProbe: {
        id: "test-claim@pinned",
        verify: async () =>
          decision === "SUPPORTS"
            ? {
                decision,
                reason: "CLAIM_HAS_RELEVANT_SOURCE",
                evidenceSpan: { startUtf16: 0, endUtf16: quote.length },
              }
            : { decision, reason: "CLAIM_NOT_SUPPORTED" },
      },
    },
  );
}
const proof = (
  state:
    | "CORROBORATED_PROPOSAL_ONLY"
    | "WITHHELD_DISAGREEMENT"
    | "WITHHELD_CONTRADICTION_PROPOSAL" = "CORROBORATED_PROPOSAL_ONLY",
) =>
  ({
    status: state,
    reason: "SHADOW_ONLY",
    supportingReviews: state === "CORROBORATED_PROPOSAL_ONLY" ? 2 : 1,
    contradictedReviews: state === "WITHHELD_CONTRADICTION_PROPOSAL" ? 1 : 0,
    uncertainReviews: state === "WITHHELD_DISAGREEMENT" ? 1 : 0,
    quoteSha256: sha(quote),
    modelFamiliesCryptographicallyIndependent: false,
    wholeAnswerSemanticsVerified: false,
    sourcePermissionReauthenticated: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  }) as const;
describe("original F3 reconciliation plus optional independent cross-reader shadow overlay", () => {
  it("proposes corroboration only after original F3 citation contract", async () => {
    const x = reconcileS2CorroboratedWriterCitations(writer(), [
      {
        citationId: "SRC1",
        assessment: await assessment(),
        original,
        exactEvidenceQuote: quote,
        corroboration: proof(),
      },
    ]);
    expect(x).toMatchObject({
      status: "CORROBORATED_PROPOSAL_ONLY",
      originalF3: { status: "SOURCE_BOUND_CANDIDATE" },
      corroboratedCitations: 1,
      completeAnswerVerified: false,
      independentHumanGoldVerified: false,
      productionAdmission: false,
    });
  });
  it("will not upgrade a base F3 insufficient citation when models agree", async () => {
    expect(
      reconcileS2CorroboratedWriterCitations(writer(), [
        {
          citationId: "SRC1",
          assessment: await assessment("INSUFFICIENT"),
          original,
          exactEvidenceQuote: quote,
          corroboration: proof(),
        },
      ]),
    ).toMatchObject({
      status: "WITHHELD_UNCORROBORATED_SOURCE",
      originalF3: { status: "WITHHELD_UNSUPPORTED_CITATION" },
    });
  });
  it("withholds dissent even when the first reviewer and baseline both support", async () => {
    expect(
      reconcileS2CorroboratedWriterCitations(writer(), [
        {
          citationId: "SRC1",
          assessment: await assessment(),
          original,
          exactEvidenceQuote: quote,
          corroboration: proof("WITHHELD_DISAGREEMENT"),
        },
      ]).status,
    ).toBe("WITHHELD_UNCORROBORATED_SOURCE");
  });
  it("prioritizes a contradiction proposal", async () => {
    expect(
      reconcileS2CorroboratedWriterCitations(writer(), [
        {
          citationId: "SRC1",
          assessment: await assessment(),
          original,
          exactEvidenceQuote: quote,
          corroboration: proof("WITHHELD_CONTRADICTION_PROPOSAL"),
        },
      ]).status,
    ).toBe("WITHHELD_REVIEW_CONTRADICTION");
  });
  it("requires all cited IDs; cannot use one verified source for two citations", async () => {
    expect(
      reconcileS2CorroboratedWriterCitations(writer(["SRC1", "SRC2"]), [
        {
          citationId: "SRC1",
          assessment: await assessment(),
          original,
          exactEvidenceQuote: quote,
          corroboration: proof(),
        },
      ]).status,
    ).toBe("REJECTED");
  });
  it("rejects a forged quote hash, new authority flags or one-reader quorum", async () => {
    for (const forged of [
      { ...proof(), quoteSha256: "not-a-hash" },
      { ...proof(), productionAdmission: true },
      { ...proof(), supportingReviews: 1 },
    ])
      expect(
        reconcileS2CorroboratedWriterCitations(writer(), [
          {
            citationId: "SRC1",
            assessment: await assessment(),
            original,
            exactEvidenceQuote: quote,
            corroboration: forged as never,
          },
        ]).status,
      ).toBe("REJECTED");
  });
  it("rejects a quote-ID receipt whose purported original bytes or literal text have changed", async () => {
    const assessmentResult = await assessment();
    for (const change of [
      {
        original: { ...original, sourceSha256: sha("fake original") },
        exactEvidenceQuote: quote,
      },
      {
        original,
        exactEvidenceQuote: quote.replace("permissions", "configuration"),
      },
      {
        original: { ...original, exactUtf8Bytes: null },
        exactEvidenceQuote: quote,
      },
    ]) {
      const result = reconcileS2CorroboratedWriterCitations(writer(), [
        {
          citationId: "SRC1",
          assessment: assessmentResult,
          corroboration: proof(),
          ...change,
        } as never,
      ]);
      expect(result).toMatchObject({
        status: "REJECTED",
        productionAdmission: false,
      });
    }
  });
  it("writer abstention cannot become an answer by model agreement", async () => {
    const w = {
      ...writer([]),
      abstained: true,
      answerText: "",
    } as NativeWriterObservation;
    expect(reconcileS2CorroboratedWriterCitations(w, []).status).toBe(
      "REJECTED",
    );
  });
});
