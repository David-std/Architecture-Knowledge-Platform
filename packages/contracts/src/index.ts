export * from "./temporal-truth.js";
export * from "./code-graph.js";
export * from "./connector-capabilities.js";
import { z } from "zod";

export const TrustTier = z.enum([
  "UNVERIFIED",
  "MACHINE_SUPPORTED",
  "HUMAN_REVIEWED",
  "ATTESTED",
]);
export type TrustTier = z.infer<typeof TrustTier>;

export const Lifecycle = z.enum([
  "DRAFT",
  "ACTIVE",
  "DISPUTED",
  "SUPERSEDED",
  "ARCHIVED",
  "DELETED_TOMBSTONE",
]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const EvidenceLocator = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("markdown"),
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    contentHash: z.string(),
  }),
  z.object({
    kind: z.literal("pdf"),
    page: z.number().int().positive(),
    figure: z.string().optional(),
    table: z.string().optional(),
  }),
  z.object({
    kind: z.literal("media"),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    speaker: z.string().optional(),
  }),
  z.object({
    kind: z.literal("image"),
    region: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
  z.object({
    kind: z.literal("spreadsheet"),
    sheet: z.string(),
    range: z.string(),
    formulaCell: z.string().optional(),
  }),
  z.object({
    kind: z.literal("code"),
    repository: z.string(),
    commit: z.string(),
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("web"),
    url: z.string().url(),
    snapshotHash: z.string(),
    section: z.string().optional(),
  }),
]);
export type EvidenceLocator = z.infer<typeof EvidenceLocator>;

export const QueryIntent = z.enum([
  "EXACT_LOOKUP",
  "CONCEPTUAL",
  "COMPARISON",
  "WORKFLOW_EXECUTION",
  "SOURCE_VERIFICATION",
  "PROJECT_CODE",
  "GLOBAL_SYNTHESIS",
  "IMPACT_ANALYSIS",
  "NO_RETRIEVAL_REQUIRED",
]);
export type QueryIntent = z.infer<typeof QueryIntent>;

export const GraphRelationType = z.enum([
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
]);
export type GraphRelationType = z.infer<typeof GraphRelationType>;

export const ContextRevisionEntry = z
  .object({
    vaultId: z.string().uuid(),
    corpusRevision: z.string().min(1),
    lexicalRevision: z.string().min(1).nullable().optional(),
    vectorRevision: z.string().min(1).nullable().optional(),
    graphRevision: z.string().min(1).nullable().optional(),
    contextPackRevision: z.string().min(1).nullable().optional(),
    communityRevision: z.string().min(1).nullable().optional(),
  })
  .strict();
export type ContextRevisionEntry = z.infer<typeof ContextRevisionEntry>;

export const ContextRevisionSet = z
  .object({
    spaceId: z.string().uuid(),
    vaults: z.array(ContextRevisionEntry).min(1).max(20),
    retrievalConfigurationVersion: z.string().min(1).optional(),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const vaultIds = value.vaults.map((vault) => vault.vaultId);
    if (new Set(vaultIds).size !== vaultIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vaults"],
        message: "revision set contains duplicate vault identities",
      });
    }
  });
export type ContextRevisionSet = z.infer<typeof ContextRevisionSet>;

export const ReasoningOperator = z.enum([
  "RESOLVE_ENTITY",
  "EXACT_LOOKUP",
  "SEARCH_LEXICAL",
  "SEARCH_VECTOR",
  "SEARCH_CODE",
  "TRAVERSE_TYPED",
  "PPR_EXPAND",
  "COMMUNITY_SEARCH",
  "TEMPORAL_AT",
  "FILTER_SCOPE",
  "JOIN_EVIDENCE",
  "COMPARE",
  "AGGREGATE",
  "CALCULATE",
  "VERIFY_SUPPORT",
  "LOAD_RAW",
  "BUILD_CONTEXT",
]);
export type ReasoningOperator = z.infer<typeof ReasoningOperator>;

