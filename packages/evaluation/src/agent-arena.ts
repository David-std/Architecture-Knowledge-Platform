import {
  aggregateAgentAbArm,
  scoreAgentAbOutput,
  type AgentAbModelOutput,
  type AgentAbScore,
  type AgentScoringTask,
} from "./agent-ab.js";

export const AGENT_ARENA_CATEGORIES = [
  "exact-lookup",
  "conceptual-synthesis",
  "workflow-execution",
  "source-verification",
  "project-code-impact",
  "historical-as-of",
  "conflicting-knowledge",
  "no-answer",
] as const;
export type AgentArenaCategory = (typeof AGENT_ARENA_CATEGORIES)[number];

export const AGENT_ARENA_ARMS = [
  "A_RAW_SEARCH",
  "B_EXPERT_TOOLS",
  "C_CONTEXT_FACADE",
  "D_FACADE_ENRICHED_CONTEXT",
  "E_FACADE_WITH_INSTRUCTIONS",
] as const;
export type AgentArenaArm = (typeof AGENT_ARENA_ARMS)[number];

export interface AgentArenaTask extends AgentScoringTask {
  category: AgentArenaCategory;
  query: string;
  retrievalQuery?: string;
  intent:
    | "EXACT_LOOKUP"
    | "CONCEPTUAL"
    | "WORKFLOW_EXECUTION"
    | "SOURCE_VERIFICATION"
    | "PROJECT_CODE"
    | "GLOBAL_SYNTHESIS";
  conflictTerms?: string[];
}

export interface AgentArenaScore extends AgentAbScore {
  missedConflicts: string[];
}

export interface AgentArenaObservation extends AgentArenaScore {
  taskId: string;
  category: AgentArenaCategory;
  arm: AgentArenaArm;
  calls: number;
  contextTokens: number;
  providerPromptTokens: number | null;
  providerCompletionTokens: number | null;
  latencyMs: number;
}

export interface AgentArenaAggregate {
  arm: AgentArenaArm;
  tasks: number;
  meanCalls: number;
  meanContextTokens: number;
  meanProviderPromptTokens: number | null;
  meanProviderCompletionTokens: number | null;
  meanLatencyMs: number;
  meanCorrectness: number;
  meanMandatoryConstraintRecall: number;
  meanUnsupportedClaims: number;
  meanUnsupportedClaimRate: number;
  meanCitationPrecision: number;
  totalMissedConstraints: number;
  totalMissedConflicts: number;
  noAnswerAccuracy: number | null;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function mean(values: readonly number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? mean(present) : null;
}

export function validateAgentArenaTasks(tasks: AgentArenaTask[]): void {
  if (tasks.length !== AGENT_ARENA_CATEGORIES.length) {
    throw new Error(
      `Agent arena requires exactly ${AGENT_ARENA_CATEGORIES.length} tasks.`,
    );
  }
  const ids = new Set<string>();
  const categories = new Set<AgentArenaCategory>();
  for (const task of tasks) {
    if (!task.id.trim() || ids.has(task.id)) {
      throw new Error(`Agent arena task id is missing or duplicated: ${task.id}`);
    }
    ids.add(task.id);
    if (!AGENT_ARENA_CATEGORIES.includes(task.category)) {
      throw new Error(`Unsupported agent arena category: ${task.category}`);
    }
    categories.add(task.category);
    if (!task.query.trim()) {
      throw new Error(`Agent arena task ${task.id} has an empty query.`);
    }
    if (!task.expectNoAnswer && task.mandatoryTerms.length === 0) {
      throw new Error(
        `Agent arena task ${task.id} needs mandatory terms or expectNoAnswer=true.`,
      );
    }
    if (
      task.category === "conflicting-knowledge" &&
      (!task.conflictTerms || task.conflictTerms.length === 0)
    ) {
      throw new Error(
        `Agent arena conflicting task ${task.id} requires conflictTerms.`,
      );
    }
  }
  for (const category of AGENT_ARENA_CATEGORIES) {
    if (!categories.has(category)) {
      throw new Error(`Agent arena is missing required category: ${category}`);
    }
  }
}

export function scoreAgentArenaOutput(
  task: AgentArenaTask,
  output: AgentAbModelOutput,
  allowedCitations: readonly string[],
  context = "",
  citationEvidence: Readonly<Record<string, readonly string[]>> = {},
): AgentArenaScore {
  const base = scoreAgentAbOutput(
    task,
    output,
    allowedCitations,
    context,
    citationEvidence,
  );
  const answer = normalize(output.answer);
  const missedConflicts = (task.conflictTerms ?? []).filter(
    (term) => !answer.includes(normalize(term)),
  );
  return { ...base, missedConflicts };
}

export function aggregateAgentArenaArm(
  observations: readonly AgentArenaObservation[],
): AgentArenaAggregate {
  if (observations.length === 0) {
    throw new Error("Agent arena aggregate cannot be empty.");
  }
  const arm = observations[0]!.arm;
  if (observations.some((observation) => observation.arm !== arm)) {
    throw new Error("Agent arena aggregate must contain one arm.");
  }
  const legacy = aggregateAgentAbArm(
    observations.map((observation) => ({
      ...observation,
      arm: "B_AKP_CONTEXT_PACKET" as const,
    })),
  );
  const noAnswerValues = observations
    .map((observation) => observation.noAnswerCorrect)
    .filter((value): value is boolean => value !== null);
  return {
    arm,
    tasks: observations.length,
    meanCalls: mean(observations.map((item) => item.calls)),
    meanContextTokens: mean(observations.map((item) => item.contextTokens)),
    meanProviderPromptTokens: meanNullable(
      observations.map((item) => item.providerPromptTokens),
    ),
    meanProviderCompletionTokens: meanNullable(
      observations.map((item) => item.providerCompletionTokens),
    ),
    meanLatencyMs: mean(observations.map((item) => item.latencyMs)),
    meanCorrectness: legacy.meanCorrectness,
    meanMandatoryConstraintRecall: legacy.meanMandatoryRuleRecall,
    meanUnsupportedClaims: legacy.meanUnsupportedClaims,
    meanUnsupportedClaimRate: mean(
      observations.map((item) => item.unsupportedClaimRate),
    ),
    meanCitationPrecision: legacy.meanCitationPrecision,
    totalMissedConstraints: legacy.totalMissedConstraints,
    totalMissedConflicts: observations.reduce(
      (sum, item) => sum + item.missedConflicts.length,
      0,
    ),
    noAnswerAccuracy:
      noAnswerValues.length === 0
        ? null
        : mean(noAnswerValues.map((value) => Number(value))),
  };
}
