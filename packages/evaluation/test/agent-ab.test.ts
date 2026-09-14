import { describe, expect, it } from "vitest";
import {
  AGENT_AB_REQUIRED_CATEGORIES,
  aggregateAgentAbArm,
  scoreAgentAbOutput,
  validateAgentAbTasks,
  type AgentAbArmObservation,
  type AgentAbTask,
} from "../src/index.js";

const tasks: AgentAbTask[] = AGENT_AB_REQUIRED_CATEGORIES.map(
  (category, index) => ({
    id: `task-${index + 1}`,
    category,
    query: `Question ${index + 1}`,
    intent:
      category === "exact-lookup"
        ? "EXACT_LOOKUP"
        : category === "workflow"
          ? "WORKFLOW_EXECUTION"
          : category === "source-verification"
            ? "SOURCE_VERIFICATION"
            : category === "project-code"
              ? "PROJECT_CODE"
              : "CONCEPTUAL",
    mandatoryTerms: category === "no-answer" ? [] : ["required fact"],
    expectNoAnswer: category === "no-answer",
  }),
);

describe("Agent A/B evaluation", () => {
  it("requires the complete task-category matrix", () => {
    expect(() => validateAgentAbTasks(tasks)).not.toThrow();
    expect(() => validateAgentAbTasks(tasks.slice(0, -1))).toThrow(
      /missing required categories/u,
    );
  });

  it("scores mandatory rules, unsupported claims and citation precision", () => {
    const score = scoreAgentAbOutput(
      tasks[0]!,
      {
        answer: "The required fact is present.",
        abstain: false,
        citations: ["doc-a@rev"],
        claims: [
          { text: "supported", citations: ["doc-a@rev"] },
          { text: "unsupported", citations: [] },
        ],
      },
      ["doc-a@rev"],
    );
    expect(score.mandatoryRuleRecall).toBe(1);
    expect(score.unsupportedClaims).toBe(1);
    expect(score.citationPrecision).toBe(1);
    expect(score.correctness).toBe(1);
  });

  it("treats a correct no-answer abstention as correct without citations", () => {
    const noAnswer = tasks.at(-1)!;
    const score = scoreAgentAbOutput(
      noAnswer,
      { answer: "Insufficient evidence.", abstain: true, citations: [], claims: [] },
      [],
    );
    expect(score.correctness).toBe(1);
    expect(score.citationPrecision).toBe(1);
  });

  it("aggregates one arm without inventing a winner", () => {
    const observation: AgentAbArmObservation = {
      taskId: "task-1",
      category: "exact-lookup",
      arm: "B_AKP_CONTEXT_PACKET",
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
    };
    expect(aggregateAgentAbArm([observation])).toEqual(
      expect.objectContaining({
        arm: "B_AKP_CONTEXT_PACKET",
        tasks: 1,
        meanContextTokens: 100,
        meanCorrectness: 1,
      }),
    );
  });
});
