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

export const SearchRequest = z.object({
  query: z.string().min(1),
  organizationId: z.string().uuid().optional(),
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid().optional(),
  vaultIds: z.array(z.string().uuid()).max(20).default([]),
  federated: z.boolean().default(false),
  projectId: z.string().uuid().optional(),
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

export const SearchHit = z.object({
  documentId: z.string().uuid(),
  vaultId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  unitType: z.string().optional(),
  parentUnitId: z.string().uuid().optional(),
  parentContext: z.string().optional(),
  revision: z.string(),
  title: z.string(),
  type: z.string(),
  trust: TrustTier,
  lifecycle: Lifecycle,
  score: z.number(),
  reasons: z.array(z.string()),
  excerpt: z.string(),
  citations: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;

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
  title: z.string(),
  content: z.string(),
  documentId: z.string().uuid(),
  vaultId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  parentUnitId: z.string().uuid().optional(),
  unitType: z.string().optional(),
  retrievalChannels: z.array(z.string()).optional(),
  documentRevision: z.string(),
  score: z.number().optional(),
  selectionReason: z.string(),
  sourceOrEvidenceIds: z.array(z.string()),
});

export const ContextPacket = z.object({
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
  budget: z.object({
    maxTokens: z.number().int().positive(),
    usedTokens: z.number().int().nonnegative(),
  }),
  mode: SearchRequest.shape.mode,
  sections: z.array(ContextSection),
  citations: z.array(z.string()),
  gaps: z.array(z.string()),
  conflicts: z.array(z.string()),
  requiredActions: z.array(z.string()),
  continuations: z.array(
    z.object({
      handle: z.string(),
      reason: z.string(),
      remainingTokens: z.number().int().nonnegative(),
    }),
  ),
  packetHash: z.string(),
});
export type ContextPacket = z.infer<typeof ContextPacket>;

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
  "ContextPackInvalidationRequested",
  "ImpactedEvalRunRequested",
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
