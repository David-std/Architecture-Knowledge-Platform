import type { SearchHit } from "@akp/contracts";
import type {
  QueryConditionedEvidenceVerification,
  QueryConditionedEvidenceVerifier,
  QueryConditionedEvidenceVerifierInput,
} from "./answerability.js";
import { contextualEvidenceSpanText } from "./contextual-evidence.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";
import {
  dateYearEvidenceMatches,
  explicitYearBindingsMatch,
  explicitYearValues,
  quantitativeEvidenceMatches,
  verifyDeterministicPassageSupport,
} from "./support-verifier.js";

export interface ExactSourceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

export type EvidenceVerdict =
  | {
      readonly kind: "ANSWERS";
      readonly quote: ExactSourceSpan;
      readonly normalizedAnswer?: string;
    }
  | { readonly kind: "CONTRADICTS"; readonly quote: ExactSourceSpan }
  | { readonly kind: "RELATED_NOT_ANSWERING" }
  | { readonly kind: "INSUFFICIENT" };

export type EvidenceAdmissionLayer =
  "STRUCTURAL_GUARD" | "STRUCTURED_PROPOSITION" | "SEMANTIC_READER";

export interface EvidenceAdmissionDecision {
  readonly layer: EvidenceAdmissionLayer;
  readonly verdict: EvidenceVerdict;
  readonly reason: string;
  readonly readerId?: string;
}

export interface StructuredProposition {
  readonly subject: string;
  readonly predicate: string;
  readonly object?: string;
  readonly polarity?: "POSITIVE" | "NEGATIVE";
  readonly quote: ExactSourceSpan;
}

export interface StructuredPropositionQuery {
  readonly subject: string;
  readonly predicate: string;
  readonly object?: string;
  readonly polarity?: "POSITIVE" | "NEGATIVE";
}

export interface StructuredPropositionMatcherInput {
  readonly query: StructuredPropositionQuery;
  readonly candidate: StructuredProposition;
}

export interface StructuredPropositionMatcher {
  match(input: StructuredPropositionMatcherInput): EvidenceVerdict;
}

function normalizedProjectionValue(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("und");
}

/**
 * Matches only explicit proposition projections.
 *
 * There is intentionally no synonym, stemming or query-regex layer here. If
 * ingestion/query planning did not produce a proposition projection, this
 * matcher must abstain rather than reconstruct semantics from raw prose.
 */
export class ExactStructuredPropositionMatcher implements StructuredPropositionMatcher {
  match(input: StructuredPropositionMatcherInput): EvidenceVerdict {
    const querySubject = normalizedProjectionValue(input.query.subject);
    const queryPredicate = normalizedProjectionValue(input.query.predicate);
    const candidateSubject = normalizedProjectionValue(input.candidate.subject);
    const candidatePredicate = normalizedProjectionValue(
      input.candidate.predicate,
    );
    if (
      !querySubject ||
      !queryPredicate ||
      !candidateSubject ||
      !candidatePredicate
    ) {
      return { kind: "INSUFFICIENT" };
    }
    if (
      querySubject !== candidateSubject ||
      queryPredicate !== candidatePredicate
    ) {
      return { kind: "INSUFFICIENT" };
    }

    const queryObject = input.query.object
      ? normalizedProjectionValue(input.query.object)
      : null;
    const candidateObject = input.candidate.object
      ? normalizedProjectionValue(input.candidate.object)
      : null;
    if (queryObject !== null && queryObject !== candidateObject) {
      return { kind: "RELATED_NOT_ANSWERING" };
    }

    const queryPolarity = input.query.polarity ?? "POSITIVE";
    const candidatePolarity = input.candidate.polarity ?? "POSITIVE";
    if (queryPolarity !== candidatePolarity) {
      return { kind: "CONTRADICTS", quote: input.candidate.quote };
    }
    return { kind: "ANSWERS", quote: input.candidate.quote };
  }
}

export interface StructuralEvidenceGuardResult {
  readonly accepted: boolean;
  readonly verdict: EvidenceVerdict;
  readonly reason: string;
}

function identifierLikeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (
    !trimmed ||
    /\s/u.test(trimmed) ||
    !/^[\p{L}\p{N}_.:/-]+$/u.test(trimmed)
  ) {
    return false;
  }
  return (
    /\d/u.test(trimmed) ||
    /[_:/.]/u.test(trimmed) ||
    (trimmed.includes("-") && trimmed === trimmed.toLocaleUpperCase("en-US"))
  );
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function exactIdentifierMatchesHit(hit: SearchHit, query: string): boolean {
  if (!identifierLikeQuery(query)) return true;
  const needle = normalizedIdentity(query);
  const path = normalizedIdentity(hit.document.path);
  const pathLeaf = path.split("/").at(-1) ?? path;
  const pathStem = pathLeaf.replace(/\.[^.]+$/u, "");
  return [
    hit.document.externalId,
    hit.title,
    hit.document.title,
    ...(hit.document.aliases ?? []),
    path,
    pathLeaf,
    pathStem,
  ]
    .filter((value): value is string => typeof value === "string")
    .map(normalizedIdentity)
    .includes(needle);
}

function validSpan(passage: string, span: ExactSourceSpan): boolean {
  return (
    Number.isSafeInteger(span.startOffset) &&
    Number.isSafeInteger(span.endOffset) &&
    span.startOffset >= 0 &&
    span.endOffset > span.startOffset &&
    span.endOffset <= passage.length
  );
}

function spanTouchesHiddenSource(
  passage: string,
  span: ExactSourceSpan,
): boolean {
  return markdownVisibleSource(passage).comments.some(
    (comment) =>
      comment.startOffset < span.endOffset &&
      comment.endOffset > span.startOffset,
  );
}

function assertionLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return !/[?？؟][\p{Pe}\p{Pf}"'\`*_]*\s*$/u.test(trimmed);
}

function hardStructuralFactsSatisfied(
  hit: SearchHit,
  query: string,
  span: ExactSourceSpan,
): boolean {
  const evidence = contextualEvidenceSpanText(hit.excerpt, span);
  if (!evidence.valueText.trim() || !evidence.scopedText.trim()) return false;
  if (!explicitYearBindingsMatch(evidence.scopedText, query)) return false;

  // The legacy helper is used only to identify explicit numeric/date question
  // requirements. Its semantic support decision is deliberately ignored.
  const structuralRequirements = verifyDeterministicPassageSupport(
    { ...hit, excerpt: evidence.scopedText },
    query,
  ).requiredAnswerCues;

  if (
    structuralRequirements.includes("QUANTITY") &&
    !quantitativeEvidenceMatches(evidence.valueText, query, evidence.scopedText)
  ) {
    return false;
  }
  if (
    structuralRequirements.includes("DATE_YEAR") &&
    !dateYearEvidenceMatches(evidence.valueText, query)
  ) {
    return false;
  }

  const requestedYears = explicitYearValues(query);
  if (requestedYears.length > 0) {
    const availableYears = new Set(explicitYearValues(evidence.scopedText));
    if (requestedYears.some((year) => !availableYears.has(year))) return false;
  }
  return true;
}

/**
 * Structural boundary for evidence admission.
 *
 * It owns lifecycle/truth sanity, exact identifier identity, visible-source
 * span integrity and explicit numeric/date/table scope. It never infers
 * semantic support from relevance or token overlap.
 */
