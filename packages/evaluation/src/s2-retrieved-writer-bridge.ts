import { createHash } from "node:crypto";
/** Structural view of an already authorized AKP SearchHit.
 * Avoid coupling evaluation package to the runtime contracts source tree. */
export interface RetrievalBridgeHit {
  documentId: string;
  vaultId: string;
  unitId: string | null;
  document: { path: string | null };
  revision: string;
  lifecycle: string;
  refreshStatus: string;
}

import {
  freezeNativeStructuredWriter,
  type NativeWriterBuild,
} from "./s2-native-structured-writer.js";
import type {
  FrozenOriginalReference,
  S2Passage,
  WriterProbeInput,
} from "./s2-writer-passage-capture.js";

const sha = (v: Uint8Array | string): string =>
  createHash("sha256").update(v).digest("hex");
const fail = (code: string): never => {
  throw Error("S2_RETRIEVED_WRITER_" + code);
};
const boundary = (s: string, n: number) =>
  Number.isSafeInteger(n) &&
  n >= 0 &&
  n <= s.length &&
  !(
    n > 0 &&
    n < s.length &&
    s.charCodeAt(n - 1) >= 0xd800 &&
    s.charCodeAt(n - 1) <= 0xdbff &&
    s.charCodeAt(n) >= 0xdc00 &&
    s.charCodeAt(n) <= 0xdfff
  );
/** Optional, evaluation-only, source-bound windows of an already admitted document. */
export interface FrozenRetrievedSourceWindow {
  vaultId: string;
  documentId: string;
  path: string;
  revision: string;
  startUtf16: number;
  endUtf16: number;
}
export interface FrozenRetrievedOriginal {
  vaultId: string;
  documentId: string;
  path: string;
  revision: string;
  fileSha256: string;
  fileBytes: Uint8Array;
  bodyStartUtf16: number;
  bodyEndUtf16: number;
}
export interface RetrievalWriterBridgeScope {
  caseKeySha256: string;
  caseManifestSha256: string;
  sourceManifestSha256: string;
  executedCommitSha: string;
  sourceFamilySha256: string;
  language: "en" | "es";
  question: string;
  model: string;
  modelDigestSha256: string;
  systemPrompt: string;
  seed: number;
  contextTokens: 4096 | 8192 | 16384;
  maxOutputTokens: number;
  vaultId: string;
  maxRetrievedDocuments: number;
}
export interface RetrievalWriterBridgeResult {
  schemaVersion: "akp.s2.retrieval-writer-bridge.v1";
  status:
    "RETRIEVAL_BOUND_WRITER_READY" | "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE";
  exactProviderRequest: NativeWriterBuild | null;
  selectedEvidence: {
    passageId: string;
    documentKeySha256: string;
    vaultKeySha256: string;
    pathSha256: string;
    revisionSha256: string;
    sourceSha256: string;
    childUnitIdSha256: string;
    hitRank: number;
    bodyStartUtf16: number;
    bodyEndUtf16: number;
  }[];
  authorizedHitsSeen: number;
  candidateCount: number;
  excludedHits: number;
  sourceSelection:
    | "RANKED_AUTHORIZED_QUERY_KNOWLEDGE_HITS_ONLY"
    | "RANKED_AUTHORIZED_QUERY_KNOWLEDGE_WINDOWS_ONLY";
  ownerGoldLoaded: false;
  independentGroundTruthMeasured: false;
  applicationHttpP95Measured: false;
  semanticCitationEntailmentVerified: false;
  productionAdmissionChanged: false;
  gateAccepted: false;
}
/** Never select source documents by their expected answers or gold membership.
 * Call ONLY on genuine scoped/authorized queryKnowledge hits with current revisions.
 */
