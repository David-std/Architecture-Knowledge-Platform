import { z } from "zod";
import { TrustTier } from "./index.js";

const ProfileId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
const SemanticName = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
const Version = z.string().trim().min(1).max(100);

export const KnowledgeProfileRevisionStatus = z.enum([
  "DRAFT",
  "VALIDATED",
  "REVIEW_REQUIRED",
  "ACTIVE",
  "SUPERSEDED",
  "RETIRED",
]);
export type KnowledgeProfileRevisionStatus = z.infer<
  typeof KnowledgeProfileRevisionStatus
>;

export const KnowledgeProfileCompatibility = z.enum([
  "NON_BREAKING",
  "REINDEX_REQUIRED",
  "RECOMPILE_REQUIRED",
  "MIGRATION_REQUIRED",
  "UNSAFE",
]);
export type KnowledgeProfileCompatibility = z.infer<
  typeof KnowledgeProfileCompatibility
>;

export const KnowledgeFieldType = z.enum([
  "string",
  "markdown",
  "number",
  "boolean",
  "datetime",
  "enum",
  "json",
]);
export type KnowledgeFieldType = z.infer<typeof KnowledgeFieldType>;

export const KnowledgeFieldDefinition = z
  .object({
    type: KnowledgeFieldType,
    required: z.boolean().default(false),
    enumValues: z.array(z.string().min(1)).min(1).optional(),
    description: z.string().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.type === "enum" && !field.enumValues?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enum fields require enumValues",
      });
    }
    if (field.type !== "enum" && field.enumValues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enumValues"],
        message: "enumValues are only valid for enum fields",
      });
    }
  });
export type KnowledgeFieldDefinition = z.infer<typeof KnowledgeFieldDefinition>;

export const LifecycleTransitionDefinition = z
  .object({
    from: SemanticName,
    to: SemanticName,
    allowedActors: z.array(z.string().min(1).max(100)).min(1),
    requiredEvidence: z.boolean().default(false),
    requiredReview: z.boolean().default(false),
  })
  .strict();
export type LifecycleTransitionDefinition = z.infer<
  typeof LifecycleTransitionDefinition
>;

export const LifecycleDefinition = z
  .object({
    states: z.array(SemanticName).min(1),
    initial: SemanticName,
    terminal: z.array(SemanticName).default([]),
    transitions: z.array(LifecycleTransitionDefinition).default([]),
  })
  .strict()
  .superRefine((lifecycle, context) => {
    const states = new Set(lifecycle.states);
    if (states.size !== lifecycle.states.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["states"],
        message: "lifecycle states must be unique",
      });
    }
    if (!states.has(lifecycle.initial)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initial"],
        message: "initial lifecycle state must be declared",
      });
    }
    for (const terminal of lifecycle.terminal) {
      if (!states.has(terminal)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["terminal"],
          message: `terminal lifecycle state is not declared: ${terminal}`,
        });
      }
    }
    const terminal = new Set(lifecycle.terminal);
    for (const [index, transition] of lifecycle.transitions.entries()) {
      if (!states.has(transition.from) || !states.has(transition.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", index],
          message: "lifecycle transition references an unknown state",
        });
      }
      if (terminal.has(transition.from)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", index, "from"],
          message: "terminal lifecycle states cannot have outgoing transitions",
        });
      }
    }
  });
export type LifecycleDefinition = z.infer<typeof LifecycleDefinition>;

export const EvidencePolicyDefinition = z
  .object({
    minimumEvidence: z.number().int().min(0).max(100).default(1),
    requireSourceLocator: z.boolean().default(true),
    minimumTrust: TrustTier.default("MACHINE_SUPPORTED"),
  })
  .strict();
export type EvidencePolicyDefinition = z.infer<typeof EvidencePolicyDefinition>;

export const ReviewPolicyDefinition = z
  .object({
    required: z.boolean().default(true),
    minimumApprovals: z.number().int().min(0).max(20).default(1),
    allowedRoles: z.array(z.string().min(1).max(100)).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.required && policy.minimumApprovals < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumApprovals"],
        message: "required review policies need at least one approval",
      });
    }
  });
