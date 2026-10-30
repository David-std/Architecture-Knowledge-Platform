import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assessS2AtomicOriginalWindowChoice,
  freezeS2AtomicOriginalWindowPlan,
  type S2AtomicWindowInput,
  type S2AtomicWindowPlan,
} from "../src/s2-atomic-original-window-choice.js";
import type { S2SemanticEvidenceConfig } from "../src/s2-semantic-evidence.js";
import type { S2EvidenceWindowSelectorConfig } from "../src/s2-evidence-window-selection.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const text = [
  "# Package publication",
  "Faro-6 permits distribution of B3 only when tres revisores de seguridad approve exactly the same revision.",
  "An unfinished review blocks distribution.",
  "The archive has six reviewers, but archive review does not approve B3.",
  "B3 never permits distribution without reviewer approval.",
].join("\n");
const original = (source = text) => ({
  assignedSourceId: "PINNED:FARO",
  sourceSha256: sha(source),
  exactUtf8Bytes: Buffer.from(source, "utf8"),
  bodyStartUtf16: 0,
  bodyEndUtf16: source.length,
});
const input = (
  claim = "Faro-6 permits B3 only with tres revisores de seguridad.",
) => ({
  originalQuestion:
    "¿Cuántos revisores aprueban B3 antes de distribuirlo en Faro-6?",
  proposedClaim: claim,
  authorizedOriginal: original(),
});
const selector = (): S2EvidenceWindowSelectorConfig => ({
  tokenizerId: "revision-fixed-tokenizer@local-eval",
  countTokens: vi.fn(async (quote: string, claim: string) =>
    Math.ceil((quote.length + claim.length) / 4),
  ),
  maxTokens: 220,
  maxWindows: 8,
  maxSentencesPerWindow: 1,
  diversityMode: "NON_REDUNDANT",
});
const sem = (
  decision: (
    quote: string,
    kind: "QUESTION" | "CLAIM",
  ) => "SUPPORTS" | "INSUFFICIENT" | "CONTRADICTS",
): S2SemanticEvidenceConfig => ({
  questionRelevanceProbe: {
    id: "question@deterministic-test",
    verify: vi.fn(async (value) => {
      const state = decision(value.exactQuote, "QUESTION");
      return state === "INSUFFICIENT"
        ? { decision: state, reason: "QUESTION_ROLE_NOT_ATTESTED" }
        : {
            decision: state,
            reason: "QUESTION_ROLE_PROPOSED",
            evidenceSpan: {
              startUtf16: 0,
              endUtf16: value.exactQuote.length,
            },
          };
    }),
  },
  claimEntailmentProbe: {
    id: "claim@deterministic-test",
    verify: vi.fn(async (value) => {
      const state = decision(value.exactQuote, "CLAIM");
      return state === "INSUFFICIENT"
        ? { decision: state, reason: "CLAIM_RELATION_NOT_ATTESTED" }
        : {
            decision: state,
            reason: "CLAIM_RELATION_PROPOSED",
            evidenceSpan: {
              startUtf16: 0,
              endUtf16: value.exactQuote.length,
            },
          };
    }),
  },
});
const tokens = (
  plan: S2AtomicWindowPlan,
  windowId = plan.options[0]?.id ?? "NONE",
) => ({
  windowId,
  questionToken: "SUPPORTS@Q1",
  claimToken: "SUPPORTS@Q1",
});
const supported = sem((quote) =>
  quote.includes("tres revisores de seguridad") && quote.includes("only when")
    ? "SUPPORTS"
    : "INSUFFICIENT",
);

