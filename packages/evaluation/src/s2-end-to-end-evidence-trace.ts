import { createHash } from "node:crypto";
import type { AuthenticatedSearchBridgeResult } from "./s2-authenticated-http-writer-bridge.js";
import type { S2RawHttpEvidenceResult } from "./s2-http-evidence-replay.js";
import {
  traceS2SemanticPipeline,
  type S2SemanticPipelineTrace,
  type S2SemanticPipelineTraceInput,
} from "./s2-semantic-pipeline-trace.js";

/**
 * A provenance-chain DIAGNOSTIC connecting observed authenticated HTTP
 * retrieval to exact provider request and the semantic stages. It does not
 * authenticate a reported Bearer token, assert gold or change release gates.
 */
export interface S2EndToEndTraceInput extends S2SemanticPipelineTraceInput {
  readonly language: "en" | "es";
  readonly http: AuthenticatedSearchBridgeResult | null;
  /** Optional strict replay of HTTP excerpt offsets against original bytes. */
  readonly httpOriginalReplay: S2RawHttpEvidenceResult | null;
  /** Optional result from the single governed R5 per-Writer-claim adapter. */
  readonly governedWriterClaims?: {
    readonly status: string;
    readonly testedClaims: number;
    readonly totalClaims: number;
    readonly sourceCitations: readonly {
      readonly citationId: string;
      readonly originalSourceSha256: string;
    }[];
    readonly productionAdmission: false;
    readonly releaseGateAccepted: false;
  };
}
export interface S2EndToEndEvidenceTrace {
  readonly status:
    | "HTTP_CAPTURE_MISSING"
    | "HTTP_SCOPE_OR_RETRIEVAL_WITHHELD"
    | "HTTP_WRITER_SOURCE_UNBOUND"
    | "HTTP_ORIGINAL_REPLAY_REJECTED"
    | "HTTP_QUESTION_IDENTITY_MISMATCH"
    | "PROVIDER_REQUEST_MISMATCH"
    | "WRITER_REFERENCES_NONADMITTED_SOURCE"
    | "GOVERNED_WRITER_CLAIMS_WITHHELD"
    | "SEMANTIC_DOWNSTREAM_UNPROVEN"
    | "SEMANTIC_DOWNSTREAM_SHADOW_CANDIDATE";
  readonly firstUnprovenStage:
    | "AUTHORIZATION"
    | "RETRIEVAL"
    | "EVIDENCE_SELECTION"
    | "WRITER"
    | "PROJECTION"
    | "SOURCE"
    | "QUESTION"
    | "CLAIM"
    | "CITATIONS"
    | "COMPLETE_ANSWER"
    | null;
  readonly httpRetrievalOutcome: string | null;
  readonly selectedSourceCount: number;
  readonly optionalHttpOriginalQuoteReplay:
    "NOT_CAPTURED" | "REPLAY_VERIFIED" | "REJECTED";
  readonly writerRequestSourceBound: boolean;
  readonly optionalGovernedClaimStatus: string | null;
  readonly downstream: S2SemanticPipelineTrace | null;
  readonly authorizationIndependentlyVerified: false;
  readonly goldIndependentlyReviewed: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
export function traceS2EndToEndEvidence(
  input: S2EndToEndTraceInput,
): S2EndToEndEvidenceTrace {
  const http = input.http;
  const replay = input.httpOriginalReplay;
  const optionalHttpOriginalQuoteReplay = replay?.status ?? "NOT_CAPTURED";
  const provider = http?.bridge.exactProviderRequest;
  const writerRequestSourceBound =
    provider !== null &&
    provider !== undefined &&
    provider.freeze.sourcePassages.length > 0 &&
    provider.freeze.sourcePassages.every(
      (p) => p.source === "ORIGINAL_LITERAL_MATCH",
    );
  const make = (
    status: S2EndToEndEvidenceTrace["status"],
    firstUnprovenStage: S2EndToEndEvidenceTrace["firstUnprovenStage"],
    downstream: S2SemanticPipelineTrace | null = null,
  ): S2EndToEndEvidenceTrace => ({
    status,
    firstUnprovenStage,
    httpRetrievalOutcome: http?.returnedRetrievalOutcome ?? null,
    selectedSourceCount: http?.selectedSourceCount ?? 0,
    optionalHttpOriginalQuoteReplay,
    writerRequestSourceBound,
    optionalGovernedClaimStatus: input.governedWriterClaims?.status ?? null,
    downstream,
    authorizationIndependentlyVerified: false,
    goldIndependentlyReviewed: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (!http) return make("HTTP_CAPTURE_MISSING", "AUTHORIZATION");
  if (
    http.status !== "HTTP_ADMITTED_WRITER_READY" ||
    http.returnedRetrievalOutcome !== "SUPPORTED" ||
    http.bridge.status !== "RETRIEVAL_BOUND_WRITER_READY" ||
    http.admittedHitCount < 1 ||
    http.selectedSourceCount < 1
  )
    return make("HTTP_SCOPE_OR_RETRIEVAL_WITHHELD", "RETRIEVAL");
  if (
    !writerRequestSourceBound ||
    !provider ||
    provider.freeze.sourcePassages.length !== http.selectedSourceCount ||
    provider.freeze.sourcePassages.length !==
      http.bridge.selectedEvidence.length ||
    provider.freeze.sourcePassages.some(
      (passage, i) =>
        passage.id !== http.bridge.selectedEvidence[i]?.passageId ||
        passage.original?.fileSha256 !==
          http.bridge.selectedEvidence[i]?.sourceSha256 ||
        passage.original?.startUtf16 !==
          http.bridge.selectedEvidence[i]?.bodyStartUtf16 ||
        passage.original?.endUtf16 !==
          http.bridge.selectedEvidence[i]?.bodyEndUtf16,
    )
  )
    return make("HTTP_WRITER_SOURCE_UNBOUND", "EVIDENCE_SELECTION");
  // A verified independent literal replay is optional when the bridge has
  // independently bound its request to original bytes; a *failed* attempted
  // replay is nevertheless a hard diagnostic stop, never positive evidence.
  if (replay !== null && replay.status !== "REPLAY_VERIFIED")
    return make("HTTP_ORIGINAL_REPLAY_REJECTED", "EVIDENCE_SELECTION");
  if (
    !input.originalQuestion.trim() ||
    provider.freeze.caseKeySha256 !==
      createHash("sha256")
        .update(input.language + "\0" + input.originalQuestion)
        .digest("hex")
  )
    return make("HTTP_QUESTION_IDENTITY_MISMATCH", "WRITER");
  if (
    !input.writer ||
    input.writer.requestSha256 !== provider.freeze.exactRequestSha256
  )
    return make("PROVIDER_REQUEST_MISMATCH", "WRITER");
  if (
    input.writer.citations.some(
      (id) => !provider.freeze.sourcePassages.some((p) => p.id === id),
    )
  )
    return make("WRITER_REFERENCES_NONADMITTED_SOURCE", "SOURCE");
  // An observed per-claim custody failure must never be repaired by F3
  // or whole-answer model agreement. Positive results remain shadow-only.
  if (
    input.governedWriterClaims !== undefined &&
    (input.governedWriterClaims.status !== "SOURCE_BOUND_CLAIMS_CANDIDATE" ||
      !Number.isSafeInteger(input.governedWriterClaims.testedClaims) ||
      input.governedWriterClaims.testedClaims < 1 ||
      input.governedWriterClaims.testedClaims !==
        input.governedWriterClaims.totalClaims ||
      !Array.isArray(input.governedWriterClaims.sourceCitations) ||
      input.governedWriterClaims.sourceCitations.length !==
        input.governedWriterClaims.totalClaims ||
      input.governedWriterClaims.sourceCitations.some(
        (ref) =>
          !ref ||
          !input.writer!.citations.includes(ref.citationId) ||
          !provider.freeze.sourcePassages.some(
            (passage) =>
              passage.id === ref.citationId &&
              passage.original?.fileSha256 === ref.originalSourceSha256,
          ),
      ) ||
      input.writer.citations.some(
        (id) =>
          !input.governedWriterClaims!.sourceCitations.some(
            (ref) => ref.citationId === id,
          ),
      ) ||
      input.governedWriterClaims.productionAdmission !== false ||
      input.governedWriterClaims.releaseGateAccepted !== false)
  )
    return make("GOVERNED_WRITER_CLAIMS_WITHHELD", "CLAIM");
  const downstream = traceS2SemanticPipeline(input);
  if (downstream.status !== "SHADOW_CANDIDATE_NOT_RELEASE")
    return make(
      "SEMANTIC_DOWNSTREAM_UNPROVEN",
      downstream.firstUnprovenStage,
      downstream,
    );
  return make("SEMANTIC_DOWNSTREAM_SHADOW_CANDIDATE", null, downstream);
}
