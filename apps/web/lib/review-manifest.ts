export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is JsonRecord =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

export function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export interface NormalizedReviewManifest {
  reviewContext: JsonRecord;
  identity: JsonRecord;
  evidence: JsonRecord[];
  existingCandidates: JsonRecord[];
  candidates: JsonRecord[];
  contradictions: JsonRecord[];
  proposedChanges: JsonRecord[];
  probes: JsonRecord[];
  evidenceIds: string[];
  impactedIds: string[];
  warnings: string[];
}

export function normalizeReviewManifest(
  impactValue: unknown,
  validationValue: unknown,
): NormalizedReviewManifest {
  const impact = asRecord(impactValue);
  const validation = asRecord(validationValue);
  const reviewContext = asRecord(impact.reviewContext ?? impact.review_context);
  const evidence = asRecords(reviewContext.evidence ?? impact.evidence);
  const evidenceIds = [
    ...new Set([
      ...evidence
        .map((entry) => entry.id)
        .filter((entry): entry is string => typeof entry === "string"),
      ...asStrings(impact.evidenceIds ?? impact.evidence_ids),
    ]),
  ];

  return {
    reviewContext,
    identity: asRecord(reviewContext.identity ?? impact.identity),
    evidence,
    existingCandidates: asRecords(
      reviewContext.existingCandidates ?? reviewContext.existing_candidates,
    ),
    candidates: asRecords(
      reviewContext.knowledgeCandidates ??
        reviewContext.knowledge_candidates ??
        impact.knowledgeCandidates ??
        impact.knowledge_candidates ??
        impact.candidates,
    ),
    contradictions: asRecords(
      reviewContext.contradictions ?? impact.contradictions ?? impact.conflicts,
    ),
    proposedChanges: asRecords(
      impact.proposedChanges ?? impact.proposed_changes,
    ),
    probes: asRecords(validation.probeResults ?? impact.probes),
    evidenceIds,
    impactedIds: asStrings(
      impact.impactedDocumentIds ?? impact.impacted_document_ids,
    ),
    warnings: asStrings(reviewContext.warnings ?? impact.warnings),
  };
}
