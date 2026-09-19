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
  retrievalQuery?: string;
  intent:
    | "EXACT_LOOKUP"
    | "CONCEPTUAL"
    | "WORKFLOW_EXECUTION"
    | "SOURCE_VERIFICATION"
    | "PROJECT_CODE";
  mandatoryTerms: string[];
  forbiddenTerms?: string[];
  /** Gold source citations for retrieval/context diagnostics when available. */
  goldCitations?: string[];
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
  retrievalRecall: number | null;
  contextPrecision: number | null;
  claimSupportRecall: number | null;
  contextUtilization: number | null;
  faithfulness: number | null;
  faithfulnessMethod: "CITATION_SCOPED_LEXICAL_SUPPORT" | null;
  noiseSensitivity: number | null;
  noAnswerCorrect: boolean | null;
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
  meanRetrievalRecall: number | null;
  retrievalRecallCoverage: number;
  meanContextPrecision: number | null;
  contextPrecisionCoverage: number;
  meanClaimSupportRecall: number | null;
  claimSupportRecallCoverage: number;
  meanContextUtilization: number | null;
  contextUtilizationCoverage: number;
  meanFaithfulness: number | null;
  faithfulnessCoverage: number;
  meanNoiseSensitivity: number | null;
  noiseSensitivityCoverage: number;
  noAnswerAccuracy: number | null;
  noAnswerCases: number;
  totalMissedConstraints: number;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function containsTerm(text: string, term: string): boolean {
  return normalize(text).includes(normalize(term));
}

const FAITHFULNESS_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "this",
  "into",
  "must",
  "what",
  "which",
  "when",
  "where",
  "does",
  "before",
  "after",
  "using",
  "los",
  "las",
  "del",
  "para",
  "que",
  "con",
  "desde",
  "este",
  "esta",
  "como",
  "cuando",
  "donde",
  "debe",
  "deben",
  "una",
  "uno",
]);

function lexicalSupportTokens(value: string): string[] {
  return [
    ...new Set(
      normalize(value)
        .replace(/[^\p{L}\p{N}_:/.-]+/gu, " ")
        .split(/\s+/u)
        .map((token) => token.trim().replace(/^[.:/\\-]+|[.:/\\-]+$/gu, ""))
        .filter(
          (token) =>
            token.length >= 4 &&
            !FAITHFULNESS_STOP_WORDS.has(token) &&
            !/^\d+$/u.test(token),
        ),
    ),
  ];
}

function citationScopedFaithfulness(
  output: AgentAbModelOutput,
  allowed: ReadonlySet<string>,
  citationEvidence: Readonly<Record<string, readonly string[]>>,
): number | null {
  if (output.claims.length === 0) return null;
  const claimScores: number[] = [];
  for (const claim of output.claims) {
    const validCitations = [
      ...new Set(claim.citations.filter((citation) => allowed.has(citation))),
    ];
    if (validCitations.length === 0) {
      claimScores.push(0);
      continue;
    }
    const evidence = validCitations.flatMap(
      (citation) => citationEvidence[citation] ?? [],
    );
    if (evidence.length === 0) return null;
    const claimTokens = lexicalSupportTokens(claim.text);
    if (claimTokens.length === 0) return null;
    const evidenceTokens = new Set(lexicalSupportTokens(evidence.join("\n")));
    const overlap =
      claimTokens.filter((token) => evidenceTokens.has(token)).length /
      claimTokens.length;
    claimScores.push(Number(overlap >= 0.5));
  }
  return mean(claimScores);
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
    if (
      task.goldCitations &&
      (task.goldCitations.some((citation) => !citation.trim()) ||
        new Set(task.goldCitations).size !== task.goldCitations.length)
    ) {
      throw new Error(
        `Agent A/B task ${task.id} has invalid or duplicate gold citations.`,
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
  context = "",
  citationEvidence: Readonly<Record<string, readonly string[]>> = {},
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
  const uniqueAllowed = [...new Set(allowedCitations)];
  const goldCitations = task.goldCitations?.length
    ? [...new Set(task.goldCitations)]
    : null;
  const retrievalRecall = goldCitations
    ? goldCitations.filter((citation) => allowed.has(citation)).length /
      goldCitations.length
    : null;
  const contextPrecision = goldCitations
    ? uniqueAllowed.length === 0
      ? 0
      : uniqueAllowed.filter((citation) => goldCitations.includes(citation))
          .length / uniqueAllowed.length
    : null;
  const claimSupportRecall =
    task.mandatoryTerms.length > 0
      ? task.mandatoryTerms.filter((term) => containsTerm(context, term))
          .length / task.mandatoryTerms.length
      : null;
  const uniqueUsedCitations = [
    ...new Set(cited.filter((citation) => allowed.has(citation))),
  ];
  const contextUtilization =
    uniqueAllowed.length > 0
      ? uniqueUsedCitations.length / uniqueAllowed.length
      : null;
  const noAnswerCorrect = task.expectNoAnswer ? output.abstain : null;
  const faithfulness = citationScopedFaithfulness(
    output,
    allowed,
    citationEvidence,
  );
  return {
    mandatoryRuleRecall,
    missedConstraints,
    forbiddenTermsPresent,
    unsupportedClaims,
    unsupportedClaimRate,
    citationPrecision,
    correctness,
    retrievalRecall,
    contextPrecision,
    claimSupportRecall,
    contextUtilization,
    faithfulness,
    faithfulnessMethod:
      faithfulness === null ? null : "CITATION_SCOPED_LEXICAL_SUPPORT",
    noiseSensitivity: null,
    noAnswerCorrect,
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

function coverage(values: readonly (number | boolean | null)[]): number {
  return values.length === 0
    ? 0
    : values.filter((value) => value !== null).length / values.length;
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
    meanRetrievalRecall: meanNullable(
      observations.map((item) => item.retrievalRecall),
    ),
    retrievalRecallCoverage: coverage(
      observations.map((item) => item.retrievalRecall),
    ),
    meanContextPrecision: meanNullable(
      observations.map((item) => item.contextPrecision),
    ),
    contextPrecisionCoverage: coverage(
      observations.map((item) => item.contextPrecision),
    ),
    meanClaimSupportRecall: meanNullable(
      observations.map((item) => item.claimSupportRecall),
    ),
    claimSupportRecallCoverage: coverage(
      observations.map((item) => item.claimSupportRecall),
    ),
    meanContextUtilization: meanNullable(
      observations.map((item) => item.contextUtilization),
    ),
    contextUtilizationCoverage: coverage(
      observations.map((item) => item.contextUtilization),
    ),
    meanFaithfulness: meanNullable(
      observations.map((item) => item.faithfulness),
    ),
    faithfulnessCoverage: coverage(
      observations.map((item) => item.faithfulness),
    ),
    meanNoiseSensitivity: meanNullable(
      observations.map((item) => item.noiseSensitivity),
    ),
    noiseSensitivityCoverage: coverage(
      observations.map((item) => item.noiseSensitivity),
    ),
    noAnswerAccuracy: (() => {
      const measured = observations
        .map((item) => item.noAnswerCorrect)
        .filter((value): value is boolean => value !== null);
      return measured.length === 0
        ? null
        : mean(measured.map((value) => Number(value)));
    })(),
    noAnswerCases: observations.filter((item) => item.noAnswerCorrect !== null)
      .length,
    totalMissedConstraints: observations.reduce(
      (sum, item) => sum + item.missedConstraints.length,
      0,
    ),
  };
}
