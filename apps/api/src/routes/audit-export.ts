import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuditExportLimitError,
  buildAuditBundle,
  renderAuditZip,
  type AuditExportLimits,
  type AuditLocatorFilter,
} from "@akp/audit-export";
import {
  intersectVaultPathPrefixes,
  pathMatchesVaultPrefix,
  getVault,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import type { ObjectStore, RawObjectRef } from "@akp/object-store";
import { z } from "zod";
import {
  actorOf,
  audit,
  hasPermission,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";

const AuditExportQuery = z.object({
  confirm: z.literal("EXPORT_SANITIZED_AUDIT_BUNDLE"),
  locator: z.string().max(8192).optional(),
  maxSources: z.coerce.number().int().positive().max(10_000).optional(),
  maxDocuments: z.coerce.number().int().positive().max(20_000).optional(),
  maxRelations: z.coerce.number().int().positive().max(50_000).optional(),
  maxEvidence: z.coerce.number().int().positive().max(50_000).optional(),
  maxPackets: z.coerce.number().int().positive().max(20).optional(),
  maxStringBytes: z.coerce.number().int().positive().max(16_384).optional(),
  maxTotalBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .optional(),
});

export const RAW_EVIDENCE_EXPORT_CONFIRMATION = "EXPORT_RAW_EVIDENCE";
export const RAW_EVIDENCE_EXPORT_HARD_MAX_BYTES = 50 * 1024 * 1024;

const RawEvidenceExportQuery = z.object({
  confirm: z.literal(RAW_EVIDENCE_EXPORT_CONFIRMATION),
  evidenceId: z.string().uuid().optional(),
  locator: z.string().max(8192).optional(),
  maxBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(RAW_EVIDENCE_EXPORT_HARD_MAX_BYTES)
    .default(RAW_EVIDENCE_EXPORT_HARD_MAX_BYTES),
});

interface RawEvidenceLocatorSelector {
  [key: string]: unknown;
}

interface RawEvidenceRow {
  id: string;
  vault_id: string;
  space_id: string;
  source_id: string;
  artifact_id: string | null;
  locator: unknown;
  source_sha256: string;
  artifact_source_hash: string | null;
  object_key: string;
  byte_size: number | string;
  media_type: string | null;
  document_paths: string[];
}

export class RawEvidenceExportError extends Error {
  constructor(
    readonly code:
      | "RAW_OBJECT_STORE_NOT_CONFIGURED"
      | "RAW_EVIDENCE_NOT_FOUND"
      | "RAW_EVIDENCE_SELECTOR_AMBIGUOUS"
      | "RAW_EVIDENCE_PATH_SCOPE_DENIED"
      | "RAW_EVIDENCE_TOO_LARGE"
      | "RAW_EVIDENCE_INTEGRITY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RawEvidenceExportError";
  }
}

export function parseRawEvidenceLocator(
  value?: string,
): RawEvidenceLocatorSelector | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("INVALID_EVIDENCE_LOCATOR");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed as Record<string, unknown>).length > 32
  ) {
    throw new Error("INVALID_EVIDENCE_LOCATOR");
  }
  return parsed as RawEvidenceLocatorSelector;
}

function locatorMatches(
  actual: unknown,
  selector: RawEvidenceLocatorSelector | undefined,
): boolean {
  if (!selector) return true;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const record = actual as Record<string, unknown>;
  return Object.entries(selector).every(([key, expected]) => {
    const value = record[key];
    return Array.isArray(expected)
      ? JSON.stringify(value) === JSON.stringify(expected)
      : value === expected;
  });
}

function safeMediaType(value: string | null): string {
  if (!value || /[\r\n]/.test(value)) return "application/octet-stream";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[\x20-\x7e]*)?$/i.test(
    value,
  )
    ? value
    : "application/octet-stream";
}

export function rawEvidenceContentDisposition(evidenceId: string): string {
  const safeId = evidenceId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  return `attachment; filename="akp-evidence-${safeId || "item"}.bin"`;
}

