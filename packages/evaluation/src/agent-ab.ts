export const AGENT_AB_REQUIRED_CATEGORIES = [
  "exact-lookup",
  "conceptual",
  "workflow",
  "source-verification",
  "project-code",
  "no-answer",
] as const;

export type AgentAbTaskCategory = (typeof AGENT_AB_REQUIRED_CATEGORIES)[number];

export interface AgentAbTask {
  id: string;
  category: AgentAbTaskCategory;
  query: string;
  intent:
    | "EXACT_LOOKUP"
    | "CONCEPTUAL"
    | "WORKFLOW_EXECUTION"
    | "SOURCE_VERIFICATION"
    | "PROJECT_CODE";
  mandatoryTerms: string[];
  forbiddenTerms?: string[];
  expectNoAnswer?: boolean;
}

export interface AgentAbClaim {
  text: string;
  citations: string[];
}

export interface AgentAbModelOutput {
  answer: string;
  abstain: boolean;
  citations: string[];
  claims: AgentAbClaim[];
}

export interface AgentAbScore {
  mandatoryRuleRecall: number;
  missedConstraints: string[];
  forbiddenTermsPresent: string[];
  unsupportedClaims: number;
  unsupportedClaimRate: number;
  citationPrecision: number;
  correctness: number;
}

export interface AgentAbArmObservation extends AgentAbScore {
  taskId: string;
  category: AgentAbTaskCategory;
  arm: "A_RAW_SEARCH" | "B_AKP_CONTEXT_PACKET";
  contextTokens: number;
  providerPromptTokens: number | null;
  providerCompletionTokens: number | null;
  latencyMs: number;
}

export interface AgentAbAggregate {
  arm: AgentAbArmObservation["arm"];
  tasks: number;
  meanContextTokens: number;
  meanProviderPromptTokens: number | null;
  meanProviderCompletionTokens: number | null;
  meanLatencyMs: number;
  meanMandatoryRuleRecall: number;
  meanUnsupportedClaims: number;
  meanCitationPrecision: number;
  meanCorrectness: number;
  totalMissedConstraints: number;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function containsTerm(text: string, term: string): boolean {
  return normalize(text).includes(normalize(term));
}

export function validateAgentAbTasks(tasks: AgentAbTask[]): void {
  if (tasks.length === 0) throw new Error("Agent A/B task set is empty.");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim()) throw new Error("Agent A/B task id is required.");
    if (ids.has(task.id))
      throw new Error(`Duplicate Agent A/B task: ${task.id}`);
    ids.add(task.id);
    if (!AGENT_AB_REQUIRED_CATEGORIES.includes(task.category)) {
      throw new Error(`Unsupported Agent A/B category: ${task.category}`);
    }
    if (!task.query.trim()) {
      throw new Error(`Agent A/B task ${task.id} has an empty query.`);
    }
    if (!task.expectNoAnswer && task.mandatoryTerms.length === 0) {
      throw new Error(
        `Agent A/B task ${task.id} needs mandatory terms or expectNoAnswer=true.`,
      );
    }
  }
  const categories = new Set(tasks.map((task) => task.category));
  const missing = AGENT_AB_REQUIRED_CATEGORIES.filter(
    (category) => !categories.has(category),
  );
  if (missing.length > 0) {
    throw new Error(
      `Agent A/B task set is missing required categories: ${missing.join(", ")}`,
    );
  }
}

export function scoreAgentAbOutput(
  task: AgentAbTask,
  output: AgentAbModelOutput,
  allowedCitations: readonly string[],
): AgentAbScore {
  const mandatoryFound = task.mandatoryTerms.filter((term) =>
    containsTerm(output.answer, term),
  );
  const missedConstraints = task.mandatoryTerms.filter(
    (term) => !mandatoryFound.includes(term),
  );
  const forbiddenTermsPresent = (task.forbiddenTerms ?? []).filter((term) =>
    containsTerm(output.answer, term),
  );
  const allowed = new Set(allowedCitations);
  const cited = [
    ...output.citations,
    ...output.claims.flatMap((claim) => claim.citations),
  ];
  const validCitations = cited.filter((citation) => allowed.has(citation));
  const unsupportedClaims = output.claims.filter(
    (claim) =>
      claim.citations.length === 0 ||
      claim.citations.every((citation) => !allowed.has(citation)),
  ).length;
  const mandatoryRuleRecall =
    task.mandatoryTerms.length === 0
      ? 1
      : mandatoryFound.length / task.mandatoryTerms.length;
  const citationPrecision =
    cited.length === 0
      ? task.expectNoAnswer && output.abstain
        ? 1
        : 0
      : validCitations.length / cited.length;
  const unsupportedClaimRate =
    output.claims.length === 0 ? 0 : unsupportedClaims / output.claims.length;
  const correctness = task.expectNoAnswer
    ? Number(output.abstain)
    : Number(
        !output.abstain &&
          mandatoryRuleRecall === 1 &&
          forbiddenTermsPresent.length === 0,
      );
  return {
    mandatoryRuleRecall,
    missedConstraints,
    forbiddenTermsPresent,
    unsupportedClaims,
    unsupportedClaimRate,
    citationPrecision,
    correctness,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanNullable(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0 ? null : mean(measured);
}

export function aggregateAgentAbArm(
  observations: AgentAbArmObservation[],
): AgentAbAggregate {
  if (observations.length === 0) {
    throw new Error("Cannot aggregate an empty Agent A/B arm.");
  }
  const arm = observations[0]?.arm;
  if (!arm || observations.some((observation) => observation.arm !== arm)) {
    throw new Error("Agent A/B aggregate must contain exactly one arm.");
  }
  return {
    arm,
    tasks: observations.length,
    meanContextTokens: mean(observations.map((item) => item.contextTokens)),
    meanProviderPromptTokens: meanNullable(
      observations.map((item) => item.providerPromptTokens),
    ),
    meanProviderCompletionTokens: meanNullable(
      observations.map((item) => item.providerCompletionTokens),
    ),
    meanLatencyMs: mean(observations.map((item) => item.latencyMs)),
    meanMandatoryRuleRecall: mean(
      observations.map((item) => item.mandatoryRuleRecall),
    ),
    meanUnsupportedClaims: mean(
      observations.map((item) => item.unsupportedClaims),
    ),
    meanCitationPrecision: mean(
      observations.map((item) => item.citationPrecision),
    ),
    meanCorrectness: mean(observations.map((item) => item.correctness)),
    totalMissedConstraints: observations.reduce(
      (sum, item) => sum + item.missedConstraints.length,
      0,
    ),
  };
}
