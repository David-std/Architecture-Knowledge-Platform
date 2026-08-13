import { createHash } from "node:crypto";

export const AUDIT_BUNDLE_SCHEMA_VERSION = "1.0";

export const AUDIT_BUNDLE_PATHS = [
  "BUNDLE_METADATA.json",
  "VAULT_MANIFEST.jsonl",
  "SOURCE_MANIFEST.jsonl",
  "DOCUMENTS.jsonl",
  "RELATIONS.jsonl",
  "EVIDENCE_INDEX.jsonl",
  "VALIDATION_RESULTS.json",
  "RETRIEVAL_BENCHMARK.json",
  "GAPS_AND_CONTRADICTIONS.json",
] as const;

export interface AuditBundleMetadata {
  schema_version: string;
  vault_id: string;
  vault_key?: string;
  platform_commit: string;
  vault_revision: string;
  corpus_revision: string;
  index_revisions: Record<string, unknown>;
  schema_profile?: Record<string, unknown>;
  retrieval_config: Record<string, unknown>;
  generated_at: string;
  limits: AuditExportLimits;
  counts: Record<string, number>;
  truncated: Record<string, boolean>;
  bundle_hash?: string;
}

export interface AuditExportLimits {
  maxSources: number;
  maxDocuments: number;
  maxRelations: number;
  maxEvidence: number;
  maxPackets: number;
  maxStringBytes: number;
  maxTotalBytes: number;
}

export interface AuditLocatorFilter {
  kind?: string;
  path?: string;
  page?: number;
  slide?: number;
  sheet?: string;
  row?: number;
  startLine?: number;
  endLine?: number;
  [key: string]: unknown;
}

export interface AuditBundleInput {
  metadata: Omit<
    AuditBundleMetadata,
    "limits" | "counts" | "truncated" | "bundle_hash"
  >;
  vaultManifest: readonly unknown[];
  sources: readonly unknown[];
  documents: readonly unknown[];
  relations: readonly unknown[];
  evidence: readonly unknown[];
  validationResults: unknown;
  retrievalBenchmark: unknown;
  gapsAndContradictions: unknown;
  sampleContextPackets?: readonly {
    id: string;
    packet: unknown;
  }[];
  locatorFilters?: readonly AuditLocatorFilter[];
  limits?: Partial<AuditExportLimits>;
}

export interface AuditBundle {
  metadata: AuditBundleMetadata;
  files: Readonly<Record<string, string>>;
  hash: string;
  totalBytes: number;
}

export class AuditExportLimitError extends Error {
  readonly code = "AUDIT_EXPORT_LIMIT_EXCEEDED";
}

const DEFAULT_LIMITS: AuditExportLimits = {
  maxSources: 10_000,
  maxDocuments: 20_000,
  maxRelations: 50_000,
  maxEvidence: 50_000,
  maxPackets: 20,
  maxStringBytes: 16_384,
  maxTotalBytes: 50 * 1024 * 1024,
};

const SENSITIVE_KEY =
  /(?:secret|token|password|credential|authorization|private[_-]?key|object[_-]?key|blob|binary|raw(?:_|$)|body(?:_|$)|bytes|(?:^|_)content[_-]?bytes$|(?:^|_)data$|(?:^|_)(?:source|local|canonical|host|absolute|file)[_-]?path$|(?:^|_)source[_-]?uri$)/i;