describe("S2 original windows to immutable tokens (evaluation only)", () => {
  it("preserves exact original offsets while selecting an answer-bearing bilingual window", async () => {
    const args = input();
    const config = selector();
    const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
    expect(plan.status).toBe("CANDIDATES");
    expect(plan.options.length).toBeGreaterThan(0);
    expect(plan.modelSchema.properties.windowId.enum).toContain("W1");
    const answerWindow = plan.options.find((o) =>
      o.exactSourceQuote.includes("tres revisores de seguridad"),
    );
    expect(answerWindow).toBeDefined();
    expect(
      text.slice(
        answerWindow!.originalStartUtf16,
        answerWindow!.originalEndUtf16,
      ),
    ).toBe(answerWindow!.exactSourceQuote);
    expect(answerWindow!.quoteSha256).toBe(sha(answerWindow!.exactSourceQuote));
    expect(plan.productionAdmission).toBe(false);
    const result = await assessS2AtomicOriginalWindowChoice(
      args,
      plan,
      tokens(plan, answerWindow!.id),
      config,
      supported,
    );
    expect(result).toMatchObject({
      status: "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY",
      selectedWindowId: answerWindow!.id,
      authorizationIndependentlyVerified: false,
      independentSemanticProof: false,
      productionAdmission: false,
      releaseGateAccepted: false,
      reader: {
        status: "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY",
        assessment: { status: "SUPPORTED_CANDIDATE" },
      },
    });
    expect(result.sourceStartUtf16).toBeGreaterThanOrEqual(
      answerWindow!.originalStartUtf16,
    );
    expect(result.sourceEndUtf16).toBeLessThanOrEqual(
      answerWindow!.originalEndUtf16,
    );
  });

  it("does not treat a genuine but irrelevant source window as evidence", async () => {
    const args = input();
    const config = selector();
    const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
    const irrelevant = plan.options.find((o) =>
      o.exactSourceQuote.includes("archive"),
    );
    expect(irrelevant).toBeDefined();
    const r = await assessS2AtomicOriginalWindowChoice(
      args,
      plan,
      tokens(plan, irrelevant!.id),
      config,
      supported,
    );
    expect(r.status).toBe("HELD");
    // The existing numeric-integrity guard runs before either semantic probe.
    expect(r.reader?.assessment?.reason).toBe(
      "EXPLICIT_CLAIM_NUMBER_NOT_IN_QUOTE",
    );
    expect(r.productionAdmission).toBe(false);

    // Without numeric atoms, the genuine but irrelevant window reaches
    // question-role evaluation and must still be held.
    const noNumber = input("Approval is mandatory before distribution.");
    const secondPlan = await freezeS2AtomicOriginalWindowPlan(noNumber, config);
    const archive = secondPlan.options.find((o) =>
      o.exactSourceQuote.includes("archive"),
    );
    expect(archive).toBeDefined();
    const second = await assessS2AtomicOriginalWindowChoice(
      noNumber,
      secondPlan,
      tokens(secondPlan, archive!.id),
      config,
      supported,
    );
    expect(second.status).toBe("HELD");
    expect(second.reader?.assessment?.reason).toBe(
      "QUESTION_RELEVANCE_INSUFFICIENT",
    );
  });

  it("retains genuine byte-bound citations when wrong subject, direction, negation or condition is proposed", async () => {
    for (const mismatch of [
      "Faro-6 requires archive reviewers instead of security reviewers for B3.",
      "Faro-6 allows B3 distribution before the reviewers approve it.",
      "B3 requires reviewer approval only after its distribution.",
      "B3 never requires security reviewer approval.",
    ]) {
      const args = input(mismatch);
      const config = selector();
      const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
      const chosen = plan.options.find((o) =>
        o.exactSourceQuote.includes("tres revisores"),
      );
      expect(chosen).toBeDefined();
      const r = await assessS2AtomicOriginalWindowChoice(
        args,
        plan,
        tokens(plan, chosen!.id),
        config,
        sem((quote, kind) =>
          kind === "QUESTION" ? "SUPPORTS" : "INSUFFICIENT",
        ),
      );
      expect(r.status).toBe("HELD");
      expect(r.reader?.assessment?.status).toBe("INSUFFICIENT");
      expect(r.productionAdmission).toBe(false);
    }
  });

  it("forbids fabricated ids, extra properties, and incoherent NONE tokens before calling probes", async () => {
    const args = input(),
      config = selector();
    const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
    const q = vi.fn(async () => ({
      decision: "SUPPORTS" as const,
      reason: "UNSAFE",
    }));
    const semantic = {
      questionRelevanceProbe: { id: "question@mock", verify: q },
      claimEntailmentProbe: { id: "claim@mock", verify: q },
    } as S2SemanticEvidenceConfig;
    for (const bad of [
      { ...tokens(plan), windowId: "W999" },
      { ...tokens(plan), windowId: "NONE" },
      { ...tokens(plan), windowId: "W1", permissions: ["knowledge:review"] },
      { ...tokens(plan), claimToken: "SUPPORTS@Q999" },
      { ...tokens(plan), questionToken: "INSUFFICIENT@NONE" },
      {
        windowId: "W1",
        questionToken: "SUPPORTS@Q1",
        claimToken: "SUPPORTS@Q1",
        exactSourceQuote: "fake",
      },
    ]) {
      const r = await assessS2AtomicOriginalWindowChoice(
        args,
        plan,
        bad,
        config,
        semantic,
      );
      expect(r.status).toBe("HELD");
      expect(r.productionAdmission).toBe(false);
    }
    expect(q).not.toHaveBeenCalled();
    const abstain = await assessS2AtomicOriginalWindowChoice(
      args,
      plan,
      {
        windowId: "NONE",
        questionToken: "INSUFFICIENT@NONE",
        claimToken: "INSUFFICIENT@NONE",
      },
      config,
      semantic,
    );
    expect(abstain.reason).toBe("MODEL_ABSTAINED_WITHOUT_SOURCE_SUPPORT");
  });

  it("rejects tampered question, claim, source, frozen schema or different tokenizer", async () => {
    const args = input();
    const config = selector();
    const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
    const changes: Array<
      [S2AtomicWindowInput, S2AtomicWindowPlan, S2EvidenceWindowSelectorConfig]
    > = [
      [
        { ...args, originalQuestion: args.originalQuestion + " además?" },
        plan,
        config,
      ],
      [
        { ...args, proposedClaim: args.proposedClaim + " Wrong." },
        plan,
        config,
      ],
      [
        {
          ...args,
          authorizedOriginal: {
            ...args.authorizedOriginal,
            sourceSha256: "0".repeat(64),
          },
        },
        plan,
        config,
      ],
      [
        args,
        {
          ...plan,
          modelSchema: {
            ...plan.modelSchema,
            properties: {
              ...plan.modelSchema.properties,
              windowId: { type: "string", enum: ["W999"] },
            },
          },
        },
        config,
      ],
      [args, plan, { ...config, tokenizerId: "new-tokenizer@changed" }],
      [args, plan, { ...config, maxWindows: 1 }],
    ];
    for (const [altered, old, selectorConfig] of changes) {
      const result = await assessS2AtomicOriginalWindowChoice(
        altered,
        old,
        tokens(plan),
        selectorConfig,
        supported,
      );
      expect(result.status).toBe("HELD");
    }
  });

  it("holds on tokenizer failure, source duplicates and no matched original windows", async () => {
    const args = input(),
      config = selector();
    const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
    const broken = await assessS2AtomicOriginalWindowChoice(
      args,
      plan,
      tokens(plan),
      {
        ...config,
        countTokens: async () => {
          throw Error("model failure");
        },
      },
      supported,
    );
    expect(broken.status).toBe("HELD");
    expect(broken.reason).toBe("ORIGINAL_WINDOW_REPLAY_FAILED");
    const duplicated =
      "Faro-6 needs three approvals.\nFaro-6 needs three approvals.";
    const d = {
      originalQuestion: "Who needs three approvals?",
      proposedClaim: "Faro-6 needs three approvals.",
      authorizedOriginal: original(duplicated),
    };
    const dupPlan = await freezeS2AtomicOriginalWindowPlan(d, selector());
    expect(dupPlan.status).toBe("NO_BOUND_WINDOWS");
    expect(dupPlan.options).toHaveLength(0);
    const unrelated = {
      originalQuestion: "Where is the hidden datacenter?",
      proposedClaim: "The datacenter is in Region Z.",
      authorizedOriginal: original(),
    };
    const empty = await freezeS2AtomicOriginalWindowPlan(unrelated, selector());
    expect(empty.status).toBe("NO_BOUND_WINDOWS");
    expect(empty.modelSchema.properties.windowId.enum).toEqual(["NONE"]);
  });

  it("does not recast a quantity in words as a proven digit without attested equivalence", async () => {
    const source = "The package requires three approvals before release.";
    const args = {
      originalQuestion: "How many approvals are needed?",
      proposedClaim: "The package requires 3 approvals.",
      authorizedOriginal: original(source),
    };
    const config = selector();
    const plan = await freezeS2AtomicOriginalWindowPlan(args, config);
    const candidate = plan.options.find((o) =>
      o.exactSourceQuote.includes("three approvals"),
    );
    expect(candidate).toBeDefined();
    const r = await assessS2AtomicOriginalWindowChoice(
      args,
      plan,
      tokens(plan, candidate!.id),
      config,
      sem(() => "SUPPORTS"),
    );
    expect(r.status).toBe("HELD");
    expect(r.reader?.assessment?.reason).toBe(
      "EXPLICIT_CLAIM_NUMBER_NOT_IN_QUOTE",
    );
  });
});