export class StructuralEvidenceGuard {
  candidateEligible(
    hit: SearchHit,
    query: string,
  ): StructuralEvidenceGuardResult {
    if (hit.lifecycle !== "ACTIVE") {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_LIFECYCLE_NOT_ACTIVE",
      };
    }
    if (hit.retrievalTrace?.truth.state === "DISPUTED") {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_TRUTH_DISPUTED",
      };
    }
    if (!exactIdentifierMatchesHit(hit, query)) {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_EXACT_IDENTIFIER_MISMATCH",
      };
    }
    return {
      accepted: true,
      verdict: { kind: "INSUFFICIENT" },
      reason: "STRUCTURAL_CANDIDATE_ELIGIBLE",
    };
  }

  constrainVerdict(
    hit: SearchHit,
    query: string,
    verdict: EvidenceVerdict,
  ): StructuralEvidenceGuardResult {
    const eligibility = this.candidateEligible(hit, query);
    if (!eligibility.accepted) return eligibility;
    if (verdict.kind !== "ANSWERS" && verdict.kind !== "CONTRADICTS") {
      return {
        accepted: true,
        verdict,
        reason: "STRUCTURAL_NO_SOURCE_SPAN_REQUIRED",
      };
    }

    if (!validSpan(hit.excerpt, verdict.quote)) {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_SOURCE_SPAN_INVALID",
      };
    }
    if (spanTouchesHiddenSource(hit.excerpt, verdict.quote)) {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_HIDDEN_SOURCE_SPAN",
      };
    }
    const evidence = contextualEvidenceSpanText(hit.excerpt, verdict.quote);
    if (!assertionLike(evidence.valueText)) {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_NON_ASSERTION_SPAN",
      };
    }
    if (!hardStructuralFactsSatisfied(hit, query, verdict.quote)) {
      return {
        accepted: false,
        verdict: { kind: "INSUFFICIENT" },
        reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
      };
    }
    return {
      accepted: true,
      verdict,
      reason: "STRUCTURAL_SOURCE_SPAN_VALID",
    };
  }
}

export interface SemanticEvidenceReader {
  readonly id: string;
  read(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<EvidenceAdmissionDecision>;
  readBatch?(
    inputs: readonly QueryConditionedEvidenceVerifierInput[],
  ): Promise<EvidenceAdmissionDecision[]>;
}

export interface QueryConditionedSemanticEvidenceReaderOptions {
  readonly verifier: QueryConditionedEvidenceVerifier;
  readonly timeoutMs?: number;
}

function timeoutMs(value: number | undefined): number {
  const resolved = value ?? 5_000;
  if (!Number.isSafeInteger(resolved) || resolved < 10 || resolved > 60_000) {
    throw new Error("semantic evidence timeoutMs must be in [10,60000]");
  }
  return resolved;
}

function verificationVerdict(
  verification: QueryConditionedEvidenceVerification,
): EvidenceVerdict {
  if (verification.decision === "INSUFFICIENT") {
    return { kind: "INSUFFICIENT" };
  }
  if (!verification.evidenceSpan) {
    return { kind: "INSUFFICIENT" };
  }
  return verification.decision === "SUPPORTS"
    ? { kind: "ANSWERS", quote: verification.evidenceSpan }
    : { kind: "CONTRADICTS", quote: verification.evidenceSpan };
}

/**
 * Adapter from current source-bound verifiers to the R5 evidence contract.
 *
 * Timeout, provider error, malformed output and CONTRADICTS without an exact
 * span all fail closed to INSUFFICIENT.
 */
export class QueryConditionedSemanticEvidenceReader implements SemanticEvidenceReader {
  readonly id: string;
  private readonly verifier: QueryConditionedEvidenceVerifier;
  private readonly maxWaitMs: number;

  constructor(options: QueryConditionedSemanticEvidenceReaderOptions) {
    this.verifier = options.verifier;
    this.maxWaitMs = timeoutMs(options.timeoutMs);
    this.id = `semantic-reader:${options.verifier.id}`;
  }

