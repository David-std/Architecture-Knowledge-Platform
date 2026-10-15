import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerabilityWithVerifier,
  retrievalAnswerabilityCandidateKey,
} from "../src/answerability.js";
import {
  CONTEXTUAL_CROSS_ENCODER_MODEL,
  CONTEXTUAL_CROSS_ENCODER_REVISION,
  ContextualCrossEncoderEvidenceVerifier,
  contextualEvidenceText,
  locateEvidenceQuote,
  type CrossEncoderPair,
  type CrossEncoderRuntimeFactory,
} from "../src/contextual-evidence.js";

function runtimeReturning(
  score: (pair: CrossEncoderPair) => number,
  seen: CrossEncoderPair[] = [],
): CrossEncoderRuntimeFactory {
  return async () => ({
    score: async (pairs) => {
      seen.push(...pairs);
      return pairs.map(score);
    },
  });
}

function input(passage: string, title = "Renewals") {
  return {
    query: "Can an overdue loan be renewed?",
    candidateKey: "doc:unit",
    title,
    headingPath: ["Loans", title],
    passage,
    unitType: "RULE",
    parentUnitType: null,
    documentType: "rule",
  };
}

describe("contextual evidence text", () => {
  it("scopes the body with its title and headings without repeating them", () => {
    expect(
      contextualEvidenceText({
        title: "Renewals",
        headingPath: ["Loans", "Renewals"],
        passage: "A loan can be renewed twice.\n\nOverdue loans cannot.",
      }),
    ).toMatchObject({
      scope: "Renewals > Loans",
      body: "A loan can be renewed twice.\nOverdue loans cannot.",
      text: "Renewals > Loans\nA loan can be renewed twice.\nOverdue loans cannot.",
      segments: [
        {
          text: "A loan can be renewed twice.",
          sourceSpan: { startOffset: 0, endOffset: 28 },
        },
        {
          text: "Overdue loans cannot.",
          sourceSpan: { startOffset: 30, endOffset: 51 },
        },
      ],
    });
  });

  it("drops link targets but keeps the visible text of inline links", () => {
    expect(
      contextualEvidenceText({
        title: "",
        passage:
          "See [[policies/renewal-policy]] and the [renewal form](https://example.test/form).",
      }).body,
    ).toBe("See and the renewal form.");
  });

  it("binds every table cell to its column header", () => {
    const { body } = contextualEvidenceText({
      title: "Recall response",
      passage:
        "Recall rules:\n\n| Class | Action | Deadline |\n|---|---|---|\n| I | Remove every unit | 4 hours |\n| II | Remove the lots | 24 hours |\n\nEnd.",
    });
    expect(body).toBe(
      "Recall rules:\nClass: I; Action: Remove every unit; Deadline: 4 hours.\nClass: II; Action: Remove the lots; Deadline: 24 hours\nEnd.",
    );
  });

  it("keeps fenced pipes as text rather than inventing a table", () => {
    expect(
      contextualEvidenceText({
        title: "",
        passage: "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```",
      }).body,
    ).toContain("| 1 | 2 |");
  });
});

describe("contextual cross-encoder evidence verifier", () => {
  it("pins the model revision and scores the contextual text", async () => {
    const seen: CrossEncoderPair[] = [];
    const factory = vi.fn(runtimeReturning(() => 0.9, seen));
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.4,
      runtimeFactory: factory,
      localFilesOnly: true,
    });
    const passage = "Overdue loans cannot be renewed.";

    await expect(verifier.verify(input(passage))).resolves.toEqual({
      decision: "SUPPORTS",
      score: 0.9,
      evidenceSpan: { startOffset: 0, endOffset: passage.length },
      reason: "CROSS_ENCODER_CONTEXTUAL_SUPPORT",
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: CONTEXTUAL_CROSS_ENCODER_MODEL,
        revision: CONTEXTUAL_CROSS_ENCODER_REVISION,
        localFilesOnly: true,
      }),
    );
    expect(seen).toEqual([
      {
        query: "Can an overdue loan be renewed?",
        passage: "Renewals > Loans\nOverdue loans cannot be renewed.",
      },
    ]);
    expect(verifier.id).toBe(
      `contextual-cross-encoder:${CONTEXTUAL_CROSS_ENCODER_MODEL}@${CONTEXTUAL_CROSS_ENCODER_REVISION}`,
    );
  });

  it("keeps scores below the calibrated threshold insufficient", async () => {
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.4,
      runtimeFactory: runtimeReturning(() => 0.39),
    });
    await expect(
      verifier.verify(input("Opening hours are 9 to 5.")),
    ).resolves.toEqual({
      decision: "INSUFFICIENT",
      score: 0.39,
      reason: "CROSS_ENCODER_BELOW_SUPPORT_THRESHOLD",
    });
  });

  it("never supports an empty passage", async () => {
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.4,
      runtimeFactory: runtimeReturning(() => 0.99),
    });
    await expect(verifier.verify(input("   "))).resolves.toMatchObject({
      decision: "INSUFFICIENT",
      reason: "EMPTY_PASSAGE",
    });
  });

  it("rejects invalid thresholds and runtime output", async () => {
    expect(
      () =>
        new ContextualCrossEncoderEvidenceVerifier({ minimumSupportScore: 1 }),
    ).toThrow("minimumSupportScore");
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.4,
      runtimeFactory: runtimeReturning(() => Number.NaN),
    });
    await expect(verifier.verify(input("Text."))).rejects.toThrow(
      "CROSS_ENCODER_SCORES_INVALID",
    );
  });

  it("retries the runtime load after a failure", async () => {
    let attempts = 0;
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.4,
      runtimeFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("MODEL_UNAVAILABLE");
        return { score: async (pairs) => pairs.map(() => 0.8) };
      },
    });
    await expect(verifier.verify(input("Text."))).rejects.toThrow(
      "MODEL_UNAVAILABLE",
    );
    await expect(verifier.verify(input("Text."))).resolves.toMatchObject({
      decision: "SUPPORTS",
    });
  });
});

