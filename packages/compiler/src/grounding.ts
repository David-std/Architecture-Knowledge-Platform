import type { TrustTier } from "@akp/contracts";
import {
  EffectiveReviewPolicy,
  KnowledgeCompilerInput,
  KnowledgeCompilerResult,
  ReviewCompilationContext,
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
  reviewContext?: ReturnType<typeof ReviewCompilationContext.parse>;
};

// Vault infrastructure that is never a knowledge document. No proposal of any
// origin may target these roots.
const RESERVED_VAULT_ROOTS = ["README.md", "docs", ".obsidian"];

// The curated source/evidence layer. Runtime-derived provenance drafts legitimately
// live here, but a model-chosen path must never land in it: generated prose sitting
// where curated evidence lives could later be cited as its own grounding.
const SOURCE_LAYER_ROOTS = ["10-sources"];

function knowledgePathSegments(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean);
}

export function assertSafeKnowledgePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  const segments = knowledgePathSegments(normalized);
  if (
    !normalized.trim() ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0") ||
    /^[a-z]:\//i.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..") ||
    RESERVED_VAULT_ROOTS.includes(segments[0] ?? "")
  ) {
    throw new Error(`Unsafe knowledge path: ${path}`);
  }
}

/**
 * Stricter boundary for paths a compiler (model) chose. It adds the source layer to
 * the denylist so generated material can never be written where curated evidence
 * lives. Runtime-derived paths use `assertSafeKnowledgePath` instead, because they
 * come from a fixed template rather than model output.
 */
export function assertCompilerAuthoredKnowledgePath(path: string): void {
  assertSafeKnowledgePath(path);
  const segments = knowledgePathSegments(path);
  if (SOURCE_LAYER_ROOTS.includes(segments[0] ?? "")) {
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
  assertCompilerAuthoredKnowledgePath(root);
  const path = `${root}/${input.kind}/${slug(input.title)}.md`;
  assertCompilerAuthoredKnowledgePath(path);
  return path;
}

function portableArtifactToken(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 128);
  return normalized || "knowledge";
}

function isV03CompatibilityProfile(
  profile: KnowledgeCompilerInputType["knowledgeProfile"],
): boolean {
  return (
    profile.profile.profileId === "default" &&
    profile.profile.version === "0.3-compat"
  );
}

export function deriveProfileKnowledgePath(input: {
  title: string;
  kind: KnowledgeKind;
  candidateId: string;
  knowledgeProfile: KnowledgeCompilerInputType["knowledgeProfile"];
  schemaProfile?: Record<string, unknown>;
}): string {
  if (isV03CompatibilityProfile(input.knowledgeProfile)) {
    return deriveKnowledgePath({
      title: input.title,
      kind: input.kind,
      ...(input.schemaProfile ? { schemaProfile: input.schemaProfile } : {}),
    });
  }
  const kind = input.knowledgeProfile.profile.knowledgeKinds[input.kind];
  if (!kind) {
    throw new Error(`COMPILER_PROFILE_KIND_NOT_DECLARED:${input.kind}`);
  }
  const contract =
    input.knowledgeProfile.profile.artifactContracts[kind.artifactContract];
  if (!contract) {
    throw new Error(
      `COMPILER_ARTIFACT_CONTRACT_NOT_FOUND:${kind.artifactContract}`,
    );
  }
  const root = contract.root.replaceAll("\\", "/").replaceAll(/\/+$/g, "");
  assertCompilerAuthoredKnowledgePath(root);
  const tokens: Record<string, string> = {
    kind: portableArtifactToken(input.kind),
    candidateId: portableArtifactToken(input.candidateId),
    slug: slug(input.title),
  };
  let rendered = contract.pathTemplate.replaceAll("\\", "/");
  for (const token of rendered.matchAll(/\{([^}]+)\}/g)) {
    const tokenName = token[1] ?? "";
    if (!Object.hasOwn(tokens, tokenName)) {
      throw new Error(
        `COMPILER_ARTIFACT_TEMPLATE_TOKEN_UNSUPPORTED:${tokenName}`,
      );
    }
  }
  for (const [name, value] of Object.entries(tokens)) {
    rendered = rendered.replaceAll(`{${name}}`, value);
  }
  if (/[{}]/.test(rendered)) {
    throw new Error("COMPILER_ARTIFACT_TEMPLATE_INVALID");
  }
  const withoutExtension = `${root}/${rendered}`.replaceAll(/\/{2,}/g, "/");
  const path = withoutExtension.endsWith(contract.extension)
    ? withoutExtension
    : `${withoutExtension}${contract.extension}`;
  assertCompilerAuthoredKnowledgePath(path);
  return path;
}

