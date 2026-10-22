import { createHash } from "node:crypto";
import {
  freezeWriterFromRetrievedHits,
  type FrozenRetrievedOriginal,
  type RetrievalBridgeHit,
  type RetrievalWriterBridgeResult,
  type RetrievalWriterBridgeScope,
} from "./s2-retrieved-writer-bridge.js";

const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const fail = (why: string): never => {
  throw Error("S2_HTTP_WRITER_" + why);
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The receipt records what an authenticated Fastify HTTP fetch returned,
 * not an independently verifiable credential or remote server attestation.
 * In particular, exploratoryHits MUST NEVER become model evidence.
 */
export interface AuthenticatedSearchBridgeResult {
  schemaVersion: "akp.s2.authenticated-http-search-writer.v1";
  status: "HTTP_ADMITTED_WRITER_READY" | "HTTP_NO_ADMITTED_EVIDENCE";
  requestSha256: string;
  responseSha256: string;
  returnedStatus: 200;
  returnedRetrievalOutcome: "SUPPORTED" | "EXPLORATORY_ONLY" | "NO_CANDIDATES";
  admittedHitCount: number;
  exploratoryHitCount: number;
  selectedSourceCount: number;
  authorizationReportedByCaller: true;
  transportAssertion: "CALLER_REPORTED_AUTHENTICATED_LOOPBACK_HTTP";
  sourceSelection: "ONLY_HTTP_RESPONSE_HITS_NOT_EXPLORATORY";
  bridge: RetrievalWriterBridgeResult;
  ownerGoldLoaded: false;
  authenticatedPrincipalVerifiedByOfflineBridge: false;
  realHttpResponseCaptured: true;
  fullAnswerHttpRouteMeasured: false;
  gateAccepted: false;
}

/** Must run after the actual Fastify HTTP request, not on a forged in-memory
 * retrieval result. Binding is to exact request and response bytes plus
 * expected scope; this pure evaluator cannot verify an OAuth/Bearer credential.
 * A caller must record an actual loopback HTTP fetch separately.
 */
export function freezeWriterFromAuthenticatedSearchResponse(input: {
  expectedSpaceId: string;
  expectedVaultId: string;
  expectedQuestion: string;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  responseStatus: number;
  authorizationReportedByCaller: true;
  bridgeScope: RetrievalWriterBridgeScope;
  originals: readonly FrozenRetrievedOriginal[];
  pathAuthorizer: (path: string, vaultId: string) => boolean;
}): AuthenticatedSearchBridgeResult {
  const {
    expectedSpaceId,
    expectedVaultId,
    requestBytes,
    responseBytes,
    responseStatus,
    bridgeScope,
  } = input;
  if (
    !uuid.test(expectedSpaceId) ||
    !uuid.test(expectedVaultId) ||
    !requestBytes.length ||
    requestBytes.length > 250000 ||
    !responseBytes.length ||
    responseBytes.length > 3000000 ||
    input.authorizationReportedByCaller !== true
  )
    fail("INVALID_HTTP_CAPTURE");
  let request: unknown, response: unknown;
  try {
    request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(requestBytes),
    );
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
    );
  } catch {
    fail("INVALID_JSON_BYTES");
  }
  if (
    !object(request) ||
    request.query !== input.expectedQuestion ||
    request.spaceId !== expectedSpaceId ||
    request.vaultId !== expectedVaultId ||
    request.mode !== "SOURCE_BACKED" ||
    request.federated !== false ||
    !Array.isArray(request.vaultIds) ||
    request.vaultIds.length !== 0 ||
    !Array.isArray(request.types) ||
    request.types.length !== 0
  )
    fail("ORIGINAL_HTTP_REQUEST_SCOPE_INVALID");
  if (!object(response)) {
    throw new Error("S2_HTTP_WRITER_RESPONSE_UNTRUSTED_SCOPE_STATUS_OR_SHAPE");
  }
  if (
    bridgeScope.question !== input.expectedQuestion ||
    bridgeScope.vaultId !== expectedVaultId ||
    responseStatus !== 200 ||
    response.mode !== "SOURCE_BACKED" ||
    !object(response.scope) ||
    response.scope.spaceId !== expectedSpaceId ||
    response.scope.federated !== false ||
    !Array.isArray(response.scope.vaultIds) ||
    response.scope.vaultIds.length !== 1 ||
    response.scope.vaultIds[0] !== expectedVaultId ||
    !Array.isArray(response.hits) ||
    !Array.isArray(response.exploratoryHits) ||
    !["SUPPORTED", "EXPLORATORY_ONLY", "NO_CANDIDATES"].includes(
      String(response.retrievalOutcome),
    )
  )
    fail("RESPONSE_UNTRUSTED_SCOPE_STATUS_OR_SHAPE");
  if (
    !Array.isArray(response.hits) ||
    !Array.isArray(response.exploratoryHits)
  ) {
    throw new Error("S2_HTTP_WRITER_RESPONSE_UNTRUSTED_SCOPE_STATUS_OR_SHAPE");
  }
  if (response.hits.length > 100 || response.exploratoryHits.length > 100)
    fail("RESPONSE_LIST_SIZE_INVALID");
  if (
    (response.retrievalOutcome === "SUPPORTED" && response.hits.length === 0) ||
    (response.retrievalOutcome !== "SUPPORTED" && response.hits.length !== 0) ||
    (response.retrievalOutcome !== "SUPPORTED" && response.noAnswer == null)
  )
    fail("INCONSISTENT_HTTP_ADMISSION");
  // Enforce canonical plain field shapes before converting untrusted JSON.
  const admitted: RetrievalBridgeHit[] = [];
  for (const hit of response.hits) {
    if (
      !object(hit) ||
      !object(hit.document) ||
      typeof hit.vaultId !== "string" ||
      typeof hit.documentId !== "string" ||
      typeof hit.unitId !== "string" ||
      typeof hit.document.path !== "string" ||
      typeof hit.revision !== "string" ||
      typeof hit.lifecycle !== "string" ||
      typeof hit.refreshStatus !== "string"
    )
      fail("UNSAFE_ADMITTED_HTTP_HIT_SHAPE");
    admitted.push({
      vaultId: hit.vaultId,
      documentId: hit.documentId,
      unitId: hit.unitId,
      document: { path: hit.document.path },
      revision: hit.revision,
      lifecycle: hit.lifecycle,
      refreshStatus: hit.refreshStatus,
    });
  }
  const bridge = freezeWriterFromRetrievedHits({
    scope: bridgeScope,
    rankedAuthorizedHits: admitted,
    originalFiles: input.originals,
    pathAuthorizer: input.pathAuthorizer,
  });
  const isReady = bridge.status === "RETRIEVAL_BOUND_WRITER_READY";
  const outcome = response.retrievalOutcome as
    "SUPPORTED" | "EXPLORATORY_ONLY" | "NO_CANDIDATES";
  return {
    schemaVersion: "akp.s2.authenticated-http-search-writer.v1",
    status: isReady
      ? "HTTP_ADMITTED_WRITER_READY"
      : "HTTP_NO_ADMITTED_EVIDENCE",
    requestSha256: sha(requestBytes),
    responseSha256: sha(responseBytes),
    returnedStatus: 200,
    returnedRetrievalOutcome: outcome,
    admittedHitCount: admitted.length,
    exploratoryHitCount: response.exploratoryHits.length,
    selectedSourceCount: bridge.selectedEvidence.length,
    authorizationReportedByCaller: true,
    transportAssertion: "CALLER_REPORTED_AUTHENTICATED_LOOPBACK_HTTP",
    sourceSelection: "ONLY_HTTP_RESPONSE_HITS_NOT_EXPLORATORY",
    bridge,
    ownerGoldLoaded: false,
    authenticatedPrincipalVerifiedByOfflineBridge: false,
    realHttpResponseCaptured: true,
    fullAnswerHttpRouteMeasured: false,
    gateAccepted: false,
  };
}
