import { TextDecoder } from "node:util";
import type { ObjectStore } from "@akp/object-store";
import type { GovernedTemporalEvidenceReference } from "@akp/postgres";
import { readAndVerifyRawEvidence } from "./routes/audit-export.js";

/** Shadow-only: bounded direct textual excerpts, not OCR/PDF or inferred quotes. */
const MAX_VERIFIED_RAW_BYTES = 2 * 1024 * 1024;
const TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

/**
 * Re-reads the immutable SOURCE object; verifies its SHA-256/size/key and
 * proves one exact occurrence of the evidence excerpt in its UTF-8 text.
 *
 * A SOURCE fallback locator is the only supported kind here. Paragraph,
 * image and PDF locators require a separate independently verified artifact
 * transform, not a guess that extracted prose appears in original raw bytes.
 * Do not use this check as natural-language claim entailment.
 */
export async function verifyGovernedRawSourceExcerpt(
  objectStore: ObjectStore,
  evidence: GovernedTemporalEvidenceReference,
): Promise<boolean> {
  const locator = evidence.locator;
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return false;
  }
  const record = locator as Record<string, unknown>;
  if (
    record.kind !== "source" ||
    record.path !== `source:${evidence.sourceId}` ||
    record.source_hash !== evidence.sourceSha256 ||
    !TEXT_MEDIA_TYPES.has(
      (evidence.sourceMediaType ?? "").split(";")[0]?.trim().toLowerCase() ??
        "",
    ) ||
    !/^[a-f0-9]{64}$/.test(evidence.sourceSha256) ||
    !evidence.excerpt ||
    !Number.isSafeInteger(Number(evidence.sourceByteSize)) ||
    Number(evidence.sourceByteSize) < 1 ||
    Number(evidence.sourceByteSize) > MAX_VERIFIED_RAW_BYTES
  ) {
    return false;
  }

  try {
    const ref = await objectStore.exists(evidence.sourceSha256);
    if (!ref) return false;
    const verified = await readAndVerifyRawEvidence(
      objectStore,
      ref,
      {
        sha256: evidence.sourceSha256,
        objectKey: evidence.sourceObjectKey,
        byteSize: Number(evidence.sourceByteSize),
      },
      MAX_VERIFIED_RAW_BYTES,
    );
    const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(
      verified.bytes,
    );
    const start = sourceText.indexOf(evidence.excerpt);
    return start >= 0 && sourceText.lastIndexOf(evidence.excerpt) === start;
  } catch {
    // Missing, changed or unreachable immutable evidence never promotes an
    // answer; do not expose raw SOURCE bytes or store errors in search traces.
    return false;
  }
}
