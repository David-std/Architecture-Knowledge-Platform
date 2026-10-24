import { createHash } from "node:crypto";
import type { FrozenRetrievedOriginal } from "./s2-retrieved-writer-bridge.js";

const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = /^[0-9a-f]{64}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const boundary = (x: string, at: number) =>
  Number.isSafeInteger(at) &&
  at >= 0 &&
  at <= x.length &&
  !(
    at > 0 &&
    at < x.length &&
    x.charCodeAt(at - 1) >= 0xd800 &&
    x.charCodeAt(at - 1) <= 0xdbff &&
    x.charCodeAt(at) >= 0xdc00 &&
    x.charCodeAt(at) <= 0xdfff
  );
const fail = (reason: string): never => {
  throw new Error("S2_DISCOVERY_" + reason);
};

/**
 * The output of a scoped historical HTTP search is NOT equivalent to evidence
 * admission. An exploratory quote is a source discovery lead, not an answer
 * or a citation a writer may publish. Only explicit subsequent original-bound
 * full-claim verification can propose support (and that is still not a gate).
 */
export interface S2PreAdmissionDiscoveredSource {
  readonly type: "PRE_ADMISSION_SOURCE_CANDIDATE";
  readonly origin: "ADMITTED_HIT" | "EXPLORATORY_HIT";
  readonly originalRank: number;
  readonly documentIdSha256: string;
  readonly pathSha256: string;
  readonly revisionSha256: string;
  readonly sourceSha256: string;
  readonly excerptSha256: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly exactQuote: string;
  readonly claimEntailmentVerified: false;
  readonly authorizedForAnswerCitation: false;
  readonly productionAdmission: false;
}
export interface S2PreAdmissionDiscovery {
  readonly schemaVersion: "akp.s2.pre-admission-original-discovery.v1";
  readonly status: "SOURCE_DISCOVERY_ONLY" | "NO_SOURCE_CANDIDATES";
  readonly scopeVaultIdSha256: string;
  readonly requestSha256: string;
  readonly responseSha256: string;
  readonly admittedHitsReported: number;
  readonly exploratoryHitsReported: number;
  readonly candidates: readonly S2PreAdmissionDiscoveredSource[];
  readonly originalLiteralMatches: number;
  readonly unmatchedOrRepeatedExcerpts: number;
  readonly originalAuthenticationNotIndependentlyVerified: true;
  readonly noGoldRead: true;
  readonly writerRequestIssued: false;
  readonly modelDecisionMade: false;
  readonly independentClaimEntailmentVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

/**
 * Discovery-only bridge. Hard reject changed HTTP pins, unauthorized/mixed
 * vaults, stale revisions and nonmatching frozen originals. Ignore excerpts
 * whose exact UTF-16 window cannot be uniquely located in the source; never
 * fuzzy-repair them. It accepts both response.hits and exploratoryHits for
 * investigation, but does NOT produce an admitted writer request.
 *
 * The pathAuthorizer and historical authenticatedTransportReportedByCaller
 * are caller assertions; this pure evaluator does not authenticate bearer
 * tokens or prove today's ACL, so no production decision may use its output.
 */
export function discoverS2PreAdmissionOriginalCandidates(input: {
  readonly expectedQuestion: string;
  readonly expectedSpaceId: string;
  readonly expectedVaultId: string;
  readonly rawHttpRequestBytes: Uint8Array;
  readonly pinnedHttpRequestSha256: string;
  readonly rawHttpResponseBytes: Uint8Array;
  readonly pinnedHttpResponseSha256: string;
  readonly responseStatus: number;
  readonly authenticatedTransportReportedByCaller: true;
  readonly originals: readonly FrozenRetrievedOriginal[];
  readonly pathAuthorizer: (path: string, vaultId: string) => boolean;
  readonly maxCandidates?: number;
}): S2PreAdmissionDiscovery {
  const max = input.maxCandidates ?? 64;
  if (
    !uuid.test(input.expectedSpaceId) ||
    !uuid.test(input.expectedVaultId) ||
    !input.expectedQuestion.trim() ||
    input.expectedQuestion.length > 2048 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 100 ||
    !hex.test(input.pinnedHttpRequestSha256) ||
    !hex.test(input.pinnedHttpResponseSha256) ||
    input.rawHttpRequestBytes.length < 2 ||
    input.rawHttpRequestBytes.length > 250000 ||
    input.rawHttpResponseBytes.length < 2 ||
    input.rawHttpResponseBytes.length > 3000000 ||
    sha(input.rawHttpRequestBytes) !== input.pinnedHttpRequestSha256 ||
    sha(input.rawHttpResponseBytes) !== input.pinnedHttpResponseSha256 ||
    input.responseStatus !== 200 ||
    input.authenticatedTransportReportedByCaller !== true ||
    !Array.isArray(input.originals) ||
    input.originals.length > 100 ||
    typeof input.pathAuthorizer !== "function"
  )
    fail("INPUT_PINS_SCOPE_OR_BOUNDS_INVALID");
  let request: unknown, response: unknown;
  try {
    request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        input.rawHttpRequestBytes,
      ),
    );
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        input.rawHttpResponseBytes,
      ),
    );
  } catch {
    fail("HTTP_BYTES_NOT_JSON_UTF8");
  }
  if (
    !record(request) ||
    request.spaceId !== input.expectedSpaceId ||
    request.vaultId !== input.expectedVaultId ||
    request.query !== input.expectedQuestion ||
    request.mode !== "SOURCE_BACKED" ||
    request.federated !== false ||
    !Array.isArray(request.vaultIds) ||
    request.vaultIds.length !== 0 ||
    !Array.isArray(request.types) ||
    request.types.length !== 0 ||
    !record(response) ||
    response.mode !== "SOURCE_BACKED" ||
    !record(response.scope) ||
    response.scope.spaceId !== input.expectedSpaceId ||
    response.scope.federated !== false ||
    !Array.isArray(response.scope.vaultIds) ||
    response.scope.vaultIds.length !== 1 ||
    response.scope.vaultIds[0] !== input.expectedVaultId ||
    !Array.isArray(response.hits) ||
    !Array.isArray(response.exploratoryHits) ||
    response.hits.length > 100 ||
    response.exploratoryHits.length > 100 ||
    !["SUPPORTED", "EXPLORATORY_ONLY", "NO_CANDIDATES"].includes(
      String(response.retrievalOutcome),
    ) ||
    (response.retrievalOutcome === "SUPPORTED"
      ? response.hits.length === 0
      : response.hits.length !== 0)
  )
    fail("HTTP_SCOPE_OR_OUTCOME_CHANGED");

  const verified = new Map<
    string,
    { file: FrozenRetrievedOriginal; text: string }
  >();
  for (const file of input.originals) {
    if (
      !file ||
      file.vaultId !== input.expectedVaultId ||
      !file.documentId ||
      !file.path ||
      !file.revision ||
      !hex.test(file.fileSha256) ||
      !(file.fileBytes instanceof Uint8Array) ||
      file.fileBytes.length < 1 ||
      file.fileBytes.length > 2000000 ||
      sha(file.fileBytes) !== file.fileSha256
    )
      fail("ORIGINAL_IDENTITY_OR_HASH_INVALID");
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        file.fileBytes,
      );
    } catch {
      fail("ORIGINAL_UTF8_INVALID");
    }
    if (
      !boundary(text, file.bodyStartUtf16) ||
      !boundary(text, file.bodyEndUtf16) ||
      file.bodyEndUtf16 <= file.bodyStartUtf16
    )
      fail("ORIGINAL_FRAME_INVALID");
    const key = [file.vaultId, file.documentId, file.path, file.revision].join(
      "\0",
    );
    if (verified.has(key)) fail("DUPLICATE_ORIGINAL");
    verified.set(key, { file, text });
  }
  const checkedResponse = response as {
    hits: unknown[];
    exploratoryHits: unknown[];
  };
  const hits = [
    ...checkedResponse.hits.map((hit: unknown) => ({
      hit,
      origin: "ADMITTED_HIT" as const,
    })),
    ...checkedResponse.exploratoryHits.map((hit: unknown) => ({
      hit,
      origin: "EXPLORATORY_HIT" as const,
    })),
  ];
  const candidates: S2PreAdmissionDiscoveredSource[] = [];
  let unmatched = 0;
  for (const [rank, { hit, origin }] of hits.entries()) {
    if (
      !record(hit) ||
      !record(hit.document) ||
      !record(hit.retrievalTrace) ||
      !record(hit.retrievalTrace.authorization) ||
      hit.retrievalTrace.authorization.decision !== "ALLOW" ||
      hit.retrievalTrace.authorization.spaceId !== input.expectedSpaceId ||
      hit.retrievalTrace.authorization.vaultId !== input.expectedVaultId ||
      typeof hit.documentId !== "string" ||
      typeof hit.vaultId !== "string" ||
      typeof hit.document.path !== "string" ||
      typeof hit.revision !== "string" ||
      typeof hit.excerpt !== "string" ||
      !Array.isArray(hit.citations) ||
      hit.vaultId !== input.expectedVaultId ||
      hit.lifecycle !== "ACTIVE" ||
      hit.refreshStatus !== "CURRENT" ||
      !hit.citations.includes(hit.document.path + "@" + hit.revision)
    )
      fail("HTTP_HIT_NOT_TRUSTWORTHY");
    const checkedHit = hit as {
      documentId: string;
      vaultId: string;
      document: { path: string };
      revision: string;
      excerpt: string;
    };
    if (!input.pathAuthorizer(checkedHit.document.path, checkedHit.vaultId))
      fail("CURRENT_PATH_NOT_AUTHORIZED");
    const key = [
      checkedHit.vaultId,
      checkedHit.documentId,
      checkedHit.document.path,
      checkedHit.revision,
    ].join("\0");
    const original = verified.get(key);
    if (!original)
      throw new Error("S2_DISCOVERY_HIT_NOT_CURRENT_FROZEN_ORIGINAL");
    const { file, text } = original;
    const quote = checkedHit.excerpt;
    const at = text.indexOf(quote, file.bodyStartUtf16);
    if (
      quote.trim() !== quote ||
      quote.length < 12 ||
      quote.length > 12000 ||
      at < file.bodyStartUtf16 ||
      at < 0 ||
      at + quote.length > file.bodyEndUtf16 ||
      text.indexOf(quote, at + 1) >= 0 ||
      !boundary(text, at) ||
      !boundary(text, at + quote.length)
    ) {
      unmatched++;
      continue;
    }
    // Audit all returned hits for scope, lifecycle and provenance even when
    // the bounded exploration output is full; later foreign hits must not hide.
    if (candidates.length >= max) continue;
    candidates.push({
      type: "PRE_ADMISSION_SOURCE_CANDIDATE",
      origin,
      originalRank: rank,
      documentIdSha256: sha(file.documentId),
      pathSha256: sha(file.path),
      revisionSha256: sha(file.revision),
      sourceSha256: file.fileSha256,
      excerptSha256: sha(quote),
      startUtf16: at,
      endUtf16: at + quote.length,
      exactQuote: quote,
      claimEntailmentVerified: false,
      authorizedForAnswerCitation: false,
      productionAdmission: false,
    });
  }
  return {
    schemaVersion: "akp.s2.pre-admission-original-discovery.v1",
    status: candidates.length
      ? "SOURCE_DISCOVERY_ONLY"
      : "NO_SOURCE_CANDIDATES",
    scopeVaultIdSha256: sha(input.expectedVaultId),
    requestSha256: input.pinnedHttpRequestSha256,
    responseSha256: input.pinnedHttpResponseSha256,
    admittedHitsReported: checkedResponse.hits.length,
    exploratoryHitsReported: checkedResponse.exploratoryHits.length,
    candidates,
    originalLiteralMatches: candidates.length,
    unmatchedOrRepeatedExcerpts: unmatched,
    originalAuthenticationNotIndependentlyVerified: true,
    noGoldRead: true,
    writerRequestIssued: false,
    modelDecisionMade: false,
    independentClaimEntailmentVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}
