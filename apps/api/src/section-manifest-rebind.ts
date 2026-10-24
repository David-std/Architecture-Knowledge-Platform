import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { SectionShadowCandidate } from "./section-candidate-shadow.js";
import {
  rebindSectionsToFrozenOriginal,
  type IndependentlyFrozenSectionFile,
  type SectionOriginalRebindReport,
} from "./section-original-rebind.js";

/**
 * OFFLINE EVALUATION ONLY. The pin must be acquired independently of this
 * manifest (e.g. a precommitted digest under custodian control).
 * A matching digest does not independently establish custody or permission.
 * Never call this module from HTTP, admission, retrieval or model inference.
 */
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 256_000;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_000_000;
const SHA = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

type FrozenFileRecord = {
  vaultId: string;
  documentId: string;
  revision: string;
  path: string;
  fileSha256: string;
  bodyStartUtf16: number;
  bodyEndUtf16: number;
};

export interface FrozenFileBytes {
  vaultId: string;
  documentId: string;
  revision: string;
  path: string;
  /** Original file bytes from a custodian-authorized immutable revision. */
  bytes: Uint8Array;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}

function exactKeys(
  input: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    Object.keys(input).length === expected.length &&
    expected.every((key) => Object.hasOwn(input, key))
  );
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1024 &&
    !value.includes("\0")
  );
}

function validRecord(input: unknown): input is FrozenFileRecord {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "vaultId",
      "documentId",
      "revision",
      "path",
      "fileSha256",
      "bodyStartUtf16",
      "bodyEndUtf16",
    ])
  )
    return false;
  const path = input.path;
  if (
    !validIdentity(input.vaultId) ||
    !validIdentity(input.documentId) ||
    !validIdentity(input.revision) ||
    !validIdentity(path) ||
    !/^[a-f0-9]{64}$/u.test(String(input.fileSha256)) ||
    !Number.isSafeInteger(input.bodyStartUtf16) ||
    !Number.isSafeInteger(input.bodyEndUtf16) ||
    Number(input.bodyStartUtf16) < 0 ||
    Number(input.bodyEndUtf16) <= Number(input.bodyStartUtf16)
  )
    return false;
  const segments = path.replaceAll("\\", "/").split("/");
  return (
    !path.startsWith("/") &&
    !/^[a-z]:/iu.test(path) &&
    !path.includes("\\") &&
    segments.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function identity(input: {
  vaultId: string;
  documentId: string;
  revision: string;
  path: string;
}): string {
  return JSON.stringify([
    input.vaultId,
    input.documentId,
    input.revision,
    input.path,
  ]);
}

export interface PinnedSectionRebindResult {
  schemaVersion: "akp.s2.section-pinned-manifest-rebind.v1";
  /** Matches a digest supplied separately from the manifest bytes. */
  manifestPinMatched: true;
  manifestSha256: string;
  fileCount: number;
  spanReport: SectionOriginalRebindReport;
  /** Not established by hashing data provided by the same operator. */
  externalCustodyIndependentlyAttested: false;
  gateAccepted: false;
}

export function verifyPinnedSectionRebind(input: {
  trustedManifestSha256: string;
  frozenManifestBytes: Uint8Array;
  frozenFiles: readonly FrozenFileBytes[];
  candidates: readonly SectionShadowCandidate[];
}): PinnedSectionRebindResult {
  if (
    !SHA256.test(input.trustedManifestSha256) ||
    input.frozenManifestBytes.byteLength === 0 ||
    input.frozenManifestBytes.byteLength > MAX_MANIFEST_BYTES ||
    SHA(input.frozenManifestBytes) !== input.trustedManifestSha256
  ) {
    throw new Error("SECTION_MANIFEST_PIN_MISMATCH");
  }
  let manifest: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(input.frozenManifestBytes);
    manifest = JSON.parse(text) as unknown;
  } catch {
    throw new Error("SECTION_MANIFEST_INVALID");
  }
  if (
    !isRecord(manifest) ||
    !exactKeys(manifest, ["schemaVersion", "files"]) ||
    manifest.schemaVersion !== "akp.s2.section-frozen-manifest.v1" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_FILES ||
    !manifest.files.every(validRecord)
  ) {
    throw new Error("SECTION_MANIFEST_INVALID");
  }

  const manifestRows = manifest.files as FrozenFileRecord[];
  const expected = new Map<string, FrozenFileRecord>();
  for (const item of manifestRows) {
    const key = identity(item);
    if (expected.has(key)) throw new Error("SECTION_MANIFEST_DUPLICATE_FILE");
    expected.set(key, item);
  }
  if (input.frozenFiles.length !== expected.size) {
    throw new Error("SECTION_FROZEN_FILE_SET_MISMATCH");
  }

  const actual = new Set<string>();
  const originalFiles: IndependentlyFrozenSectionFile[] = [];
  for (const item of input.frozenFiles) {
    const key = identity(item);
    const pinned = expected.get(key);
    if (!pinned || actual.has(key)) {
      throw new Error("SECTION_FROZEN_FILE_SET_MISMATCH");
    }
    actual.add(key);
    if (
      item.bytes.byteLength > MAX_FILE_BYTES ||
      SHA(item.bytes) !== pinned.fileSha256
    ) {
      throw new Error("SECTION_FROZEN_FILE_HASH_MISMATCH");
    }
    let fileText: string;
    try {
      fileText = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(item.bytes);
    } catch {
      throw new Error("SECTION_FROZEN_FILE_ENCODING_INVALID");
    }
    originalFiles.push({
      vaultId: pinned.vaultId,
      documentId: pinned.documentId,
      revision: pinned.revision,
      path: pinned.path,
      fileSha256: pinned.fileSha256,
      fileText,
      bodyStartUtf16: pinned.bodyStartUtf16,
      bodyEndUtf16: pinned.bodyEndUtf16,
    });
  }

  // No unexpected, duplicate or missing candidate/file identity is tolerated.
  const candidateFileSet = new Set(input.candidates.map(identity));
  if (
    candidateFileSet.size !== expected.size ||
    [...expected.keys()].some((key) => !candidateFileSet.has(key))
  ) {
    throw new Error("SECTION_CANDIDATE_MANIFEST_SCOPE_MISMATCH");
  }
  const spanReport = rebindSectionsToFrozenOriginal(
    input.candidates,
    originalFiles,
  );
  if (spanReport.verifiedSpanCount !== spanReport.candidateCount) {
    // Keep all failure statuses in the returned diagnostic, never admit them.
    // This routine does not call the application or change the gate.
  }
  return {
    schemaVersion: "akp.s2.section-pinned-manifest-rebind.v1",
    manifestPinMatched: true,
    manifestSha256: input.trustedManifestSha256,
    fileCount: expected.size,
    spanReport,
    externalCustodyIndependentlyAttested: false,
    gateAccepted: false,
  };
}
