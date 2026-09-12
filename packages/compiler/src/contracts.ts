import { z } from "zod";
import {
  DocumentArtifact as DocumentArtifactSchema,
  Lifecycle,
  StructuralLocator,
  TrustTier,
} from "@akp/contracts";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const BoundedText = z.string().min(1).max(60_000);

export const KnowledgeKind = z.enum([
  "claim",
  "decision",
  "rule",
  "workflow",
  "concept",
  "example",
  "counterexample",
  "artifact",
]);
export type KnowledgeKind = z.infer<typeof KnowledgeKind>;

export const CompilerEvidence = z
  .object({
    id: z.string().uuid(),
    sourceArtifactId: z.string().uuid(),
    locator: StructuralLocator,
    excerpt: z.string().min(1).max(12_000),
    excerptHash: Sha256,
  })
  .strict();
export type CompilerEvidence = z.infer<typeof CompilerEvidence>;

export const ExistingKnowledgeCandidate = z
  .object({
    documentId: z.string().uuid(),
    externalId: z.string().nullable().default(null),
    path: z.string().min(1).max(1_024),
    title: z.string().min(1).max(500),
    type: z.string().min(1).max(120),
    lifecycle: Lifecycle,
    trust: TrustTier,
    revision: z.string().min(1).max(200),
    contentExcerpt: z.string().max(12_000),
    score: z.number().nonnegative().optional(),
    reasons: z.array(z.string().min(1).max(500)).max(20).default([]),
  })
  .strict();
export type ExistingKnowledgeCandidate = z.infer<
  typeof ExistingKnowledgeCandidate
>;

export const CompilerBudget = z
  .object({
    maxInputCharacters: z
      .number()
      .int()
      .min(4_000)
      .max(200_000)
      .default(48_000),
    maxEvidence: z.number().int().min(1).max(50).default(20),
    maxExistingCandidates: z.number().int().min(0).max(50).default(20),
    maxProposedChanges: z.number().int().min(1).max(20).default(8),
    maxProbes: z.number().int().min(1).max(20).default(8),
  })
  .strict();
export type CompilerBudget = z.infer<typeof CompilerBudget>;

export const CompilerPolicy = z
  .object({
    reviewRequired: z.literal(true).default(true),
    allowDirectPublication: z.literal(false).default(false),
    allowedKnowledgeKinds: z
      .array(KnowledgeKind)
      .min(1)
      .default([
        "claim",
        "decision",
        "rule",
        "workflow",
        "concept",
        "example",
        "counterexample",
        "artifact",
      ]),
  })
  .strict();
export type CompilerPolicy = z.infer<typeof CompilerPolicy>;

export const KnowledgeCompilerInput = z
  .object({
    source: z
      .object({
        sourceId: z.string().uuid(),
        sourceArtifactId: z.string().uuid(),
        sha256: Sha256,
        title: z.string().min(1).max(500),
        mediaType: z.string().min(1).max(200),
      })
      .strict(),
    documentArtifact: DocumentArtifactSchema,
    evidence: z.array(CompilerEvidence).max(50),
    existingCandidates: z.array(ExistingKnowledgeCandidate).max(50),
    schemaProfile: z.record(z.string(), z.unknown()).default({}),
    policy: CompilerPolicy.default({}),
    budget: CompilerBudget.default({}),
    corpusRevision: z.string().min(1).max(200),
    spaceId: z.string().uuid(),
    vaultId: z.string().uuid(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.documentArtifact.source_id !== input.source.sourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentArtifact", "source_id"],
        message: "document artifact source identity does not match compiler source",
      });
    }
    if (input.documentArtifact.source_hash !== input.source.sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentArtifact", "source_hash"],
        message: "document artifact hash does not match compiler source",
      });
    }
    if (input.evidence.length > input.budget.maxEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "compiler evidence exceeds configured budget",
      });
    }
    if (input.existingCandidates.length > input.budget.maxExistingCandidates) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["existingCandidates"],
        message: "existing knowledge candidates exceed configured budget",
      });
    }
    for (const evidence of input.evidence) {
      if (evidence.sourceArtifactId !== input.source.sourceArtifactId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence"],
          message: "evidence belongs to a different source artifact",
        });
        break;
      }
    }
  });