function hit(id: string, title: string, excerpt: string): SearchHit {
  return {
    documentId: `00000000-0000-4000-8000-00000000000${id}`,
    vaultId: "00000000-0000-4000-8000-000000000100",
    unitId: `00000000-0000-4000-8000-00000000020${id}`,
    unitType: "RULE",
    headingPath: ["Loans", title],
    document: { externalId: `unit-${id}`, path: `loans/${id}.md`, title },
    revision: "r1",
    title,
    type: "rule",
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["test"],
    excerpt,
    citations: [],
  };
}

describe("batched query-conditioned verification", () => {
  it("verifies all candidates in one batch with their headings", async () => {
    const seen: CrossEncoderPair[] = [];
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.5,
      runtimeFactory: runtimeReturning(
        (pair) => (pair.passage.includes("cannot be renewed") ? 0.92 : 0.05),
        seen,
      ),
    });
    const answer = hit("1", "Renewals", "Overdue loans cannot be renewed.");
    const distractor = hit("2", "Opening hours", "We open at 9.");
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [distractor, answer],
      "Can an overdue loan be renewed?",
      verifier,
      { mode: "ENFORCE" },
    );
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(answer),
    ]);
    expect(seen.map((pair) => pair.passage)).toEqual([
      "Opening hours > Loans\nWe open at 9.",
      "Renewals > Loans\nOverdue loans cannot be renewed.",
    ]);
  });

  it("records a verifier error for every candidate when a batch fails", async () => {
    const verifier = new ContextualCrossEncoderEvidenceVerifier({
      minimumSupportScore: 0.5,
      runtimeFactory: async () => ({
        score: async () => {
          throw new Error("RUNTIME_CRASHED");
        },
      }),
    });
    const result = await assessRetrievalAnswerabilityWithVerifier(
      [hit("1", "Renewals", "Overdue loans cannot be renewed.")],
      "Can an overdue loan be renewed?",
      verifier,
      { mode: "ENFORCE" },
    );
    expect(result.supported).toBe(false);
    expect(result.candidateSignals[0]?.queryConditionedEvidence).toMatchObject({
      decision: "VERIFIER_ERROR",
      reason: "RUNTIME_CRASHED",
    });
  });
});

describe("quote mapping integrity", () => {
  it("fails closed when the selected prose mapping is incomplete", () => {
    const contextual = contextualEvidenceText({
      title: "Operations",
      passage: "The recovery window is 47 minutes.",
    });
    const segment = contextual.segments[0]!;
    expect(
      locateEvidenceQuote(
        {
          ...contextual,
          segments: [
            { ...segment, characterSpans: segment.characterSpans!.slice(1) },
          ],
        },
        "The recovery window is 47 minutes",
      ),
    ).toBeNull();
  });
});

describe("hidden Markdown source boundaries", () => {
  it("does not turn source comments into reader evidence", () => {
    const passage =
      "<!-- ALFA can call BETA. -->\nVisible notes awaiting review.";
    const contextual = contextualEvidenceText({
      title: "Integration",
      passage,
    });
    expect(contextual.body).toBe("Visible notes awaiting review.");
    expect(locateEvidenceQuote(contextual, "ALFA can call BETA.")).toBeNull();
  });

  it("preserves the original quote offsets after a hidden comment", () => {
    const answer = "ALFA can call BETA during reconciliation.";
    const passage = `<!-- 🧭 Hidden draft. -->\n${answer}`;
    const contextual = contextualEvidenceText({
      title: "Integration",
      passage,
    });
    expect(locateEvidenceQuote(contextual, answer)).toEqual({
      startOffset: passage.indexOf(answer),
      endOffset: passage.length - 1,
    });
  });

  it("keeps literal comment syntax in code examples visible", () => {
    for (const passage of [
      "Use `<!-- draft -->` in the template.",
      "```html\n<!-- draft -->\n```",
      "    <!-- draft -->",
    ]) {
      expect(
        contextualEvidenceText({ title: "Template syntax", passage }).body,
      ).toContain("<!-- draft -->");
    }
  });
});

it("does not fabricate a contiguous quote across hidden source bytes", () => {
  const passage = "ALFA can <!-- unpublished draft --> call BETA.";
  const contextual = contextualEvidenceText({ title: "Integration", passage });
  expect(contextual.body).toBe("ALFA can call BETA.");
  expect(locateEvidenceQuote(contextual, "ALFA can call BETA")).toBeNull();
});
