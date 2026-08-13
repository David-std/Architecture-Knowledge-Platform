import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const AUDIT_EXPORT_CONFIRMATION = "EXPORT_SANITIZED_AUDIT_BUNDLE";
export const RAW_EVIDENCE_EXPORT_CONFIRMATION = "EXPORT_RAW_EVIDENCE";
export const RAW_EVIDENCE_EXPORT_HARD_MAX_BYTES = 50 * 1024 * 1024;

export interface AuditExportClientOptions {
  apiBase: string;
  token: string;
  vaultId: string;
  confirmation: string;
  outputPath?: string;
  locator?: string;
  continuation?: string;
  schemaVersion?: string;
  maxSources?: number;
  maxDocuments?: number;
  maxRelations?: number;
  maxEvidence?: number;
  maxPackets?: number;
  maxStringBytes?: number;
  maxTotalBytes?: number;
  fetchImpl?: typeof fetch;
  exportRoots?: readonly string[];
}

export interface AuditExportResult {
  status: "READY" | "EXPORTED";
  schemaVersion: string;
  bundleHash: string | null;
  bytes: number | null;
  path: string | null;
  continuation: string | null;
  authenticated: true;
}

export interface RawEvidenceExportClientOptions {
  apiBase: string;
  token: string;
  vaultId: string;
  evidenceId?: string;
  locator?: string;
  confirmation: string;
  outputPath?: string;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  exportRoots?: readonly string[];
}

export interface RawEvidenceExportResult {
  status: "READY" | "EXPORTED";
  sha256: string | null;
  bytes: number | null;
  path: string | null;
  authenticated: true;
}

export class AuditExportClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    options: { status?: number | null; details?: unknown } = {},
  ) {
    super(message);
    this.name = "AuditExportClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.details = options.details ?? null;
  }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export function parseExportRoots(
  value = process.env.AKP_EXPORT_ROOTS,
): string[] {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

/** Resolve an explicit destination without permitting traversal or symlink escape. */
export async function resolveAuditExportPath(
  outputPath: string,
  roots: readonly string[],
): Promise<string> {
  if (!outputPath.trim()) {
    throw new AuditExportClientError(
      "OUTPUT_PATH_REQUIRED",
      "outputPath must not be empty",
    );
  }
  if (roots.length === 0) {
    throw new AuditExportClientError(
      "EXPORT_ROOTS_REQUIRED",
      "AKP_EXPORT_ROOTS must name at least one approved export root",
    );
  }
  const target = path.resolve(outputPath);
  const lexicalRoot = roots.find((root) =>
    isWithin(target, path.resolve(root)),
  );
  if (!lexicalRoot) {
    throw new AuditExportClientError(
      "EXPORT_PATH_DENIED",
      "The requested output path is outside AKP_EXPORT_ROOTS",
    );
  }
  const root = await realpath(path.resolve(lexicalRoot)).catch(() => {
    throw new AuditExportClientError(
      "EXPORT_ROOT_NOT_FOUND",
      "An approved export root does not exist",
    );
  });
  const parent = path.dirname(target);
  let existingAncestor = parent;
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      const next = path.dirname(existingAncestor);
      if (next === existingAncestor) {
        throw new AuditExportClientError(
          "EXPORT_PATH_DENIED",
          "The output path has no canonical approved ancestor",
        );
      }
      existingAncestor = next;
    }
  }
  const canonicalAncestor = await realpath(existingAncestor);
  if (!isWithin(canonicalAncestor, root)) {
    throw new AuditExportClientError(
      "EXPORT_PATH_DENIED",
      "The output parent would traverse outside AKP_EXPORT_ROOTS",
    );
  }
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent).catch(() => {
    throw new AuditExportClientError(
      "EXPORT_PATH_DENIED",
      "The output parent cannot be canonicalized",
    );
  });
  if (!isWithin(canonicalParent, root)) {
    throw new AuditExportClientError(
      "EXPORT_PATH_DENIED",
      "The output parent resolves outside AKP_EXPORT_ROOTS",
    );
  }
  try {
    await lstat(target);
    throw new AuditExportClientError(
      "EXPORT_TARGET_EXISTS",
      "Audit export refuses to overwrite an existing path",
    );
  } catch (error) {
    if (error instanceof AuditExportClientError) throw error;
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT") throw error;
  }
  return target;
}

function queryFor(options: AuditExportClientOptions): string {
  const query = new URLSearchParams();
  query.set("confirm", options.confirmation);
  if (options.locator) query.set("locator", options.locator);
  if (options.continuation) query.set("continuation", options.continuation);
  const limits: Array<[keyof AuditExportClientOptions, string]> = [
    ["maxSources", "maxSources"],
    ["maxDocuments", "maxDocuments"],
    ["maxRelations", "maxRelations"],
    ["maxEvidence", "maxEvidence"],
    ["maxPackets", "maxPackets"],
    ["maxStringBytes", "maxStringBytes"],
    ["maxTotalBytes", "maxTotalBytes"],
  ];
  for (const [key, queryKey] of limits) {
    const value = options[key];
    if (typeof value === "number") query.set(queryKey, String(value));
  }
  return query.toString();
}