export type KnowledgeCompilerInput = z.infer<typeof KnowledgeCompilerInput>;

export const IdentityClassification = z.enum([
  "SAME_IDENTITY",
  "LIKELY_DUPLICATE",
  "DISTINCT",
  "UNRESOLVED",
]);
export type IdentityClassification = z.infer<typeof IdentityClassification>;

export const IdentityAssessment = z
  .object({
    classification: IdentityClassification,
    existingDocumentId: z.string().uuid().optional(),
    reason: z.string().min(1).max(4_000),
  })
  .strict();
export type IdentityAssessment = z.infer<typeof IdentityAssessment>;

export const EvidenceCandidate = z
  .object({
    evidenceId: z.string().uuid(),
    sourceArtifactId: z.string().uuid(),
    locator: StructuralLocator,
    excerptHash: Sha256,
  })
  .strict();
export type EvidenceCandidate = z.infer<typeof EvidenceCandidate>;

export const ProposedKnowledgeAction = z.enum([
  "CREATE",
  "UPDATE",
  "DISPUTE",
  "NO_MATERIAL",
]);
export type ProposedKnowledgeAction = z.infer<typeof ProposedKnowledgeAction>;

export const KnowledgeCandidate = z
  .object({
    candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    kind: KnowledgeKind,
    statement: BoundedText,
    scope: z.string().min(1).max(2_000),
    evidenceIds: z.array(z.string().uuid()).min(1).max(20),
    confidence: z.number().min(0).max(1),
    existingDocumentId: z.string().uuid().optional(),
    proposedAction: ProposedKnowledgeAction,
  })
  .strict();
export type KnowledgeCandidate = z.infer<typeof KnowledgeCandidate>;

export const KnowledgeContradiction = z
  .object({
    candidateId: z.string().min(1).max(128),
    existingDocumentId: z.string().uuid(),
    explanation: z.string().min(1).max(8_000),
    severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    evidenceIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict();
export type KnowledgeContradiction = z.infer<typeof KnowledgeContradiction>;

export const ProposedKnowledgeFileChange = z
  .object({
    path: z.string().min(1).max(1_024),
    operation: z.enum(["CREATE", "UPDATE", "SUPERSEDE", "ARCHIVE"]),
    baseContentHash: Sha256.optional(),
    content: BoundedText,
    reasons: z.array(z.string().min(1).max(2_000)).min(1).max(20),
    evidenceIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict();
export type ProposedKnowledgeFileChange = z.infer<
  typeof ProposedKnowledgeFileChange
>;

export const CompilerProbe = z
  .object({
    question: z.string().min(1).max(4_000),
    criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    evidenceIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict();
export type CompilerProbe = z.infer<typeof CompilerProbe>;

export const KnowledgeCompilerResult = z
  .object({
    identity: IdentityAssessment,
    evidenceCandidates: z.array(EvidenceCandidate).max(50),
    knowledgeCandidates: z.array(KnowledgeCandidate).max(50),
    contradictions: z.array(KnowledgeContradiction).max(50),
    proposedFileChanges: z.array(ProposedKnowledgeFileChange).max(20),
    impactedDocumentIds: z.array(z.string().uuid()).max(50),
    probes: z.array(CompilerProbe).max(20),
    warnings: z.array(z.string().min(1).max(2_000)).max(50),
    summary: z.string().min(1).max(8_000),
  })
  .strict();
export type KnowledgeCompilerResult = z.infer<typeof KnowledgeCompilerResult>;

export interface KnowledgeCompilerPort {
  compile(input: KnowledgeCompilerInput): Promise<KnowledgeCompilerResult>;
}
