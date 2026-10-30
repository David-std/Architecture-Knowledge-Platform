import { createHash } from "node:crypto";
import {
  freezeS2FrozenReaderChoicePlan,
  assessS2FrozenReaderChoice,
  type S2FrozenReaderChoicePlan,
  type S2FrozenReaderChoiceResult,
  type S2FrozenReaderChoiceInput,
} from "./s2-frozen-reader-source-bridge.js";
import type { AuthenticatedSearchBridgeResult } from "./s2-authenticated-http-writer-bridge.js";
import type { FrozenRetrievedOriginal } from "./s2-retrieved-writer-bridge.js";
import type { S2SemanticEvidenceConfig } from "./s2-semantic-evidence.js";
import { replayS2RawHttpEvidence } from "./s2-http-evidence-replay.js";

/**
 * OFFLINE/EVALUATION-ONLY composer of two already validated boundaries:
 * Fastify HTTP-admitted originals -> original-source frozen reader tokens.
 * The authenticated HTTP bridge is the ONLY source of admission. This adapter
 * does not make an HTTP call, authenticate a bearer, or expand exploratoryHits.
 */
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export interface S2HttpFrozenReaderInput {
  readonly http: AuthenticatedSearchBridgeResult;
  readonly rawHttpRequestBytes: Uint8Array;
  readonly rawHttpResponseBytes: Uint8Array;
  readonly original: FrozenRetrievedOriginal;
  readonly passageId: string;
  readonly originalQuestion: string;
  readonly proposedClaim: string;
  /** Preselected UTF-16 literal quote from the HTTP-admitted passage. */
  readonly exactSourceQuote: string;
}