const TRUST_ORDER: Record<TrustTier, number> = {
  UNVERIFIED: 0,
  MACHINE_SUPPORTED: 1,
  HUMAN_REVIEWED: 2,
  ATTESTED: 3,
};

function effectiveEvidenceTrust(
  input: KnowledgeCompilerInputType,
  evidence: CompilerEvidence,
): TrustTier {
  if (evidence.trust) return evidence.trust;
  return isV03CompatibilityProfile(input.knowledgeProfile)
    ? "MACHINE_SUPPORTED"
    : "UNVERIFIED";
}

export function effectiveReviewPolicyForKinds(
  knowledgeProfile: KnowledgeCompilerInputType["knowledgeProfile"],
  kinds: readonly string[],
): ReturnType<typeof EffectiveReviewPolicy.parse> {
  const uniqueKinds = [...new Set(kinds)];
  const policyDefinitions = uniqueKinds.map((kindName) => {
    const kind = knowledgeProfile.profile.knowledgeKinds[kindName];
    if (!kind) {
      throw new Error(`COMPILER_PROFILE_KIND_NOT_DECLARED:${kindName}`);
    }
    const policy = knowledgeProfile.profile.reviewPolicies[kind.reviewPolicy];
    if (!policy) {
      throw new Error(`COMPILER_REVIEW_POLICY_NOT_FOUND:${kind.reviewPolicy}`);
    }
    return policy;
  });
  const minimumApprovals = Math.max(
    1,
    ...policyDefinitions.map((policy) => policy.minimumApprovals),
  );
  const allowedRoles = policyDefinitions.length
    ? policyDefinitions
        .slice(1)
        .reduce(
          (roles, policy) =>
            roles.filter((role) => policy.allowedRoles.includes(role)),
          [...policyDefinitions[0]!.allowedRoles],
        )
        .sort()
    : ["ADMIN", "ARCHITECT", "REVIEWER"];
  if (!allowedRoles.length) {
    throw new Error("COMPILER_REVIEW_POLICY_ROLE_CONFLICT");
  }
  return EffectiveReviewPolicy.parse({
    required: true,
    minimumApprovals,
    allowedRoles,
    profileSource: knowledgeProfile.source,
    profileRevisionId: knowledgeProfile.revisionId,
    profileHash: knowledgeProfile.profileHash,
    profileId: knowledgeProfile.profile.profileId,
    profileVersion: knowledgeProfile.profile.version,
  });
}

export function effectiveReviewKinds(
  result: KnowledgeCompilerResultType,
): string[] {
  const materialCandidateIds = new Set(
    result.proposedFileChanges.map((change) => change.candidateId),
  );
  return [
    ...new Set(
      result.knowledgeCandidates
        .filter((candidate) =>
          materialCandidateIds.size
            ? materialCandidateIds.has(candidate.candidateId)
            : candidate.proposedAction !== "NO_MATERIAL",
        )
        .map((candidate) => candidate.kind),
    ),
  ];
}

