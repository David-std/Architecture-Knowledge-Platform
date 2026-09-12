import {
  KnowledgeCompilerInput,
  KnowledgeCompilerResult,
  type CompilerEvidence,
  type KnowledgeCompilerInput as KnowledgeCompilerInputType,
  type KnowledgeCompilerResult as KnowledgeCompilerResultType,
  type KnowledgeKind,
} from "./contracts.js";

export type LegacyCompilationPlan = {
  sourceId: string;
  corpusRevision: string;
  disposition: "NEW" | "UPDATE" | "DISPUTED" | "NO_MATERIAL";
  summary: string;
  proposedChanges: Array<{
    path: string;
    operation: "CREATE" | "UPDATE" | "SUPERSEDE" | "ARCHIVE";
    baseContentHash?: string;
    content: string;
    reasons: string[];
    evidenceIds: string[];
  }>;
  impactedDocumentIds: string[];
  conflicts: Array<{
    existingDocumentId: string;
    explanation: string;
    proposedStatus: "DISPUTED" | "SUPERSEDED" | "UNCHANGED";
  }>;
  probes: Array<{
    question: string;
    criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    evidenceIds: string[];
  }>;
};

export function assertSafeKnowledgePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized.trim() ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0") ||
    /^[a-z]:\//i.test(normalized)
  ) {
    throw new Error(`Unsafe knowledge path: ${path}`);
  }
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "knowledge";
}

export function deriveKnowledgePath(input: {
  title: string;
  kind: KnowledgeKind;
  schemaProfile?: Record<string, unknown>;
}): string {
  const configuredRoot = input.schemaProfile?.compiledRoot;
  const root =
    typeof configuredRoot === "string" && configuredRoot.trim()
      ? configuredRoot.replaceAll("\\", "/").replaceAll(/\/+$/g, "")
      : "20-knowledge/generated";
  assertSafeKnowledgePath(root);
  const path = `${root}/${input.kind}/${slug(input.title)}.md`;
  assertSafeKnowledgePath(path);
  return path;
}

function assertEvidenceReferences(
  label: string,
  references: string[],
  allowedEvidenceIds: Set<string>,
): void {
  for (const evidenceId of references) {
    if (!allowedEvidenceIds.has(evidenceId)) {
      throw new Error(`${label}:UNKNOWN_EVIDENCE:${evidenceId}`);
    }
  }
}

function locatorFingerprint(locator: CompilerEvidence["locator"]): string {
  return JSON.stringify(locator);
}

function evidenceForResultCandidate(
  inputEvidence: CompilerEvidence[],
  candidate: {
    sourceArtifactId: string;
    locator: CompilerEvidence["locator"];
    excerptHash: string;
  },
): CompilerEvidence | undefined {
  const candidateLocator = locatorFingerprint(candidate.locator);
  return inputEvidence.find(
    (evidence) =>
      evidence.sourceArtifactId === candidate.sourceArtifactId &&
      evidence.excerptHash === candidate.excerptHash &&
      locatorFingerprint(evidence.locator) === candidateLocator,
  );
}

function artifactSupportsPreciseLocators(
  input: KnowledgeCompilerInputType,
): boolean {
  return input.documentArtifact.locators.some(
    (locator) =>
      locator.kind !== "source" ||
      locator.page != null ||
      locator.slide != null ||
      locator.paragraph != null ||
      locator.table != null ||
      locator.start_line != null ||
      locator.start_char != null,
  );
}

