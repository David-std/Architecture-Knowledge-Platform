import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assessS2AtomicEvidencePortfolio } from "../src/s2-evidence-portfolio.js";
import type { S2ExactQuoteOriginal } from "../src/s2-exact-quote-attribution.js";
const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const statementA = "The gateway authenticates the request.";
const statementB = "The operator revokes expired access tokens.";
const statementC = "The operator does not revoke unexpired access tokens.";
const originalText =
  "# Access policy\n\n" +
  statementA +
  "\n\n" +
  statementB +
  "\n\n" +
  statementC +
  "\n";
const original: S2ExactQuoteOriginal = {
  assignedSourceId: "SRC1",
  sourceSha256: sha(Buffer.from(originalText)),
  exactUtf8Bytes: Buffer.from(originalText),
  bodyStartUtf16: 0,
  bodyEndUtf16: originalText.length,
};
const window = (text: string) => ({
  sourceId: "SRC1",
  sourceSha256: original.sourceSha256,
  startUtf16: originalText.indexOf(text),
  endUtf16: originalText.indexOf(text) + text.length,
  exactText: text,
  productionAdmission: false as const,
});
const complete = statementA + " " + statementB;
const atoms = () => [
  {
    claimText: statementA,
    startUtf16: 0,
    endUtf16: statementA.length,
    windows: [window(statementC), window(statementA)],
  },
  {
    claimText: statementB,
    startUtf16: statementA.length + 1,
    endUtf16: complete.length,
    windows: [window(statementB)],
  },
];
const probes = (
  answer: (
    claim: string,
    quote: string,
  ) => "SUPPORTS" | "INSUFFICIENT" | "CONTRADICTS",
) => ({
  semantic: {
    questionRelevanceProbe: {
      id: "question@v1",
      verify: vi.fn(async ({ exactQuote }: { exactQuote: string }) => ({
        decision: "SUPPORTS" as const,
        reason: "SOURCE_QUESTION_RELEVANCE",
        evidenceSpan: { startUtf16: 0, endUtf16: exactQuote.length },
      })),
    },
    claimEntailmentProbe: {
      id: "complete-claim@v1",
      verify: vi.fn(
        async ({
          exactQuote,
          answerClaim,
        }: {
          exactQuote: string;
          answerClaim: string;
        }) => {
          const decision = answer(answerClaim, exactQuote);
          return {
            decision,
            reason: "SOURCE_CLAIM_VERDICT",
            ...(decision === "INSUFFICIENT"
              ? {}
              : {
                  evidenceSpan: { startUtf16: 0, endUtf16: exactQuote.length },
                }),
          };
        },
      ),
    },
  },
});
const literalSupport = (
  claim: string,
  quote: string,
): "SUPPORTS" | "INSUFFICIENT" =>
  claim === quote ? "SUPPORTS" : "INSUFFICIENT";