export type ReviewPolicyDefinition = z.infer<typeof ReviewPolicyDefinition>;

export const ArtifactContractDefinition = z
  .object({
    root: z.string().min(1).max(500),
    pathTemplate: z.string().min(1).max(500),
    extension: z
      .string()
      .regex(/^\.[A-Za-z0-9]+$/)
      .default(".md"),
  })
  .strict();
export type ArtifactContractDefinition = z.infer<
  typeof ArtifactContractDefinition
>;

export const KnowledgeKindDefinition = z
  .object({
    fields: z.record(z.string(), KnowledgeFieldDefinition).default({}),
    lifecycle: SemanticName,
    evidencePolicy: SemanticName,
    reviewPolicy: SemanticName,
    artifactContract: SemanticName,
  })
  .strict();
export type KnowledgeKindDefinition = z.infer<typeof KnowledgeKindDefinition>;

export const RelationDefinition = z
  .object({
    from: z.array(SemanticName).min(1),
    to: z.array(SemanticName).min(1),
    symmetric: z.boolean().default(false),
    evidenceRequired: z.boolean().default(false),
    description: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type RelationDefinition = z.infer<typeof RelationDefinition>;

export const RetrievalProfilePolicy = z
  .object({
    allowedKinds: z.array(SemanticName).min(1),
    relationAllowlist: z.array(SemanticName).default([]),
    mandatoryKindsByIntent: z
      .record(z.string(), z.array(SemanticName))
      .default({}),
    progressiveDisclosure: z
      .array(z.enum(["L0", "L1", "L2", "L3"]))
      .min(1)
      .default(["L0", "L1", "L2", "L3"]),
  })
  .strict();
export type RetrievalProfilePolicy = z.infer<typeof RetrievalProfilePolicy>;

export const PromotionPolicyDefinition = z
  .object({
    allowedTargetScopes: z
      .array(
        z.enum([
          "PERSONAL",
          "PROJECT",
          "TEAM",
          "ORGANIZATION",
          "EXTERNAL_FEDERATED",
        ]),
      )
      .min(1),
    reviewRequired: z.boolean().default(true),
  })
  .strict();
export type PromotionPolicyDefinition = z.infer<
  typeof PromotionPolicyDefinition
>;

export const FreshnessPolicyDefinition = z
  .object({
    sourceChangeAction: z
      .enum(["MARK_STALE", "RECOMPILE", "REVIEW_REQUIRED"])
      .default("MARK_STALE"),
    staleAfterDays: z.number().int().positive().max(36_500).optional(),
  })
  .strict();
export type FreshnessPolicyDefinition = z.infer<
  typeof FreshnessPolicyDefinition
>;

export const ConnectorProfilePolicy = z
  .object({
    allowedAccessModes: z
      .array(
        z.enum([
          "MIRROR_INDEXED",
          "REMOTE_FEDERATED",
          "REFERENCE_LIVE",
          "HYBRID_CACHE",
        ]),
      )
      .min(1),
    requirePermissionFidelity: z.boolean().default(true),
  })
  .strict();
export type ConnectorProfilePolicy = z.infer<typeof ConnectorProfilePolicy>;

export const ModelRoleConstraint = z
  .object({
    role: z.string().min(1).max(100),
    residency: z.enum(["LOCAL_ONLY", "ORG_APPROVED", "EXTERNAL_ALLOWED"]),
    structuredOutputRequired: z.boolean().default(false),
  })
  .strict();
export type ModelRoleConstraint = z.infer<typeof ModelRoleConstraint>;

function unsafeProfilePath(value: string): boolean {
  return (
    value.includes("\0") ||
    value.includes("..") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]+/).some((segment) => segment.startsWith(".akp"))
  );
}

