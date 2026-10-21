import { createHash } from "node:crypto";
import type { SectionShadowCandidate } from "./section-candidate-shadow.js";

/**
 * Offline-only confirmation of SECTION projection spans against separately
 * frozen ORIGINAL FILE bytes. This function performs no authorization and
 * MUST NOT be called from the search/answer/admission path.
 *
 * A source custodian must independently authorize the original-file fetch,
 * freeze and authenticate the manifest containing fileSha256 and revision.
 * Supplying a self-computed digest here does not establish external custody.
 */

const SHA256 = /^[0-9a-f]{64}$/u;

const digest = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

function validBoundary(text: string, position: number): boolean {
  if (!Number.isSafeInteger(position) || position < 0 || position > text.length)
    return false;
  if (position === 0 || position === text.length) return true;
  const high = text.charCodeAt(position - 1);
  const low = text.charCodeAt(position);
  return !(high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff);
}

export interface IndependentlyFrozenSectionFile {
  vaultId: string;
  documentId: string;
  revision: string;
  path: string;
  /** Raw immutable original Markdown file: keep frontmatter and CRLF intact. */
  fileText: string;
  /** Precommitted digest from an external source freeze, never derived from DB. */
  fileSha256: string;
  /**
   * Original-file UTF-16 coordinates selecting exactly the body_cache-equivalent
   * Markdown body. For frontmatter files this is NOT the start of the file.
   * These offsets MUST be established from the source artifact independently.
   */
  bodyStartUtf16: number;
  bodyEndUtf16: number;
}

export type SectionOriginalRebindStatus =
  | "ORIGINAL_FILE_HASH_MISMATCH"
  | "REVISION_IDENTITY_MISMATCH"
  | "ORIGINAL_BODY_FRAME_INVALID"
  | "ORIGINAL_BODY_PROJECTION_MISMATCH"
  | "ORIGINAL_SPAN_OUT_OF_BOUNDS"
  | "ORIGINAL_SPAN_HASH_MISMATCH"
  | "ORIGINAL_SECTION_TEXT_MISMATCH"
  | "FROZEN_FILE_SPAN_MATCHED";

export interface SectionOriginalRebindDecision {
  sectionKeySha256: string;
  status: SectionOriginalRebindStatus;
  /** Position in the exact supplied original file, not in DB body_cache. */
  originalSpan: null | {
    startUtf16: number;
    endUtf16: number;
    spanSha256: string;
  };
}

export interface SectionOriginalRebindReport {
  schemaVersion: "akp.s2.section-original-rebind.v1";
  candidateCount: number;
  verifiedSpanCount: number;
  decisions: SectionOriginalRebindDecision[];
  /** A separate external custody check is still required. */
  externalManifestAuthenticated: false;
  semanticSufficiencyMeasured: false;
  gateAccepted: false;
}

export function rebindSectionsToFrozenOriginal(
  candidates: readonly SectionShadowCandidate[],
  files: readonly IndependentlyFrozenSectionFile[],
): SectionOriginalRebindReport {
  const byDocument = new Map<string, IndependentlyFrozenSectionFile>();
  const fileKey = (input: {
    vaultId: string;
    documentId: string;
    revision: string;
    path: string;
  }) =>
    JSON.stringify([
      input.vaultId,
      input.documentId,
      input.revision,
      input.path,
    ]);
  for (const file of files) {
    const key = fileKey(file);
    if (byDocument.has(key)) throw new Error("DUPLICATE_FROZEN_SOURCE");
    byDocument.set(key, file);
  }
  const seen = new Set<string>();
  const referencedFiles = new Set(candidates.map(fileKey));
  if ([...byDocument.keys()].some((key) => !referencedFiles.has(key))) {
    throw new Error("UNEXPECTED_FROZEN_SOURCE");
  }
  const decisions: SectionOriginalRebindDecision[] = [];
  for (const candidate of candidates) {
    const sectionKeySha256 = digest(
      JSON.stringify([
        candidate.vaultId,
        candidate.documentId,
        candidate.sectionUnitId,
        candidate.revision,
      ]),
    );
    if (seen.has(sectionKeySha256)) {
      throw new Error("DUPLICATE_SECTION_CANDIDATE");
    }
    seen.add(sectionKeySha256);
    const decision = (
      status: SectionOriginalRebindStatus,
      originalSpan: SectionOriginalRebindDecision["originalSpan"] = null,
    ) => decisions.push({ sectionKeySha256, status, originalSpan });
    const file = byDocument.get(fileKey(candidate));
    if (!file) {
      decision("REVISION_IDENTITY_MISMATCH");
      continue;
    }
    if (
      !SHA256.test(file.fileSha256) ||
      digest(file.fileText) !== file.fileSha256
    ) {
      decision("ORIGINAL_FILE_HASH_MISMATCH");
      continue;
    }
    if (
      !validBoundary(file.fileText, file.bodyStartUtf16) ||
      !validBoundary(file.fileText, file.bodyEndUtf16) ||
      file.bodyEndUtf16 <= file.bodyStartUtf16
    ) {
      decision("ORIGINAL_BODY_FRAME_INVALID");
      continue;
    }
    const body = file.fileText.slice(file.bodyStartUtf16, file.bodyEndUtf16);
    if (
      !SHA256.test(candidate.projectionBodySha256) ||
      digest(body) !== candidate.projectionBodySha256
    ) {
      decision("ORIGINAL_BODY_PROJECTION_MISMATCH");
      continue;
    }
    const start = file.bodyStartUtf16 + candidate.sourceStartUtf16;
    const end = file.bodyStartUtf16 + candidate.sourceEndUtf16;
    if (
      !validBoundary(file.fileText, start) ||
      !validBoundary(file.fileText, end) ||
      start < file.bodyStartUtf16 ||
      end > file.bodyEndUtf16 ||
      end <= start
    ) {
      decision("ORIGINAL_SPAN_OUT_OF_BOUNDS");
      continue;
    }
    const span = file.fileText.slice(start, end);
    if (
      !SHA256.test(candidate.sourceSpanSha256) ||
      digest(span) !== candidate.sourceSpanSha256
    ) {
      decision("ORIGINAL_SPAN_HASH_MISMATCH");
      continue;
    }
    if (
      !SHA256.test(candidate.contentSha256) ||
      digest(candidate.body) !== candidate.contentSha256 ||
      span.replace(/\r\n?|\n/gu, "\n").trim() !== candidate.body
    ) {
      decision("ORIGINAL_SECTION_TEXT_MISMATCH");
      continue;
    }
    decision("FROZEN_FILE_SPAN_MATCHED", {
      startUtf16: start,
      endUtf16: end,
      spanSha256: digest(span),
    });
  }
  // No private original text, absolute paths, document IDs or queries in report.
  return {
    schemaVersion: "akp.s2.section-original-rebind.v1",
    candidateCount: candidates.length,
    verifiedSpanCount: decisions.filter(
      (entry) => entry.status === "FROZEN_FILE_SPAN_MATCHED",
    ).length,
    decisions,
    externalManifestAuthenticated: false,
    semanticSufficiencyMeasured: false,
    gateAccepted: false,
  };
}
