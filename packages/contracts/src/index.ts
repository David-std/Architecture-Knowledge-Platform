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
  z.object({ kind: z.literal("markdown"), path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), contentHash: z.string() }),
  z.object({ kind: z.literal("pdf"), page: z.number().int().positive(), figure: z.string().optional(), table: z.string().optional() }),
  z.object({ kind: z.literal("media"), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), speaker: z.string().optional() }),
  z.object({ kind: z.literal("image"), region: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
  z.object({ kind: z.literal("spreadsheet"), sheet: z.string(), range: z.string(), formulaCell: z.string().optional() }),
  z.object({ kind: z.literal("code"), repository: z.string(), commit: z.string(), path: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
  z.object({ kind: z.literal("web"), url: z.string().url(), snapshotHash: z.string(), section: z.string().optional() })
]);
export type EvidenceLocator = z.infer<typeof EvidenceLocator>;

export const SearchRequest = z.object({
  query: z.string().min(1),
  organizationId: z.string().uuid().optional(),
  spaceId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  types: z.array(z.string()).default([]),
  minimumTrust: TrustTier.default("MACHINE_SUPPORTED"),
  mode: z.enum(["COMPILED_ONLY", "SOURCE_BACKED", "RAW_ONLY", "PROJECT_CODE", "DRAFT_INCLUDED"]).default("SOURCE_BACKED"),
  limit: z.number().int().min(1).max(100).default(20)
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const SearchHit = z.object({
  documentId: z.string().uuid(),
  revision: z.string(),
  title: z.string(),
  type: z.string(),
  trust: TrustTier,
  lifecycle: Lifecycle,
  score: z.number(),
  reasons: z.array(z.string()),
  excerpt: z.string(),
  citations: z.array(z.string())
});
export type SearchHit = z.infer<typeof SearchHit>;

export const ContextSection = z.object({
  kind: z.enum(["rule", "workflow", "concept", "profile", "example", "evidence", "source"]),
  title: z.string(),
  content: z.string(),
  documentId: z.string().uuid().optional(),
  revision: z.string().optional(),
  score: z.number().optional(),
  reason: z.string()
});

export const ContextPacket = z.object({
  packetId: z.string().uuid(),
  query: z.string(),
  intent: z.string(),
  corpusRevision: z.string(),
  generatedAt: z.string().datetime(),
  budget: z.object({ maxTokens: z.number().int().positive(), usedTokens: z.number().int().nonnegative() }),
  mode: SearchRequest.shape.mode,
  sections: z.array(ContextSection),
  citations: z.array(z.string()),
  gaps: z.array(z.string()),
  conflicts: z.array(z.string()),
  requiredActions: z.array(z.string()),
  packetHash: z.string()
});
export type ContextPacket = z.infer<typeof ContextPacket>;

export const IngestRequest = z.object({
  spaceId: z.string().uuid(),
  sourceUri: z.string(),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  title: z.string().optional(),
  mediaType: z.string().optional(),
  policy: z.enum(["REVIEW_REQUIRED", "ALLOW_LOW_RISK_AUTO_APPROVAL"]).default("REVIEW_REQUIRED")
});
export type IngestRequest = z.infer<typeof IngestRequest>;
