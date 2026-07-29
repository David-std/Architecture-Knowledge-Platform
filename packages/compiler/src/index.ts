import { z } from "zod";

export const Disposition = z.enum(["NEW", "UPDATE", "DISPUTED", "NO_MATERIAL"]);

export const ProposedFileChange = z.object({
  path: z.string().min(1),
  operation: z.enum(["CREATE", "UPDATE", "SUPERSEDE", "ARCHIVE"]),
  baseContentHash: z.string().optional(),
  content: z.string(),
  reasons: z.array(z.string()).min(1),
  evidenceIds: z.array(z.string()).default([]),
});

export const CompilationPlan = z.object({
  sourceId: z.string().uuid(),
  corpusRevision: z.string().min(1),
  disposition: Disposition,
  summary: z.string(),
  proposedChanges: z.array(ProposedFileChange),
  impactedDocumentIds: z.array(z.string()),
  conflicts: z.array(z.object({
    existingDocumentId: z.string(),
    explanation: z.string(),
    proposedStatus: z.enum(["DISPUTED", "SUPERSEDED", "UNCHANGED"])
  })),
  probes: z.array(z.object({
    question: z.string(),
    criticality: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    evidenceIds: z.array(z.string()).min(1)
  }))
});
export type CompilationPlan = z.infer<typeof CompilationPlan>;

export function assertSafeKnowledgePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe knowledge path: ${path}`);
  }
}