export const KnowledgeProfileV1 = z
  .object({
    schemaVersion: z.literal(1),
    profileId: ProfileId,
    version: Version,
    displayName: z.string().trim().min(1).max(200),
    knowledgeKinds: z.record(SemanticName, KnowledgeKindDefinition),
    relationTypes: z.record(SemanticName, RelationDefinition).default({}),
    lifecycles: z.record(SemanticName, LifecycleDefinition),
    evidencePolicies: z.record(SemanticName, EvidencePolicyDefinition),
    reviewPolicies: z.record(SemanticName, ReviewPolicyDefinition),
    artifactContracts: z.record(SemanticName, ArtifactContractDefinition),
    retrievalPolicy: RetrievalProfilePolicy,
    promotionPolicy: PromotionPolicyDefinition,
    freshnessPolicy: FreshnessPolicyDefinition,
    connectorPolicy: ConnectorProfilePolicy.optional(),
    modelRoleConstraints: z.array(ModelRoleConstraint).default([]),
  })
  .strict()
  .superRefine((profile, context) => {
    const kindNames = new Set(Object.keys(profile.knowledgeKinds));
    const relationNames = new Set(Object.keys(profile.relationTypes));
    const lifecycleNames = new Set(Object.keys(profile.lifecycles));
    const evidenceNames = new Set(Object.keys(profile.evidencePolicies));
    const reviewNames = new Set(Object.keys(profile.reviewPolicies));
    const artifactNames = new Set(Object.keys(profile.artifactContracts));

    if (kindNames.size === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knowledgeKinds"],
        message: "a profile must declare at least one knowledge kind",
      });
    }

    for (const [kind, definition] of Object.entries(profile.knowledgeKinds)) {
      if (!lifecycleNames.has(definition.lifecycle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledgeKinds", kind, "lifecycle"],
          message: "knowledge kind references an unknown lifecycle",
        });
      }
      if (!evidenceNames.has(definition.evidencePolicy)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledgeKinds", kind, "evidencePolicy"],
          message: "knowledge kind references an unknown evidence policy",
        });
      }
      if (!reviewNames.has(definition.reviewPolicy)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledgeKinds", kind, "reviewPolicy"],
          message: "knowledge kind references an unknown review policy",
        });
      }
      if (!artifactNames.has(definition.artifactContract)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledgeKinds", kind, "artifactContract"],
          message: "knowledge kind references an unknown artifact contract",
        });
      }
    }

    for (const [relation, definition] of Object.entries(
      profile.relationTypes,
    )) {
      for (const kind of [...definition.from, ...definition.to]) {
        if (!kindNames.has(kind)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["relationTypes", relation],
            message: `relation references an unknown knowledge kind: ${kind}`,
          });
        }
      }
    }

    for (const kind of profile.retrievalPolicy.allowedKinds) {
      if (!kindNames.has(kind)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retrievalPolicy", "allowedKinds"],
          message: `retrieval policy references an unknown kind: ${kind}`,
        });
      }
    }
    for (const relation of profile.retrievalPolicy.relationAllowlist) {
      if (!relationNames.has(relation)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retrievalPolicy", "relationAllowlist"],
          message: `retrieval policy references an unknown relation: ${relation}`,
        });
      }
    }
    for (const [intent, kinds] of Object.entries(
      profile.retrievalPolicy.mandatoryKindsByIntent,
    )) {
      for (const kind of kinds) {
        if (!kindNames.has(kind)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["retrievalPolicy", "mandatoryKindsByIntent", intent],
            message: `mandatory retrieval kind is unknown: ${kind}`,
          });
        }
      }
    }

    for (const [name, artifact] of Object.entries(profile.artifactContracts)) {
      if (
        unsafeProfilePath(artifact.root) ||
        unsafeProfilePath(artifact.pathTemplate)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifactContracts", name],
          message: "artifact contracts must use safe relative paths",
        });
      }
    }
  });
export type KnowledgeProfileV1 = z.infer<typeof KnowledgeProfileV1>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function canonicalKnowledgeProfileJson(input: unknown): string {
  const parsed = KnowledgeProfileV1.parse(input);
  return JSON.stringify(stableValue(parsed));
}

const v03Kinds = [
  "claim",
  "decision",
  "rule",
  "workflow",
  "concept",
  "example",
  "counterexample",
] as const;

