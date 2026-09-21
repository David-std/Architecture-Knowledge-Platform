import {
  ReasoningPlan,
  type ContextRevisionSet,
  type ReasoningModelRole,
  type ReasoningOperator,
  type ReasoningPlan as ReasoningPlanValue,
  type ReasoningStep,
} from "@akp/contracts";

export type ReasoningOutputKind =
  | "DOCUMENT_SET"
  | "COMPARISON"
  | "AGGREGATE"
  | "RAW_CONTENT"
  | "CONTEXT_PACKET";

export interface ReasoningPlanValidationPolicy {
  authorizedSpaceId: string;
  authorizedVaultIds: readonly string[];
  authorizedProjectIds?: readonly string[];
  rawAllowed?: boolean;
  maxSteps?: number;
  maxWallMs?: number;
  maxTokens?: number;
  maxCost?: number;
  maxFanout?: number;
  maxGraphHops?: number;
  allowExternalPeers?: boolean;
  allowedExternalPeerIds?: readonly string[];
  allowedModelRoles?: readonly ReasoningModelRole[];
  allowedModelProviders?: readonly string[];
  allowedDataResidencies?: readonly string[];
  allowedResidenciesByModelRole?: Partial<
    Record<ReasoningModelRole, readonly string[]>
  >;
  pathAuthorizer?: (vaultId: string, pathPrefix: string) => boolean;
}

export interface ReasoningPlanValidationContext {
  policy: ReasoningPlanValidationPolicy;
  currentRevisionSet: ContextRevisionSet;
}

export interface ReasoningPlanValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type ReasoningPlanValidationResult =
  | { ok: true; plan: ReasoningPlanValue }
  | { ok: false; issues: ReasoningPlanValidationIssue[] };

const DEFAULT_LIMITS = Object.freeze({
  maxSteps: 32,
  maxWallMs: 120_000,
  maxTokens: 128_000,
  maxCost: 25,
  maxFanout: 8,
  maxGraphHops: 3,
});

export function reasoningOutputKind(
  operator: ReasoningOperator,
): ReasoningOutputKind {
  switch (operator) {
    case "RESOLVE_ENTITY":
    case "EXACT_LOOKUP":
    case "SEARCH_LEXICAL":
    case "SEARCH_VECTOR":
    case "SEARCH_CODE":
    case "TRAVERSE_TYPED":
    case "PPR_EXPAND":
    case "COMMUNITY_SEARCH":
    case "TEMPORAL_AT":
    case "FILTER_SCOPE":
    case "JOIN_EVIDENCE":
    case "VERIFY_SUPPORT":
      return "DOCUMENT_SET";
    case "COMPARE":
      return "COMPARISON";
    case "AGGREGATE":
    case "CALCULATE":
      return "AGGREGATE";
    case "LOAD_RAW":
      return "RAW_CONTENT";
    case "BUILD_CONTEXT":
      return "CONTEXT_PACKET";
  }
}

export function reasoningReferencedStepIds(step: ReasoningStep): string[] {
  switch (step.operator) {
    case "TRAVERSE_TYPED":
      return [step.args.seedStepId];
    case "PPR_EXPAND":
      return [...step.args.seedStepIds];
    case "TEMPORAL_AT":
    case "FILTER_SCOPE":
    case "JOIN_EVIDENCE":
    case "AGGREGATE":
    case "VERIFY_SUPPORT":
      return [step.args.inputStepId];
    case "COMPARE":
      return [step.args.leftStepId, step.args.rightStepId];
    case "CALCULATE":
    case "BUILD_CONTEXT":
      return [...step.args.inputStepIds];
    case "LOAD_RAW":
      return step.args.inputStepId ? [step.args.inputStepId] : [];
    case "RESOLVE_ENTITY":
    case "EXACT_LOOKUP":
    case "SEARCH_LEXICAL":
    case "SEARCH_VECTOR":
    case "SEARCH_CODE":
    case "COMMUNITY_SEARCH":
      return [];
  }
}