interface RawEvidenceBytes {
  bytes: Buffer;
  sha256: string;
}

/** Read and hash an immutable object before sending it to the client. */
export async function readAndVerifyRawEvidence(
  store: ObjectStore,
  ref: RawObjectRef,
  expected: { sha256: string; byteSize: number; objectKey: string },
  maxBytes: number,
): Promise<RawEvidenceBytes> {
  if (
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    expected.byteSize < 0 ||
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize > maxBytes ||
    ref.sha256 !== expected.sha256 ||
    ref.key !== expected.objectKey ||
    ref.bytes !== expected.byteSize
  ) {
    if (expected.byteSize > maxBytes) {
      throw new RawEvidenceExportError(
        "RAW_EVIDENCE_TOO_LARGE",
        "The source exceeds the configured raw-evidence export limit.",
      );
    }
    throw new RawEvidenceExportError(
      "RAW_EVIDENCE_INTEGRITY_FAILED",
      "The immutable source metadata does not match the requested evidence.",
    );
  }
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = await store.get(ref);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        throw new RawEvidenceExportError(
          "RAW_EVIDENCE_TOO_LARGE",
          "The immutable object exceeds the configured raw-evidence export limit.",
        );
      }
      hash.update(buffer);
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof RawEvidenceExportError) throw error;
    throw new RawEvidenceExportError(
      "RAW_EVIDENCE_INTEGRITY_FAILED",
      "The immutable source could not be read completely.",
    );
  }
  const sha256 = hash.digest("hex");
  if (bytes !== expected.byteSize || sha256 !== expected.sha256) {
    throw new RawEvidenceExportError(
      "RAW_EVIDENCE_INTEGRITY_FAILED",
      "The immutable source failed SHA-256 or byte-size verification.",
    );
  }
  return { bytes: Buffer.concat(chunks), sha256 };
}

function locatorFilters(value?: string): AuditLocatorFilter[] | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (
    values.length > 16 ||
    values.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new Error("INVALID_LOCATOR_FILTER");
  }
  return values as AuditLocatorFilter[];
}

function packetManifest(row: Record<string, unknown>): Record<string, unknown> {
  const packet = (row.packet ?? {}) as Record<string, unknown>;
  const sections = Array.isArray(packet.sections) ? packet.sections : [];
  return {
    id: row.id,
    corpus_revision: row.corpus_revision,
    packet_hash: row.packet_hash,
    scope: row.scope,
    created_at: row.created_at,
    status: packet.status,
    budget: packet.budget,
    citation_count: Array.isArray(packet.citations)
      ? packet.citations.length
      : 0,
    sections: sections.map((value) => {
      const section = value as Record<string, unknown>;
      return {
        kind: section.kind,
        documentId: section.documentId,
        vaultId: section.vaultId,
        unitId: section.unitId,
        documentRevision: section.documentRevision,
        retrievalChannels: section.retrievalChannels,
        score: section.score,
      };
    }),
  };
}

const DEFAULT_ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  VIEWER: ["knowledge:read", "source:read"],
  CONTRIBUTOR: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
  ],
  CURATOR: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
  ],
  REVIEWER: ["knowledge:read", "source:read", "knowledge:review"],
  ARCHITECT: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
    "knowledge:review",
    "eval:run",
  ],
  ADMIN: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
    "knowledge:review",
    "eval:run",
    "admin",
  ],
  SERVICE_ACCOUNT: ["knowledge:read", "source:read", "source:write"],
};

function membershipHasSourceRead(row: {
  role: string;
  permissions: unknown;
}): boolean {
  const configured = Array.isArray(row.permissions)
    ? row.permissions.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return (
    configured.length > 0
      ? configured
      : (DEFAULT_ROLE_PERMISSIONS[row.role] ?? [])
  ).some(
    (permission) => permission === "source:read" || permission === "admin",
  );
}