export function normalizeKnowledgeCompilerResult(
  inputValue: KnowledgeCompilerInputType,
  resultValue: unknown,
): KnowledgeCompilerResultType {
  const input = KnowledgeCompilerInput.parse(inputValue);
  const result = KnowledgeCompilerResult.parse(resultValue);

  if (result.proposedFileChanges.length > input.budget.maxProposedChanges) {
    throw new Error("COMPILER_RESULT_CHANGE_BUDGET_EXCEEDED");
  }
  if (result.probes.length > input.budget.maxProbes) {
    throw new Error("COMPILER_RESULT_PROBE_BUDGET_EXCEEDED");
  }

  const evidenceById = new Map(
    input.evidence.map((entry) => [entry.id, entry]),
  );
  const allowedEvidenceIds = new Set(evidenceById.keys());
  const allowedDocumentIds = new Set(
    input.existingCandidates.map((entry) => entry.documentId),
  );
  const candidateIds = new Set(
    result.knowledgeCandidates.map((entry) => entry.candidateId),
  );

  for (const documentId of result.identity.candidates) {
    if (!allowedDocumentIds.has(documentId)) {
      throw new Error(`COMPILER_IDENTITY_UNKNOWN_CANDIDATE:${documentId}`);
    }
  }
  if (
    result.identity.existingDocumentId &&
    !allowedDocumentIds.has(result.identity.existingDocumentId)
  ) {
    throw new Error("COMPILER_IDENTITY_REFERENCES_UNKNOWN_DOCUMENT");
  }

  for (const candidate of result.evidenceCandidates) {
    if (!evidenceForResultCandidate(input.evidence, candidate)) {
      throw new Error("COMPILER_EVIDENCE_CANDIDATE_NOT_GROUNDED");
    }
  }

  const requiresPreciseLocator = artifactSupportsPreciseLocators(input);
  for (const candidate of result.knowledgeCandidates) {
    if (!input.policy.allowedKnowledgeKinds.includes(candidate.kind)) {
      throw new Error(`COMPILER_KIND_NOT_ALLOWED:${candidate.kind}`);
    }
    assertEvidenceReferences(
      `COMPILER_KNOWLEDGE_CANDIDATE:${candidate.candidateId}`,
      candidate.evidenceIds,
      allowedEvidenceIds,
    );
    if (
      candidate.existingDocumentId &&
      !allowedDocumentIds.has(candidate.existingDocumentId)
    ) {
      throw new Error(
        `COMPILER_KNOWLEDGE_CANDIDATE_UNKNOWN_DOCUMENT:${candidate.existingDocumentId}`,
      );
    }
    if (
      requiresPreciseLocator &&
      candidate.proposedAction !== "NO_MATERIAL" &&
      candidate.evidenceIds.every(
        (evidenceId) => evidenceById.get(evidenceId)?.locator.kind === "source",
      )
    ) {
      throw new Error(
        `COMPILER_PRECISE_LOCATOR_REQUIRED:${candidate.candidateId}`,
      );
    }
  }

  for (const contradiction of result.contradictions) {
    if (!candidateIds.has(contradiction.candidateId)) {
      throw new Error(
        `COMPILER_CONTRADICTION_UNKNOWN_CANDIDATE:${contradiction.candidateId}`,
      );
    }
    if (!allowedDocumentIds.has(contradiction.existingDocumentId)) {
      throw new Error(
        `COMPILER_CONTRADICTION_UNKNOWN_DOCUMENT:${contradiction.existingDocumentId}`,
      );
    }
    assertEvidenceReferences(
      `COMPILER_CONTRADICTION:${contradiction.candidateId}`,
      contradiction.evidenceIds,
      allowedEvidenceIds,
    );
  }

  for (const change of result.proposedFileChanges) {
    assertSafeKnowledgePath(change.path);
    assertEvidenceReferences(
      `COMPILER_FILE_CHANGE:${change.path}`,
      change.evidenceIds,
      allowedEvidenceIds,
    );
  }

  for (const documentId of result.impactedDocumentIds) {
    if (!allowedDocumentIds.has(documentId)) {
      throw new Error(`COMPILER_IMPACT_UNKNOWN_DOCUMENT:${documentId}`);
    }
  }

  for (const probe of result.probes) {
    assertEvidenceReferences(
      `COMPILER_PROBE:${probe.question}`,
      probe.evidenceIds,
      allowedEvidenceIds,
    );
  }

  return result;
}

export function resultToCompilationPlan(
  inputValue: KnowledgeCompilerInputType,
  resultValue: KnowledgeCompilerResultType,
): LegacyCompilationPlan {
  const input = KnowledgeCompilerInput.parse(inputValue);
  const result = normalizeKnowledgeCompilerResult(input, resultValue);
  const disposition: LegacyCompilationPlan["disposition"] =
    result.proposedFileChanges.length === 0
      ? "NO_MATERIAL"
      : result.contradictions.length > 0
        ? "DISPUTED"
        : result.proposedFileChanges.some(
              (change) => change.operation !== "CREATE",
            )
          ? "UPDATE"
          : "NEW";

  return {
    sourceId: input.source.sourceId,
    corpusRevision: input.corpusRevision,
    disposition,
    summary: result.summary,
    proposedChanges: result.proposedFileChanges.map((change) => ({
      path: change.path,
      operation: change.operation,
      ...(change.baseContentHash
        ? { baseContentHash: change.baseContentHash }
        : {}),
      content: change.content,
      reasons: change.reasons,
      evidenceIds: change.evidenceIds,
    })),
    impactedDocumentIds: [...new Set(result.impactedDocumentIds)],
    conflicts: result.contradictions.map((contradiction) => ({
      existingDocumentId: contradiction.existingDocumentId,
      explanation: contradiction.explanation,
      proposedStatus: "DISPUTED" as const,
    })),
    probes: result.probes.map((probe) => ({
      question: probe.question,
      criticality: probe.criticality,
      evidenceIds: probe.evidenceIds,
    })),
  };
}