export interface S2HttpFrozenReaderPlan {
  readonly schemaVersion: "akp.s2.http-admitted-frozen-reader.v1";
  readonly httpRequestSha256: string;
  readonly httpResponseSha256: string;
  readonly passageId: string;
  readonly originalDocumentKeySha256: string;
  readonly selectedSourceRevisionSha256: string;
  readonly originalHttpQuoteReplay: "REPLAY_VERIFIED";
  readonly inlineCitationMarkers: "ALL_PRESENT" | "SOME_ABSENT";
  readonly selection: S2FrozenReaderChoicePlan;
  readonly admissionVerifiedByOfflineBridge: false;
  readonly semanticRelationIndependentlyVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

function prepared(input: S2HttpFrozenReaderInput): {
  plan: S2HttpFrozenReaderPlan;
  selected: S2FrozenReaderChoiceInput;
} {
  const http = input.http;
  const provider = http.bridge.exactProviderRequest?.freeze;
  if (
    http.status !== "HTTP_ADMITTED_WRITER_READY" ||
    http.returnedRetrievalOutcome !== "SUPPORTED" ||
    http.returnedStatus !== 200 ||
    http.gateAccepted !== false ||
    http.bridge.status !== "RETRIEVAL_BOUND_WRITER_READY" ||
    http.bridge.gateAccepted !== false ||
    http.sourceSelection !== "ONLY_HTTP_RESPONSE_HITS_NOT_EXPLORATORY" ||
    !provider ||
    provider.sourcePassages.length === 0
  ) {
    throw Error("S2_HTTP_FROZEN_NO_ADMITTED_PROVENANCE");
  }
  // The complete original question and the HTTP-captured writer scope must
  // agree. The raw request digest was frozen by the existing HTTP bridge.
  if (
    !input.originalQuestion.trim() ||
    !["en", "es"].some(
      (language) =>
        sha(language + "\0" + input.originalQuestion) ===
        provider.caseKeySha256,
    )
  )
    throw Error("S2_HTTP_FROZEN_QUESTION_NOT_HTTP_BOUND");
  const original = input.original;
  const key =
    original.vaultId +
    "|" +
    original.documentId +
    "|" +
    original.path +
    "|" +
    original.revision;
  const documentKey = sha("document:" + key);
  const selectedEvidence = http.bridge.selectedEvidence.filter(
    (entry) => entry.passageId === input.passageId,
  );
  const sameProviderPassage = provider.sourcePassages.filter(
    (entry) => entry.id === input.passageId,
  );
  if (
    selectedEvidence.length !== 1 ||
    sameProviderPassage.length !== 1 ||
    http.admittedHitCount < 1 ||
    http.selectedSourceCount !== http.bridge.selectedEvidence.length ||
    provider.sourcePassages.length !== http.selectedSourceCount
  )
    throw Error("S2_HTTP_FROZEN_SELECTED_EVIDENCE_NOT_ADMITTED");
  const evidence = selectedEvidence[0]!;
  const providerPassage = sameProviderPassage[0]!;
  if (
    evidence.documentKeySha256 !== documentKey ||
    evidence.vaultKeySha256 !== sha(original.vaultId) ||
    evidence.pathSha256 !== sha(original.path) ||
    evidence.revisionSha256 !== sha(original.revision) ||
    evidence.sourceSha256 !== original.fileSha256 ||
    providerPassage.source !== "ORIGINAL_LITERAL_MATCH" ||
    providerPassage.original?.documentKeySha256 !== documentKey ||
    providerPassage.original.fileSha256 !== original.fileSha256 ||
    providerPassage.original.startUtf16 !== evidence.bodyStartUtf16 ||
    providerPassage.original.endUtf16 !== evidence.bodyEndUtf16
  )
    throw Error("S2_HTTP_FROZEN_SOURCE_REVISION_ORIGINAL_DRIFT");
  // Never infer offsets by trimming or translating. The source bytes and
  // original selection are owned by the existing retrieval-writer bridge.
  if (
    original.fileBytes.length === 0 ||
    original.fileBytes.length > 2_000_000 ||
    sha(original.fileBytes) !== original.fileSha256
  )
    throw Error("S2_HTTP_FROZEN_ORIGINAL_SHA_MISMATCH");
  const decoded = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(original.fileBytes);
  const selectedWindow = decoded.slice(
    evidence.bodyStartUtf16,
    evidence.bodyEndUtf16,
  );
  const literal = input.exactSourceQuote;
  if (
    !literal ||
    literal.trim() !== literal ||
    selectedWindow.indexOf(literal) < 0 ||
    selectedWindow.indexOf(literal) !== selectedWindow.lastIndexOf(literal) ||
    sha(selectedWindow) !== providerPassage.textSha256
  )
    throw Error("S2_HTTP_FROZEN_QUOTE_OUTSIDE_ADMITTED_PASSAGE");
  // Reuse the raw Fastify HTTP/SOURCE replay instead of merely accepting
  // an in-memory postprocessed bridge result. This also forbids selecting
  // text from elsewhere in a full-document frozen writer window when the
  // actual HTTP-admitted *excerpt* did not contain that quote.
  const quoteStart = decoded.indexOf(literal);
  const replay = replayS2RawHttpEvidence({
    rawRequestBytes: input.rawHttpRequestBytes,
    externallyPinnedRequestSha256: http.requestSha256,
    rawResponseBytes: input.rawHttpResponseBytes,
    externallyPinnedResponseSha256: http.responseSha256,
    httpStatus: http.returnedStatus,
    expectedVaultId: original.vaultId,
    originals: [
      {
        documentId: original.documentId,
        vaultId: original.vaultId,
        path: original.path,
        revision: original.revision,
        originalSha256: original.fileSha256,
        bytes: original.fileBytes,
        bodyStartUtf16: original.bodyStartUtf16,
        bodyEndUtf16: original.bodyEndUtf16,
      },
    ],
    quotes: [
      {
        hitIndex: evidence.hitRank,
        documentId: original.documentId,
        quote: literal,
        startUtf16: quoteStart,
        endUtf16: quoteStart + literal.length,
      },
    ],
  });
  if (
    replay.status !== "REPLAY_VERIFIED" ||
    (replay.inlineCitationMarkers !== "ALL_PRESENT" &&
      replay.inlineCitationMarkers !== "SOME_ABSENT")
  )
    throw Error("S2_HTTP_FROZEN_RAW_HTTP_OR_EXCERPT_REPLAY_FAILED");
  const selected: S2FrozenReaderChoiceInput = {
    originalQuestion: input.originalQuestion,
    proposedClaim: input.proposedClaim,
    exactSourceQuote: literal,
    authorizedOriginal: {
      assignedSourceId: documentKey,
      sourceSha256: original.fileSha256,
      exactUtf8Bytes: original.fileBytes,
      bodyStartUtf16: original.bodyStartUtf16,
      bodyEndUtf16: original.bodyEndUtf16,
    },
  };
  const selection = freezeS2FrozenReaderChoicePlan(selected);
  return {
    selected,
    plan: {
      schemaVersion: "akp.s2.http-admitted-frozen-reader.v1",
      httpRequestSha256: http.requestSha256,
      httpResponseSha256: http.responseSha256,
      passageId: input.passageId,
      originalDocumentKeySha256: documentKey,
      selectedSourceRevisionSha256: sha(original.revision),
      originalHttpQuoteReplay: "REPLAY_VERIFIED",
      inlineCitationMarkers: replay.inlineCitationMarkers,
      selection,
      admissionVerifiedByOfflineBridge: false,
      semanticRelationIndependentlyVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    },
  };
}
export function freezeS2HttpAdmittedReaderPlan(
  input: S2HttpFrozenReaderInput,
): S2HttpFrozenReaderPlan {
  return prepared(input).plan;
}

export async function assessS2HttpAdmittedReader(
  input: S2HttpFrozenReaderInput,
  plan: S2HttpFrozenReaderPlan,
  proposal: unknown,
  probes: S2SemanticEvidenceConfig,
): Promise<S2FrozenReaderChoiceResult> {
  let current: ReturnType<typeof prepared>;
  try {
    current = prepared(input);
  } catch {
    return {
      status: "HELD",
      reason: "HTTP_SOURCE_ORIGINAL_REPLAY_REJECTED",
      originalQuoteStartUtf16: null,
      originalQuoteEndUtf16: null,
      assessment: null,
      sourceAuthorizationIndependentlyVerified: false,
      semanticRelationIndependentlyVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    };
  }
  if (JSON.stringify(current.plan) !== JSON.stringify(plan))
    return {
      status: "HELD",
      reason: "HTTP_RECEIPT_OR_FROZEN_PLAN_CHANGED",
      originalQuoteStartUtf16: null,
      originalQuoteEndUtf16: null,
      assessment: null,
      sourceAuthorizationIndependentlyVerified: false,
      semanticRelationIndependentlyVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    };
  return assessS2FrozenReaderChoice(
    current.selected,
    current.plan.selection,
    proposal,
    probes,
  );
}
