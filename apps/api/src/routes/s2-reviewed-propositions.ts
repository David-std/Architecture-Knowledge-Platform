import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ObjectStore } from "@akp/object-store";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import { actorOf, hasSpaceAccess, requirePermission } from "../auth.js";
import {
  reviewedS2QueryProposition,
  reviewedS2SourceProposition,
} from "../s2-reviewed-source-proposition-service.js";
import { readAndVerifyRawEvidence } from "./audit-export.js";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const uuid = z.string().uuid();
const Proposal = z
  .object({
    spaceId: uuid,
    vaultId: uuid,
    documentId: uuid,
    unitId: uuid.nullable(),
    sourceId: uuid,
    question: z.string().min(1).max(4096),
    excerpt: z.string().min(1).max(8192),
    queryProposition: reviewedS2QueryProposition,
    sourceProposition: reviewedS2SourceProposition,
  })
  .strict();
const Id = z.object({ id: uuid });
type SourceRow = {
  path: string;
  current_revision: string;
  source_sha256: string;
  object_key: string;
  byte_size: string;
  media_type: string | null;
};
const MAX_BYTES = 2_000_000;

async function reviewedScope(
  db: Postgres,
  request: FastifyRequest,
  spaceId: string,
  vaultId: string,
  path: string,
): Promise<boolean> {
  const actor = actorOf(request);
  if (
    !actor ||
    actor.principalKind !== "HUMAN" ||
    !hasSpaceAccess(actor, spaceId, "knowledge:review") ||
    !hasSpaceAccess(actor, spaceId, "source:read")
  )
    return false;
  try {
    for (const permission of ["knowledge:review", "source:read"] as const) {
      const scope = await resolveAuthorizedVaultScope(db, {
        userId: actor.id,
        spaceId,
        permission,
        vaultId,
        vaultIds: [vaultId],
        federated: false,
      });
      const prefix = scope.accessByVault[vaultId]?.pathPrefix;
      if (prefix === undefined || !pathMatchesVaultPrefix(path, prefix))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function sourceContainsUniqueExcerpt(
  store: ObjectStore,
  source: SourceRow,
  excerpt: string,
  start: number,
  end: number,
): Promise<boolean> {
  const bytes = Number(source.byte_size);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_BYTES ||
    !/^[a-f0-9]{64}$/u.test(source.source_sha256) ||
    !["text/plain", "text/markdown", "text/x-markdown"].includes(
      (source.media_type ?? "").split(";")[0]!.trim().toLowerCase(),
    ) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > excerpt.length
  )
    return false;
  try {
    const ref = await store.exists(source.source_sha256);
    if (!ref) return false;
    const raw = await readAndVerifyRawEvidence(
      store,
      ref,
      {
        sha256: source.source_sha256,
        byteSize: bytes,
        objectKey: source.object_key,
      },
      MAX_BYTES,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes);
    const at = text.indexOf(excerpt);
    return (
      at >= 0 &&
      text.indexOf(excerpt, at + 1) === -1 &&
      !(
        start > 0 &&
        /[\uD800-\uDBFF]/u.test(excerpt[start - 1]!) &&
        /[\uDC00-\uDFFF]/u.test(excerpt[start]!)
      ) &&
      !(
        end < excerpt.length &&
        /[\uD800-\uDBFF]/u.test(excerpt[end - 1]!) &&
        /[\uDC00-\uDFFF]/u.test(excerpt[end]!)
      )
    );
  } catch {
    return false;
  }
}

/**
 * This register accepts human review, not model authority. A second distinct
 * HUMAN must approve. The original bytes and permissions are rechecked on
 * both writes and on every eventual query resolver invocation.
 */
export function registerS2ReviewedPropositionRoutes(
  app: FastifyInstance,
  db: Postgres,
  store: ObjectStore,
): void {
  app.post(
    "/v1/s2/proposition-reviews",
    {
      preHandler: requirePermission("knowledge:review"),
    },
    async (request, reply) => {
      const parsed = Proposal.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "S2_PROPOSAL_INVALID" });
      const body = parsed.data;
      const actor = actorOf(request);
      if (!actor || actor.principalKind !== "HUMAN")
        return reply.code(403).send({ code: "S2_HUMAN_REVIEW_REQUIRED" });
      const found = await db.pool.query<SourceRow>(
        `select d.path,d.current_revision,s.sha256 source_sha256,
              s.object_key,s.byte_size::text,s.media_type
         from knowledge_documents d
         join vaults v on v.id=d.vault_id and v.space_id=d.space_id and v.enabled
         join sources s on s.id=$4 and s.vault_id=d.vault_id
              and s.space_id=d.space_id and s.status='ACTIVE'
        where d.id=$1 and d.space_id=$2 and d.vault_id=$3
          and d.lifecycle='ACTIVE'
          and ($5::uuid is null or exists (
            select 1 from knowledge_units u where u.id=$5
              and u.document_id=d.id and u.space_id=d.space_id
              and u.vault_id=d.vault_id and u.document_revision=d.current_revision
          ))
          and exists (select 1 from document_evidence de
            join evidence e on e.id=de.evidence_id
             and e.source_id=s.id and e.space_id=d.space_id
             and e.vault_id=d.vault_id
            where de.document_id=d.id and de.relation_type='supported_by'
             and e.locator->>'source_hash'=s.sha256)
        limit 2`,
        [
          body.documentId,
          body.spaceId,
          body.vaultId,
          body.sourceId,
          body.unitId,
        ],
      );
      if (found.rows.length !== 1)
        return reply
          .code(404)
          .send({ code: "S2_SOURCE_NOT_CURRENT_OR_LINKED" });
      const source = found.rows[0]!;
      if (
        !(await reviewedScope(
          db,
          request,
          body.spaceId,
          body.vaultId,
          source.path,
        ))
      )
        return reply.code(403).send({ code: "S2_REVIEW_SCOPE_DENIED" });
      const q = body.sourceProposition.quote;
      if (
        !(await sourceContainsUniqueExcerpt(
          store,
          source,
          body.excerpt,
          q.startOffset,
          q.endOffset,
        ))
      )
        return reply.code(409).send({ code: "S2_RAW_SOURCE_PROOF_MISSING" });
      const result = await db.pool.query<{ id: string }>(
        `insert into s2_reviewed_source_propositions
       (space_id,vault_id,document_id,unit_id,document_path,document_revision,
        source_id,source_sha256,question_text,question_sha256,excerpt,excerpt_sha256,
        query_proposition,source_proposition,proposed_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)
       returning id`,
        [
          body.spaceId,
          body.vaultId,
          body.documentId,
          body.unitId,
          source.path,
          source.current_revision,
          body.sourceId,
          source.source_sha256,
          body.question,
          sha256(body.question),
          body.excerpt,
          sha256(body.excerpt),
          JSON.stringify(body.queryProposition),
          JSON.stringify(body.sourceProposition),
          actor.id,
        ],
      );
      return reply.code(201).send({
        id: result.rows[0]!.id,
        status: "PROPOSED",
        productionAdmission: false,
      });
    },
  );

  app.post(
    "/v1/s2/proposition-reviews/:id/approve",
    {
      preHandler: requirePermission("knowledge:review"),
    },
    async (request, reply) => {
      const id = Id.safeParse(request.params);
      if (!id.success)
        return reply.code(400).send({ code: "S2_REVIEW_ID_INVALID" });
      const actor = actorOf(request);
      if (!actor || actor.principalKind !== "HUMAN")
        return reply.code(403).send({ code: "S2_HUMAN_REVIEW_REQUIRED" });
      const result = await db.pool.query<
        SourceRow & {
          space_id: string;
          vault_id: string;
          proposed_by: string;
          excerpt: string;
          start_offset: number;
          end_offset: number;
          question_text: string;
          query_proposition: unknown;
          source_proposition: unknown;
        }
      >(
        `select r.space_id,r.vault_id,r.proposed_by,r.excerpt,r.question_text,
              r.query_proposition,r.source_proposition,d.path,d.current_revision,
              s.sha256 source_sha256,s.object_key,s.byte_size::text,s.media_type,
              (r.source_proposition->'quote'->>'startOffset')::int start_offset,
              (r.source_proposition->'quote'->>'endOffset')::int end_offset
         from s2_reviewed_source_propositions r
         join knowledge_documents d on d.id=r.document_id
            and d.space_id=r.space_id and d.vault_id=r.vault_id
            and d.path=r.document_path and d.current_revision=r.document_revision
            and d.lifecycle='ACTIVE'
         join vaults v on v.id=r.vault_id and v.space_id=r.space_id and v.enabled
         join sources s on s.id=r.source_id and s.space_id=r.space_id
            and s.vault_id=r.vault_id and s.sha256=r.source_sha256
            and s.status='ACTIVE'
        where r.id=$1 and r.status='PROPOSED' and r.proposed_by<>$2
          and exists (select 1 from document_evidence de
            join evidence e on e.id=de.evidence_id
             and e.source_id=s.id and e.space_id=r.space_id and e.vault_id=r.vault_id
            where de.document_id=d.id and de.relation_type='supported_by'
             and e.locator->>'source_hash'=s.sha256)
        limit 1`,
        [id.data.id, actor.id],
      );
      if (result.rows.length !== 1)
        return reply.code(409).send({ code: "S2_REVIEW_NOT_ELIGIBLE" });
      const row = result.rows[0]!;
      if (
        !(await reviewedScope(
          db,
          request,
          row.space_id,
          row.vault_id,
          row.path,
        ))
      )
        return reply.code(403).send({ code: "S2_REVIEW_SCOPE_DENIED" });
      if (
        !reviewedS2QueryProposition.safeParse(row.query_proposition).success ||
        !reviewedS2SourceProposition.safeParse(row.source_proposition)
          .success ||
        !(await sourceContainsUniqueExcerpt(
          store,
          row,
          row.excerpt,
          row.start_offset,
          row.end_offset,
        ))
      )
        return reply.code(409).send({ code: "S2_REVIEW_SOURCE_CHANGED" });
      const updated = await db.pool.query<{ id: string }>(
        `update s2_reviewed_source_propositions
          set status='APPROVED',approved_by=$2,approved_at=now()
        where id=$1 and status='PROPOSED' and proposed_by<>$2
        returning id`,
        [id.data.id, actor.id],
      );
      if (updated.rowCount !== 1)
        return reply.code(409).send({ code: "S2_REVIEW_CONCURRENT_CHANGE" });
      return {
        id: updated.rows[0]!.id,
        status: "APPROVED",
        productionAdmission: false,
      };
    },
  );

  app.post(
    "/v1/s2/proposition-reviews/:id/revoke",
    {
      preHandler: requirePermission("knowledge:review"),
    },
    async (request, reply) => {
      const id = Id.safeParse(request.params);
      if (!id.success)
        return reply.code(400).send({ code: "S2_REVIEW_ID_INVALID" });
      const actor = actorOf(request);
      if (!actor || actor.principalKind !== "HUMAN")
        return reply.code(403).send({ code: "S2_HUMAN_REVIEW_REQUIRED" });
      const rows = await db.pool.query<{
        space_id: string;
        vault_id: string;
        document_path: string;
      }>(
        `select space_id,vault_id,document_path from s2_reviewed_source_propositions
        where id=$1 and status in ('PROPOSED','APPROVED')`,
        [id.data.id],
      );
      const row = rows.rows[0];
      if (!row) return reply.code(404).send({ code: "S2_REVIEW_NOT_FOUND" });
      if (
        !(await reviewedScope(
          db,
          request,
          row.space_id,
          row.vault_id,
          row.document_path,
        ))
      )
        return reply.code(403).send({ code: "S2_REVIEW_SCOPE_DENIED" });
      const changed = await db.pool.query(
        `update s2_reviewed_source_propositions
          set status='REVOKED',revoked_by=$2,revoked_at=now()
         where id=$1 and status in ('PROPOSED','APPROVED')`,
        [id.data.id, actor.id],
      );
      return changed.rowCount === 1
        ? { id: id.data.id, status: "REVOKED", productionAdmission: false }
        : reply.code(409).send({ code: "S2_REVIEW_CONCURRENT_CHANGE" });
    },
  );
}
