import type { SearchHit } from "@akp/contracts";
import type {
  QueryConditionedEvidenceVerifier,
  QueryConditionedEvidenceVerifierInput,
} from "./answerability.js";
import { contextualEvidenceSpanText } from "./contextual-evidence.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";
import {
  SourceVerificationError,
  sourceVerificationFailureCode,
  sourceSpanUsesCodePointBoundaries,
  validateSourceBoundVerification,
} from "./source-verification.js";
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
    span.endOffset <= passage.length &&
    sourceSpanUsesCodePointBoundaries(passage, span.startOffset, span.endOffset)
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
  return !/[?？؟][\p{Pe}\p{Pf}"'`*_]*\s*$/u.test(trimmed);
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

function isReaderInput(
  input: unknown,
): input is QueryConditionedEvidenceVerifierInput {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { passage?: unknown }).passage === "string"
  );
}

function isSpanlessContradiction(verification: unknown): boolean {
  return (
    typeof verification === "object" &&
    verification !== null &&
    !Array.isArray(verification) &&
    (verification as { decision?: unknown }).decision === "CONTRADICTS" &&
    !(verification as { evidenceSpan?: unknown }).evidenceSpan
  );
}

function semanticReaderFailureReason(
  error: unknown,
  verification: unknown,
): string {
  if (
    sourceVerificationFailureCode(error) ===
      "QUERY_CONDITIONED_EVIDENCE_SPAN_REQUIRED" &&
    isSpanlessContradiction(verification)
  ) {
    return "SEMANTIC_CONTRADICTION_WITHOUT_SOURCE_SPAN";
  }
  return `SEMANTIC_READER_ERROR:${sourceVerificationFailureCode(error)}`;
}

