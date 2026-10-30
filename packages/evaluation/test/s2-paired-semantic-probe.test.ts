import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { createS2PairedSemanticPorts } from "../src/s2-paired-semantic-probe.js";
import { assessS2QuoteSemantics } from "../src/s2-semantic-evidence.js";
const evidence = "The gateway grants access only after verification.";
const bytes = Buffer.from(evidence);
const original = {
  assignedSourceId: "ORIG1",
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  exactUtf8Bytes: bytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: evidence.length,
};
const sample = (
  question = "When does the gateway grant access?",
  claim = evidence,
) => ({
  originalQuestion: question,
  answerClaim: claim,
  exactQuote: evidence,
  originalBodyContext: evidence,
  verifiedSourceId: original.assignedSourceId,
  verifiedSourceSha256: original.sourceSha256,
  quoteStartUtf16: 0,
  quoteEndUtf16: evidence.length,
});
const proposed = {
  decision: "SUPPORTS" as const,
  reason: "LITERAL_QUOTE_REPLAYED",
  evidenceSpan: { startUtf16: 0, endUtf16: evidence.length },
};
const reader = () => ({
  id: "paired-semantic-reader@model-revision-1",
  verify: vi.fn(async () => ({
    questionRelevance: proposed,
    claimEntailment: proposed,
  })),
});
describe("bounded single-inference paired semantic observations", () => {
  it("performs one inference for two F3 stages with the exact original SHA and UTF16", async () => {
    const r = reader(),
      ports = createS2PairedSemanticPorts(r);
    const result = await assessS2QuoteSemantics(
      sample().originalQuestion,
      {
        sourceId: original.assignedSourceId,
        evidenceQuote: evidence,
        answerText: evidence,
        abstained: false,
      },
      [original],
      { ...ports, timeoutMs: 2000 },
    );
    expect(result.status).toBe("SUPPORTED_CANDIDATE");
    expect(r.verify).toHaveBeenCalledTimes(1);
    expect(ports.pairedJudgmentsNotIndependent).toBe(true);
    expect(ports.productionAdmission).toBe(false);
  });
  it("deduplicates concurrent identical inference, but never different source span or question", async () => {
    const r = reader(),
      ports = createS2PairedSemanticPorts(r);
    await Promise.all([
      ports.questionRelevanceProbe.verify(sample()),
      ports.claimEntailmentProbe.verify(sample()),
      ports.claimEntailmentProbe.verify(sample()),
    ]);
    expect(r.verify).toHaveBeenCalledTimes(1);
    await ports.questionRelevanceProbe.verify(
      sample("What happens before verification?", evidence),
    );
    expect(r.verify).toHaveBeenCalledTimes(2);
    await ports.questionRelevanceProbe.verify({
      ...sample(),
      originalBodyContext: evidence + " Additional local context.",
    });
    expect(r.verify).toHaveBeenCalledTimes(3);
    await ports.questionRelevanceProbe.verify({
      ...sample(),
      quoteStartUtf16: 1,
    });
    expect(r.verify).toHaveBeenCalledTimes(4);
    ports.clear();
    await ports.questionRelevanceProbe.verify(sample());
    expect(r.verify).toHaveBeenCalledTimes(5);
  });
  it("does not cache failed provider calls or leak their error contents", async () => {
    const r = {
      id: "reader@revision-2",
      verify: vi
        .fn()
        .mockRejectedValueOnce(Error("private text must not be logged"))
        .mockResolvedValue({
          questionRelevance: proposed,
          claimEntailment: proposed,
        }),
    };
    const p = createS2PairedSemanticPorts(r);
    await expect(p.questionRelevanceProbe.verify(sample())).rejects.toThrow();
    expect((await p.questionRelevanceProbe.verify(sample())).decision).toBe(
      "SUPPORTS",
    );
    expect(r.verify).toHaveBeenCalledTimes(2);
  });
  it("holds a bounded cache and leaves F3 validation of malformed spans intact", async () => {
    const r = reader(),
      p = createS2PairedSemanticPorts(r, 1);
    await p.questionRelevanceProbe.verify(sample());
    await p.questionRelevanceProbe.verify(
      sample("Who may grant access?", evidence),
    );
    await p.questionRelevanceProbe.verify(sample());
    expect(r.verify).toHaveBeenCalledTimes(3);
    const wrong = {
      id: "bad@revision",
      verify: async () => ({
        questionRelevance: {
          ...proposed,
          evidenceSpan: { startUtf16: 0, endUtf16: 10000 },
        },
        claimEntailment: proposed,
      }),
    };
    const ports = createS2PairedSemanticPorts(wrong);
    const status = await assessS2QuoteSemantics(
      sample().originalQuestion,
      {
        sourceId: original.assignedSourceId,
        evidenceQuote: evidence,
        answerText: evidence,
        abstained: false,
      },
      [original],
      ports,
    );
    expect(status.status).toBe("ERROR");
  });
  it("rejects unversioned readers, invalid cache sizes and alias port identities", () => {
    expect(() =>
      createS2PairedSemanticPorts({ ...reader(), id: "reader" }),
    ).toThrow("S2_PAIRED_READER_INVALID");
    expect(() => createS2PairedSemanticPorts(reader(), 129)).toThrow(
      "S2_PAIRED_READER_INVALID",
    );
  });
});
