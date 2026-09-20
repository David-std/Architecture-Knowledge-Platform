export type CompetitiveExecutionStatus =
  | "EXECUTED"
  | "REFERENCE_ONLY"
  | "NOT_EXECUTED"
  | "FAILED";

export interface CompetitiveMetric<T = number> {
  value: T | null;
  measured: boolean;
  reason?: string;
}

export interface CompetitiveRetrievalMetrics {
  recallAt5: CompetitiveMetric;
  recallAt10: CompetitiveMetric;
  mrr: CompetitiveMetric;
  ndcgAt10: CompetitiveMetric;
  contextPrecision: CompetitiveMetric;
  claimSupportRecall: CompetitiveMetric;
  citationPrecision: CompetitiveMetric;
  unsupportedClaimRate: CompetitiveMetric;
  noAnswerAccuracy: CompetitiveMetric;
  contradictionRecall: CompetitiveMetric;
  latencyP50Ms: CompetitiveMetric;
  latencyP95Ms: CompetitiveMetric;
  contextTokens: CompetitiveMetric;
  providerCost: CompetitiveMetric;
}

export interface CompetitiveGraphMetrics {
  typedPathPrecision: CompetitiveMetric;
  multiHopRecall: CompetitiveMetric;
  pprAssociativeRecall: CompetitiveMetric;
  globalCommunityCoverage: CompetitiveMetric;
  bridgeAccuracy: CompetitiveMetric;
  staleEdgeSuppression: CompetitiveMetric;
  unauthorizedPathRate: CompetitiveMetric;
  pathExplainability: CompetitiveMetric;
}

export interface CompetitiveCodeMetrics {
  symbolResolution: CompetitiveMetric;
  callersCalleesCorrectness: CompetitiveMetric;
  dependencyPathPrecision: CompetitiveMetric;
  blastRadiusRecall: CompetitiveMetric;
  changeImpactRecall: CompetitiveMetric;
  testLinkageAccuracy: CompetitiveMetric;
  ruleDecisionBridgePrecision: CompetitiveMetric;
  buildTimeMs: CompetitiveMetric;
  incrementalUpdateMs: CompetitiveMetric;
  staleDetection: CompetitiveMetric;
}

export interface CompetitiveTemporalMetrics {
  currentTruthAccuracy: CompetitiveMetric;
  asOfAccuracy: CompetitiveMetric;
  changedSinceAccuracy: CompetitiveMetric;
  withdrawalBehavior: CompetitiveMetric;
  alternativeSupportAccuracy: CompetitiveMetric;
  staleDerivedSuppression: CompetitiveMetric;
  mixedRevisionDetection: CompetitiveMetric;
}

export interface CompetitiveTeamMetrics {
  crossSpaceLeakRate: CompetitiveMetric;
  privateToTeamLeakRate: CompetitiveMetric;
  revokedPrincipalAccessRate: CompetitiveMetric;
  pinnedContextReproducibility: CompetitiveMetric;
  handoffCompleteness: CompetitiveMetric;
  overlappingClaimFencing: CompetitiveMetric;
  promotionCorrectness: CompetitiveMetric;
  offlineStaleDisclosure: CompetitiveMetric;
  federationPartialFailure: CompetitiveMetric;
}

export interface CompetitiveSystemResult {
  id: string;
  label: string;
  executionStatus: CompetitiveExecutionStatus;
  executionKind:
    | "CURRENT_RUNTIME"
    | "CURRENT_RUNTIME_HISTORICAL_PROFILE_REPLAY"
    | "REGISTERED_REFERENCE"
    | "EXTERNAL_REPORT";
  source: string;
  limitations: string[];
  retrievalRuns: Array<{
    configuration: string;
    metrics: CompetitiveRetrievalMetrics;
  }>;
  graph: CompetitiveGraphMetrics;
  code: CompetitiveCodeMetrics;
  temporal: CompetitiveTemporalMetrics;
  team: CompetitiveTeamMetrics;
}

