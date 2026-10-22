import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assessS2CompleteAnswer,
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
  it("does not require models when answer is a coherent empty abstention", async () => {
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
    expect(out.status).toBe("VALID_ABSTAIN");
    expect(conf.atomicityVerifier.verify).not.toHaveBeenCalled();
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
