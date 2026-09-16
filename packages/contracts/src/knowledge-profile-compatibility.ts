import {
  KnowledgeProfileV1,
  type KnowledgeProfileCompatibility,
} from "./knowledge-profile.js";

export interface KnowledgeProfileCorpusUsage {
  kindCounts?: Record<string, number>;
  relationCounts?: Record<string, number>;
  lifecycleStateCounts?: Record<string, Record<string, number>>;
}

export interface KnowledgeProfileCompatibilityIssue {
  code: string;
  path: string;
  compatibilityClass: KnowledgeProfileCompatibility;
  detail: string;
  usageCount?: number;
}

export interface KnowledgeProfileCompatibilityResult {
  compatibilityClass: KnowledgeProfileCompatibility;
  requiresReview: boolean;
  requiredActions: string[];
  issues: KnowledgeProfileCompatibilityIssue[];
}

const severity: Record<KnowledgeProfileCompatibility, number> = {
  NON_BREAKING: 0,
  REINDEX_REQUIRED: 1,
  RECOMPILE_REQUIRED: 2,
  MIGRATION_REQUIRED: 3,
  UNSAFE: 4,
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

function countKind(usage: KnowledgeProfileCorpusUsage, kind: string): number {
  return usage.kindCounts?.[kind] ?? 0;
}

function countRelation(
  usage: KnowledgeProfileCorpusUsage,
  relation: string,
): number {
  return usage.relationCounts?.[relation] ?? 0;
}

function countLifecycleState(
  usage: KnowledgeProfileCorpusUsage,
  lifecycle: string,
  state: string,
): number {
  return usage.lifecycleStateCounts?.[lifecycle]?.[state] ?? 0;
}

function maxClass(
  issues: KnowledgeProfileCompatibilityIssue[],
): KnowledgeProfileCompatibility {
  return issues.reduce<KnowledgeProfileCompatibility>(
    (current, issue) =>
      severity[issue.compatibilityClass] > severity[current]
        ? issue.compatibilityClass
        : current,
    "NON_BREAKING",
  );
}

function requiredActions(
  compatibilityClass: KnowledgeProfileCompatibility,
): string[] {
  switch (compatibilityClass) {
    case "NON_BREAKING":
      return [];
    case "REINDEX_REQUIRED":
      return ["REINDEX"];
    case "RECOMPILE_REQUIRED":
      return ["RECOMPILE", "RUN_REGRESSION_EVALS"];
    case "MIGRATION_REQUIRED":
      return [
        "APPROVE_MIGRATION",
        "MIGRATE_AFFECTED_KNOWLEDGE",
        "RECOMPILE",
        "REINDEX",
        "RUN_REGRESSION_EVALS",
      ];
    case "UNSAFE":
      return [
        "BLOCK_ACTIVATION",
        "CREATE_MIGRATION_PLAN",
        "REVIEW_IMPACT",
        "RUN_REGRESSION_EVALS",
      ];
  }
}

function kindsUsingPolicy(
  profile: KnowledgeProfileV1,
  field: "evidencePolicy" | "reviewPolicy" | "artifactContract" | "lifecycle",
  name: string,
): string[] {
  return Object.entries(profile.knowledgeKinds)
    .filter(([, definition]) => definition[field] === name)
    .map(([kind]) => kind);
}

function usageForKinds(
  usage: KnowledgeProfileCorpusUsage,
  kinds: readonly string[],
): number {
  return kinds.reduce((total, kind) => total + countKind(usage, kind), 0);
}

/**
 * Classify semantic profile compatibility. Corpus usage is optional, but when
 * supplied it upgrades changes that affect live knowledge instead of treating
 * the profile as a purely syntactic document diff.
 */
export function classifyKnowledgeProfileCompatibility(
  currentInput: unknown,
  candidateInput: unknown,
  usage: KnowledgeProfileCorpusUsage = {},
): KnowledgeProfileCompatibilityResult {
  const current = KnowledgeProfileV1.parse(currentInput);
  const candidate = KnowledgeProfileV1.parse(candidateInput);
  const issues: KnowledgeProfileCompatibilityIssue[] = [];

  const add = (
    code: string,
    path: string,
    compatibilityClass: KnowledgeProfileCompatibility,
    detail: string,
    usageCount?: number,
  ) => {
    issues.push({
      code,
      path,
      compatibilityClass,
      detail,
      ...(usageCount === undefined ? {} : { usageCount }),
    });
  };

  if (current.profileId !== candidate.profileId) {
    add(
      "PROFILE_ID_CHANGED",
      "profileId",
      "UNSAFE",
      "A revision cannot silently change the identity of its profile.",
    );
  }

  for (const [kind, currentKind] of Object.entries(current.knowledgeKinds)) {
    const candidateKind = candidate.knowledgeKinds[kind];
    const kindUsage = countKind(usage, kind);
    if (!candidateKind) {
      add(
        "KNOWLEDGE_KIND_REMOVED",
        `knowledgeKinds.${kind}`,
        kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Removing a knowledge kind changes the compiler/runtime contract.",
        kindUsage,
      );
      continue;
    }

    if (currentKind.lifecycle !== candidateKind.lifecycle) {
      add(
        "KIND_LIFECYCLE_CHANGED",
        `knowledgeKinds.${kind}.lifecycle`,
        kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Changing the lifecycle attached to a kind can reinterpret existing knowledge.",
        kindUsage,
      );
    }
    if (currentKind.evidencePolicy !== candidateKind.evidencePolicy) {
      add(
        "KIND_EVIDENCE_POLICY_CHANGED",
        `knowledgeKinds.${kind}.evidencePolicy`,
        kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Changing an evidence policy changes validity requirements for the kind.",
        kindUsage,
      );
    }
    if (currentKind.reviewPolicy !== candidateKind.reviewPolicy) {
      add(
        "KIND_REVIEW_POLICY_CHANGED",
        `knowledgeKinds.${kind}.reviewPolicy`,
        "RECOMPILE_REQUIRED",
        "Changing review policy changes governed behavior and requires review.",
        kindUsage,
      );
    }
    if (currentKind.artifactContract !== candidateKind.artifactContract) {
      add(
        "KIND_ARTIFACT_CONTRACT_CHANGED",
        `knowledgeKinds.${kind}.artifactContract`,
        kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Changing artifact placement can require moving existing canonical files.",
        kindUsage,
      );
    }

    for (const [field, currentField] of Object.entries(currentKind.fields)) {
      const candidateField = candidateKind.fields[field];
      if (!candidateField) {
        add(
          "FIELD_REMOVED",
          `knowledgeKinds.${kind}.fields.${field}`,
          kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
          "Removing a declared field changes the compiled schema.",
          kindUsage,
        );
        continue;
      }
      if (!same(currentField, candidateField)) {
        const becameRequired =
          !currentField.required && candidateField.required;
        const structuralChange =
          currentField.type !== candidateField.type ||
          !same(currentField.enumValues, candidateField.enumValues);
        add(
          becameRequired
            ? "FIELD_BECAME_REQUIRED"
            : structuralChange
              ? "FIELD_SCHEMA_CHANGED"
              : "FIELD_POLICY_CHANGED",
          `knowledgeKinds.${kind}.fields.${field}`,
          kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
          "Changing an existing field can invalidate or reinterpret compiled knowledge.",
          kindUsage,
        );
      }
    }

    for (const [field, candidateField] of Object.entries(
      candidateKind.fields,
    )) {
      if (currentKind.fields[field]) continue;
      if (candidateField.required) {
        add(
          "REQUIRED_FIELD_ADDED",
          `knowledgeKinds.${kind}.fields.${field}`,
          kindUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
          "A new required field must be populated before existing knowledge can conform.",
          kindUsage,
        );
      }
    }
  }

  for (const [name, currentLifecycle] of Object.entries(current.lifecycles)) {
    const candidateLifecycle = candidate.lifecycles[name];
    const affectedKinds = kindsUsingPolicy(current, "lifecycle", name);
    const affectedUsage = usageForKinds(usage, affectedKinds);
    if (!candidateLifecycle) {
      add(
        "LIFECYCLE_REMOVED",
        `lifecycles.${name}`,
        affectedUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Removing a lifecycle invalidates kinds that reference it.",
        affectedUsage,
      );
      continue;
    }

    for (const state of currentLifecycle.states) {
      if (candidateLifecycle.states.includes(state)) continue;
      const stateUsage = countLifecycleState(usage, name, state);
      add(
        "LIFECYCLE_STATE_REMOVED",
        `lifecycles.${name}.states.${state}`,
        stateUsage > 0 ? "UNSAFE" : "RECOMPILE_REQUIRED",
        stateUsage > 0
          ? "A lifecycle state currently in use cannot be removed before migration."
          : "Removing an unused lifecycle state still changes executable lifecycle rules.",
        stateUsage,
      );
    }

    if (
      currentLifecycle.initial !== candidateLifecycle.initial ||
      !same(currentLifecycle.terminal, candidateLifecycle.terminal) ||
      !same(currentLifecycle.transitions, candidateLifecycle.transitions)
    ) {
      add(
        "LIFECYCLE_RULES_CHANGED",
        `lifecycles.${name}`,
        affectedUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Lifecycle transition semantics changed.",
        affectedUsage,
      );
    }
  }

  for (const [relation, currentRelation] of Object.entries(
    current.relationTypes,
  )) {
    const candidateRelation = candidate.relationTypes[relation];
    const relationUsage = countRelation(usage, relation);
    if (!candidateRelation) {
      add(
        "RELATION_REMOVED",
        `relationTypes.${relation}`,
        relationUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Removing a relation type changes the graph contract.",
        relationUsage,
      );
      continue;
    }
    if (!same(currentRelation, candidateRelation)) {
      add(
        "RELATION_SEMANTICS_CHANGED",
        `relationTypes.${relation}`,
        relationUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
        "Changing relation semantics requires explicit impact handling.",
        relationUsage,
      );
    }
  }

  for (const [name, currentPolicy] of Object.entries(
    current.evidencePolicies,
  )) {
    const candidatePolicy = candidate.evidencePolicies[name];
    if (!candidatePolicy || same(currentPolicy, candidatePolicy)) continue;
    const affectedKinds = kindsUsingPolicy(current, "evidencePolicy", name);
    const affectedUsage = usageForKinds(usage, affectedKinds);
    add(
      "EVIDENCE_POLICY_CHANGED",
      `evidencePolicies.${name}`,
      affectedUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
      "Evidence requirements changed for one or more knowledge kinds.",
      affectedUsage,
    );
  }

  for (const [name, currentPolicy] of Object.entries(current.reviewPolicies)) {
    const candidatePolicy = candidate.reviewPolicies[name];
    if (!candidatePolicy || same(currentPolicy, candidatePolicy)) continue;
    add(
      "REVIEW_POLICY_CHANGED",
      `reviewPolicies.${name}`,
      "RECOMPILE_REQUIRED",
      "Review policy is runtime governance and cannot change silently.",
      usageForKinds(usage, kindsUsingPolicy(current, "reviewPolicy", name)),
    );
  }

  for (const [name, currentContract] of Object.entries(
    current.artifactContracts,
  )) {
    const candidateContract = candidate.artifactContracts[name];
    if (!candidateContract || same(currentContract, candidateContract))
      continue;
    const affectedUsage = usageForKinds(
      usage,
      kindsUsingPolicy(current, "artifactContract", name),
    );
    add(
      "ARTIFACT_CONTRACT_CHANGED",
      `artifactContracts.${name}`,
      affectedUsage > 0 ? "MIGRATION_REQUIRED" : "RECOMPILE_REQUIRED",
      "Artifact path/root semantics changed.",
      affectedUsage,
    );
  }

  if (!same(current.retrievalPolicy, candidate.retrievalPolicy)) {
    add(
      "RETRIEVAL_POLICY_CHANGED",
      "retrievalPolicy",
      "REINDEX_REQUIRED",
      "Retrieval policy changes require refreshed retrieval projections/index evidence.",
    );
  }
  if (!same(current.promotionPolicy, candidate.promotionPolicy)) {
    add(
      "PROMOTION_POLICY_CHANGED",
      "promotionPolicy",
      "RECOMPILE_REQUIRED",
      "Promotion policy changes governed runtime behavior.",
    );
  }
  if (!same(current.freshnessPolicy, candidate.freshnessPolicy)) {
    add(
      "FRESHNESS_POLICY_CHANGED",
      "freshnessPolicy",
      "RECOMPILE_REQUIRED",
      "Freshness policy changes lifecycle/truth behavior.",
    );
  }
  if (!same(current.connectorPolicy, candidate.connectorPolicy)) {
    add(
      "CONNECTOR_POLICY_CHANGED",
      "connectorPolicy",
      "RECOMPILE_REQUIRED",
      "Connector policy changes source access behavior.",
    );
  }
  if (!same(current.modelRoleConstraints, candidate.modelRoleConstraints)) {
    add(
      "MODEL_ROLE_CONSTRAINTS_CHANGED",
      "modelRoleConstraints",
      "RECOMPILE_REQUIRED",
      "Model role constraints are runtime policy and require explicit review.",
    );
  }

  const compatibilityClass = maxClass(issues);
  return {
    compatibilityClass,
    requiresReview: compatibilityClass !== "NON_BREAKING",
    requiredActions: requiredActions(compatibilityClass),
    issues,
  };
}