async function rawEvidencePathAllowed(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  vault: { id: string; space_id: string; visibility: string },
  documentPaths: readonly string[],
): Promise<boolean> {
  if (!actor) return false;
  if (
    hasUnrestrictedPathAccess(actor, vault.space_id, "source:read") ||
    hasUnrestrictedPathAccess(actor, vault.space_id, "admin")
  ) {
    return true;
  }
  if (documentPaths.length === 0) return false;

  const memberships = actor.memberships.filter(
    (membership) =>
      membership.spaceId === vault.space_id &&
      (membership.permissions ?? []).some(
        (permission) => permission === "source:read" || permission === "admin",
      ),
  );
  if (memberships.length === 0) return false;
  const vaultMemberships = await db.pool.query<{
    role: string;
    path_prefix: string | null;
    permissions: unknown;
  }>(
    `select role,path_prefix,permissions
       from vault_memberships
      where user_id=$1 and vault_id=$2 and enabled=true`,
    [actor.id, vault.id],
  );

  const prefixes: Array<string | null> = [];
  if (vaultMemberships.rowCount) {
    for (const vaultMembership of vaultMemberships.rows) {
      if (!membershipHasSourceRead(vaultMembership)) continue;
      for (const membership of memberships) {
        const prefix = intersectVaultPathPrefixes(
          membership.pathPrefix,
          vaultMembership.path_prefix,
        );
        if (prefix !== undefined) prefixes.push(prefix);
      }
    }
  } else if (vault.visibility !== "PRIVATE") {
    prefixes.push(...memberships.map((membership) => membership.pathPrefix));
  }
  return documentPaths.some((documentPath) =>
    prefixes.some(
      (prefix) =>
        prefix === null || pathMatchesVaultPrefix(documentPath, prefix),
    ),
  );
}

async function selectRawEvidence(
  db: Postgres,
  vault: { id: string; space_id: string },
  selector: { evidenceId?: string; locator?: RawEvidenceLocatorSelector },
): Promise<RawEvidenceRow[]> {
  const values: unknown[] = [vault.id, vault.space_id];
  const predicates = [
    "e.vault_id=$1",
    "e.space_id=$2",
    "s.vault_id=$1",
    "s.space_id=$2",
  ];
  if (selector.evidenceId) {
    values.push(selector.evidenceId);
    predicates.push(`e.id=$${values.length}::uuid`);
  }
  if (selector.locator) {
    values.push(JSON.stringify(selector.locator));
    predicates.push(`e.locator @> $${values.length}::jsonb`);
  }
  const result = await db.pool.query<RawEvidenceRow>(
    `
    select e.id,e.vault_id,e.space_id,e.source_id,e.artifact_id,e.locator,
           s.sha256 source_sha256, s.object_key, s.byte_size, s.media_type,
           sa.source_hash artifact_source_hash,
           coalesce(array_agg(distinct d.path) filter (where d.path is not null), '{}') document_paths
      from evidence e
      join sources s on s.id=e.source_id
      left join source_artifacts sa on sa.id=e.artifact_id
      left join document_evidence de on de.evidence_id=e.id
      left join knowledge_documents d
        on d.id=de.document_id and d.space_id=e.space_id and d.vault_id=e.vault_id
     where ${predicates.join(" and ")}
     group by e.id,e.vault_id,e.space_id,e.source_id,e.artifact_id,e.locator,
              s.sha256,s.object_key,s.byte_size,s.media_type,sa.source_hash
     order by e.created_at desc
     limit 2
    `,
    values,
  );
  return result.rows;
}

