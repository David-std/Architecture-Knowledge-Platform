import type { FastifyInstance } from "fastify";
import { resolveAuthorizedVaultScope, type Postgres } from "@akp/postgres";
import {
  actorOf,
  audit,
  hasUnrestrictedPathAccess,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_METADATA_KEY =
  /^(?:source(?:uri|_uri|path|_path)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|root(?:path|_path)|canonical(?:path|_path)|object(?:key|_key)|endpoint|host|password|secret|token|credential|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;
const ABSOLUTE_PATH_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g;

/** Error-book metadata is diagnostic, not a host-routing or secret store. */
function sanitizeErrorMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeErrorMetadata);
  if (typeof value === "string") {
    return value.replaceAll(ABSOLUTE_PATH_TOKEN, "[REDACTED_PATH]");
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_METADATA_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeErrorMetadata(entry)]),
  );
}

function sanitizedErrorRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return { ...row, metadata: sanitizeErrorMetadata(row.metadata) };
}

/**
 * Error-book entries are pathless operational records.  A space role alone
 * must never expose a private vault, so every operation resolves the explicit
 * vault grant as well as the enclosing space permission.
 */
async function authorizedVault(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  spaceId: string,
  vaultId: string,
  permission:
    "knowledge:propose" | "knowledge:review" | "eval:run" | "knowledge:read",
): Promise<boolean> {
  if (!actor || !UUID.test(vaultId)) return false;
  if (!hasUnrestrictedPathAccess(actor, spaceId, permission)) return false;
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId,
      vaultId,
      vaultIds: [vaultId],
      permission,
      federated: false,
    });
    return scope.accessByVault[vaultId]?.pathPrefix === null;
  } catch {
    return false;
  }
}

const ERROR_TYPES = new Set([
  "SOURCE_MISSED",
  "FACT_DROPPED",
  "WRONG_IDENTITY",
  "DUPLICATE_PAGE",
  "STALE_CLAIM",
  "BROKEN_PROVENANCE",
  "BAD_CONTEXT_PACKET",
  "RETRIEVAL_FAILURE",
  "INDEX_REVISION_MISMATCH",
  "PROMPT_INJECTION",
  "REVIEW_ESCAPE",
  "EXTRACTOR_FAILURE",
  "TABLE_PARSE_FAILURE",
  "RESTORE_FAILURE",
  "GENERICITY_LEAK",
  "REPOSITORY_HYGIENE_FAILURE",
]);