export const ReasoningExecutionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("LOCAL") }).strict(),
  z
    .object({
      kind: z.literal("EXTERNAL_PEER"),
      peerId: z.string().min(1).max(256),
    })
    .strict(),
]);
export type ReasoningExecutionTarget = z.infer<typeof ReasoningExecutionTarget>;

export const ReasoningModelRole = z.enum([
  "DOCUMENT_EXTRACT",
  "VISION",
  "KNOWLEDGE_COMPILE",
  "ENTITY_RESOLUTION",
  "TEMPORAL_EXTRACTION",
  "QUERY_EXPANSION",
  "RERANK",
  "COMMUNITY_SUMMARY",
  "REASONING_PLAN",
  "ADVERSARY",
  "EVAL_JUDGE",
]);
export type ReasoningModelRole = z.infer<typeof ReasoningModelRole>;

const ReasoningStepBase = {
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  dependsOn: z
    .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
    .max(16)
    .default([]),
  executionTarget: ReasoningExecutionTarget.default({ kind: "LOCAL" }),
  processing: z
    .object({
      modelRole: ReasoningModelRole.optional(),
      modelProvider: z.string().min(1).max(160).optional(),
      dataResidency: z.string().min(1).max(160).optional(),
    })
    .strict()
    .optional(),
};