function allowedInputKinds(
  operator: ReasoningOperator,
): ReadonlySet<ReasoningOutputKind> | null {
  switch (operator) {
    case "TRAVERSE_TYPED":
    case "PPR_EXPAND":
    case "TEMPORAL_AT":
    case "FILTER_SCOPE":
    case "JOIN_EVIDENCE":
    case "VERIFY_SUPPORT":
    case "LOAD_RAW":
      return new Set(["DOCUMENT_SET"]);
    case "COMPARE":
      return new Set(["DOCUMENT_SET", "AGGREGATE", "COMPARISON"]);
    case "AGGREGATE":
      return new Set(["DOCUMENT_SET", "COMPARISON"]);
    case "CALCULATE":
      return new Set(["DOCUMENT_SET", "AGGREGATE"]);
    case "BUILD_CONTEXT":
      return new Set([
        "DOCUMENT_SET",
        "COMPARISON",
        "AGGREGATE",
        "RAW_CONTENT",
      ]);
    case "RESOLVE_ENTITY":
    case "EXACT_LOOKUP":
    case "SEARCH_LEXICAL":
    case "SEARCH_VECTOR":
    case "SEARCH_CODE":
    case "COMMUNITY_SEARCH":
      return null;
  }
}

function comparableRevisionSet(
  planned: ContextRevisionSet,
  current: ContextRevisionSet,
): boolean {
  if (planned.spaceId !== current.spaceId) return false;
  if (
    (planned.retrievalConfigurationVersion ?? null) !==
    (current.retrievalConfigurationVersion ?? null)
  ) {
    return false;
  }
  const normalize = (revisionSet: ContextRevisionSet) =>
    [...revisionSet.vaults]
      .map((vault) => ({
        vaultId: vault.vaultId,
        corpusRevision: vault.corpusRevision,
        lexicalRevision: vault.lexicalRevision ?? null,
        vectorRevision: vault.vectorRevision ?? null,
        graphRevision: vault.graphRevision ?? null,
        contextPackRevision: vault.contextPackRevision ?? null,
        communityRevision: vault.communityRevision ?? null,
      }))
      .sort((left, right) => left.vaultId.localeCompare(right.vaultId));
  return (
    JSON.stringify(normalize(planned)) === JSON.stringify(normalize(current))
  );
}

