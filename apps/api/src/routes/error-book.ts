import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import {
  actorOf,
  audit,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const DEFAULT_SPACE = "00000000-0000-0000-0000-000000000003";
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
  "RESTORE_FAILURE",
]);

export function registerErrorBookRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{
    Body: {
      spaceId?: string;
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
      const spaceId =
        request.body?.spaceId ??
        spaceIdsForPermission(actor, "knowledge:propose")[0] ??
        DEFAULT_SPACE;
      const errorType = String(request.body?.errorType ?? "").toUpperCase();
      if (!hasUnrestrictedPathAccess(actor, spaceId, "knowledge:propose")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!ERROR_TYPES.has(errorType)) {
        return reply.code(400).send({ code: "INVALID_ERROR_BOOK_TYPE" });
      }
      const result = await db.pool.query(
        `
        insert into error_book(space_id,error_type,root_cause,correction,metadata)
        values($1,$2,$3,$4,$5::jsonb) returning *
        `,
        [
          spaceId,
          errorType,
          request.body?.rootCause?.trim() || null,
          request.body?.correction?.trim() || null,
          JSON.stringify(request.body?.metadata ?? {}),
        ],
      );
      await audit(
        db,
        request,
        "error_book.create",
        "error_book",
        String(result.rows[0]?.id),
        {},
        spaceId,
      );
      return reply.code(201).send(result.rows[0]);
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
        insert into eval_cases(id,space_id,category,query,expected,critical,active)
        values($1,$2,$3,$4,$5::jsonb,$6,true)
        on conflict(id) do update set
          category=excluded.category,query=excluded.query,expected=excluded.expected,
          critical=excluded.critical,active=true
        `,
        [
          caseId,
          error.rows[0]?.space_id,
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
        { errorBookId: request.params.id },
        String(error.rows[0]?.space_id),
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
      const result = await db.pool.query(
        `
        update error_book set status='RESOLVED',verification_result=$3,resolved_at=now()
         where id=$1 and space_id=any($2::uuid[]) returning *
        `,
        [
          request.params.id,
          unrestrictedSpaceIdsForPermission(
            actorOf(request),
            "knowledge:review",
          ),
          verificationResult,
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
        {},
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
    },
  );
}
