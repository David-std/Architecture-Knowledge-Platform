import { createHash } from "node:crypto";
import type { FrozenRetrievedOriginal } from "./s2-retrieved-writer-bridge.js";
import type { S2PreAdmissionDiscovery } from "./s2-pre-admission-source-discovery.js";
import { bindS2VerbatimWindowQuote } from "./s2-evidence-window-selection.js";

const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
export interface S2DiscoveryReviewWindow {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly exactText: string;
  readonly candidateOrigin: "ADMITTED_HIT" | "EXPLORATORY_HIT";
  readonly sourceRank: number;
  readonly productionAdmission: false;
}
export interface S2DiscoveryReviewOriginal {
  readonly assignedSourceId: string;
  readonly sourceSha256: string;
  readonly exactUtf8Bytes: Uint8Array;
  readonly bodyStartUtf16: number;
  readonly bodyEndUtf16: number;
  readonly authorizedForAnswerCitation: false;
}
export interface S2DiscoveryReviewPlan {
  readonly status:
    "SHADOW_REVIEW_INPUTS_ONLY" | "NO_BOUND_WINDOWS" | "REJECTED";
  readonly reason: string;
  readonly windows: readonly S2DiscoveryReviewWindow[];
  readonly originalRefs: readonly S2DiscoveryReviewOriginal[];
  readonly candidatesInspected: number;
  readonly candidatesOutsideBudget: number;
  readonly modelCalled: false;
  readonly liveAccessControlCryptographicallyVerified: false;
  readonly sourcePropositionsVerified: false;
  readonly completeAnswerVerified: false;
  readonly canBuildAdmittedWriterRequest: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
/**
 * Materialize a bounded original-bound REVIEW portfolio from source-discovery
 * leads. Before selecting anything, verify all leads against exact frozen
 * revisions and current caller path authorization. A false source/revision
 * anywhere in the captured set invalidates the entire plan, including if it
 * appears after maxWindows.
 *
 * Existing S2EvidencePortfolio can inspect these exact windows in SHADOW,
 * but this method never makes them eligible as admitted writer citations.
 */
export function freezeS2DiscoveryReviewPlan(input: {
  readonly discovery: S2PreAdmissionDiscovery;
  readonly originals: readonly FrozenRetrievedOriginal[];
  readonly currentPathAuthorizer: (path: string, vaultId: string) => boolean;
  readonly maxWindows?: number;
}): S2DiscoveryReviewPlan {
  const make = (
    status: S2DiscoveryReviewPlan["status"],
    reason: string,
    windows: readonly S2DiscoveryReviewWindow[] = [],
    originalRefs: readonly S2DiscoveryReviewOriginal[] = [],
  ): S2DiscoveryReviewPlan => ({
    status,
    reason,
    windows,
    originalRefs,
    candidatesInspected: input.discovery?.candidates?.length ?? 0,
    candidatesOutsideBudget: Math.max(
      0,
      (input.discovery?.candidates?.length ?? 0) - windows.length,
    ),
    modelCalled: false,
    liveAccessControlCryptographicallyVerified: false,
    sourcePropositionsVerified: false,
    completeAnswerVerified: false,
    canBuildAdmittedWriterRequest: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  const cap = input.maxWindows ?? 8;
  if (
    !input.discovery ||
    input.discovery.schemaVersion !==
      "akp.s2.pre-admission-original-discovery.v1" ||
    !["SOURCE_DISCOVERY_ONLY", "NO_SOURCE_CANDIDATES"].includes(
      input.discovery.status,
    ) ||
    input.discovery.productionAdmission !== false ||
    input.discovery.writerRequestIssued !== false ||
    input.discovery.modelDecisionMade !== false ||
    input.discovery.releaseGateAccepted !== false ||
    !Array.isArray(input.discovery.candidates) ||
    input.discovery.candidates.length > 100 ||
    input.discovery.originalLiteralMatches !==
      input.discovery.candidates.length ||
    !Array.isArray(input.originals) ||
    input.originals.length > 100 ||
    typeof input.currentPathAuthorizer !== "function" ||
    !Number.isSafeInteger(cap) ||
    cap < 1 ||
    cap > 16
  )
    return make("REJECTED", "DISCOVERY_OR_REVIEW_BUDGET_INVALID");
  const byKey = new Map<
    string,
    { file: FrozenRetrievedOriginal; ref: S2DiscoveryReviewOriginal }
  >();
  const sourceIds = new Map<string, string>();
  for (const file of input.originals) {
    if (
      !file ||
      !(file.fileBytes instanceof Uint8Array) ||
      file.fileBytes.length < 1 ||
      file.fileBytes.length > 2_000_000 ||
      sha(file.fileBytes) !== file.fileSha256 ||
      sha(file.vaultId) !== input.discovery.scopeVaultIdSha256 ||
      !input.currentPathAuthorizer(file.path, file.vaultId)
    )
      return make("REJECTED", "ORIGINAL_FILE_NOT_BOUND_OR_AUTHORIZED");
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        file.fileBytes,
      );
    } catch {
      return make("REJECTED", "ORIGINAL_UTF8_INVALID");
    }
    if (
      !Number.isSafeInteger(file.bodyStartUtf16) ||
      !Number.isSafeInteger(file.bodyEndUtf16) ||
      file.bodyStartUtf16 < 0 ||
      file.bodyEndUtf16 > body.length ||
      file.bodyStartUtf16 >= file.bodyEndUtf16
    )
      return make("REJECTED", "ORIGINAL_BODY_FRAME_INVALID");
    const key = [
      sha(file.documentId),
      sha(file.path),
      sha(file.revision),
      file.fileSha256,
    ].join("|");
    if (byKey.has(key)) return make("REJECTED", "DUPLICATE_ORIGINAL");
    const id = "SRC" + (byKey.size + 1);
    sourceIds.set(key, id);
    byKey.set(key, {
      file,
      ref: {
        assignedSourceId: id,
        sourceSha256: file.fileSha256,
        exactUtf8Bytes: file.fileBytes,
        bodyStartUtf16: file.bodyStartUtf16,
        bodyEndUtf16: file.bodyEndUtf16,
        authorizedForAnswerCitation: false,
      },
    });
  }
  const verified: S2DiscoveryReviewWindow[] = [];
  const used = new Set<string>();
  for (const c of input.discovery.candidates) {
    if (
      !c ||
      c.type !== "PRE_ADMISSION_SOURCE_CANDIDATE" ||
      c.authorizedForAnswerCitation !== false ||
      c.productionAdmission !== false ||
      c.claimEntailmentVerified !== false ||
      !["ADMITTED_HIT", "EXPLORATORY_HIT"].includes(c.origin)
    )
      return make("REJECTED", "CANDIDATE_HAS_INVALID_AUTHORITY");
    const key = [
      c.documentIdSha256,
      c.pathSha256,
      c.revisionSha256,
      c.sourceSha256,
    ].join("|");
    const owner = byKey.get(key);
    if (!owner) return make("REJECTED", "CANDIDATE_SOURCE_NOT_ORIGINAL_BOUND");
    if (!input.currentPathAuthorizer(owner.file.path, owner.file.vaultId))
      return make("REJECTED", "CANDIDATE_PATH_NOT_AUTHORIZED");
    const proposed = {
      sourceId: sourceIds.get(key)!,
      sourceSha256: c.sourceSha256,
      startUtf16: c.startUtf16,
      endUtf16: c.endUtf16,
      exactText: c.exactQuote,
      productionAdmission: false as const,
    };
    if (
      sha(c.exactQuote) !== c.excerptSha256 ||
      !bindS2VerbatimWindowQuote(owner.ref, proposed)
    )
      return make("REJECTED", "CANDIDATE_ORIGINAL_INTERVAL_DRIFT");
    const signature = key + ":" + c.startUtf16 + ":" + c.endUtf16;
    if (used.has(signature)) continue;
    used.add(signature);
    verified.push({
      ...proposed,
      candidateOrigin: c.origin,
      sourceRank: c.originalRank,
    });
  }
  // First rank remains first, irrespective of whether it was originally
  // admitted. An exploratory hit NEVER gains admission by joining the plan.
  const windows = verified.slice(0, cap);
  const included = new Set(windows.map((w) => w.sourceId));
  const refs = [...byKey.values()]
    .map((x) => x.ref)
    .filter((x) => included.has(x.assignedSourceId));
  return make(
    windows.length ? "SHADOW_REVIEW_INPUTS_ONLY" : "NO_BOUND_WINDOWS",
    windows.length
      ? "SOURCE_BOUND_REVIEW_REQUIRED_NOT_ADMITTED"
      : "NO_VERIFIABLE_WINDOWS",
    windows,
    refs,
  );
}