const QueryArgs = z
  .object({
    query: z.string().min(1).max(8_000),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const ReasoningStep = z.discriminatedUnion("operator", [
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("RESOLVE_ENTITY"),
      args: QueryArgs.extend({
        entityKinds: z.array(z.string().min(1).max(120)).max(20).default([]),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("EXACT_LOOKUP"),
      args: QueryArgs,
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("SEARCH_LEXICAL"),
      args: QueryArgs,
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("SEARCH_VECTOR"),
      args: QueryArgs,
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("SEARCH_CODE"),
      args: QueryArgs.extend({
        projectId: z.string().uuid().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("TRAVERSE_TYPED"),
      args: z
        .object({
          seedStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          relationTypes: z.array(GraphRelationType).max(32).default([]),
          direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
          maxHops: z.number().int().min(1).max(8).default(2),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("PPR_EXPAND"),
      args: z
        .object({
          seedStepIds: z
            .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
            .min(1)
            .max(16),
          damping: z.number().gt(0).lt(1).default(0.85),
          maxIterations: z.number().int().min(1).max(500).default(100),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("COMMUNITY_SEARCH"),
      args: QueryArgs.extend({
        strategy: z.enum(["GLOBAL", "DRIFT"]).default("GLOBAL"),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("TEMPORAL_AT"),
      args: z
        .object({
          inputStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          asOf: z.string().datetime(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("FILTER_SCOPE"),
      args: z
        .object({
          inputStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          vaultIds: z.array(z.string().uuid()).max(20).default([]),
          pathPrefixes: z
            .array(z.string().min(1).max(2048))
            .max(64)
            .default([]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("JOIN_EVIDENCE"),
      args: z
        .object({
          inputStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          minimumSupport: z.number().int().min(1).max(20).default(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("COMPARE"),
      args: z
        .object({
          leftStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          rightStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          fields: z.array(z.string().min(1).max(160)).max(32).default([]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("AGGREGATE"),
      args: z
        .object({
          inputStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          operation: z.enum([
            "COUNT",
            "DISTINCT_COUNT",
            "SUM",
            "AVERAGE",
            "MIN",
            "MAX",
          ]),
          field: z.string().min(1).max(160).optional(),
          groupBy: z.string().min(1).max(160).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("CALCULATE"),
      args: z
        .object({
          operation: z.enum(["COUNT", "SUM", "AVERAGE", "MIN", "MAX", "RATIO"]),
          inputStepIds: z
            .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
            .min(1)
            .max(16),
          field: z.string().min(1).max(160).optional(),
          numeratorField: z.string().min(1).max(160).optional(),
          denominatorField: z.string().min(1).max(160).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("VERIFY_SUPPORT"),
      args: z
        .object({
          inputStepId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
          minimumTrust: TrustTier.default("MACHINE_SUPPORTED"),
          requireCitation: z.boolean().default(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("LOAD_RAW"),
      args: z
        .object({
          inputStepId: z
            .string()
            .regex(/^[a-z][a-z0-9_-]{0,63}$/)
            .optional(),
          sourceIds: z.array(z.string().uuid()).max(100).default([]),
          maxBytes: z.number().int().min(1).max(10_000_000).default(1_000_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...ReasoningStepBase,
      operator: z.literal("BUILD_CONTEXT"),
      args: z
        .object({
          inputStepIds: z
            .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
            .min(1)
            .max(16),
          contextLevel: z.enum(["L0", "L1", "L2", "L3"]).default("L2"),
          maxTokens: z.number().int().min(128).max(200_000),
        })
        .strict(),
    })
    .strict(),
]);
export type ReasoningStep = z.infer<typeof ReasoningStep>;

export const ReasoningPlan = z
  .object({
    schemaVersion: z.literal(1),
    query: z.string().min(1).max(8_000),
    intent: QueryIntent,
    revisionSet: ContextRevisionSet,
    steps: z.array(ReasoningStep).min(1).max(100),
    budget: z
      .object({
        maxSteps: z.number().int().min(1).max(100),
        maxWallMs: z.number().int().min(1).max(3_600_000),
        maxTokens: z.number().int().min(1).max(2_000_000).optional(),
        maxCost: z.number().nonnegative().max(10_000).optional(),
      })
      .strict(),
  })
  .strict();
export type ReasoningPlan = z.infer<typeof ReasoningPlan>;

export const SearchRequest = z.object({
  query: z.string().min(1),
  intent: QueryIntent.optional(),
  organizationId: z.string().uuid().optional(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid().optional(),
  vaultIds: z.array(z.string().uuid()).max(20).default([]),
  federated: z.boolean().default(false),
  projectId: z.string().uuid().optional(),
  truthConsistency: z.enum(["STRICT", "BEST_EFFORT"]).optional(),
  types: z.array(z.string()).default([]),
  minimumTrust: TrustTier.default("MACHINE_SUPPORTED"),
  mode: z
    .enum([
      "COMPILED_ONLY",
      "SOURCE_BACKED",
      "RAW_ONLY",
      "PROJECT_CODE",
      "DRAFT_INCLUDED",
    ])
    .default("SOURCE_BACKED"),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const GraphPathNode = z.object({
  documentId: z.string().uuid(),
  document: z.string().min(1),
  relation: GraphRelationType.optional(),
  direction: z.enum(["outgoing", "incoming"]).optional(),
});
export type GraphPathNode = z.infer<typeof GraphPathNode>;

export const GraphPathProvenance = z.object({
  channel: z.literal("graph"),
  seedDocumentId: z.string().uuid(),
  targetDocumentId: z.string().uuid(),
  path: z.array(GraphPathNode).min(2),
  hops: z.number().int().min(1),
  graphScore: z.number().min(0),
});
export type GraphPathProvenance = z.infer<typeof GraphPathProvenance>;

export const SearchHit = z.object({
  documentId: z.string().uuid(),
  vaultId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  unitType: z.string().optional(),
  parentUnitId: z.string().uuid().optional(),
  parentUnitType: z.string().optional(),
  headingPath: z.array(z.string()).optional(),
  parentContext: z.string().optional(),
  document: z.object({
    externalId: z.string().nullable(),
    path: z.string(),
    title: z.string(),
  }),
  revision: z.string(),
  title: z.string(),
  type: z.string(),
  trust: TrustTier,
  lifecycle: Lifecycle,
  refreshStatus: z.string().min(1),
  score: z.number(),
  reasons: z.array(z.string()),
  fusionContributions: z
    .array(
      z.object({
        channel: z.string().min(1),
        rank: z.number().int().positive(),
        channelWeight: z.number().nonnegative(),
        reason: z.string().min(1),
        rawScore: z.number().finite().optional(),
        candidateRevision: z.string().nullable().optional(),
      }),
    )
    .optional(),
  rerankTrace: z
    .object({
      reranker: z.string().min(1),
      preRank: z.number().int().positive(),
      postRank: z.number().int().positive(),
    })
    .optional(),
  excerpt: z.string(),
  citations: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
  graphProvenance: z.array(GraphPathProvenance).optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const ContextDisclosureLevel = z.enum(["L0", "L1", "L2", "L3"]);
export type ContextDisclosureLevel = z.infer<typeof ContextDisclosureLevel>;

export const ContextSection = z.object({
  kind: z.enum([
    "rule",
    "workflow",
    "concept",
    "profile",
    "decision",
    "example",
    "counterexample",
    "evidence",
    "source",
  ]),
  contextLevel: ContextDisclosureLevel,
  title: z.string(),
  content: z.string(),
  documentId: z.string().uuid(),
  vaultId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  parentUnitId: z.string().uuid().optional(),
  unitType: z.string().optional(),
  parentUnitType: z.string().optional(),
  headingPath: z.array(z.string()).optional(),
  document: SearchHit.shape.document,
  retrievalChannels: z.array(z.string()).optional(),
  documentRevision: z.string(),
  score: z.number().optional(),
  selectionReason: z.string(),
  sourceOrEvidenceIds: z.array(z.string()),
  graphProvenance: z.array(GraphPathProvenance).optional(),
});
export type ContextSection = z.infer<typeof ContextSection>;

export const ContextPacketMode = z.enum([
  "FULL_CONTEXT_PACKET",
  "COMPACT_AGENT_PACKET",
]);
export type ContextPacketMode = z.infer<typeof ContextPacketMode>;

export const ContextRequest = SearchRequest.extend({
  maxTokens: z.number().int().min(256).max(32000).optional(),
  packetMode: ContextPacketMode.default("FULL_CONTEXT_PACKET"),
  contextLevel: ContextDisclosureLevel.default("L2"),
  reasoningMode: z.enum(["DIRECT", "PLAN"]).default("DIRECT"),
});
export type ContextRequest = z.infer<typeof ContextRequest>;

export const TokenizerMetadata = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  quality: z.enum(["EXACT", "APPROXIMATE"]),
  approximate: z.boolean(),
  source: z.enum(["injected", "fallback"]),
});
export type TokenizerMetadata = z.infer<typeof TokenizerMetadata>;

export const ContextPacketBudget = z.object({
  maxTokens: z.number().int().positive(),
  usedTokens: z.number().int().nonnegative(),
  contentTokens: z.number().int().nonnegative(),
  metadataTokens: z.number().int().nonnegative(),
  serializedTokens: z.number().int().nonnegative(),
  tokenizer: TokenizerMetadata,
});
export type ContextPacketBudget = z.infer<typeof ContextPacketBudget>;

export const ContextContinuation = z.object({
  handle: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string(),
  remainingTokens: z.number().int().nonnegative(),
});
export type ContextContinuation = z.infer<typeof ContextContinuation>;

export const ContextPacket = z.object({
  packetMode: z.literal("FULL_CONTEXT_PACKET"),
  packetId: z.string().uuid(),
  vaultId: z.string().uuid().optional(),
  query: z.string(),
  intent: z.string(),
  corpusRevision: z.string(),
  status: z.enum(["SUPPORTED", "INSUFFICIENT_KNOWLEDGE", "DEGRADED"]),
  indexRevisions: z.record(z.string(), z.string().nullable()),
  retrievalConfiguration: z.record(z.string(), z.unknown()),
  scope: z.object({
    organizationId: z.string().uuid().optional(),
    spaceId: z.string().uuid(),
    vaultIds: z.array(z.string().uuid()).min(1),
    federated: z.boolean().default(false),
  }),
  generatedAt: z.string().datetime(),
  budget: ContextPacketBudget,
  mode: SearchRequest.shape.mode,
  requestedContextLevel: ContextDisclosureLevel,
  searchedChannels: z.array(z.string()),
  sections: z.array(ContextSection),
  citations: z.array(z.string()),
  gaps: z.array(z.string()),
  conflicts: z.array(z.string()),
  requiredActions: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  continuations: z.array(ContextContinuation),
  packetHash: z.string(),
});
export type ContextPacket = z.infer<typeof ContextPacket>;

export const ContextContinuationResponse = z.object({
  packetId: z.string().uuid(),
  packetHash: z.string(),
  corpusRevision: z.string(),
  scope: ContextPacket.shape.scope,
  continuation: ContextContinuation,
  sections: z.array(ContextSection).min(1),
});
export type ContextContinuationResponse = z.infer<
  typeof ContextContinuationResponse
>;

export const CompactContextSection = z.object({
  kind: ContextSection.shape.kind,
  contextLevel: ContextDisclosureLevel,
  identity: z.object({
    documentId: z.string().uuid(),
    vaultId: z.string().uuid(),
    title: z.string(),
    revision: z.string(),
    unitId: z.string().uuid().optional(),
    parentUnitId: z.string().uuid().optional(),
    unitType: z.string().optional(),
    parentUnitType: z.string().optional(),
    headingPath: z.array(z.string()).optional(),
    document: SearchHit.shape.document,
  }),
  content: z.string(),
  references: z.array(z.string()),
  citations: z.array(z.string()),
  retrievalChannels: z.array(z.string()),
  selectionReason: z.string(),
  score: z.number().optional(),
  graphProvenance: z.array(GraphPathProvenance).optional(),
});
export type CompactContextSection = z.infer<typeof CompactContextSection>;

export const CompactAgentPacket = z.object({
  packetMode: z.literal("COMPACT_AGENT_PACKET"),
  identity: z.object({
    packetId: z.string().uuid(),
    query: z.string(),
    intent: z.string(),
    corpusRevision: z.string(),
    status: ContextPacket.shape.status,
    mode: SearchRequest.shape.mode,
    requestedContextLevel: ContextDisclosureLevel,
    scope: ContextPacket.shape.scope,
    indexRevisions: ContextPacket.shape.indexRevisions,
  }),
  content: z.array(CompactContextSection),
  references: z.array(z.string()),
  citations: z.array(z.string()),
  searchedChannels: z.array(z.string()),
  conflicts: z.array(z.string()),
  gaps: z.array(z.string()),
  requiredActions: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  continuations: ContextPacket.shape.continuations,
  budget: ContextPacketBudget,
  packetHash: z.string(),
});
export type CompactAgentPacket = z.infer<typeof CompactAgentPacket>;

export const ContextPacketResponse = z.discriminatedUnion("packetMode", [
  ContextPacket,
  CompactAgentPacket,
]);
export type ContextPacketResponse = z.infer<typeof ContextPacketResponse>;

export const DocumentIntelligenceIngestOptions = z
  .object({
    complexity: z
      .enum([
        "simple",
        "digital",
        "complex",
        "scanned",
        "formula",
        "table-heavy",
        "unknown",
      ])
      .optional(),
    ocrRequired: z.boolean().default(false),
    tables: z.boolean().default(false),
    formula: z.boolean().default(false),
    costPolicy: z.enum(["NO_PAID", "STANDARD", "QUALITY"]).default("STANDARD"),
    privacyPolicy: z
      .enum(["LOCAL_ONLY", "LOCAL_PREFERRED", "REMOTE_ALLOWED"])
      .default("LOCAL_PREFERRED"),
    language: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{1,31}$/)
      .optional(),
    extractor: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
      .optional(),
    ocr: z.boolean().optional(),
    ocrEngine: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
      .optional(),
    forceFullPageOcr: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(900).optional(),
  })
  .strict();
export type DocumentIntelligenceIngestOptions = z.infer<
  typeof DocumentIntelligenceIngestOptions
>;

export const DocumentIntelligenceRequest = DocumentIntelligenceIngestOptions;
export type DocumentIntelligenceRequest = z.infer<
  typeof DocumentIntelligenceRequest
>;

export const IngestRequest = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  sourceUri: z.string(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  title: z.string().optional(),
  mediaType: z.string().optional(),
  documentIntelligence: DocumentIntelligenceIngestOptions.optional(),
  policy: z
    .enum(["REVIEW_REQUIRED", "ALLOW_LOW_RISK_AUTO_APPROVAL"])
    .default("REVIEW_REQUIRED"),
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const VaultEvalPack = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  version: z.string().min(1),
  enabled: z.boolean().default(true),
  criticalCases: z.array(z.string()).default([]),
});
export type VaultEvalPack = z.infer<typeof VaultEvalPack>;

export const VaultRegistration = z.object({
  vaultKey: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(200),
  spaceId: z.string().uuid(),
  visibility: z.enum(["PRIVATE", "TEAM", "CENTRAL"]).default("PRIVATE"),
  gitRepository: z.string().min(1).nullable().default(null),
  defaultBranch: z.string().min(1).default("main"),
  localPath: z.string().min(1),
  contentRoots: z.array(z.string().min(1)).min(1).default(["."]),
  sourceRoots: z.array(z.string().min(1)).default([]),
  schemaProfile: z.record(z.string(), z.unknown()).default({}),
  evalPack: VaultEvalPack.default({
    name: "generic",
    version: "1",
    enabled: true,
    criticalCases: [],
  }),
  retrievalConfig: z.record(z.string(), z.unknown()).default({}),
  permissions: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type VaultRegistration = z.infer<typeof VaultRegistration>;

export const IntegrationEventType = z.enum([
  "SourceRegistered",
  "ExtractionRequested",
  "ExtractionCompleted",
  "CompilationRequested",
  "KnowledgeDraftCreated",
  "ValidationRequested",
  "KnowledgePublished",
  "CorpusRevisionPublished",
  "LexicalIndexUpdateRequested",
  "VectorIndexUpdateRequested",
  "GraphIndexUpdateRequested",
  "CodeGraphRefreshRequested",
  "CodeKnowledgeLinkApproved",
  "GraphRevisionBuilt",
  "GraphRevisionActivated",
  "GraphRevisionStale",
  "SourceWithdrawn",
  "EvidenceInvalidated",
  "FactSuperseded",
  "TruthRevisionPublished",
  "DerivedSupportInvalidationRequested",
  "ContextPackInvalidationRequested",
  "ImpactedEvalRunRequested",
  "WorkspaceSessionCreated",
  "WorkspaceSessionUpdated",
  "WorkspaceClaimUpdated",
  "WorkspaceHandoffCreated",
  "WorkspacePromotionRequested",
  "ExternalObjectRefUpserted",
  "OfflineDraftQueued",
  "OfflineDraftReconciled",
  "ContextFabricPeerRegistered",
  "PrincipalRevoked",
]);
export type IntegrationEventType = z.infer<typeof IntegrationEventType>;

export const EventEnvelope = z.object({
  eventId: z.string().uuid(),
  eventType: IntegrationEventType,
  eventVersion: z.number().int().positive(),
  resourceId: z.string().min(1),
  organizationId: z.string().uuid().nullable().default(null),
  spaceId: z.string().uuid().nullable().default(null),
  vaultId: z.string().uuid().nullable().default(null),
  correlationId: z.string().min(1).nullable().default(null),
  causationId: z.string().min(1).nullable().default(null),
  occurredAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const DocumentBlockType = z.enum([
  "block",
  "page",
  "heading",
  "paragraph",
  "list",
  "list-item",
  "table",
  "figure",
  "equation",
  "code",
]);

export const ArtifactBoundingBox = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  unit: z.string().default("pixel"),
});

export const StructuralLocator = z
  .object({
    kind: z.string().min(1),
    source_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    path: z.string().nullable().optional(),
    page: z.number().int().positive().nullable().optional(),
    slide: z.number().int().positive().nullable().optional(),
    paragraph: z.number().int().positive().nullable().optional(),
    table: z.number().int().positive().nullable().optional(),
    row: z.number().int().positive().nullable().optional(),
    column: z.number().int().positive().nullable().optional(),
    sheet: z.string().nullable().optional(),
    index: z.number().int().positive().nullable().optional(),
    start_line: z.number().int().positive().nullable().optional(),
    end_line: z.number().int().positive().nullable().optional(),
    start_char: z.number().int().nonnegative().nullable().optional(),
    end_char: z.number().int().nonnegative().nullable().optional(),
    heading_path: z.array(z.string()).default([]),
    region: ArtifactBoundingBox.nullable().optional(),
    timestamp_start: z.number().nonnegative().nullable().optional(),
    timestamp_end: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();

export const DocumentArtifactItem = z
  .object({
    id: z.string().nullable().optional(),
    kind: DocumentBlockType.default("block"),
    text: z.string().nullable().optional(),
    locator: StructuralLocator,
    parent_id: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    page: z.number().int().positive().nullable().optional(),
    headers: z.array(z.string()).optional(),
    rows: z.array(z.array(z.string())).optional(),
    caption: z.string().nullable().optional(),
  })
  .passthrough();

export const DocumentArtifact = z
  .object({
    source_id: z.string().min(1),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: z.string().min(1),
    extractor: z.string().min(1),
    extractor_version: z.string().min(1),
    configuration: z.record(z.string(), z.unknown()).default({}),
    pages: z.array(DocumentArtifactItem).default([]),
    blocks: z.array(DocumentArtifactItem).default([]),
    headings: z.array(DocumentArtifactItem).default([]),
    paragraphs: z.array(DocumentArtifactItem).default([]),
    lists: z.array(DocumentArtifactItem).default([]),
    tables: z.array(DocumentArtifactItem).default([]),
    figures: z.array(DocumentArtifactItem).default([]),
    equations: z.array(DocumentArtifactItem).default([]),
    code: z.array(DocumentArtifactItem).default([]),
    bounding_boxes: z.array(ArtifactBoundingBox).default([]),
    reading_order: z.array(z.string()).default([]),
    locators: z.array(StructuralLocator).default([]),
    warnings: z.array(z.string()).default([]),
    quality: z.string().default("UNREVIEWED"),
    quality_metrics: z
      .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
      .default({}),
  })
  .superRefine((artifact, context) => {
    const items = [
      ...artifact.pages,
      ...artifact.blocks,
      ...artifact.headings,
      ...artifact.paragraphs,
      ...artifact.lists,
      ...artifact.tables,
      ...artifact.figures,
      ...artifact.equations,
      ...artifact.code,
    ];
    for (const item of items) {
      if (
        item.locator.source_hash &&
        item.locator.source_hash !== artifact.source_hash
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `locator source_hash mismatch for ${item.kind}`,
        });
      }
    }
    for (const locator of artifact.locators) {
      if (locator.source_hash && locator.source_hash !== artifact.source_hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "artifact locator source_hash mismatch",
        });
      }
    }
    const knownIds = new Set(
      items
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string"),
    );
    for (const id of artifact.reading_order) {
      if (!knownIds.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `reading_order references unknown item id: ${id}`,
        });
      }
    }
  });
export type DocumentArtifact = z.infer<typeof DocumentArtifact>;

export * from "./federated-graph.js";