function verificationVerdict(
  passage: string,
  verification: unknown,
): { verdict: EvidenceVerdict; reason: string } {
  const verified = validateSourceBoundVerification(passage, verification);
  if (verified.decision === "INSUFFICIENT") {
    return { verdict: { kind: "INSUFFICIENT" }, reason: verified.reason };
  }
  return {
    verdict:
      verified.decision === "SUPPORTS"
        ? { kind: "ANSWERS", quote: verified.evidenceSpan! }
        : { kind: "CONTRADICTS", quote: verified.evidenceSpan! },
    reason: verified.reason,
  };
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
    if (!isReaderInput(input)) {
      return {
        layer: "SEMANTIC_READER",
        verdict: { kind: "INSUFFICIENT" },
        reason:
          "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_INPUT_INVALID",
        readerId: this.id,
      };
    }
    let verification: unknown;
    try {
      verification = await this.withTimeout(this.verifier.verify(input));
      const { verdict, reason } = verificationVerdict(
        input.passage,
        verification,
      );
      return {
        layer: "SEMANTIC_READER",
        verdict,
        reason,
        readerId: this.id,
      };
    } catch (error) {
      return {
        layer: "SEMANTIC_READER",
        verdict: { kind: "INSUFFICIENT" },
        reason: semanticReaderFailureReason(error, verification),
        readerId: this.id,
      };
    }
  }

  async readBatch(
    inputs: readonly QueryConditionedEvidenceVerifierInput[],
  ): Promise<EvidenceAdmissionDecision[]> {
    if (inputs.length === 0) return [];
    if (inputs.some((input) => !isReaderInput(input))) {
      return Promise.all(inputs.map((input) => this.read(input)));
    }
    if (!this.verifier.verifyBatch) {
      return Promise.all(inputs.map((input) => this.read(input)));
    }
    let rows: unknown;
    try {
      rows = await this.withTimeout(this.verifier.verifyBatch(inputs));
      if (!Array.isArray(rows) || rows.length !== inputs.length) {
        throw new SourceVerificationError(
          "QUERY_CONDITIONED_EVIDENCE_BATCH_SIZE_MISMATCH",
        );
      }
      return rows.map((verification, index) => {
        const input = inputs[index]!;
        try {
          const { verdict, reason } = verificationVerdict(
            input.passage,
            verification,
          );
          return {
            layer: "SEMANTIC_READER" as const,
            verdict,
            reason,
            readerId: this.id,
          };
        } catch (error) {
          return {
            layer: "SEMANTIC_READER" as const,
            verdict: { kind: "INSUFFICIENT" as const },
            reason: semanticReaderFailureReason(error, verification),
            readerId: this.id,
          };
        }
      });
    } catch (error) {
      const decision: EvidenceAdmissionDecision = {
        layer: "SEMANTIC_READER",
        verdict: { kind: "INSUFFICIENT" },
        reason: semanticReaderFailureReason(error, rows),
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
            () =>
              reject(new SourceVerificationError("SEMANTIC_READER_TIMEOUT")),
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
    const [decision] = await this.evaluateBatch([input]);
    return decision!;
  }

  /**
   * Batch form used by governed semantic experiments and future production
   * wiring. Structural/proposition decisions are resolved before any model
   * call. Only the remaining eligible candidates reach the semantic reader,
   * which allows an order-only shortlist to compare candidates without ever
   * becoming evidence authority.
   */
  async evaluateBatch(
    inputs: readonly LayeredEvidenceAdmissionInput[],
  ): Promise<EvidenceAdmissionDecision[]> {
    if (inputs.length === 0) return [];

    const output: Array<EvidenceAdmissionDecision | undefined> = new Array(
      inputs.length,
    );
    const semanticIndexes: number[] = [];
    const semanticInputs: QueryConditionedEvidenceVerifierInput[] = [];

    inputs.forEach((input, index) => {
      const eligible = this.guard.candidateEligible(input.hit, input.query);
      if (!eligible.accepted) {
        output[index] = {
          layer: "STRUCTURAL_GUARD",
          verdict: eligible.verdict,
          reason: eligible.reason,
        };
        return;
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
          output[index] = {
            layer: "STRUCTURED_PROPOSITION",
            verdict: constrained.verdict,
            reason: constrained.reason,
          };
          return;
        }
      }

      semanticIndexes.push(index);
      semanticInputs.push({
        query: input.query,
        candidateKey: `${input.hit.documentId}:${input.hit.unitId ?? "document"}`,
        title: input.hit.title,
        ...(input.hit.headingPath
          ? { headingPath: input.hit.headingPath }
          : {}),
        passage: input.hit.excerpt,
        unitType: input.hit.unitType ?? null,
        parentUnitType: input.hit.parentUnitType ?? null,
        documentType: input.hit.type,
      });
    });

    if (semanticInputs.length > 0) {
      let semanticDecisions: EvidenceAdmissionDecision[];
      try {
        semanticDecisions = this.semanticReader.readBatch
          ? await this.semanticReader.readBatch(semanticInputs)
          : await Promise.all(
              semanticInputs.map((input) => this.semanticReader.read(input)),
            );
      } catch {
        semanticDecisions = semanticInputs.map(() => ({
          layer: "SEMANTIC_READER",
          verdict: { kind: "INSUFFICIENT" },
          reason: "SEMANTIC_READER_BATCH_FAILURE",
          readerId: this.semanticReader.id,
        }));
      }
      if (semanticDecisions.length !== semanticInputs.length) {
        semanticDecisions = semanticInputs.map(() => ({
          layer: "SEMANTIC_READER",
          verdict: { kind: "INSUFFICIENT" },
          reason: "SEMANTIC_READER_BATCH_SIZE_MISMATCH",
          readerId: this.semanticReader.id,
        }));
      }

      semanticIndexes.forEach((inputIndex, semanticIndex) => {
        const input = inputs[inputIndex]!;
        const semantic = semanticDecisions[semanticIndex]!;
        const constrained = this.guard.constrainVerdict(
          input.hit,
          input.query,
          semantic.verdict,
        );
        output[inputIndex] = {
          ...semantic,
          verdict: constrained.verdict,
          reason:
            constrained.reason === "STRUCTURAL_SOURCE_SPAN_VALID" ||
            constrained.reason === "STRUCTURAL_NO_SOURCE_SPAN_REQUIRED"
              ? semantic.reason
              : constrained.reason,
        };
      });
    }

    return output.map(
      (decision) =>
        decision ?? {
          layer: "STRUCTURAL_GUARD",
          verdict: { kind: "INSUFFICIENT" },
          reason: "EVIDENCE_ADMISSION_INTERNAL_GAP",
        },
    );
  }
}
