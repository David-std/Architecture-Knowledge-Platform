import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  reviewS2ClaimCorroboration,
  s2CorroborationInputSha256,
} from "../src/s2-claim-corroboration.js";
import { assessS2QuoteSemantics } from "../src/s2-semantic-evidence.js";
import type { S2ExactQuoteOriginal } from "../src/s2-exact-quote-attribution.js";
const sha = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const quote =
  "The permissions key changes which capabilities a deployment token may use.";
const text = "## Source\n\n" + quote + "\n\n## Other source material";
const question = "Which key changes deployment token capabilities?";
const claim =
  "The permissions key changes which capabilities a deployment token may use.";
const original: S2ExactQuoteOriginal = {
  assignedSourceId: "SRC1",
  sourceSha256: sha(Buffer.from(text)),
  exactUtf8Bytes: Buffer.from(text),
  bodyStartUtf16: 0,
  bodyEndUtf16: text.length,
};
const request = { question, claim, quote, original };
const inputSha = s2CorroborationInputSha256(request);
async function reviewer(
  family: string,
  claimDecision: "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT" = "SUPPORTS",
) {
  const s = await assessS2QuoteSemantics(
    question,
    {
      answerText: claim,
      evidenceQuote: quote,
      sourceId: "SRC1",
      abstained: false,
    },
    [original],
    {
      questionRelevanceProbe: {
        id: family + "@question",
        verify: async () => ({
          decision: "SUPPORTS",
          reason: "LITERAL_QUESTION_BINDING",
          evidenceSpan: { startUtf16: 0, endUtf16: quote.length },
        }),
      },
      claimEntailmentProbe: {
        id: family + "@claim",
        verify: async () =>
          claimDecision === "INSUFFICIENT"
            ? { decision: claimDecision, reason: "SOURCE_DOES_NOT_ENTAIL" }
            : {
                decision: claimDecision,
                reason: "FULL_CLAIM_VERIFIED",
                evidenceSpan: { startUtf16: 0, endUtf16: quote.length },
              },
      },
    },
  );
  return {
    declaredModelFamily: family,
    modelDigestSha256: sha(family + " pinned model"),
    providerResponseSha256: sha(family + " provider-response"),
    boundInputSha256: inputSha,
    assessment: s,
  };
}
describe("source-bound cross-reader guard is never production authority", () => {
  it("requires both complete-claim and question stages and only yields a shadow proposal", async () => {
    const x = reviewS2ClaimCorroboration({
      ...request,
      reviewers: [await reviewer("family-a"), await reviewer("family-b")],
    });
    expect(x).toMatchObject({
      status: "CORROBORATED_PROPOSAL_ONLY",
      supportingReviews: 2,
      modelFamiliesCryptographicallyIndependent: false,
      wholeAnswerSemanticsVerified: false,
      sourcePermissionReauthenticated: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
  });
  it("one model cannot pass", async () => {
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [await reviewer("family-a")],
      }).status,
    ).toBe("REJECTED");
  });
  it("a different-reader disagreement withholds rather than accepts first positive", async () => {
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [
          await reviewer("family-a"),
          await reviewer("family-b", "INSUFFICIENT"),
        ],
      }),
    ).toMatchObject({
      status: "WITHHELD_DISAGREEMENT",
      supportingReviews: 1,
      uncertainReviews: 1,
    });
  });
  it("an explicit contradiction proposal takes priority over support proposal", async () => {
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [
          await reviewer("family-a"),
          await reviewer("family-b", "CONTRADICTS"),
        ],
      }),
    ).toMatchObject({
      status: "WITHHELD_CONTRADICTION_PROPOSAL",
      contradictedReviews: 1,
    });
  });
  it("rejects a replay from an identical declared family, model receipt or stage probe", async () => {
    const a = await reviewer("family-a"),
      b = await reviewer("family-b");
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [a, { ...b, declaredModelFamily: a.declaredModelFamily }],
      }).status,
    ).toBe("REJECTED");
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [
          a,
          { ...b, providerResponseSha256: a.providerResponseSha256 },
        ],
      }).status,
    ).toBe("REJECTED");
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [
          a,
          {
            ...b,
            assessment: {
              ...b.assessment,
              claimProbeId: a.assessment.claimProbeId,
            },
          },
        ],
      }).status,
    ).toBe("REJECTED");
  });
  it("blocks changed question, changed claim, changed quote, changed source or repaired source ID", async () => {
    const a = await reviewer("family-a"),
      b = await reviewer("family-b");
    const pair = [a, b];
    for (const changed of [
      { ...request, question: "Which version is allowed?" },
      { ...request, claim: "An administrator changes the permissions." },
      { ...request, quote: quote.replace("changes", "specifies") },
      { ...request, original: { ...original, sourceSha256: sha("tampered") } },
    ])
      expect(
        reviewS2ClaimCorroboration({ ...changed, reviewers: pair }).status,
      ).toBe("REJECTED");
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        reviewers: [
          {
            ...a,
            assessment: {
              ...a.assessment,
              attribution: {
                ...a.assessment.attribution,
                modelSourceIdConfirmed: false,
              },
            },
          },
          b,
        ],
      }).status,
    ).toBe("REJECTED");
  });
  it("never accepts a source quote with repeated text or repaired UTF-16", async () => {
    const a = await reviewer("family-a"),
      b = await reviewer("family-b");
    const repeated = Buffer.from(text + "\n" + quote);
    expect(
      reviewS2ClaimCorroboration({
        ...request,
        original: {
          ...original,
          exactUtf8Bytes: repeated,
          sourceSha256: sha(repeated),
          bodyEndUtf16: repeated.toString().length,
        },
        reviewers: [a, b],
      }).status,
    ).toBe("REJECTED");
  });
});