async function handleRawEvidenceExport(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Postgres,
  rawObjectStore: ObjectStore | undefined,
  pathEvidenceId?: string,
): Promise<unknown> {
  const actor = actorOf(request);
  if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
  if (!rawObjectStore) {
    return reply.code(503).send({ code: "RAW_OBJECT_STORE_NOT_CONFIGURED" });
  }
  const query = RawEvidenceExportQuery.safeParse(request.query);
  if (!query.success) {
    return reply.code(400).send({
      code: "RAW_EVIDENCE_CONFIRMATION_REQUIRED",
      issues: query.error.issues,
    });
  }
  const params = request.params as { vaultId: string; evidenceId?: string };
  const routeEvidenceId = pathEvidenceId ?? params.evidenceId;
  if (
    routeEvidenceId &&
    !z.string().uuid().safeParse(routeEvidenceId).success
  ) {
    return reply.code(400).send({ code: "INVALID_EVIDENCE_ID" });
  }
  if (
    routeEvidenceId &&
    query.data.evidenceId &&
    routeEvidenceId !== query.data.evidenceId
  ) {
    return reply.code(400).send({ code: "EVIDENCE_SELECTOR_CONFLICT" });
  }
  let locator: RawEvidenceLocatorSelector | undefined;
  try {
    locator = parseRawEvidenceLocator(query.data.locator);
  } catch {
    return reply.code(400).send({ code: "INVALID_EVIDENCE_LOCATOR" });
  }
  const evidenceId = routeEvidenceId ?? query.data.evidenceId;
  if (!evidenceId && !locator) {
    return reply.code(400).send({ code: "EVIDENCE_SELECTOR_REQUIRED" });
  }
  const vaultId = params.vaultId;
  const scopePermission = hasPermission(actor, "source:read")
    ? "source:read"
    : "admin";
  const sourceSpaces = spaceIdsForPermission(actor, scopePermission);
  const vault = await getVault(db, vaultId, sourceSpaces);
  if (!vault) return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
  try {
    await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId: vault.space_id,
      permission: scopePermission,
      vaultId: vault.id,
      vaultIds: [vault.id],
      federated: false,
    });
  } catch {
    return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
  }
  const rows = await selectRawEvidence(db, vault, {
    ...(evidenceId ? { evidenceId } : {}),
    ...(locator ? { locator } : {}),
  });
  if (rows.length === 0) {
    return reply.code(404).send({ code: "RAW_EVIDENCE_NOT_FOUND" });
  }
  if (rows.length > 1) {
    return reply.code(409).send({ code: "RAW_EVIDENCE_SELECTOR_AMBIGUOUS" });
  }
  const row = rows[0];
  if (!row || !locatorMatches(row.locator, locator)) {
    return reply.code(404).send({ code: "RAW_EVIDENCE_NOT_FOUND" });
  }
  if (!(await rawEvidencePathAllowed(db, actor, vault, row.document_paths))) {
    return reply.code(403).send({ code: "RAW_EVIDENCE_PATH_SCOPE_DENIED" });
  }
  const byteSize = Number(row.byte_size);
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    byteSize > query.data.maxBytes
  ) {
    return reply.code(413).send({ code: "RAW_EVIDENCE_TOO_LARGE" });
  }
  if (
    !/^[a-f0-9]{64}$/.test(row.source_sha256) ||
    (row.artifact_source_hash !== null &&
      row.artifact_source_hash !== row.source_sha256)
  ) {
    return reply.code(409).send({ code: "RAW_EVIDENCE_INTEGRITY_FAILED" });
  }
  const objectRef = await rawObjectStore.exists(row.source_sha256);
  if (!objectRef) {
    return reply.code(404).send({ code: "RAW_OBJECT_NOT_FOUND" });
  }
  let result: RawEvidenceBytes;
  try {
    result = await readAndVerifyRawEvidence(
      rawObjectStore,
      objectRef,
      {
        sha256: row.source_sha256,
        byteSize,
        objectKey: row.object_key,
      },
      query.data.maxBytes,
    );
  } catch (error) {
    if (error instanceof RawEvidenceExportError) {
      return reply
        .code(error.code === "RAW_EVIDENCE_TOO_LARGE" ? 413 : 409)
        .send({ code: error.code });
    }
    throw error;
  }
  const locatorHash = createHash("sha256")
    .update(JSON.stringify(row.locator))
    .digest("hex");
  await audit(
    db,
    request,
    "evidence.raw_export",
    "evidence",
    row.id,
    {
      vaultId: vault.id,
      evidenceId: row.id,
      sourceId: row.source_id,
      locatorHash,
      bytes: result.bytes.byteLength,
      sha256: result.sha256,
    },
    vault.space_id,
  );
  return reply
    .header("content-type", safeMediaType(row.media_type))
    .header("content-length", String(result.bytes.byteLength))
    .header("content-disposition", rawEvidenceContentDisposition(row.id))
    .header("cache-control", "no-store")
    .header("x-akp-evidence-sha256", result.sha256)
    .header("x-akp-evidence-bytes", String(result.bytes.byteLength))
    .send(result.bytes);
}

