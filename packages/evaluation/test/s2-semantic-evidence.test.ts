import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assessS2QuoteSemantics,
  type S2SemanticProbe,
  type S2SemanticProbeResult,
} from "../src/s2-semantic-evidence.js";
import {
  createS2DirectNliClaimProbe,
  createS2QaRelevanceProbe,
  createS2QaQuestionFocusProbe,
} from "../src/s2-semantic-probes.js";

const text =
  "## Flight memo\nThe violet shuttle carries 42 crates on Tuesdays. 😀\n";
const bytes = Buffer.from(text, "utf8");
const original = {
  assignedSourceId: "SRC1",
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  exactUtf8Bytes: bytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: text.length,
};
const quote = "The violet shuttle carries 42 crates on Tuesdays.";
const response = {
  abstained: false,
  sourceId: "SRC17",
  answerText: "42 crates",
  evidenceQuote: quote,
};
const span = { startUtf16: 0, endUtf16: quote.length };
const yes: S2SemanticProbeResult = {
  decision: "SUPPORTS",
  reason: "SYNTHETIC_SUPPORTS",
  evidenceSpan: span,
};
const port = (
  id: string,
  result: S2SemanticProbeResult = yes,
): S2SemanticProbe => ({ id, verify: vi.fn(async () => result) });
const config = () => ({
  questionRelevanceProbe: port("qa@frozen"),
  claimEntailmentProbe: port("nli@frozen"),
  timeoutMs: 200,
});
const run = (
  q = "How many crates does the violet shuttle carry?",
  answer = response,
  conf = config(),
  originals = [original],
) => assessS2QuoteSemantics(q, answer, originals, conf);

