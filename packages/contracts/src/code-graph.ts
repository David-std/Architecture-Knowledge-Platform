import { z } from "zod";

export const CodeEvidenceTier = z.enum([
  "NO_SIGNAL",
  "AI_CANDIDATE",
  "STATICALLY_LINKED",
  "RUNTIME_COVERED",
  "DYNAMICALLY_PROVEN",
]);
export type CodeEvidenceTier = z.infer<typeof CodeEvidenceTier>;

export const CodeGraphNodeKind = z.enum([
  "REPOSITORY",
  "MODULE",
  "FILE",
  "CLASS",
  "INTERFACE",
  "FUNCTION",
  "METHOD",
  "TEST",
  "ROUTE",
  "CONFIG",
  "ADR_REF",
  "OTHER",
]);
export type CodeGraphNodeKind = z.infer<typeof CodeGraphNodeKind>;

export const CodeGraphRelation = z.enum([
  "CONTAINS",
  "CALLS",
  "IMPORTS",
  "INHERITS",
  "IMPLEMENTS",
  "REFERENCES",
  "TESTS",
  "ROUTES_TO",
  "RATIONALE_REF",
]);
export type CodeGraphRelation = z.infer<typeof CodeGraphRelation>;

export const CodeGraphEdgeDerivation = z.enum([
  "EXTRACTED",
  "STATICALLY_RESOLVED",
  "INFERRED",
  "AMBIGUOUS",
]);
export type CodeGraphEdgeDerivation = z.infer<typeof CodeGraphEdgeDerivation>;

export const CodeLocator = z
  .object({
    repository: z.string().min(1).max(2048),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
    path: z.string().min(1).max(4096),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    symbol: z.string().min(1).max(1024).optional(),
    qualifiedName: z.string().min(1).max(2048).optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      value.lineStart !== undefined &&
      value.lineEnd !== undefined &&
      value.lineEnd < value.lineStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "lineEnd must be greater than or equal to lineStart",
      });
    }
  });
export type CodeLocator = z.infer<typeof CodeLocator>;

export const CodeGraphNode = z.object({
  id: z.string().min(1).max(256),
  kind: CodeGraphNodeKind,
  name: z.string().min(1).max(1024),
  qualifiedName: z.string().min(1).max(2048).optional(),
  signature: z.string().min(1).max(4096).optional(),
  language: z.string().min(1).max(120).optional(),
  path: z.string().min(1).max(4096),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type CodeGraphNode = z.infer<typeof CodeGraphNode>;

export const CodeGraphEdge = z.object({
  id: z.string().min(1).max(256),
  sourceId: z.string().min(1).max(256),
  targetId: z.string().min(1).max(256),
  relation: CodeGraphRelation,
  derivation: CodeGraphEdgeDerivation,
  confidence: z.number().min(0).max(1).optional(),
  locator: CodeLocator.optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type CodeGraphEdge = z.infer<typeof CodeGraphEdge>;

export const CodeGraphWarning = z.object({
  code: z.string().min(1).max(160),
  message: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type CodeGraphWarning = z.infer<typeof CodeGraphWarning>;

export const CodeGraphArtifact = z.object({
  schemaVersion: z.literal(1),
  repository: z.string().min(1).max(2048),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  provider: z.string().min(1).max(160),
  providerVersion: z.string().min(1).max(160),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  languages: z.array(z.string().min(1).max(120)).max(128),
  nodes: z.array(CodeGraphNode),
  edges: z.array(CodeGraphEdge),
  warnings: z.array(CodeGraphWarning),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type CodeGraphArtifact = z.infer<typeof CodeGraphArtifact>;

export const CodeSnapshotFile = z.object({
  path: z.string().min(1).max(4096),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
export type CodeSnapshotFile = z.infer<typeof CodeSnapshotFile>;

export const CodeSnapshot = z.object({
  repository: z.string().min(1).max(2048),
  repositoryPath: z.string().min(1).max(4096),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  treeHash: z.string().regex(/^[a-f0-9]{40}$/i),
  files: z.array(CodeSnapshotFile).max(100000),
});
export type CodeSnapshot = z.infer<typeof CodeSnapshot>;

export const CodeGraphExclusionPolicy = z.object({
  patterns: z.array(z.string().min(1).max(1024)).max(512),
  maxFileBytes: z.number().int().positive().max(128 * 1024 * 1024),
});
export type CodeGraphExclusionPolicy = z.infer<typeof CodeGraphExclusionPolicy>;

export const CodeGraphOptions = z.object({
  exclusions: CodeGraphExclusionPolicy,
  timeoutMs: z.number().int().min(1000).max(60 * 60 * 1000),
  maxProcessOutputBytes: z.number().int().positive().max(128 * 1024 * 1024),
  maxGraphBytes: z.number().int().positive().max(512 * 1024 * 1024),
  providerConfiguration: z.record(z.string(), z.unknown()).default({}),
});
export type CodeGraphOptions = z.infer<typeof CodeGraphOptions>;

export const CodeGraphArtifactRef = z.object({
  repository: z.string().min(1).max(2048),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  provider: z.string().min(1).max(160),
  providerVersion: z.string().min(1).max(160),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CodeGraphArtifactRef = z.infer<typeof CodeGraphArtifactRef>;

export const CodeChangeSet = z.object({
  fromCommitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  toCommitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  added: z.array(z.string().min(1).max(4096)),
  modified: z.array(z.string().min(1).max(4096)),
  deleted: z.array(z.string().min(1).max(4096)),
  renamed: z
    .array(
      z.object({
        from: z.string().min(1).max(4096),
        to: z.string().min(1).max(4096),
      }),
    )
    .default([]),
});
export type CodeChangeSet = z.infer<typeof CodeChangeSet>;

export interface CodeGraphExtractionPort {
  analyze(
    snapshot: CodeSnapshot,
    options: CodeGraphOptions,
  ): Promise<CodeGraphArtifact>;

  update?(
    previous: CodeGraphArtifactRef,
    changes: CodeChangeSet,
    options: CodeGraphOptions,
  ): Promise<CodeGraphArtifact>;
}
