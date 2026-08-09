import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import {
  actorOf,
  audit,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";

const DEFAULT_SPACE = "00000000-0000-0000-0000-000000000003";

function normalized(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}

async function corpusFingerprint(
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>,
  spaceId: string,
): Promise<string> {
  const result = await query(
    `
    select encode(digest(coalesce(string_agg(
      id::text||':'||coalesce(content_hash,'')||':'||current_revision,
      '|' order by id
    ),''),'sha256'),'hex') fingerprint
      from knowledge_documents where space_id=$1
    `,
    [spaceId],
  );
  return String(result.rows[0]?.fingerprint ?? "");
}

export function registerSchemaGovernanceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{
    Body: {
      spaceId?: string;
      candidateVersion?: string;
      requiredFrontmatterFields?: string[];
      allowedTypes?: string[];
    };
  }>(
    "/v1/schema/dry-run",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaceId =
        request.body?.spaceId ??
        spaceIdsForPermission(actor, "admin")[0] ??
        DEFAULT_SPACE;
      if (!hasUnrestrictedPathAccess(actor, spaceId, "admin")) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const candidateVersion = request.body?.candidateVersion?.trim();
      if (!candidateVersion) {
        return reply
          .code(400)
          .send({ code: "CANDIDATE_SCHEMA_VERSION_REQUIRED" });
      }
      const requiredFields = normalized(request.body.requiredFrontmatterFields);
      const allowedTypes = normalized(request.body.allowedTypes);
      const candidate = {
        candidateVersion,
        requiredFrontmatterFields: requiredFields,
        allowedTypes,
      };
      const candidateHash = createHash("sha256")
        .update(JSON.stringify(candidate))
        .digest("hex");
      const client = await db.pool.connect();
      let before = "";
      let after = "";
      let documents: Array<Record<string, unknown>> = [];
      try {
        await client.query("begin isolation level repeatable read read only");
        before = await corpusFingerprint(client.query.bind(client), spaceId);
        const result = await client.query(
          `
          select id,external_id,path,type,frontmatter,current_revision
            from knowledge_documents where space_id=$1 order by path
          `,
          [spaceId],
        );
        documents = result.rows;
        after = await corpusFingerprint(client.query.bind(client), spaceId);
        await client.query("rollback");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      const affected = documents.flatMap((document) => {
        const frontmatter = (document.frontmatter ?? {}) as Record<
          string,
          unknown
        >;
        const missingFields = requiredFields.filter(
          (field) => !(field in frontmatter) || frontmatter[field] === null,
        );
        const unsupportedType =
          allowedTypes.length > 0 &&
          !allowedTypes.includes(String(document.type));
        return missingFields.length || unsupportedType
          ? [
              {
                id: document.id,
                externalId: document.external_id,
                path: document.path,
                type: document.type,
                missingFields,
                unsupportedType,
              },
            ]
          : [];
      });
      const revision = await db.pool.query(
        "select coalesce(corpus_revision,'unknown') revision from index_revisions where space_id=$1",
        [spaceId],
      );
      const compatibilityStatus = affected.length
        ? "MIGRATION_REQUIRED"
        : "COMPATIBLE";
      const report = {
        candidate,
        compatibilityStatus,
        affectedDocumentCount: affected.length,
        affectedSample: affected.slice(0, 100),
        sampleTruncated: affected.length > 100,
        corpusUnchanged: before === after,
        requiresArchitectureOrCuratorApproval: true,
        requiredFollowUp: affected.length
          ? [
              "APPROVE_MIGRATION",
              "MIGRATE_AFFECTED_DOCUMENTS",
              "REINDEX",
              "RUN_REGRESSION_EVALS",
            ]
          : ["APPROVE_SCHEMA", "REINDEX", "RUN_REGRESSION_EVALS"],
        rollbackPlan:
          "Retain the prior schema version and reverse the reviewed migration commit.",
      };
      const inserted = await db.pool.query(
        `
        insert into schema_dry_runs(
          space_id,actor_id,candidate_version,candidate_hash,corpus_revision,
          affected_document_count,compatibility_status,report,
          corpus_fingerprint_before,corpus_fingerprint_after
        ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) returning id,created_at
        `,
        [
          spaceId,
          actor?.id ?? null,
          candidateVersion,
          candidateHash,
          String(revision.rows[0]?.revision ?? "unknown"),
          affected.length,
          compatibilityStatus,
          JSON.stringify(report),
          before,
          after,
        ],
      );
      await audit(
        db,
        request,
        "schema.dry_run",
        "schema_dry_run",
        String(inserted.rows[0]?.id),
        { candidateHash, affectedDocumentCount: affected.length },
        spaceId,
      );
      return {
        id: inserted.rows[0]?.id,
        createdAt: inserted.rows[0]?.created_at,
        candidateHash,
        corpusFingerprintBefore: before,
        corpusFingerprintAfter: after,
        ...report,
      };
    },
  );
}