function effectiveReviewPolicy(
  input: KnowledgeCompilerInputType,
  result: KnowledgeCompilerResultType,
) {
  return effectiveReviewPolicyForKinds(
    input.knowledgeProfile,
    effectiveReviewKinds(result),
  );
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
  const existingById = new Map(
    input.existingCandidates.map((entry) => [entry.documentId, entry]),
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
  if (
    result.identity.classification === "SAME_IDENTITY" &&
    !result.identity.existingDocumentId
  ) {
    throw new Error("COMPILER_SAME_IDENTITY_DOCUMENT_REQUIRED");
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
    const kindDefinition =
      input.knowledgeProfile.profile.knowledgeKinds[candidate.kind];
    if (!kindDefinition) {
      throw new Error(`COMPILER_PROFILE_KIND_NOT_DECLARED:${candidate.kind}`);
    }
    const evidencePolicy =
      input.knowledgeProfile.profile.evidencePolicies[
        kindDefinition.evidencePolicy
      ];
    if (!evidencePolicy) {
      throw new Error(
        `COMPILER_EVIDENCE_POLICY_NOT_FOUND:${kindDefinition.evidencePolicy}`,
      );
    }
    const uniqueEvidenceIds = [...new Set(candidate.evidenceIds)];
    if (
      uniqueEvidenceIds.length < Math.max(1, evidencePolicy.minimumEvidence)
    ) {
      throw new Error(
        `COMPILER_EVIDENCE_POLICY_MINIMUM_NOT_MET:${candidate.candidateId}`,
      );
    }
    for (const evidenceId of uniqueEvidenceIds) {
      const evidence = evidenceById.get(evidenceId)!;
      if (
        evidencePolicy.requireSourceLocator &&
        (!evidence.locator.path?.trim() ||
          !evidence.locator.source_hash?.trim())
      ) {
        throw new Error(
          `COMPILER_EVIDENCE_POLICY_LOCATOR_REQUIRED:${candidate.candidateId}:${evidenceId}`,
        );
      }
      if (
        TRUST_ORDER[effectiveEvidenceTrust(input, evidence)] <
        TRUST_ORDER[evidencePolicy.minimumTrust]
      ) {
        throw new Error(
          `COMPILER_EVIDENCE_POLICY_TRUST_NOT_MET:${candidate.candidateId}:${evidenceId}`,
        );
      }
    }
    if (
      candidate.existingDocumentId &&
      !allowedDocumentIds.has(candidate.existingDocumentId)
    ) {
      throw new Error(
        `COMPILER_KNOWLEDGE_CANDIDATE_UNKNOWN_DOCUMENT:${candidate.existingDocumentId}`,
      );
    }
    if (
      candidate.proposedAction === "NO_MATERIAL" &&
      result.proposedFileChanges.length > 0
    ) {
      throw new Error("COMPILER_NO_MATERIAL_HAS_FILE_CHANGES");
    }
    if (
      candidate.proposedAction === "CREATE" &&
      ["SAME_IDENTITY", "LIKELY_DUPLICATE"].includes(
        result.identity.classification,
      )
    ) {
      throw new Error("COMPILER_IDENTITY_FORBIDS_CREATE");
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
    assertCompilerAuthoredKnowledgePath(change.path);
    assertEvidenceReferences(
      `COMPILER_FILE_CHANGE:${change.path}`,
      change.evidenceIds,
      allowedEvidenceIds,
    );
    const candidate = result.knowledgeCandidates.find(
      (entry) => entry.candidateId === change.candidateId,
    );
    if (!candidate) throw new Error("COMPILER_CHANGE_UNKNOWN_CANDIDATE");
    if (!change.evidenceIds.every((id) => candidate.evidenceIds.includes(id))) {
      throw new Error("COMPILER_CHANGE_EVIDENCE_MISMATCH");
    }
    if (change.operation === "CREATE") {
      if (candidate.proposedAction !== "CREATE") {
        throw new Error("COMPILER_CREATE_ACTION_MISMATCH");
      }
      if (!change.content.includes(candidate.statement)) {
        throw new Error("COMPILER_FILE_CONTENT_MISSING_STATEMENT");
      }
      const expectedPath = deriveProfileKnowledgePath({
        title: candidate.statement,
        kind: candidate.kind,
        candidateId: candidate.candidateId,
        knowledgeProfile: input.knowledgeProfile,
        schemaProfile: input.schemaProfile,
      });
      if (change.path !== expectedPath) {
        throw new Error("COMPILER_CREATE_PATH_NOT_RUNTIME_DERIVED");
      }
    } else {
      const existing = candidate?.existingDocumentId
        ? existingById.get(candidate.existingDocumentId)
        : undefined;
      if (!existing) throw new Error("COMPILER_CHANGE_DOCUMENT_REQUIRED");
      if (change.path !== existing.path.replace(/^managed\//, "")) {
        throw new Error("COMPILER_CHANGE_PATH_NOT_AUTHORIZED");
      }
    }
  }

  if (
    result.proposedFileChanges.length > 0 &&
    !result.probes.some((probe) => probe.criticality === "CRITICAL")
  ) {
    throw new Error("COMPILER_CRITICAL_PROBE_REQUIRED");
  }
  if (
    result.contradictions.length > 0 &&
    result.knowledgeCandidates.some(
      (candidate) => candidate.proposedAction !== "DISPUTE",
    )
  ) {
    throw new Error("COMPILER_CONTRADICTION_REQUIRES_DISPUTE");
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
  const reviewContext = ReviewCompilationContext.parse({
    identity: result.identity,
    evidence: input.evidence.map((entry) => ({
      id: entry.id,
      sourceArtifactId: entry.sourceArtifactId,
      locator: entry.locator,
      excerptHash: entry.excerptHash,
    })),
    evidenceCandidates: result.evidenceCandidates,
    existingCandidates: input.existingCandidates.map((entry) => ({
      documentId: entry.documentId,
      externalId: entry.externalId,
      path: entry.path,
      title: entry.title,
      type: entry.type,
      lifecycle: entry.lifecycle,
      trust: entry.trust,
      revision: entry.revision,
      ...(entry.score === undefined ? {} : { score: entry.score }),
      reasons: entry.reasons,
    })),
    knowledgeCandidates: result.knowledgeCandidates,
    reviewKinds: effectiveReviewKinds(result),
    contradictions: result.contradictions,
    reviewPolicy: effectiveReviewPolicy(input, result),
    warnings: result.warnings,
    summary: result.summary,
  });

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
    reviewContext,
  };
}