describe("E4 source-original atomic portfolio has no promotion authority", () => {
  it("recovers each full atom from different source windows without citing a topic-only top hit", async () => {
    const config = probes(literalSupport);
    const result = await assessS2AtomicEvidencePortfolio(
      "How are requests and expired tokens handled?",
      complete,
      [original],
      atoms(),
      config,
    );
    expect(result).toMatchObject({
      status: "ALL_ATOMS_SOURCE_CANDIDATES_UNVERIFIED",
      totalWindows: 3,
      verifiedAtoms: 2,
      contradictionProposals: 0,
      entireClaimTextCovered: true,
      everyWindowSourceBoundBeforeInference: true,
      independentlyValidatedAtomicity: false,
      questionAnswerSlotsVerified: false,
      completeAnswerVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(result.atomResults.map((x) => x.review.status)).toEqual([
      "SUPPORTED_CANDIDATE",
      "SUPPORTED_CANDIDATE",
    ]);
    expect(result.atomResults[0]?.review.exhaustiveEvidenceScan).toBe(true);
    expect(config.semantic.claimEntailmentProbe.verify).toHaveBeenCalledTimes(
      3,
    );
  });
  it("withholds an unsupported atom even when a previous atom had true support", async () => {
    const config = probes(literalSupport);
    const candidates = atoms();
    candidates[1]!.windows = [window(statementC)];
    const result = await assessS2AtomicEvidencePortfolio(
      "How are requests and expired tokens handled?",
      complete,
      [original],
      candidates,
      config,
    );
    expect(result).toMatchObject({
      status: "WITHHELD_UNSUPPORTED_ATOM",
      verifiedAtoms: 1,
      entireClaimTextCovered: true,
      productionAdmission: false,
    });
  });
  it("exhaustively examines contradictory original windows after apparent support", async () => {
    const config = probes((claim, quote) => {
      if (claim === statementA && quote === statementC) return "CONTRADICTS";
      return literalSupport(claim, quote);
    });
    const result = await assessS2AtomicEvidencePortfolio(
      "How do gateways work?",
      complete,
      [original],
      atoms(),
      config,
    );
    expect(result).toMatchObject({
      status: "WITHHELD_SOURCE_CONFLICT",
      verifiedAtoms: 1,
      contradictionProposals: 1,
      completeAnswerVerified: false,
    });
    expect(result.atomResults[0]?.review.status).toBe("CONFLICTING_PROPOSALS");
  });
  it("rejects missing claim text, extra trailing assertions, overlap and source window tampering before any model call", async () => {
    const c = probes(() => "SUPPORTS");
    const invalid = [
      { claim: complete + " The system does more.", atoms: atoms() },
      { claim: complete, atoms: atoms().slice(0, 1) },
      {
        claim: complete,
        atoms: [
          { ...atoms()[0]!, endUtf16: statementA.length + 2 },
          atoms()[1]!,
        ],
      },
      {
        claim: complete,
        atoms: [
          atoms()[0]!,
          {
            ...atoms()[1]!,
            windows: [{ ...window(statementB), sourceSha256: sha("fake") }],
          },
        ],
      },
      {
        claim: complete,
        atoms: [
          atoms()[0]!,
          {
            ...atoms()[1]!,
            windows: [
              {
                ...window(statementB),
                endUtf16: window(statementB).endUtf16 - 1,
              },
            ],
          },
        ],
      },
    ];
    for (const entry of invalid) {
      const r = await assessS2AtomicEvidencePortfolio(
        "What happened?",
        entry.claim,
        [original],
        entry.atoms,
        c,
      );
      expect(r.status, r.reason).toBe("REJECTED");
    }
    expect(c.semantic.questionRelevanceProbe.verify).not.toHaveBeenCalled();
    expect(c.semantic.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("does not omit budget excess silently or run probes on invalid total budgets", async () => {
    const c = probes(() => "SUPPORTS");
    const a = atoms();
    const r = await assessS2AtomicEvidencePortfolio(
      "What happened?",
      complete,
      [original],
      a,
      { ...c, maxWindowsPerAtom: 1, maxTotalWindows: 2 },
    );
    expect(r).toMatchObject({
      status: "REJECTED",
      totalWindows: 3,
      entireClaimTextCovered: false,
      productionAdmission: false,
    });
    expect(c.semantic.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("rejects an unpaired surrogate boundary and a fabricated original ID", async () => {
    const c = probes(() => "SUPPORTS");
    const prefix = "😀" + statementA;
    const emojiBytes = Buffer.from(prefix);
    const emojiSource = {
      ...original,
      exactUtf8Bytes: emojiBytes,
      sourceSha256: sha(emojiBytes),
      bodyEndUtf16: prefix.length,
    };
    const emojiWindow = {
      sourceId: "SRC1",
      sourceSha256: emojiSource.sourceSha256,
      startUtf16: 0,
      endUtf16: prefix.length,
      exactText: prefix,
      productionAdmission: false as const,
    };
    const unpaired = await assessS2AtomicEvidencePortfolio(
      "Who?",
      prefix,
      [emojiSource],
      [
        {
          claimText: "\ud83d",
          startUtf16: 0,
          endUtf16: 1,
          windows: [emojiWindow],
        },
      ],
      c,
    );
    expect(unpaired.status).toBe("REJECTED");
    const invalidSource = await assessS2AtomicEvidencePortfolio(
      "Who?",
      complete,
      [original],
      [
        {
          ...atoms()[0]!,
          windows: [{ ...window(statementA), sourceId: "SRC2" }],
        },
        atoms()[1]!,
      ],
      c,
    );
    expect(invalidSource.status).toBe("REJECTED");
    expect(c.semantic.questionRelevanceProbe.verify).not.toHaveBeenCalled();
  });
  it("does not allow a proposed contradiction to masquerade as proven source conflict", async () => {
    const c = probes(() => "CONTRADICTS");
    const r = await assessS2AtomicEvidencePortfolio(
      "What happened?",
      complete,
      [original],
      atoms(),
      c,
    );
    expect(r).toMatchObject({
      status: "WITHHELD_SOURCE_CONFLICT",
      verifiedAtoms: 0,
      independentlyValidatedAtomicity: false,
      completeAnswerVerified: false,
      sourceAuthorizationReauthenticated: false,
      productionAdmission: false,
    });
  });
});
