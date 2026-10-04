import type {
  SearchHit,
  TemporalFactView,
  TruthSupportSet,
} from "@akp/contracts";
import type { StructuredProposition } from "./evidence-admission.js";
import { sourceSpanUsesCodePointBoundaries } from "./source-verification.js";

export interface GovernedPropositionEvidence {
  readonly id: string;
  readonly spaceId: string;
  readonly vaultId: string;
  readonly sourceId: string;
  readonly artifactId?: string | null;
  readonly locator: unknown;
  readonly contentHash: string;
  readonly excerpt: string;
}

export interface PropositionEvidenceReference
  extends GovernedPropositionEvidence {}

export interface TemporalFactPropositionProjection {
  readonly sourceFactId: string;
  readonly spaceId: string;
  readonly vaultId: string;
  readonly kind: "CLAIM";
  readonly subjectRefs: readonly [string];
  readonly predicate: string;
  readonly objectRefs: readonly [string];
  readonly polarity: "POSITIVE";
  readonly conditions: readonly [];
  readonly quantities: readonly [];
  readonly temporalScope: {
    readonly validFrom: string;
    readonly validTo: string | null;
  };
  readonly evidenceRefs: readonly PropositionEvidenceReference[];
  readonly derivation: "TEMPORAL_TRUTH";
  readonly revision: string;
  readonly truthRevisionSeq: number;
  readonly supportSetId: string;
  readonly authorizationPath: string;
  readonly scopeId: string;
}

export interface TemporalFactPropositionProjectionInput {
  readonly fact: TemporalFactView;
  readonly supportSet: TruthSupportSet;
  readonly evidence: readonly GovernedPropositionEvidence[];
}

export interface ResolvedCandidateProposition {
  readonly evidenceId: string;
  readonly proposition: StructuredProposition;
}

function canonicalJsonValue(
  value: unknown,
  seen: WeakSet<object>,
): string | null {
  if (value === null) return "null";
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return null;
  }

  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => canonicalJsonValue(item, seen));
      if (items.some((item) => item === null)) return null;
      return `[${items.join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    const fields: string[] = [];
    for (const key of keys) {
      const projected = canonicalJsonValue(record[key], seen);
      if (projected === null) return null;
      fields.push(`${JSON.stringify(key)}:${JSON.stringify(projected)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Canonicalizes a temporal fact object without interpreting field names.
 *
 * Primitive values retain their textual identity. Arrays and records are
 * serialized with stable key ordering, and unsupported/non-JSON values fail
 * closed.
 */
export function canonicalTemporalFactObject(value: unknown): string | null {
  return canonicalJsonValue(value, new WeakSet<object>());
}

function evidenceReferenceValid(
  evidence: GovernedPropositionEvidence,
  fact: TemporalFactView,
): boolean {
  return (
    evidence.spaceId === fact.spaceId &&
    evidence.vaultId === fact.vaultId &&
    Boolean(evidence.id.trim()) &&
    Boolean(evidence.sourceId.trim()) &&
    /^[a-f0-9]{64}$/iu.test(evidence.contentHash) &&
    Boolean(evidence.excerpt.trim()) &&
    evidence.locator !== null &&
    typeof evidence.locator === "object"
  );
}

/**
 * Projects only already-governed temporal truth into a structured proposition.
 *
 * This function performs no semantic extraction from prose. It refuses facts
 * that are not current/supported, support sets without explicit evidence, and
 * incomplete or cross-scope evidence.
 */
export function projectSupportedTemporalFact(
  input: TemporalFactPropositionProjectionInput,
): TemporalFactPropositionProjection | null {
  const { fact, supportSet } = input;
  if (
    fact.lifecycle !== "ACTIVE" ||
    fact.supportState !== "SUPPORTED" ||
    fact.truthState !== "SUPPORTED_CURRENT" ||
    supportSet.state !== "SUPPORTED"
  ) {
    return null;
  }
  if (
    fact.supportSetId !== supportSet.id ||
    fact.spaceId !== supportSet.spaceId ||
    fact.vaultId !== supportSet.vaultId ||
    supportSet.evidenceIds.length === 0
  ) {
    return null;
  }

  const object = canonicalTemporalFactObject(fact.object);
  if (!object || !fact.subjectRef.trim() || !fact.predicate.trim()) return null;

  const requestedEvidenceIds = [...new Set(supportSet.evidenceIds)].sort();
  if (requestedEvidenceIds.length !== supportSet.evidenceIds.length) return null;

  const byId = new Map<string, GovernedPropositionEvidence>();
  for (const evidence of input.evidence) {
    if (byId.has(evidence.id)) return null;
    byId.set(evidence.id, evidence);
  }

  const evidenceRefs: GovernedPropositionEvidence[] = [];
  for (const evidenceId of requestedEvidenceIds) {
    const evidence = byId.get(evidenceId);
    if (!evidence || !evidenceReferenceValid(evidence, fact)) return null;
    evidenceRefs.push(evidence);
  }

  return {
    sourceFactId: fact.id,
    spaceId: fact.spaceId,
    vaultId: fact.vaultId,
    kind: "CLAIM",
    subjectRefs: [fact.subjectRef.trim()],
    predicate: fact.predicate.trim(),
    objectRefs: [object],
    polarity: "POSITIVE",
    conditions: [],
    quantities: [],
    temporalScope: {
      validFrom: fact.validFrom,
      validTo: fact.validTo,
    },
    evidenceRefs,
    derivation: "TEMPORAL_TRUTH",
    revision: fact.truthRevisionHash,
    truthRevisionSeq: fact.truthRevisionSeq,
    supportSetId: supportSet.id,
    authorizationPath: fact.authorizationPath,
    scopeId: fact.scopeId,
  };
}

function exactUniqueSpan(
  passage: string,
  excerpt: string,
): { startOffset: number; endOffset: number } | null {
  const startOffset = passage.indexOf(excerpt);
  if (startOffset < 0 || passage.lastIndexOf(excerpt) !== startOffset) return null;
  const endOffset = startOffset + excerpt.length;
  if (
    !sourceSpanUsesCodePointBoundaries(passage, startOffset, endOffset)
  ) {
    return null;
  }
  return { startOffset, endOffset };
}

/**
 * Resolves a governed projection to one concrete candidate passage.
 *
 * Evidence identity is supplied by the caller from an authorized persistence
 * join; SearchHit citations intentionally do not act as evidence-ID authority.
 * Text alone can never authorize a proposition. Ambiguous or absent excerpts
 * fail closed.
 */
export function resolveTemporalFactPropositionForCandidate(
  projection: TemporalFactPropositionProjection,
  hit: Pick<SearchHit, "vaultId" | "excerpt">,
  authorizedEvidenceIds: readonly string[],
): ResolvedCandidateProposition | null {
  if (hit.vaultId !== projection.vaultId) return null;
  const authorized = new Set(authorizedEvidenceIds.filter(Boolean));
  if (authorized.size === 0) return null;

  for (const evidence of projection.evidenceRefs) {
    if (!authorized.has(evidence.id)) continue;
    const quote = exactUniqueSpan(hit.excerpt, evidence.excerpt);
    if (!quote) continue;
    return {
      evidenceId: evidence.id,
      proposition: {
        subject: projection.subjectRefs[0],
        predicate: projection.predicate,
        object: projection.objectRefs[0],
        polarity: projection.polarity,
        quote,
      },
    };
  }
  return null;
}