function issue(
  issues: ReasoningPlanValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

export function validateReasoningPlan(
  input: unknown,
  context: ReasoningPlanValidationContext,
): ReasoningPlanValidationResult {
  const parsed = ReasoningPlan.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((entry) => ({
        code: "REASONING_PLAN_SCHEMA_INVALID",
        path: entry.path.join("."),
        message: entry.message,
      })),
    };
  }

  const plan = parsed.data;
  const { policy } = context;
  const issues: ReasoningPlanValidationIssue[] = [];
  const maxSteps = policy.maxSteps ?? DEFAULT_LIMITS.maxSteps;
  const maxWallMs = policy.maxWallMs ?? DEFAULT_LIMITS.maxWallMs;
  const maxTokens = policy.maxTokens ?? DEFAULT_LIMITS.maxTokens;
  const maxCost = policy.maxCost ?? DEFAULT_LIMITS.maxCost;
  const maxFanout = policy.maxFanout ?? DEFAULT_LIMITS.maxFanout;
  const maxGraphHops = policy.maxGraphHops ?? DEFAULT_LIMITS.maxGraphHops;

  if (plan.revisionSet.spaceId !== policy.authorizedSpaceId) {
    issue(
      issues,
      "REASONING_PLAN_SPACE_DENIED",
      "revisionSet.spaceId",
      "plan space is outside the authorized scope",
    );
  }
  const allowedVaults = new Set(policy.authorizedVaultIds);
  for (const [index, vault] of plan.revisionSet.vaults.entries()) {
    if (!allowedVaults.has(vault.vaultId)) {
      issue(
        issues,
        "REASONING_PLAN_VAULT_DENIED",
        `revisionSet.vaults.${index}.vaultId`,
        "plan vault is outside the authorized scope",
      );
    }
  }
  if (!comparableRevisionSet(plan.revisionSet, context.currentRevisionSet)) {
    issue(
      issues,
      "REASONING_PLAN_REVISION_MISMATCH",
      "revisionSet",
      "plan revision set no longer matches the current executable revision set",
    );
  }

  if (
    plan.steps.length > plan.budget.maxSteps ||
    plan.budget.maxSteps > maxSteps
  ) {
    issue(
      issues,
      "REASONING_PLAN_STEP_BUDGET_EXCEEDED",
      "budget.maxSteps",
      "plan step count exceeds the allowed step budget",
    );
  }
  if (plan.budget.maxWallMs > maxWallMs) {
    issue(
      issues,
      "REASONING_PLAN_WALL_BUDGET_EXCEEDED",
      "budget.maxWallMs",
      "plan wall-clock budget exceeds policy",
    );
  }
  if ((plan.budget.maxTokens ?? 0) > maxTokens) {
    issue(
      issues,
      "REASONING_PLAN_TOKEN_BUDGET_EXCEEDED",
      "budget.maxTokens",
      "plan token budget exceeds policy",
    );
  }
  if ((plan.budget.maxCost ?? 0) > maxCost) {
    issue(
      issues,
      "REASONING_PLAN_COST_BUDGET_EXCEEDED",
      "budget.maxCost",
      "plan cost budget exceeds policy",
    );
  }

  const priorSteps = new Map<string, ReasoningStep>();
  const consumerCounts = new Map<string, number>();
  const allowedPeers = new Set(policy.allowedExternalPeerIds ?? []);
  const allowedRoles = policy.allowedModelRoles
    ? new Set(policy.allowedModelRoles)
    : null;
  const allowedProviders = policy.allowedModelProviders
    ? new Set(policy.allowedModelProviders)
    : null;
  const allowedResidencies = policy.allowedDataResidencies
    ? new Set(policy.allowedDataResidencies)
    : null;
  const allowedProjects = policy.authorizedProjectIds
    ? new Set(policy.authorizedProjectIds)
    : null;

  for (const [index, step] of plan.steps.entries()) {
    const stepPath = `steps.${index}`;
    if (priorSteps.has(step.id)) {
      issue(
        issues,
        "REASONING_PLAN_DUPLICATE_STEP_ID",
        `${stepPath}.id`,
        "step id must be unique",
      );
      continue;
    }

    if (step.dependsOn.length > maxFanout) {
      issue(
        issues,
        "REASONING_PLAN_FANOUT_EXCEEDED",
        `${stepPath}.dependsOn`,
        "step dependency fanout exceeds policy",
      );
    }

    const references = reasoningReferencedStepIds(step);
    const declaredDependencies = new Set(step.dependsOn);
    for (const reference of references) {
      const source = priorSteps.get(reference);
      if (!source) {
        issue(
          issues,
          "REASONING_PLAN_FORWARD_OR_UNKNOWN_REFERENCE",
          `${stepPath}.args`,
          `referenced step ${reference} must exist earlier in the plan`,
        );
        continue;
      }
      if (!declaredDependencies.has(reference)) {
        issue(
          issues,
          "REASONING_PLAN_DEPENDENCY_NOT_DECLARED",
          `${stepPath}.dependsOn`,
          `referenced step ${reference} must be declared in dependsOn`,
        );
      }
      const allowedKinds = allowedInputKinds(step.operator);
      if (
        allowedKinds &&
        !allowedKinds.has(reasoningOutputKind(source.operator))
      ) {
        issue(
          issues,
          "REASONING_PLAN_IO_MISMATCH",
          `${stepPath}.args`,
          `${step.operator} cannot consume ${reasoningOutputKind(source.operator)} from ${reference}`,
        );
      }
    }
    for (const dependency of new Set(step.dependsOn)) {
      if (!priorSteps.has(dependency)) {
        issue(
          issues,
          "REASONING_PLAN_FORWARD_OR_UNKNOWN_DEPENDENCY",
          `${stepPath}.dependsOn`,
          `dependency ${dependency} must exist earlier in the plan`,
        );
        continue;
      }
      consumerCounts.set(
        dependency,
        (consumerCounts.get(dependency) ?? 0) + 1,
      );
    }

    if (
      step.executionTarget.kind === "EXTERNAL_PEER" &&
      (!policy.allowExternalPeers ||
        !allowedPeers.has(step.executionTarget.peerId))
    ) {
      issue(
        issues,
        "REASONING_PLAN_EXTERNAL_PEER_DENIED",
        `${stepPath}.executionTarget`,
        "external peer execution is not allowed by policy",
      );
    }
    if (
      step.processing?.modelRole &&
      allowedRoles &&
      !allowedRoles.has(step.processing.modelRole)
    ) {
      issue(
        issues,
        "REASONING_PLAN_MODEL_ROLE_DENIED",
        `${stepPath}.processing.modelRole`,
        "model role is not allowed by policy",
      );
    }
    if (step.processing?.modelRole) {
      const roleResidencies =
        policy.allowedResidenciesByModelRole?.[step.processing.modelRole];
      if (roleResidencies) {
        if (!step.processing.dataResidency) {
          issue(
            issues,
            "REASONING_PLAN_MODEL_ROLE_RESIDENCY_REQUIRED",
            `${stepPath}.processing.dataResidency`,
            "model role requires an explicit data residency",
          );
        } else if (!roleResidencies.includes(step.processing.dataResidency)) {
          issue(
            issues,
            "REASONING_PLAN_MODEL_ROLE_RESIDENCY_DENIED",
            `${stepPath}.processing.dataResidency`,
            "data residency is not allowed for this model role",
          );
        }
      }
    }
    if (
      step.processing?.modelProvider &&
      allowedProviders &&
      !allowedProviders.has(step.processing.modelProvider)
    ) {
      issue(
        issues,
        "REASONING_PLAN_MODEL_PROVIDER_DENIED",
        `${stepPath}.processing.modelProvider`,
        "model provider is not allowed by policy",
      );
    }
    if (
      step.processing?.dataResidency &&
      allowedResidencies &&
      !allowedResidencies.has(step.processing.dataResidency)
    ) {
      issue(
        issues,
        "REASONING_PLAN_DATA_RESIDENCY_DENIED",
        `${stepPath}.processing.dataResidency`,
        "data residency is not allowed by policy",
      );
    }

    if (
      step.operator === "TRAVERSE_TYPED" &&
      step.args.maxHops > maxGraphHops
    ) {
      issue(
        issues,
        "REASONING_PLAN_GRAPH_HOPS_EXCEEDED",
        `${stepPath}.args.maxHops`,
        "typed graph hop count exceeds policy",
      );
    }
    if (step.operator === "LOAD_RAW" && policy.rawAllowed !== true) {
      issue(
        issues,
        "REASONING_PLAN_RAW_DENIED",
        `${stepPath}.operator`,
        "raw loading is not allowed by policy",
      );
    }
    if (
      step.operator === "SEARCH_CODE" &&
      step.args.projectId &&
      allowedProjects &&
      !allowedProjects.has(step.args.projectId)
    ) {
      issue(
        issues,
        "REASONING_PLAN_PROJECT_DENIED",
        `${stepPath}.args.projectId`,
        "project is outside the authorized scope",
      );
    }
    if (step.operator === "FILTER_SCOPE") {
      for (const vaultId of step.args.vaultIds) {
        if (!allowedVaults.has(vaultId)) {
          issue(
            issues,
            "REASONING_PLAN_FILTER_SCOPE_DENIED",
            `${stepPath}.args.vaultIds`,
            "filter scope contains an unauthorized vault",
          );
        }
      }
      if (policy.pathAuthorizer) {
        const scopeVaults =
          step.args.vaultIds.length > 0
            ? step.args.vaultIds
            : plan.revisionSet.vaults.map((vault) => vault.vaultId);
        for (const vaultId of scopeVaults) {
          for (const prefix of step.args.pathPrefixes) {
            if (!policy.pathAuthorizer(vaultId, prefix)) {
              issue(
                issues,
                "REASONING_PLAN_PATH_SCOPE_DENIED",
                `${stepPath}.args.pathPrefixes`,
                "filter path prefix is outside the authorized scope",
              );
            }
          }
        }
      }
    }
    if (
      step.operator === "BUILD_CONTEXT" &&
      plan.budget.maxTokens !== undefined &&
      step.args.maxTokens > plan.budget.maxTokens
    ) {
      issue(
        issues,
        "REASONING_PLAN_CONTEXT_TOKEN_BUDGET_EXCEEDED",
        `${stepPath}.args.maxTokens`,
        "context step exceeds the plan token budget",
      );
    }

    priorSteps.set(step.id, step);
  }

  for (const [stepId, consumers] of consumerCounts) {
    if (consumers > maxFanout) {
      issue(
        issues,
        "REASONING_PLAN_BRANCH_FANOUT_EXCEEDED",
        `steps.${stepId}`,
        `step feeds ${consumers} downstream references, exceeding policy fanout`,
      );
    }
  }

  return issues.length === 0 ? { ok: true, plan } : { ok: false, issues };
}