const SENSITIVE_NORMALIZED_KEYS = new Set([
  "privatekey",
  "objectkey",
  "rawbody",
  "rawcontent",
  "rawdata",
  "bodycache",
  "contentbytes",
  "sourceuri",
  "localpath",
  "canonicalpath",
  "hostpath",
  "absolutepath",
  "filepath",
  "licensedoriginal",
  "licensoriginal",
  "originalblob",
  "originalbytes",
]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function sanitize(
  value: unknown,
  limits: AuditExportLimits,
  key = "",
): unknown {
  const normalizedKey = key
    .replaceAll("_", "")
    .replaceAll("-", "")
    .toLowerCase();
  if (SENSITIVE_KEY.test(key) || SENSITIVE_NORMALIZED_KEYS.has(normalizedKey)) {
    return undefined;
  }
  if (
    typeof value === "string" &&
    (normalizedKey === "path" || normalizedKey.endsWith("path")) &&
    /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)
  ) {
    return undefined;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= limits.maxStringBytes) return value;
    return `${value.slice(0, limits.maxStringBytes)}…[TRUNCATED]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitize(entry, limits))
      .filter((entry) => entry !== undefined);
  }
  const output: Record<string, unknown> = {};
  for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
    const child = sanitize(
      (value as Record<string, unknown>)[childKey],
      limits,
      childKey,
    );
    if (child !== undefined) output[childKey] = child;
  }
  return output;
}

function safeRecord(value: unknown, limits: AuditExportLimits): unknown {
  return canonicalize(sanitize(value, limits));
}

function recordKey(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "";
  const record = value as Record<string, unknown>;
  for (const key of ["id", "path", "document_id", "source_id", "cluster_id"]) {
    if (record[key] !== undefined && record[key] !== null)
      return String(record[key]);
  }
  return JSON.stringify(canonicalize(value)) ?? "";
}

function orderedRows(
  rows: readonly unknown[],
  limit: number,
  limits: AuditExportLimits,
): { rows: unknown[]; truncated: boolean } {
  const sanitized = rows
    .map((row) => safeRecord(row, limits))
    .filter((row) => row !== undefined)
    .sort((left, right) => recordKey(left).localeCompare(recordKey(right)));
  return {
    rows: sanitized.slice(0, limit),
    truncated: sanitized.length > limit,
  };
}

function matchesLocator(value: unknown, filter: AuditLocatorFilter): boolean {
  if (!value || typeof value !== "object") return false;
  const locator = value as Record<string, unknown>;
  return Object.entries(filter).every(([key, expected]) => {
    const actual = locator[key];
    if (Array.isArray(expected))
      return JSON.stringify(actual) === JSON.stringify(expected);
    return actual === expected || String(actual) === String(expected);
  });
}

function filterEvidence(
  rows: readonly unknown[],
  filters: readonly AuditLocatorFilter[] | undefined,
): unknown[] {
  if (!filters?.length) return [...rows];
  return rows.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const locator = (row as Record<string, unknown>).locator;
    return filters.some((filter) => matchesLocator(locator, filter));
  });
}

function json(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function jsonl(rows: readonly unknown[]): string {
  return (
    rows.map((row) => JSON.stringify(canonicalize(row))).join("\n") +
    (rows.length ? "\n" : "")
  );
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Build a logical audit bundle.  Inputs must already be authorized and must
 * contain metadata-only projections; this module never reads the filesystem,
 * object store or database and therefore cannot accidentally export blobs.
 */
export function buildAuditBundle(input: AuditBundleInput): AuditBundle {
  const limits: AuditExportLimits = {
    ...DEFAULT_LIMITS,
    ...(input.limits ?? {}),
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AuditExportLimitError(`Invalid audit export limit: ${key}`);
    }
  }
  const sourceRows = orderedRows(input.sources, limits.maxSources, limits);
  const documentRows = orderedRows(
    input.documents,
    limits.maxDocuments,
    limits,
  );
  const relationRows = orderedRows(
    input.relations,
    limits.maxRelations,
    limits,
  );
  const evidenceRows = orderedRows(
    filterEvidence(input.evidence, input.locatorFilters),
    limits.maxEvidence,
    limits,
  );
  const packetRows = (input.sampleContextPackets ?? [])
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limits.maxPackets);
  const truncated = {
    sources: sourceRows.truncated,
    documents: documentRows.truncated,
    relations: relationRows.truncated,
    evidence: evidenceRows.truncated,
    sample_context_packets:
      (input.sampleContextPackets?.length ?? 0) > packetRows.length,
  };
  const files: Record<string, string> = {
    "VAULT_MANIFEST.jsonl": jsonl(
      orderedRows(input.vaultManifest, 1, limits).rows,
    ),
    "SOURCE_MANIFEST.jsonl": jsonl(sourceRows.rows),
    "DOCUMENTS.jsonl": jsonl(documentRows.rows),
    "RELATIONS.jsonl": jsonl(relationRows.rows),
    "EVIDENCE_INDEX.jsonl": jsonl(evidenceRows.rows),
    "VALIDATION_RESULTS.json": json(
      safeRecord(input.validationResults, limits),
    ),
    "RETRIEVAL_BENCHMARK.json": json(
      safeRecord(input.retrievalBenchmark, limits),
    ),
    "GAPS_AND_CONTRADICTIONS.json": json(
      safeRecord(input.gapsAndContradictions, limits),
    ),
  };
  for (const packet of packetRows) {
    const safeId =
      packet.id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "packet";
    files[`SAMPLE_CONTEXT_PACKETS/${safeId}.json`] = json(
      safeRecord(packet.packet, limits),
    );
  }
  const counts = {
    sources: sourceRows.rows.length,
    documents: documentRows.rows.length,
    relations: relationRows.rows.length,
    evidence: evidenceRows.rows.length,
    sample_context_packets: packetRows.length,
  };
  const safeMetadata = safeRecord(input.metadata, limits) as Record<
    string,
    unknown
  >;
  const safeMetadataString = (key: string, fallback: string): string =>
    typeof safeMetadata[key] === "string"
      ? String(safeMetadata[key])
      : fallback;
  const safeMetadataObject = (
    key: string,
    fallback: Record<string, unknown>,
  ): Record<string, unknown> => {
    const value = safeMetadata[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fallback;
  };
  const metadataWithoutHash = {
    ...safeMetadata,
    vault_id: safeMetadataString("vault_id", input.metadata.vault_id),
    platform_commit: safeMetadataString(
      "platform_commit",
      input.metadata.platform_commit,
    ),
    vault_revision: safeMetadataString(
      "vault_revision",
      input.metadata.vault_revision,
    ),
    corpus_revision: safeMetadataString(
      "corpus_revision",
      input.metadata.corpus_revision,
    ),
    index_revisions: safeMetadataObject("index_revisions", {}),
    retrieval_config: safeMetadataObject("retrieval_config", {}),
    generated_at: safeMetadataString(
      "generated_at",
      input.metadata.generated_at,
    ),
    schema_version: safeMetadataString(
      "schema_version",
      input.metadata.schema_version || AUDIT_BUNDLE_SCHEMA_VERSION,
    ),
    limits,
    counts,
    truncated,
  } satisfies Omit<AuditBundleMetadata, "bundle_hash">;
  const metadataWithoutHashJson = json(metadataWithoutHash);
  const payload = Object.entries({
    ...files,
    "BUNDLE_METADATA.json": metadataWithoutHashJson,
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${name}\n${content}`)
    .join("");
  const hash = sha256(Buffer.from(payload, "utf8"));
  const metadata: AuditBundleMetadata = {
    ...metadataWithoutHash,
    bundle_hash: hash,
  };
  files["BUNDLE_METADATA.json"] = json(metadata);
  const totalBytes = Object.entries(files).reduce(
    (total, [name, content]) =>
      total +
      Buffer.byteLength(name, "utf8") +
      Buffer.byteLength(content, "utf8"),
    0,
  );
  if (totalBytes > limits.maxTotalBytes) {
    throw new AuditExportLimitError(
      `Audit bundle exceeds maxTotalBytes (${totalBytes} > ${limits.maxTotalBytes})`,
    );
  }
  return { metadata, files, hash, totalBytes };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Render a deterministic, uncompressed ZIP without adding a dependency. */
export function renderAuditZip(bundle: AuditBundle): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const entries = Object.entries(bundle.files).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const contentBytes = Buffer.from(content, "utf8");
    const checksum = crc32(contentBytes);
    const local = concat([
      Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(contentBytes.byteLength),
      u32(contentBytes.byteLength),
      u16(nameBytes.byteLength),
      u16(0),
      nameBytes,
      contentBytes,
    ]);
    localParts.push(local);
    const central = concat([
      Uint8Array.of(0x50, 0x4b, 0x01, 0x02),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(contentBytes.byteLength),
      u32(contentBytes.byteLength),
      u16(nameBytes.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    centralParts.push(central);
    offset += local.byteLength;
  }
  const local = concat(localParts);
  const central = concat(centralParts);
  const end = concat([
    Uint8Array.of(0x50, 0x4b, 0x05, 0x06),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.byteLength),
    u32(local.byteLength),
    u16(0),
  ]);
  return concat([local, central, end]);
}