export function registerErrorBookRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{
    Body: {
      spaceId: string;
      vaultId: string;
      errorType?: string;
      rootCause?: string;
      correction?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    "/v1/error-book",
    { preHandler: requirePermission("knowledge:propose") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceId = request.body?.spaceId;
      const vaultId = request.body?.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      const errorType = String(request.body?.errorType ?? "").toUpperCase();
      if (
        !(await authorizedVault(
          db,
          actor,
          spaceId,
          vaultId,
          "knowledge:propose",
        ))
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!ERROR_TYPES.has(errorType)) {
        return reply.code(400).send({ code: "INVALID_ERROR_BOOK_TYPE" });
      }
      const result = await db.pool.query(
        `
        insert into error_book(space_id,vault_id,error_type,root_cause,correction,metadata)
        select $1,$2,$3,$4,$5,$6::jsonb
          from vaults where id=$2 and space_id=$1 and enabled=true
        returning *
        `,
        [
          spaceId,
          vaultId,
          errorType,
          request.body?.rootCause?.trim() || null,
          request.body?.correction?.trim() || null,
          JSON.stringify(sanitizeErrorMetadata(request.body?.metadata ?? {})),
        ],
      );
      if (!result.rowCount) {
        return reply.code(404).send({ code: "VAULT_SCOPE_NOT_FOUND" });
      }
      await audit(
        db,
        request,
        "error_book.create",
        "error_book",
        String(result.rows[0]?.id),
        { vaultId },
        spaceId,
      );
      return reply
        .code(201)
        .send(sanitizedErrorRow(result.rows[0] as Record<string, unknown>));
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      query?: string;
      category?: string;
      goldDocuments?: string[];
      mustNotInclude?: string[];
      critical?: boolean;
    };
  }>(
    "/v1/error-book/:id/regression",
    { preHandler: requirePermission("eval:run") },
    async (request, reply) => {
      const error = await db.pool.query(
        "select * from error_book where id=$1 and space_id=any($2::uuid[])",
        [
          request.params.id,
          unrestrictedSpaceIdsForPermission(actorOf(request), "eval:run"),
        ],
      );
      if (!error.rowCount)
        return reply.code(404).send({ code: "ERROR_BOOK_ENTRY_NOT_FOUND" });
      const errorRow = error.rows[0] as Record<string, unknown>;
      if (
        !(await authorizedVault(
          db,
          actorOf(request),
          String(errorRow.space_id),
          String(errorRow.vault_id ?? ""),
          "eval:run",
        ))
      ) {
        return reply.code(404).send({ code: "ERROR_BOOK_ENTRY_NOT_FOUND" });
      }
      const query = request.body?.query?.trim();
      const goldDocuments = (request.body?.goldDocuments ?? [])
        .map(String)
        .filter(Boolean);
      if (!query || !goldDocuments.length) {
        return reply
          .code(400)
          .send({ code: "REGRESSION_QUERY_AND_GOLD_REQUIRED" });
      }
      const caseId = `error-book-${request.params.id}`;
      const expected = {
        gold_documents: goldDocuments,
        must_not_include: (request.body?.mustNotInclude ?? [])
          .map(String)
          .filter(Boolean),
        error_book_id: request.params.id,
      };
      await db.pool.query(
        `
        insert into eval_cases(id,space_id,vault_id,category,query,expected,critical,active)
        values($1,$2,$3,$4,$5,$6::jsonb,$7,true)
        on conflict(id) do update set
          category=excluded.category,query=excluded.query,expected=excluded.expected,
          critical=excluded.critical,active=true
        `,
        [
          caseId,
          errorRow.space_id,
          errorRow.vault_id,
          request.body?.category?.trim() || "error-book-regression",
          query,
          JSON.stringify(expected),
          request.body?.critical ?? true,
        ],
      );
      await db.pool.query(
        "update error_book set regression_reference=$2 where id=$1",
        [request.params.id, caseId],
      );
      await audit(
        db,
        request,
        "error_book.regression_create",
        "eval_case",
        caseId,
        {
          vaultId: String(errorRow.vault_id),
          errorBookId: request.params.id,
        },
        String(errorRow.space_id),
      );
      return reply.code(201).send({
        caseId,
        active: true,
        critical: request.body?.critical ?? true,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { verificationResult?: string } }>(
    "/v1/error-book/:id/resolve",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      const verificationResult = request.body?.verificationResult?.trim();
      if (!verificationResult) {
        return reply.code(400).send({ code: "VERIFICATION_RESULT_REQUIRED" });
      }
      const current = await db.pool.query<Record<string, unknown>>(
        "select * from error_book where id=$1 and space_id=any($2::uuid[])",
        [
          request.params.id,
          unrestrictedSpaceIdsForPermission(
            actorOf(request),
            "knowledge:review",
          ),
        ],
      );
      const currentRow = current.rows[0];
      if (
        !currentRow ||
        !(await authorizedVault(
          db,
          actorOf(request),
          String(currentRow.space_id),
          String(currentRow.vault_id ?? ""),
          "knowledge:review",
        ))
      ) {
        return reply.code(404).send({ code: "ERROR_BOOK_ENTRY_NOT_FOUND" });
      }
      const result = await db.pool.query(
        `
        update error_book set status='RESOLVED',verification_result=$3,resolved_at=now()
         where id=$1 and space_id=$2 and vault_id=$4 returning *
        `,
        [
          request.params.id,
          currentRow.space_id,
          verificationResult,
          currentRow.vault_id,
        ],
      );
      if (!result.rowCount)
        return reply.code(404).send({ code: "ERROR_BOOK_ENTRY_NOT_FOUND" });
      await audit(
        db,
        request,
        "error_book.resolve",
        "error_book",
        request.params.id,
        { vaultId: String(result.rows[0]?.vault_id) },
        String(result.rows[0]?.space_id),
      );
      return sanitizedErrorRow(result.rows[0] as Record<string, unknown>);
    },
  );
}