  async read(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<EvidenceAdmissionDecision> {
    try {
      const verification = await this.withTimeout(this.verifier.verify(input));
      const verdict = verificationVerdict(verification);
      return {
        layer: "SEMANTIC_READER",
        verdict,
        reason:
          verdict.kind === "INSUFFICIENT" &&
          verification.decision === "CONTRADICTS" &&
          !verification.evidenceSpan
            ? "SEMANTIC_CONTRADICTION_WITHOUT_SOURCE_SPAN"
            : verification.reason,
        readerId: this.id,
      };
    } catch (error) {
      return {
        layer: "SEMANTIC_READER",
        verdict: { kind: "INSUFFICIENT" },
        reason:
          error instanceof Error
            ? `SEMANTIC_READER_ERROR:${error.message}`
            : "SEMANTIC_READER_ERROR",
        readerId: this.id,
      };
    }
  }

  async readBatch(
    inputs: readonly QueryConditionedEvidenceVerifierInput[],
  ): Promise<EvidenceAdmissionDecision[]> {
    if (inputs.length === 0) return [];
    if (!this.verifier.verifyBatch) {
      return Promise.all(inputs.map((input) => this.read(input)));
    }
    try {
      const rows = await this.withTimeout(this.verifier.verifyBatch(inputs));
      if (rows.length !== inputs.length) {
        throw new Error("SEMANTIC_READER_BATCH_SIZE_MISMATCH");
      }
      return rows.map((verification) => {
        const verdict = verificationVerdict(verification);
        return {
          layer: "SEMANTIC_READER" as const,
          verdict,
          reason:
            verdict.kind === "INSUFFICIENT" &&
            verification.decision === "CONTRADICTS" &&
            !verification.evidenceSpan
              ? "SEMANTIC_CONTRADICTION_WITHOUT_SOURCE_SPAN"
              : verification.reason,
          readerId: this.id,
        };
      });
    } catch (error) {
      const decision: EvidenceAdmissionDecision = {
        layer: "SEMANTIC_READER",
        verdict: { kind: "INSUFFICIENT" },
        reason:
          error instanceof Error
            ? `SEMANTIC_READER_ERROR:${error.message}`
            : "SEMANTIC_READER_ERROR",
        readerId: this.id,
      };
      return inputs.map(() => decision);
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("SEMANTIC_READER_TIMEOUT")),
            this.maxWaitMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface LayeredEvidenceAdmissionInput {
  readonly query: string;
  readonly hit: SearchHit;
  readonly queryProposition?: StructuredPropositionQuery;
  readonly candidateProposition?: StructuredProposition;
}

/**
 * R5 shadow pipeline. It is not wired into production admission yet.
 *
 * Explicit structured propositions take precedence. Otherwise the semantic
 * reader may propose a verdict, but the structural guard remains the final
 * authority over source-bound admissibility.
 */
export class LayeredEvidenceAdmissionPipeline {
  private readonly guard: StructuralEvidenceGuard;
  private readonly propositionMatcher: StructuredPropositionMatcher;
  private readonly semanticReader: SemanticEvidenceReader;

  constructor(options: {
    semanticReader: SemanticEvidenceReader;
    guard?: StructuralEvidenceGuard;
    propositionMatcher?: StructuredPropositionMatcher;
  }) {
    this.semanticReader = options.semanticReader;
    this.guard = options.guard ?? new StructuralEvidenceGuard();
    this.propositionMatcher =
      options.propositionMatcher ?? new ExactStructuredPropositionMatcher();
  }

  async evaluate(
    input: LayeredEvidenceAdmissionInput,
  ): Promise<EvidenceAdmissionDecision> {
    const eligible = this.guard.candidateEligible(input.hit, input.query);
    if (!eligible.accepted) {
      return {
        layer: "STRUCTURAL_GUARD",
        verdict: eligible.verdict,
        reason: eligible.reason,
      };
    }

    if (input.queryProposition && input.candidateProposition) {
      const structured = this.propositionMatcher.match({
        query: input.queryProposition,
        candidate: input.candidateProposition,
      });
      if (structured.kind !== "INSUFFICIENT") {
        const constrained = this.guard.constrainVerdict(
          input.hit,
          input.query,
          structured,
        );
        return {
          layer: "STRUCTURED_PROPOSITION",
          verdict: constrained.verdict,
          reason: constrained.reason,
        };
      }
    }

    const semantic = await this.semanticReader.read({
      query: input.query,
      candidateKey: `${input.hit.documentId}:${input.hit.unitId ?? "document"}`,
      title: input.hit.title,
      ...(input.hit.headingPath ? { headingPath: input.hit.headingPath } : {}),
      passage: input.hit.excerpt,
      unitType: input.hit.unitType ?? null,
      parentUnitType: input.hit.parentUnitType ?? null,
      documentType: input.hit.type,
    });
    const constrained = this.guard.constrainVerdict(
      input.hit,
      input.query,
      semantic.verdict,
    );
    return {
      ...semantic,
      verdict: constrained.verdict,
      reason:
        constrained.reason === "STRUCTURAL_SOURCE_SPAN_VALID" ||
        constrained.reason === "STRUCTURAL_NO_SOURCE_SPAN_REQUIRED"
          ? semantic.reason
          : constrained.reason,
    };
  }
}