describe("S2 experimental quote→question→claim verification", () => {
  it("accepts only a two-stage candidate, never product admission", async () => {
    const out = await run();
    expect(out).toMatchObject({
      status: "SUPPORTED_CANDIDATE",
      reason: "TWO_STAGE_SEMANTIC_SUPPORT_CANDIDATE",
      productionAdmission: false,
      releaseGateAccepted: false,
      attribution: {
        assignedSourceId: "SRC1",
        modelSourceIdRepairedByLiteralProof: true,
        semanticEntailmentVerified: false,
      },
    });
    expect(out.questionProbeId).toBe("qa@frozen");
    expect(out.claimProbeId).toBe("nli@frozen");
  });
  it("rejects irrelevant evidence even if a claim model says SUPPORTS", async () => {
    const conf = config();
    conf.questionRelevanceProbe = port("qa@frozen", {
      decision: "INSUFFICIENT",
      reason: "NO_RELEVANT_ANSWER",
    });
    const out = await run(undefined, undefined, conf);
    expect(out.status).toBe("INSUFFICIENT");
    expect(conf.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("continues independent full-claim evidence inspection only when explicitly requested", async () => {
    const conf = {
      ...config(),
      inspectClaimWhenQuestionUncertain: true,
    };
    conf.questionRelevanceProbe = port("qa@frozen", {
      decision: "INSUFFICIENT",
      reason: "QUESTION_ROLE_NOT_ESTABLISHED",
    });
    const out = await run(undefined, undefined, conf);
    expect(out).toMatchObject({
      status: "CLAIM_SUPPORT_QUESTION_DISPUTED",
      reason: "CLAIM_SUPPORT_PROPOSED_BUT_ANSWER_ROLE_UNVERIFIED",
      questionRelevance: { decision: "INSUFFICIENT" },
      claimEntailment: { decision: "SUPPORTS" },
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(conf.claimEntailmentProbe.verify).toHaveBeenCalledOnce();
  });
  it("records claim contradiction as a proposal rather than a failed-question proof", async () => {
    const conf = {
      ...config(),
      inspectClaimWhenQuestionUncertain: true,
    };
    conf.questionRelevanceProbe = port("qa@frozen", {
      decision: "CONTRADICTS",
      reason: "QUESTION_RELEVANCE_MODEL_MISCLASSIFIED",
      evidenceSpan: span,
    });
    conf.claimEntailmentProbe = port("nli@frozen", {
      decision: "CONTRADICTS",
      reason: "MODEL_DIRECTLY_REFUTES",
      evidenceSpan: span,
    });
    expect(await run(undefined, undefined, conf)).toMatchObject({
      status: "CLAIM_CONTRADICTION_QUESTION_DISPUTED",
      questionRelevance: { decision: "CONTRADICTS" },
      claimEntailment: { decision: "CONTRADICTS" },
      productionAdmission: false,
    });
  });
  it("never converts an optional uncertain claim verdict into source support", async () => {
    const conf = { ...config(), inspectClaimWhenQuestionUncertain: true };
    conf.questionRelevanceProbe = port("qa@frozen", {
      decision: "INSUFFICIENT",
      reason: "QUESTION_UNCERTAIN",
    });
    conf.claimEntailmentProbe = port("nli@frozen", {
      decision: "INSUFFICIENT",
      reason: "CLAIM_UNCERTAIN",
    });
    expect(await run(undefined, undefined, conf)).toMatchObject({
      status: "INSUFFICIENT",
      reason: "QUESTION_AND_CLAIM_PROBES_INSUFFICIENT",
    });
  });
  it("does not send a mismatched explicit number to a second model even in optional mode", async () => {
    const conf = { ...config(), inspectClaimWhenQuestionUncertain: true };
    const out = await run(
      undefined,
      { ...response, answerText: "99 crates" },
      conf,
    );
    expect(out.reason).toBe("EXPLICIT_CLAIM_NUMBER_NOT_IN_QUOTE");
    expect(conf.questionRelevanceProbe.verify).not.toHaveBeenCalled();
    expect(conf.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("rejects malformed optional continuation without invoking models", async () => {
    const conf = {
      ...config(),
      inspectClaimWhenQuestionUncertain: "yes" as never,
    };
    const result = await run(undefined, undefined, conf);
    expect(result.status).toBe("REJECTED");
    expect(conf.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("does not misclassify an interrogative relevance judgement as factual source contradiction", async () => {
    const conf = config();
    conf.questionRelevanceProbe = port("qa@frozen", {
      decision: "CONTRADICTS",
      reason: "MODEL_QUESTION_STAGE_MISCLASSIFIED",
      evidenceSpan: span,
    });
    const observed = await run(undefined, undefined, conf);
    expect(observed).toMatchObject({
      status: "INSUFFICIENT",
      reason: "QUESTION_RELEVANCE_CONTRADICTION_NOT_PROOF",
      questionRelevance: { decision: "CONTRADICTS" },
      productionAdmission: false,
    });
    expect(conf.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("rejects a reversed subject/object relationship", async () => {
    const conf = config();
    conf.claimEntailmentProbe = port("nli@frozen", {
      decision: "CONTRADICTS",
      reason: "REVERSED_RELATIONSHIP",
      evidenceSpan: span,
    });
    expect((await run(undefined, undefined, conf)).status).toBe("CONTRADICTED");
  });
  it("vetoes a changed explicit quantity before NLI is called", async () => {
    const conf = config();
    conf.claimEntailmentProbe = port("nli@frozen", {
      decision: "CONTRADICTS",
      reason: "NUMBER_MISMATCH",
      evidenceSpan: span,
    });
    const out = await run(
      undefined,
      { ...response, answerText: "43 crates" },
      conf,
    );
    expect(out.status).toBe("INSUFFICIENT");
    expect(out.reason).toBe("EXPLICIT_CLAIM_NUMBER_NOT_IN_QUOTE");
    expect(conf.claimEntailmentProbe.verify).not.toHaveBeenCalled();
  });
  it("treats negation/temporal scope uncertainty as insufficient", async () => {
    const conf = config();
    conf.claimEntailmentProbe = port("nli@frozen", {
      decision: "INSUFFICIENT",
      reason: "CONDITIONAL_SCOPE_UNKNOWN",
    });
    expect(
      (await run(undefined, { ...response, answerText: "Always 42" }, conf))
        .status,
    ).toBe("INSUFFICIENT");
  });
  it("refuses invalid literal before invoking any semantic model", async () => {
    const conf = config();
    const out = await run(
      undefined,
      { ...response, evidenceQuote: quote.replace("42", "99") },
      conf,
    );
    expect(out.status).toBe("REJECTED");
    expect(conf.questionRelevanceProbe.verify).not.toHaveBeenCalled();
  });
  it("refuses tampered source SHA before any model invocation", async () => {
    const conf = config();
    const out = await run(undefined, undefined, conf, [
      { ...original, sourceSha256: "0".repeat(64) },
    ]);
    expect(out.status).toBe("REJECTED");
    expect(conf.questionRelevanceProbe.verify).not.toHaveBeenCalled();
  });
  it("rejects repeated quotes across authorized originals", async () => {
    const out = await run(undefined, undefined, config(), [
      original,
      { ...original, assignedSourceId: "SRC2" },
    ]);
    expect(out).toMatchObject({
      status: "REJECTED",
      reason: "QUOTE_NOT_UNIQUE_IN_AUTHORIZED_SOURCES",
    });
  });
  it("does not run semantic probes on a legitimate model abstention", async () => {
    const conf = config();
    const out = await run(
      undefined,
      { abstained: true, answerText: "", evidenceQuote: "", sourceId: "" },
      conf,
    );
    expect(out.status).toBe("VALID_ABSTAIN");
    expect(conf.questionRelevanceProbe.verify).not.toHaveBeenCalled();
  });
  it("does not truncate a context silently to fit a model budget", async () => {
    const conf = { ...config(), maxBodyContextUtf16: 20 };
    const out = await run(undefined, undefined, conf);
    expect(out).toMatchObject({
      status: "INSUFFICIENT",
      reason: "ORIGINAL_CONTEXT_EXCEEDS_BUDGET",
    });
    expect(conf.questionRelevanceProbe.verify).not.toHaveBeenCalled();
  });
  it("fails closed for invalid model output / absent evidence offsets", async () => {
    const conf = config();
    conf.questionRelevanceProbe = port("qa@frozen", {
      decision: "SUPPORTS",
      reason: "INVALID_SPAN",
    });
    expect((await run(undefined, undefined, conf)).status).toBe("ERROR");
  });
  it("fails closed on model errors without exposing private exceptions", async () => {
    const conf = config();
    conf.claimEntailmentProbe = {
      id: "nli@frozen",
      verify: vi.fn(async () => {
        throw new Error("private confidential source bytes");
      }),
    };
    const out = await run(undefined, undefined, conf);
    expect(out.status).toBe("ERROR");
    expect(JSON.stringify(out)).not.toContain("private confidential");
  });
  it("fails closed on an NLI timeout", async () => {
    const conf = config();
    conf.claimEntailmentProbe = {
      id: "nli@frozen",
      verify: () => new Promise(() => {}),
    };
    conf.timeoutMs = 5;
    expect((await run(undefined, undefined, conf)).reason).toBe(
      "CLAIM_PROBE_ERROR",
    );
  });
  it("requires distinct revision-pinned stage IDs, even for wrapped functions", async () => {
    const conf = config();
    conf.claimEntailmentProbe = port("qa@frozen");
    const out = await run(undefined, undefined, conf);
    expect(out.status).toBe("REJECTED");
    expect(conf.questionRelevanceProbe.verify).not.toHaveBeenCalled();
    expect(conf.claimEntailmentProbe.verify).not.toHaveBeenCalled();
    conf.claimEntailmentProbe = port("claim_without_revision");
    expect((await run(undefined, undefined, conf)).status).toBe("REJECTED");
  });
  it("refuses a second use of the same semantic probe", async () => {
    const conf = config();
    conf.claimEntailmentProbe = conf.questionRelevanceProbe;
    const out = await run(undefined, undefined, conf);
    expect(out).toMatchObject({
      status: "REJECTED",
      reason: "SEMANTIC_INPUT_OR_PROBE_INVALID",
    });
  });
});

describe("independent QA relevance and direct NLI adapters", () => {
  it("handles an open Spanish question and paraphrased answer without lexical overlap", async () => {
    const qa = createS2QaQuestionFocusProbe("xlm-qa@revision-frozen", {
      verify: async ({ query, passage }) => {
        expect(query).toBe("¿Qué cantidad transporta el transbordador?");
        expect(passage).toBe(quote);
        return {
          decision: "SUPPORTS",
          evidenceSpan: {
            startOffset: quote.indexOf("42"),
            endOffset: quote.indexOf("42") + 2,
          },
        };
      },
    });
    const result = await run(
      "¿Qué cantidad transporta el transbordador?",
      { ...response, answerText: "Transporta cuarenta y dos cajas." },
      { ...config(), questionRelevanceProbe: qa },
    );
    expect(result.status).toBe("SUPPORTED_CANDIDATE");
    expect(result.questionRelevance?.reason).toBe(
      "QUESTION_FOCUS_FOUND_IN_QUOTE",
    );
    // The NLI probe is responsible for detecting any semantic mistranslation.
  });
  it("fails closed on invalid open-question QA boundaries", async () => {
    const qa = createS2QaQuestionFocusProbe("xlm-qa@revision-frozen", {
      verify: async () => ({
        decision: "SUPPORTS",
        evidenceSpan: { startOffset: -2, endOffset: 3 },
      }),
    });
    const result = await run(undefined, undefined, {
      ...config(),
      questionRelevanceProbe: qa,
    });
    expect(result.status).toBe("INSUFFICIENT");
  });

  it("uses original question, exact quote and spans; never a model source ID", async () => {
    const qa = vi.fn(async () => ({
      decision: "SUPPORTS" as const,
      evidenceSpan: {
        startOffset: quote.indexOf("42"),
        endOffset: quote.indexOf("42") + 2,
      },
    }));
    const verifier = createS2QaRelevanceProbe("qa@pinned", {
      verify: qa,
    });
    const conf = { ...config(), questionRelevanceProbe: verifier };
    const out = await run(undefined, undefined, conf);
    expect(out.status).toBe("SUPPORTED_CANDIDATE");
    expect(qa).toHaveBeenCalledWith({
      query: "How many crates does the violet shuttle carry?",
      passage: quote,
    });
  });
  it("rejects QA evidence not appearing in the generated answer", async () => {
    const qa = createS2QaRelevanceProbe("qa@pinned", {
      verify: async () => ({
        decision: "SUPPORTS",
        evidenceSpan: { startOffset: 4, endOffset: 10 },
      }),
    });
    expect(
      (
        await run(undefined, undefined, {
          ...config(),
          questionRelevanceProbe: qa,
        })
      ).status,
    ).toBe("INSUFFICIENT");
  });
  it("checks an NLI distribution for a claim against the literal quote", async () => {
    const infer = vi.fn(async () => ({
      entailment: 0.97,
      neutral: 0.02,
      contradiction: 0.01,
    }));
    const claimEntailmentProbe = createS2DirectNliClaimProbe({
      id: "model@frozen:min=.8:margin=.2",
      runtime: { infer, countTokens: async () => 42 },
      minimumScore: 0.8,
      minimumMargin: 0.2,
      maxCombinedUtf16: 512,
      maxTokens: 512,
    });
    const out = await run(undefined, undefined, {
      ...config(),
      claimEntailmentProbe,
    });
    expect(out.status).toBe("SUPPORTED_CANDIDATE");
    expect(infer).toHaveBeenCalledWith(quote, "42 crates");
  });
  it("refuses neutral or invalid NLI distributions", async () => {
    const build = (distribution: {
      entailment: number;
      neutral: number;
      contradiction: number;
    }) =>
      createS2DirectNliClaimProbe({
        id: "model@frozen",
        runtime: {
          infer: async () => distribution,
          countTokens: async () => 42,
        },
        minimumScore: 0.8,
        minimumMargin: 0.2,
        maxCombinedUtf16: 512,
        maxTokens: 512,
      });
    expect(
      (
        await run(undefined, undefined, {
          ...config(),
          claimEntailmentProbe: build({
            entailment: 0.1,
            contradiction: 0.1,
            neutral: 0.8,
          }),
        })
      ).status,
    ).toBe("INSUFFICIENT");
    expect(
      (
        await run(undefined, undefined, {
          ...config(),
          claimEntailmentProbe: build({
            entailment: NaN,
            contradiction: 0.1,
            neutral: 0.9,
          }),
        })
      ).status,
    ).toBe("ERROR");
  });
  it("refuses long NLI premise/hypothesis without calling runtime", async () => {
    const infer = vi.fn(async () => ({
      entailment: 1,
      neutral: 0,
      contradiction: 0,
    }));
    const claimEntailmentProbe = createS2DirectNliClaimProbe({
      id: "model@frozen",
      runtime: { infer, countTokens: async () => 42 },
      minimumScore: 0.8,
      minimumMargin: 0.2,
      maxCombinedUtf16: 8,
      maxTokens: 512,
    });
    expect(
      (
        await run(undefined, undefined, {
          ...config(),
          claimEntailmentProbe,
        })
      ).status,
    ).toBe("INSUFFICIENT");
    expect(infer).not.toHaveBeenCalled();
  });
});