function v03Transition(
  from: string,
  to: string,
  allowedActors: string[],
  options: { requiredEvidence?: boolean; requiredReview?: boolean } = {},
) {
  return {
    from,
    to,
    allowedActors,
    requiredEvidence: options.requiredEvidence ?? false,
    requiredReview: options.requiredReview ?? false,
  };
}

function v03Relation(
  options: {
    symmetric?: boolean;
    evidenceRequired?: boolean;
  } = {},
) {
  return {
    from: [...v03Kinds],
    to: [...v03Kinds],
    symmetric: options.symmetric ?? false,
    evidenceRequired: options.evidenceRequired ?? false,
  };
}

const v03KindDefinitions = Object.fromEntries(
  v03Kinds.map((kind) => [
    kind,
    {
      fields: {
        statement: { type: "markdown", required: true },
        scope: { type: "string", required: true },
      },
      lifecycle: "knowledge-v03",
      evidencePolicy: "grounded-v03",
      reviewPolicy: "human-review-v03",
      artifactContract: "markdown-v03",
    },
  ]),
);

export const DEFAULT_KNOWLEDGE_PROFILE_V1 = KnowledgeProfileV1.parse({
  schemaVersion: 1,
  profileId: "default",
  version: "0.3-compat",
  displayName: "AKP v0.3 compatibility profile",
  knowledgeKinds: v03KindDefinitions,
  relationTypes: {
    derives_from: v03Relation(),
    supports: v03Relation({ evidenceRequired: true }),
    contradicts: v03Relation({ symmetric: true }),
    supersedes: v03Relation(),
    implements: v03Relation(),
    applies_to: v03Relation(),
    example_of: v03Relation(),
    counterexample_of: v03Relation(),
    uses: v03Relation(),
    requires: v03Relation(),
    validated_by: v03Relation(),
    produces: v03Relation(),
    consumed_by: v03Relation(),
    related_to: v03Relation({ symmetric: true }),
  },
  lifecycles: {
    "knowledge-v03": {
      states: [
        "DRAFT",
        "ACTIVE",
        "DISPUTED",
        "SUPERSEDED",
        "ARCHIVED",
        "DELETED_TOMBSTONE",
      ],
      initial: "DRAFT",
      terminal: ["DELETED_TOMBSTONE"],
      transitions: [
        v03Transition("DRAFT", "ACTIVE", ["REVIEWER"], {
          requiredReview: true,
        }),
        v03Transition("DRAFT", "ARCHIVED", ["REVIEWER"], {
          requiredReview: true,
        }),
        v03Transition("ACTIVE", "DISPUTED", ["REVIEWER", "ARCHITECT"]),
        v03Transition("ACTIVE", "SUPERSEDED", ["REVIEWER", "ARCHITECT"], {
          requiredReview: true,
        }),
        v03Transition("ACTIVE", "ARCHIVED", ["REVIEWER", "ARCHITECT"], {
          requiredReview: true,
        }),
        v03Transition("DISPUTED", "ACTIVE", ["REVIEWER", "ARCHITECT"], {
          requiredReview: true,
        }),
        v03Transition("DISPUTED", "SUPERSEDED", ["REVIEWER", "ARCHITECT"], {
          requiredReview: true,
        }),
        v03Transition("DISPUTED", "ARCHIVED", ["REVIEWER", "ARCHITECT"], {
          requiredReview: true,
        }),
        v03Transition("SUPERSEDED", "ARCHIVED", ["REVIEWER", "ARCHITECT"]),
        v03Transition("ARCHIVED", "DELETED_TOMBSTONE", ["ADMIN"], {
          requiredReview: true,
        }),
      ],
    },
  },
  evidencePolicies: {
    "grounded-v03": {
      minimumEvidence: 1,
      requireSourceLocator: true,
      minimumTrust: "MACHINE_SUPPORTED",
    },
  },
  reviewPolicies: {
    "human-review-v03": {
      required: true,
      minimumApprovals: 1,
      allowedRoles: ["REVIEWER", "ARCHITECT", "ADMIN"],
    },
  },
  artifactContracts: {
    "markdown-v03": {
      root: "knowledge",
      pathTemplate: "{kind}/{candidateId}.md",
      extension: ".md",
    },
  },
  retrievalPolicy: {
    allowedKinds: [...v03Kinds],
    relationAllowlist: [
      "derives_from",
      "supports",
      "contradicts",
      "supersedes",
      "implements",
      "applies_to",
      "example_of",
      "counterexample_of",
      "uses",
      "requires",
      "validated_by",
      "produces",
      "consumed_by",
      "related_to",
    ],
    mandatoryKindsByIntent: {},
    progressiveDisclosure: ["L0", "L1", "L2", "L3"],
  },
  promotionPolicy: {
    allowedTargetScopes: ["PROJECT", "TEAM", "ORGANIZATION"],
    reviewRequired: true,
  },
  freshnessPolicy: {
    sourceChangeAction: "MARK_STALE",
  },
});