async function requireRawEvidencePermission(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const actor = actorOf(request);
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return;
  }
  if (!hasPermission(actor, "source:read") && !hasPermission(actor, "admin")) {
    await reply.code(403).send({
      code: "PERMISSION_DENIED",
      permission: "source:read",
    });
  }
}

export function registerAuditExportRoutes(
  app: FastifyInstance,
  db: Postgres,
  rawObjectStore?: ObjectStore,
): void {
  const rawEvidenceExportEnabled =
    process.env.AKP_ENABLE_RAW_EVIDENCE_EXPORT === "true";
  app.get(
    "/v1/evidence/export/:vaultId/:evidenceId",
    { preHandler: requireRawEvidencePermission },
    async (request, reply) => {
      if (!rawEvidenceExportEnabled) {
        return reply.code(503).send({
          code: "RAW_EVIDENCE_EXPORT_DISABLED",
          message: "Raw evidence export is disabled by deployment policy.",
        });
      }
      return handleRawEvidenceExport(request, reply, db, rawObjectStore);
    },
  );

  app.get(
    "/v1/evidence/export/:vaultId",
    { preHandler: requireRawEvidencePermission },
    async (request, reply) => {
      if (!rawEvidenceExportEnabled) {
        return reply.code(503).send({
          code: "RAW_EVIDENCE_EXPORT_DISABLED",
          message: "Raw evidence export is disabled by deployment policy.",
        });
      }
      return handleRawEvidenceExport(request, reply, db, rawObjectStore);
    },
  );

  app.get(
    "/v1/audit/export/:vaultId/metadata",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const confirmation = z
        .object({ confirm: z.literal("EXPORT_SANITIZED_AUDIT_BUNDLE") })
        .safeParse(request.query);
      if (!confirmation.success) {
        return reply
          .code(400)
          .send({ code: "AUDIT_EXPORT_CONFIRMATION_REQUIRED" });
      }
      const { vaultId } = request.params as { vaultId: string };
      const vault = await getVault(
        db,
        vaultId,
        spaceIdsForPermission(actor, "admin"),
      );
      if (!vault) return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
      if (!hasUnrestrictedPathAccess(actor, vault.space_id, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      try {
        await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: vault.space_id,
          permission: "admin",
          vaultId: vault.id,
          vaultIds: [vault.id],
          federated: false,
        });
      } catch {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
      }
      const result = await db.pool.query(
        `select v.current_revision,
                i.corpus_revision,i.lexical_revision,i.vector_revision,
                i.graph_revision,i.context_pack_revision,i.status,
                (select count(*) from sources s where s.vault_id=v.id) sources,
                (select count(*) from knowledge_documents d where d.vault_id=v.id) documents,
                (select count(*) from evidence e where e.vault_id=v.id) evidence,
                (select count(*) from context_packets p where p.vault_id=v.id) packets,
                (select count(*) from knowledge_relations r
                   join knowledge_documents d on d.id=r.from_document_id
                  where d.vault_id=v.id) relations
           from vaults v
           left join vault_index_revisions i on i.vault_id=v.id and i.space_id=v.space_id
          where v.id=$1 and v.space_id=$2`,
        [vault.id, vault.space_id],
      );
      const row = result.rows[0] ?? {};
      const manifest = {
        schemaVersion: "1.0",
        vaultId: vault.id,
        vaultKey: vault.vault_key,
        vaultRevision: row.current_revision ?? null,
        indexRevisions: {
          corpus: row.corpus_revision ?? null,
          lexical: row.lexical_revision ?? null,
          vector: row.vector_revision ?? null,
          graph: row.graph_revision ?? null,
          contextPack: row.context_pack_revision ?? null,
          status: row.status ?? "DEGRADED",
        },
        counts: {
          sources: Number(row.sources ?? 0),
          documents: Number(row.documents ?? 0),
          relations: Number(row.relations ?? 0),
          evidence: Number(row.evidence ?? 0),
          packets: Number(row.packets ?? 0),
        },
        continuation: null,
      };
      const manifestHash = createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex");
      await audit(
        db,
        request,
        "audit.export.preflight",
        "audit_bundle",
        vault.id,
        { vaultId: vault.id, manifestHash },
        vault.space_id,
      );
      return {
        status: "READY",
        ...manifest,
        manifestHash,
        delivery:
          "Use the authenticated HTTP ZIP endpoint or CLI with an explicit AKP_EXPORT_ROOTS destination.",
      };
    },
  );

  app.get(
    "/v1/audit/export/:vaultId",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const query = AuditExportQuery.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({
          code: "AUDIT_EXPORT_CONFIRMATION_REQUIRED",
          issues: query.error.issues,
        });
      }
      let filters: AuditLocatorFilter[] | undefined;
      try {
        filters = locatorFilters(query.data.locator);
      } catch {
        return reply.code(400).send({ code: "INVALID_LOCATOR_FILTER" });
      }
      const { vaultId } = request.params as { vaultId: string };
      const vault = await getVault(
        db,
        vaultId,
        spaceIdsForPermission(actor, "admin"),
      );
      if (!vault) return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
      if (!hasUnrestrictedPathAccess(actor, vault.space_id, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      try {
        await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: vault.space_id,
          permission: "admin",
          vaultId: vault.id,
          vaultIds: [vault.id],
          federated: false,
        });
      } catch {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
      }

      const [
        indexResult,
        sources,
        documents,
        relations,
        evidence,
        lintRuns,
        schemaRuns,
        errors,
        evalRuns,
        contradictions,
        packets,
      ] = await Promise.all([
        db.pool.query(
          `select corpus_revision,lexical_revision,vector_revision,graph_revision,
                  context_pack_revision,retrieval_configuration_version,status,
                  warnings,updated_at from vault_index_revisions
            where space_id=$1 and vault_id=$2`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,title,media_type,sha256,byte_size,status,created_at
             from sources where space_id=$1 and vault_id=$2 order by id`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,path,title,type,lifecycle,trust_tier,current_revision,
                  external_id,aliases,layer,content_hash,token_estimate,
                  last_verified_at,verified_against_revision,freshness_policy,
                  stale_after,invalidated_by,stale_reason,refresh_status,updated_at
             from knowledge_documents
            where space_id=$1 and vault_id=$2 order by id`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select r.id,r.from_document_id,r.to_document_id,r.relation_type,
                  r.weight,r.provenance from knowledge_relations r
             join knowledge_documents f on f.id=r.from_document_id
             join knowledge_documents t on t.id=r.to_document_id
            where r.space_id=$1 and f.vault_id=$2 and t.vault_id=$2 order by r.id`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,source_id,artifact_id,locator,content_hash,review_status,created_at
             from evidence where space_id=$1 and vault_id=$2 order by id`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,trigger,corpus_revision,status,findings,created_at
             from knowledge_lint_runs where space_id=$1 and vault_id=$2
            order by created_at desc limit 50`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,candidate_version,candidate_hash,corpus_revision,
                  affected_document_count,compatibility_status,
                  corpus_fingerprint_before,corpus_fingerprint_after,created_at
             from schema_dry_runs where space_id=$1 and vault_id=$2
            order by created_at desc limit 50`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,error_type,status,root_cause,correction,regression_reference,
                  verification_result,created_at,resolved_at from error_book
            where space_id=$1 and vault_id=$2 order by created_at desc limit 500`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,corpus_revision,eval_pack,retrieval_config,
                  metrics-'results' metrics,status,created_at from eval_runs
            where space_id=$1 and vault_id=$2 order by created_at desc limit 50`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select c.id,c.topic,c.status,c.resolution,c.created_at,c.updated_at,
                  coalesce(jsonb_agg(jsonb_build_object(
                    'document_id',m.document_id,'authority',m.authority,'scope',m.scope
                  )) filter (where m.document_id is not null),'[]'::jsonb) members
             from contradiction_clusters c
             left join contradiction_members m on m.cluster_id=c.id
            where c.space_id=$1 and c.vault_id=$2
            group by c.id order by c.id`,
          [vault.space_id, vault.id],
        ),
        db.pool.query(
          `select id,corpus_revision,packet_hash,scope,packet,created_at
             from context_packets where space_id=$1 and vault_id=$2
            order by created_at desc limit 20`,
          [vault.space_id, vault.id],
        ),
      ]);

      const index = indexResult.rows[0] ?? {};
      const limits = Object.fromEntries(
        Object.entries(query.data).filter(
          ([key, value]) =>
            !["confirm", "locator"].includes(key) && value !== undefined,
        ),
      ) as Partial<AuditExportLimits>;
      try {
        const bundle = buildAuditBundle({
          metadata: {
            schema_version: process.env.AKP_AUDIT_SCHEMA_VERSION ?? "1.0",
            vault_id: vault.id,
            vault_key: vault.vault_key,
            platform_commit: process.env.AKP_PLATFORM_COMMIT ?? "UNKNOWN",
            vault_revision: vault.current_revision ?? "unknown",
            corpus_revision: String(index.corpus_revision ?? "unknown"),
            index_revisions: {
              corpus: index.corpus_revision ?? null,
              lexical: index.lexical_revision ?? null,
              vector: index.vector_revision ?? null,
              graph: index.graph_revision ?? null,
              contextPack: index.context_pack_revision ?? null,
              status: index.status ?? "DEGRADED",
              warnings: index.warnings ?? [],
            },
            schema_profile: vault.schema_profile,
            retrieval_config: vault.retrieval_config,
            generated_at: new Date().toISOString(),
          },
          vaultManifest: [
            {
              id: vault.id,
              vault_key: vault.vault_key,
              name: vault.name,
              space_id: vault.space_id,
              default_branch: vault.default_branch,
              content_roots: vault.content_roots,
              source_roots: vault.source_roots,
              current_revision: vault.current_revision,
              last_imported_at: vault.last_imported_at,
              enabled: vault.enabled,
              visibility: vault.visibility,
            },
          ],
          sources: sources.rows,
          documents: documents.rows,
          relations: relations.rows,
          evidence: evidence.rows,
          validationResults: {
            lintRuns: lintRuns.rows,
            schemaRuns: schemaRuns.rows,
            errors: errors.rows,
          },
          retrievalBenchmark: { runs: evalRuns.rows },
          gapsAndContradictions: {
            contradictions: contradictions.rows,
            openErrors: errors.rows.filter((row) => row.status === "OPEN"),
          },
          sampleContextPackets: packets.rows.map((row) => ({
            id: String(row.id),
            packet: packetManifest(row),
          })),
          ...(filters ? { locatorFilters: filters } : {}),
          ...(Object.keys(limits).length ? { limits } : {}),
        });
        await audit(
          db,
          request,
          "audit.export",
          "audit_bundle",
          vault.id,
          {
            vaultId: vault.id,
            vaultKey: vault.vault_key,
            bundleHash: bundle.hash,
            counts: bundle.metadata.counts,
          },
          vault.space_id,
        );
        const safeKey = vault.vault_key.replace(/[^a-z0-9.-]/gi, "_");
        return reply
          .header("content-type", "application/zip")
          .header(
            "content-disposition",
            `attachment; filename="akp-audit-${safeKey}.zip"`,
          )
          .header("cache-control", "no-store")
          .header("x-akp-bundle-hash", bundle.hash)
          .header("x-akp-bundle-schema-version", "1.0")
          .send(Buffer.from(renderAuditZip(bundle)));
      } catch (error) {
        if (error instanceof AuditExportLimitError) {
          return reply.code(413).send({
            code: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