export interface CompetitiveArenaReport {
  schemaVersion: 1;
  generatedAt: string;
  scope: string;
  status: "EXECUTED" | "PARTIAL" | "FAILED";
  superiorityClaimAllowed: false;
  winner: null;
  systems: CompetitiveSystemResult[];
  coverage: {
    executed: string[];
    referenceOnly: string[];
    notExecuted: string[];
    failed: string[];
  };
}

export function measured(value: number): CompetitiveMetric {
  if (!Number.isFinite(value)) {
    throw new Error("Competitive metric must be finite.");
  }
  return { value, measured: true };
}

export function unmeasured(reason: string): CompetitiveMetric {
  if (!reason.trim()) throw new Error("Unmeasured metric needs a reason.");
  return { value: null, measured: false, reason };
}

export function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (
    values.length === 0 ||
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    fraction > 1
  ) {
    return null;
  }
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

function validateMetric(metric: CompetitiveMetric, path: string): void {
  if (metric.measured) {
    if (metric.value === null || !Number.isFinite(metric.value)) {
      throw new Error(path + " is marked measured without a finite value.");
    }
    return;
  }
  if (metric.value !== null || !metric.reason?.trim()) {
    throw new Error(path + " must be null with an explicit unmeasured reason.");
  }
}

function validateMetricGroup(
  group: Record<string, CompetitiveMetric>,
  path: string,
): void {
  for (const [name, metric] of Object.entries(group)) {
    validateMetric(metric, path + "." + name);
  }
}

export function validateCompetitiveSystem(
  system: CompetitiveSystemResult,
): void {
  if (!system.id.trim() || !system.label.trim() || !system.source.trim()) {
    throw new Error("Competitive system identity is incomplete.");
  }
  for (const [index, run] of system.retrievalRuns.entries()) {
    if (!run.configuration.trim()) {
      throw new Error("Competitive retrieval configuration is empty.");
    }
    validateMetricGroup(
      run.metrics as unknown as Record<string, CompetitiveMetric>,
      system.id + ".retrievalRuns[" + String(index) + "]",
    );
  }
  validateMetricGroup(
    system.graph as unknown as Record<string, CompetitiveMetric>,
    system.id + ".graph",
  );
  validateMetricGroup(
    system.code as unknown as Record<string, CompetitiveMetric>,
    system.id + ".code",
  );
  validateMetricGroup(
    system.temporal as unknown as Record<string, CompetitiveMetric>,
    system.id + ".temporal",
  );
  validateMetricGroup(
    system.team as unknown as Record<string, CompetitiveMetric>,
    system.id + ".team",
  );
  if (
    system.executionStatus === "EXECUTED" &&
    system.retrievalRuns.length === 0 &&
    Object.values(system.graph).every((metric) => !metric.measured) &&
    Object.values(system.code).every((metric) => !metric.measured) &&
    Object.values(system.temporal).every((metric) => !metric.measured) &&
    Object.values(system.team).every((metric) => !metric.measured)
  ) {
    throw new Error(
      "An EXECUTED competitive system must contain at least one measured metric.",
    );
  }
}

export function buildCompetitiveArenaReport(
  systems: CompetitiveSystemResult[],
  scope: string,
  generatedAt = new Date().toISOString(),
): CompetitiveArenaReport {
  const ids = new Set<string>();
  for (const system of systems) {
    if (ids.has(system.id)) {
      throw new Error("Duplicate competitive system id: " + system.id);
    }
    ids.add(system.id);
    validateCompetitiveSystem(system);
  }
  const failed = systems.filter(
    (system) => system.executionStatus === "FAILED",
  );
  const executed = systems.filter(
    (system) => system.executionStatus === "EXECUTED",
  );
  return {
    schemaVersion: 1,
    generatedAt,
    scope,
    status:
      failed.length > 0 ? "FAILED" : executed.length > 0 ? "PARTIAL" : "FAILED",
    superiorityClaimAllowed: false,
    winner: null,
    systems,
    coverage: {
      executed: executed.map((system) => system.id),
      referenceOnly: systems
        .filter((system) => system.executionStatus === "REFERENCE_ONLY")
        .map((system) => system.id),
      notExecuted: systems
        .filter((system) => system.executionStatus === "NOT_EXECUTED")
        .map((system) => system.id),
      failed: failed.map((system) => system.id),
    },
  };
}