async function responseDetails(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

export async function requestAuditExport(
  options: AuditExportClientOptions,
): Promise<AuditExportResult> {
  if (options.confirmation !== AUDIT_EXPORT_CONFIRMATION) {
    throw new AuditExportClientError(
      "EXPORT_CONFIRMATION_REQUIRED",
      `confirmation must equal ${AUDIT_EXPORT_CONFIRMATION}`,
    );
  }
  if (!options.token) {
    throw new AuditExportClientError(
      "AUTHENTICATION_REQUIRED",
      "AKP_API_TOKEN is required for audit export",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = queryFor(options);
  const suffix = query ? `?${query}` : "";
  const endpoint = `${options.apiBase.replace(/\/+$/, "")}/v1/audit/export/${encodeURIComponent(options.vaultId)}${suffix}`;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      accept: "application/zip",
      authorization: `Bearer ${options.token}`,
    },
  });
  if (!response.ok) {
    const details = await responseDetails(response);
    const record =
      details && typeof details === "object"
        ? (details as Record<string, unknown>)
        : {};
    throw new AuditExportClientError(
      typeof record.code === "string" ? record.code : `HTTP_${response.status}`,
      typeof record.message === "string"
        ? record.message
        : `AKP API request failed (${response.status})`,
      { status: response.status, details },
    );
  }
  const schemaVersion =
    response.headers.get("x-akp-bundle-schema-version") ??
    options.schemaVersion ??
    "unknown";
  const bundleHash = response.headers.get("x-akp-bundle-hash");
  const continuation = response.headers.get("x-akp-export-continuation");
  if (!options.outputPath) {
    await response.body?.cancel();
    const contentLength = response.headers.get("content-length");
    const bytes =
      contentLength && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : null;
    return {
      status: "READY",
      schemaVersion,
      bundleHash,
      bytes,
      path: null,
      continuation,
      authenticated: true,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const target = await resolveAuditExportPath(
    options.outputPath,
    options.exportRoots ?? parseExportRoots(),
  );
  try {
    await writeFile(target, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new AuditExportClientError(
        "EXPORT_TARGET_EXISTS",
        "Audit export refuses to overwrite an existing path",
      );
    }
    throw error;
  }
  return {
    status: "EXPORTED",
    schemaVersion,
    bundleHash,
    bytes: bytes.byteLength,
    path: target,
    continuation,
    authenticated: true,
  };
}

function rawEvidenceQuery(options: RawEvidenceExportClientOptions): string {
  const query = new URLSearchParams();
  query.set("confirm", options.confirmation);
  if (options.evidenceId && !options.evidenceId.trim()) {
    throw new AuditExportClientError(
      "EVIDENCE_ID_INVALID",
      "evidenceId must not be empty",
    );
  }
  if (options.locator) query.set("locator", options.locator);
  if (typeof options.maxBytes === "number") {
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > RAW_EVIDENCE_EXPORT_HARD_MAX_BYTES
    ) {
      throw new AuditExportClientError(
        "RAW_EVIDENCE_LIMIT_INVALID",
        `maxBytes must be between 1 and ${RAW_EVIDENCE_EXPORT_HARD_MAX_BYTES}`,
      );
    }
    query.set("maxBytes", String(options.maxBytes));
  }
  return query.toString();
}

export async function requestRawEvidenceExport(
  options: RawEvidenceExportClientOptions,
): Promise<RawEvidenceExportResult> {
  if (options.confirmation !== RAW_EVIDENCE_EXPORT_CONFIRMATION) {
    throw new AuditExportClientError(
      "RAW_EVIDENCE_CONFIRMATION_REQUIRED",
      `confirmation must equal ${RAW_EVIDENCE_EXPORT_CONFIRMATION}`,
    );
  }
  if (!options.token) {
    throw new AuditExportClientError(
      "AUTHENTICATION_REQUIRED",
      "AKP_API_TOKEN is required for raw evidence export",
    );
  }
  if (!options.evidenceId && !options.locator) {
    throw new AuditExportClientError(
      "EVIDENCE_SELECTOR_REQUIRED",
      "Provide evidenceId or locator",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = rawEvidenceQuery(options);
  const suffix = query ? `?${query}` : "";
  const pathSuffix = options.evidenceId
    ? `/${encodeURIComponent(options.evidenceId)}`
    : "";
  const endpoint = `${options.apiBase.replace(/\/+$/, "")}/v1/evidence/export/${encodeURIComponent(options.vaultId)}${pathSuffix}${suffix}`;
  const response = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      accept: "application/octet-stream",
      authorization: `Bearer ${options.token}`,
    },
  });
  if (!response.ok) {
    const details = await responseDetails(response);
    const record =
      details && typeof details === "object"
        ? (details as Record<string, unknown>)
        : {};
    throw new AuditExportClientError(
      typeof record.code === "string" ? record.code : `HTTP_${response.status}`,
      typeof record.message === "string"
        ? record.message
        : `AKP API request failed (${response.status})`,
      { status: response.status, details },
    );
  }
  const digest = response.headers.get("x-akp-evidence-sha256");
  const contentLength =
    response.headers.get("x-akp-evidence-bytes") ??
    response.headers.get("content-length");
  const advertisedBytes =
    contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  if (!options.outputPath) {
    await response.body?.cancel();
    return {
      status: "READY",
      sha256: digest,
      bytes: advertisedBytes,
      path: null,
      authenticated: true,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    typeof options.maxBytes === "number" &&
    bytes.byteLength > options.maxBytes
  ) {
    throw new AuditExportClientError(
      "RAW_EVIDENCE_LIMIT_EXCEEDED",
      "The downloaded evidence exceeds the requested client limit",
    );
  }
  const target = await resolveAuditExportPath(
    options.outputPath,
    options.exportRoots ?? parseExportRoots(),
  );
  try {
    await writeFile(target, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new AuditExportClientError(
        "EXPORT_TARGET_EXISTS",
        "Evidence export refuses to overwrite an existing path",
      );
    }
    throw error;
  }
  return {
    status: "EXPORTED",
    sha256: digest,
    bytes: bytes.byteLength,
    path: target,
    authenticated: true,
  };
}