export function freezeWriterFromRetrievedHits(input: {
  scope: RetrievalWriterBridgeScope;
  rankedAuthorizedHits: readonly RetrievalBridgeHit[];
  originalFiles: readonly FrozenRetrievedOriginal[];
  /** Undefined retains the historical full-document selection. */
  sourceWindows?: readonly FrozenRetrievedSourceWindow[];
  pathAuthorizer: (path: string, vaultId: string) => boolean;
}): RetrievalWriterBridgeResult {
  const {
    scope,
    rankedAuthorizedHits,
    originalFiles,
    pathAuthorizer,
    sourceWindows,
  } = input;
  if (
    !/^[0-9a-f-]{36}$/u.test(scope.vaultId) ||
    !Number.isSafeInteger(scope.maxRetrievedDocuments) ||
    scope.maxRetrievedDocuments < 1 ||
    scope.maxRetrievedDocuments > 3 ||
    rankedAuthorizedHits.length > 100 ||
    originalFiles.length > 100 ||
    (sourceWindows !== undefined &&
      (!Array.isArray(sourceWindows) || sourceWindows.length > 100))
  )
    fail("INVALID_SCOPE_OR_BOUNDS");
  const originals = new Map<
    string,
    { ref: FrozenOriginalReference; raw: string; item: FrozenRetrievedOriginal }
  >();
  for (const file of originalFiles) {
    if (
      file.vaultId !== scope.vaultId ||
      !file.documentId ||
      !file.path ||
      !file.revision ||
      file.fileBytes.length === 0 ||
      file.fileBytes.length > 2_000_000 ||
      sha(file.fileBytes) !== file.fileSha256
    )
      fail("FROZEN_ORIGINAL_NOT_TRUSTWORTHY");
    const key =
      file.vaultId +
      "|" +
      file.documentId +
      "|" +
      file.path +
      "|" +
      file.revision;
    if (originals.has(key)) fail("DUPLICATE_ORIGINAL");
    let raw = "";
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        file.fileBytes,
      );
    } catch {
      fail("ORIGINAL_UTF8_INVALID");
    }
    if (
      !boundary(raw, file.bodyStartUtf16) ||
      !boundary(raw, file.bodyEndUtf16) ||
      file.bodyStartUtf16 >= file.bodyEndUtf16
    )
      fail("FROZEN_ORIGINAL_BODY_INVALID");
    const documentKeySha256 = sha("document:" + key);
    originals.set(key, {
      item: file,
      raw,
      ref: {
        documentKeySha256,
        fileSha256: file.fileSha256,
        fileBytes: file.fileBytes,
        bodyStartUtf16: file.bodyStartUtf16,
        bodyEndUtf16: file.bodyEndUtf16,
      },
    });
  }
  // Prevalidate every requested original window before matching it to a hit.
  // Window proposals never confer authority; only the ranked authorized hit does.
  const windowsBySource = new Map<string, FrozenRetrievedSourceWindow[]>();
  for (const window of sourceWindows ?? []) {
    const key =
      window.vaultId +
      "|" +
      window.documentId +
      "|" +
      window.path +
      "|" +
      window.revision;
    const source = originals.get(key);
    if (!source) {
      throw new Error("S2_RETRIEVED_WRITER_SOURCE_WINDOW_NOT_ORIGINAL_BOUND");
    }
    if (
      !boundary(source.raw, window.startUtf16) ||
      !boundary(source.raw, window.endUtf16) ||
      window.startUtf16 < source.item.bodyStartUtf16 ||
      window.endUtf16 > source.item.bodyEndUtf16 ||
      window.startUtf16 >= window.endUtf16
    )
      fail("SOURCE_WINDOW_NOT_ORIGINAL_BOUND");
    const span = source.raw.slice(window.startUtf16, window.endUtf16);
    if (span.length > 4000 || Buffer.byteLength(span, "utf8") > 6000)
      fail("SOURCE_WINDOW_SIZE_INVALID");
    const list = windowsBySource.get(key) ?? [];
    if (
      list.some(
        (v) =>
          v.startUtf16 === window.startUtf16 && v.endUtf16 === window.endUtf16,
      )
    )
      fail("DUPLICATE_SOURCE_WINDOW");
    list.push(window);
    windowsBySource.set(key, list);
  }
  const selected = new Set<string>();
  const passages: S2Passage[] = [];
  const boundOriginals: FrozenOriginalReference[] = [];
  const evidence: RetrievalWriterBridgeResult["selectedEvidence"] = [];
  let excludedHits = 0,
    authorizedHitsSeen = 0;
  for (const [rank, hit] of rankedAuthorizedHits.entries()) {
    const path = hit.document.path;
    if (
      hit.vaultId !== scope.vaultId ||
      hit.lifecycle !== "ACTIVE" ||
      hit.refreshStatus !== "CURRENT" ||
      !hit.documentId ||
      !hit.unitId ||
      !path ||
      !hit.revision ||
      !pathAuthorizer(path, hit.vaultId)
    ) {
      excludedHits++;
      continue;
    }
    authorizedHitsSeen++;
    const key =
      hit.vaultId + "|" + hit.documentId + "|" + path + "|" + hit.revision;
    const source = originals.get(key);
    if (!source) {
      excludedHits++;
      continue;
    }
    if (selected.has(key)) continue;
    const spans =
      sourceWindows === undefined
        ? [
            {
              startUtf16: source.item.bodyStartUtf16,
              endUtf16: source.item.bodyEndUtf16,
            },
          ]
        : (windowsBySource.get(key) ?? []).slice(0, 2);
    if (!spans.length) {
      excludedHits++;
      continue;
    }
    let acceptedSpans = 0;
    for (const span of spans) {
      const text = source.raw.slice(span.startUtf16, span.endUtf16);
      // Retain the full-document limits as well as the stricter window limits.
      if (text.length > 18000 || Buffer.byteLength(text, "utf8") > 16000) {
        excludedHits++;
        continue;
      }
      const passageId = "SRC" + (passages.length + 1);
      passages.push({
        id: passageId,
        text,
        original: {
          documentKeySha256: source.ref.documentKeySha256,
          fileSha256: source.item.fileSha256,
          startUtf16: span.startUtf16,
          endUtf16: span.endUtf16,
        },
      });
      if (acceptedSpans === 0) boundOriginals.push(source.ref);
      acceptedSpans++;
      evidence.push({
        passageId,
        documentKeySha256: source.ref.documentKeySha256,
        vaultKeySha256: sha(hit.vaultId),
        pathSha256: sha(path),
        revisionSha256: sha(hit.revision),
        sourceSha256: source.item.fileSha256,
        childUnitIdSha256: sha(hit.unitId),
        hitRank: rank,
        bodyStartUtf16: span.startUtf16,
        bodyEndUtf16: span.endUtf16,
      });
    }
    if (acceptedSpans > 0) selected.add(key);
    if (selected.size >= scope.maxRetrievedDocuments) break;
  }
  const base = {
    schemaVersion: "akp.s2.retrieval-writer-bridge.v1" as const,
    selectedEvidence: evidence,
    authorizedHitsSeen,
    candidateCount: rankedAuthorizedHits.length,
    excludedHits,
    sourceSelection:
      sourceWindows === undefined
        ? ("RANKED_AUTHORIZED_QUERY_KNOWLEDGE_HITS_ONLY" as const)
        : ("RANKED_AUTHORIZED_QUERY_KNOWLEDGE_WINDOWS_ONLY" as const),
    ownerGoldLoaded: false as const,
    independentGroundTruthMeasured: false as const,
    applicationHttpP95Measured: false as const,
    semanticCitationEntailmentVerified: false as const,
    productionAdmissionChanged: false as const,
    gateAccepted: false as const,
  };
  if (!passages.length)
    return {
      ...base,
      status: "NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE",
      exactProviderRequest: null,
    };
  const requestCase: WriterProbeInput = {
    caseKeySha256: scope.caseKeySha256,
    caseManifestSha256: scope.caseManifestSha256,
    sourceManifestSha256: scope.sourceManifestSha256,
    executedCommitSha: scope.executedCommitSha,
    sourceFamilySha256: scope.sourceFamilySha256,
    language: scope.language,
    question: scope.question,
    model: scope.model,
    modelDigestSha256: scope.modelDigestSha256,
    systemPrompt: scope.systemPrompt,
    temperature: 0,
    seed: scope.seed,
    maxTokens: scope.maxOutputTokens,
    passages,
  };
  const exactProviderRequest = freezeNativeStructuredWriter({
    case: requestCase,
    originals: boundOriginals,
    contextTokens: scope.contextTokens,
    maxOutputTokens: scope.maxOutputTokens,
  });
  if (
    !exactProviderRequest.freeze.sourcePassages.every(
      (p) => p.source === "ORIGINAL_LITERAL_MATCH",
    )
  )
    fail("SENT_PASSAGE_NOT_ORIGINAL_BOUND");
  return {
    ...base,
    status: "RETRIEVAL_BOUND_WRITER_READY",
    exactProviderRequest,
  };
}
