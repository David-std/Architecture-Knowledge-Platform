import { describe, expect, it } from "vitest";
import {
  AGENT_ARENA_ARMS,
  AGENT_ARENA_CATEGORIES,
  aggregateAgentArenaArm,
  scoreAgentArenaOutput,
  validateAgentArenaTasks,
  type AgentArenaObservation,
  type AgentArenaTask,
} from "../src/agent-arena.js";

const tasks: AgentArenaTask[] = AGENT_ARENA_CATEGORIES.map(
  (category, index) => ({
    id: `arena-${index}`,
    category,
    query: `Question ${index}`,
    intent:
      category === "exact-lookup"
        ? "EXACT_LOOKUP"
        : category === "workflow-execution"
          ? "WORKFLOW_EXECUTION"
          : category === "source-verification"
            ? "SOURCE_VERIFICATION"
            : category === "project-code-impact"
              ? "PROJECT_CODE"
              : category === "conceptual-synthesis"
                ? "GLOBAL_SYNTHESIS"
                : "CONCEPTUAL",
    mandatoryTerms: category === "no-answer" ? [] : ["required"],
    expectNoAnswer: category === "no-answer",
    ...(category === "conflicting-knowledge"
      ? { conflictTerms: ["disputed", "alternative"] }
      : {}),
  }),
);

describe("five-arm agent arena", () => {
  it("requires one task for every normative category", () => {
    expect(() => validateAgentArenaTasks(tasks)).not.toThrow();
    expect(() => validateAgentArenaTasks(tasks.slice(1))).toThrow(
      /exactly 8 tasks/u,
    );
    expect(AGENT_ARENA_ARMS).toHaveLength(5);
  });

  it("measures missed conflict handling separately from correctness", () => {
    const task = tasks.find(
      (candidate) => candidate.category === "conflicting-knowledge",
    )!;
    const score = scoreAgentArenaOutput(
      task,
      {
        answer: "The required fact is disputed.",
        abstain: false,
        citations: ["source-a"],
        claims: [
          { text: "required fact is disputed", citations: ["source-a"] },
        ],
      },
      ["source-a"],
      "required disputed alternative",
      { "source-a": ["required fact is disputed with alternative support"] },
    );
    expect(score.correctness).toBe(1);
    expect(score.missedConflicts).toEqual(["alternative"]);
  });

  it("aggregates the required operational and quality metrics without a winner", () => {
    const observation: AgentArenaObservation = {
      taskId: "arena-0",
      category: "exact-lookup",
      arm: "A_RAW_SEARCH",
      calls: 1,
      contextTokens: 100,
      providerPromptTokens: 120,
      providerCompletionTokens: 30,
      latencyMs: 50,
      mandatoryRuleRecall: 1,
      missedConstraints: [],
      forbiddenTermsPresent: [],
      unsupportedClaims: 0,
      unsupportedClaimRate: 0,
      citationPrecision: 1,
      correctness: 1,
      retrievalRecall: 1,
      contextPrecision: 1,
      claimSupportRecall: 1,
      contextUtilization: 1,
      faithfulness: 1,
      faithfulnessMethod: "CITATION_SCOPED_LEXICAL_SUPPORT",
      noiseSensitivity: null,
      noAnswerCorrect: null,
      missedConflicts: [],
    };
    expect(aggregateAgentArenaArm([observation])).toMatchObject({
      arm: "A_RAW_SEARCH",
      tasks: 1,
      meanCalls: 1,
      meanCorrectness: 1,
      meanMandatoryConstraintRecall: 1,
      totalMissedConflicts: 0,
    });
  });
});