export const NEUTRAL_KNOWLEDGE_PROFILE_V1 = KnowledgeProfileV1.parse({
  schemaVersion: 1,
  profileId: "neutral-notes",
  version: "1.0.0",
  displayName: "Neutral notes and procedures",
  knowledgeKinds: {
    note: {
      fields: {
        body: { type: "markdown", required: true },
      },
      lifecycle: "note-flow",
      evidencePolicy: "optional-evidence",
      reviewPolicy: "neutral-review",
      artifactContract: "neutral-markdown",
    },
    procedure: {
      fields: {
        body: { type: "markdown", required: true },
        owner: { type: "string", required: false },
      },
      lifecycle: "procedure-flow",
      evidencePolicy: "grounded-procedure",
      reviewPolicy: "neutral-review",
      artifactContract: "neutral-markdown",
    },
  },
  relationTypes: {
    follows: {
      from: ["procedure"],
      to: ["procedure"],
    },
    explains: {
      from: ["note"],
      to: ["procedure"],
    },
  },
  lifecycles: {
    "note-flow": {
      states: ["DRAFT", "ACTIVE", "RETIRED"],
      initial: "DRAFT",
      terminal: ["RETIRED"],
      transitions: [
        {
          from: "DRAFT",
          to: "ACTIVE",
          allowedActors: ["REVIEWER"],
          requiredReview: true,
        },
        {
          from: "ACTIVE",
          to: "RETIRED",
          allowedActors: ["REVIEWER"],
          requiredReview: true,
        },
      ],
    },
    "procedure-flow": {
      states: ["DRAFT", "VALIDATED", "ACTIVE", "RETIRED"],
      initial: "DRAFT",
      terminal: ["RETIRED"],
      transitions: [
        {
          from: "DRAFT",
          to: "VALIDATED",
          allowedActors: ["CURATOR"],
          requiredEvidence: true,
        },
        {
          from: "VALIDATED",
          to: "ACTIVE",
          allowedActors: ["REVIEWER"],
          requiredReview: true,
        },
        {
          from: "ACTIVE",
          to: "RETIRED",
          allowedActors: ["REVIEWER"],
          requiredReview: true,
        },
      ],
    },
  },
  evidencePolicies: {
    "optional-evidence": {
      minimumEvidence: 0,
      requireSourceLocator: false,
      minimumTrust: "UNVERIFIED",
    },
    "grounded-procedure": {
      minimumEvidence: 1,
      requireSourceLocator: true,
      minimumTrust: "MACHINE_SUPPORTED",
    },
  },
  reviewPolicies: {
    "neutral-review": {
      required: true,
      minimumApprovals: 1,
      allowedRoles: ["REVIEWER", "ADMIN"],
    },
  },
  artifactContracts: {
    "neutral-markdown": {
      root: "knowledge",
      pathTemplate: "{kind}/{candidateId}.md",
      extension: ".md",
    },
  },
  retrievalPolicy: {
    allowedKinds: ["note", "procedure"],
    relationAllowlist: ["follows", "explains"],
    mandatoryKindsByIntent: {},
  },
  promotionPolicy: {
    allowedTargetScopes: ["PROJECT", "TEAM"],
    reviewRequired: true,
  },
  freshnessPolicy: {
    sourceChangeAction: "REVIEW_REQUIRED",
    staleAfterDays: 180,
  },
});
