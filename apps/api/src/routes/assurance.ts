import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ASSURANCE_DETECTORS,
  IMPLEMENTED_ASSURANCE_DETECTORS,
  cancelAssuranceRun,
  resolveAuthorizedVaultScope,
  submitAssuranceRun,
  transitionAssuranceFindingStatus,
  type Postgres,
} from "@akp/postgres";
import { actorOf, audit, requirePermission, type Permission } from "../auth.js";

const UUID = z.string().uuid();
const RunBody = z
  .object({
    spaceId: UUID,
    vaultId: UUID,
    detectors: z
      .array(z.enum(IMPLEMENTED_ASSURANCE_DETECTORS))
      .min(1)
      .max(IMPLEMENTED_ASSURANCE_DETECTORS.length)
      .optional(),
  })
  .strict();

const ScopedQuery = z
  .object({
    spaceId: UUID,
    vaultId: UUID,
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const FindingQuery = ScopedQuery.extend({
  status: z
    .enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "FALSE_POSITIVE"])
    .optional(),
  detector: z.enum(ASSURANCE_DETECTORS).optional(),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  category: z.string().trim().min(1).max(120).optional(),
}).strict();

const FindingStatusBody = z
  .object({
    status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "FALSE_POSITIVE"]),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

async function requireWholeVault(
  db: Postgres,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  spaceId: string,
  vaultId: string,
): Promise<boolean> {
  const actor = actorOf(request);
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return false;
  }
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId,
      permission,
      vaultId,
      vaultIds: [vaultId],
      federated: false,
    });
    if (
      scope.vaultIds.length !== 1 ||
      scope.vaultIds[0] !== vaultId ||
      scope.accessByVault[vaultId]?.pathPrefix !== null
    ) {
      await reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      return false;
    }
    return true;
  } catch {
    await reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
    return false;
  }
}

function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || key.length < 8 || key.length > 200) return null;
  return key;
}

export function registerAssuranceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/assurance/capabilities",
    { preHandler: requirePermission("knowledge:read") },
    async () => ({
      schemaVersion: 1,
      detectors: [...ASSURANCE_DETECTORS],
      implementedDetectors: [...IMPLEMENTED_ASSURANCE_DETECTORS],
      deferredDetectors: ASSURANCE_DETECTORS.filter(
        (detector) =>
          !(IMPLEMENTED_ASSURANCE_DETECTORS as readonly string[]).includes(
            detector,
          ),
      ),
      findingAuthority: "DIAGNOSTIC_NON_CANONICAL",
      externalContentTrust: "UNTRUSTED_EXTERNAL",
    }),
  );

  app.post(
    "/v1/assurance/runs",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const parsed = RunBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_ASSURANCE_RUN",
          issues: parsed.error.issues,
        });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "admin",
          parsed.data.spaceId,
          parsed.data.vaultId,
        ))
      ) {
        return;
      }
      const key = idempotencyKey(request);
      if (!key) {
        return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const run = await submitAssuranceRun(db, {
        spaceId: parsed.data.spaceId,
        vaultId: parsed.data.vaultId,
        trigger: "MANUAL",
        detectors: [
          ...(parsed.data.detectors ?? IMPLEMENTED_ASSURANCE_DETECTORS),
        ],
        idempotencyKey: key,
        requestedByUserId: actor.id,
        requestedByPrincipalId: actor.principalId,
      });
      await audit(
        db,
        request,
        "assurance.run.submit",
        "assurance_run",
        run.id,
        {
          vaultId: run.vaultId,
          detectors: run.detectors,
          trigger: run.trigger,
        },
        run.spaceId,
      );
      return reply.code(202).send(run);
    },
  );

  app.get(
    "/v1/assurance/runs",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const parsed = ScopedQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_ASSURANCE_SCOPE",
          issues: parsed.error.issues,
        });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "knowledge:read",
          parsed.data.spaceId,
          parsed.data.vaultId,
        ))
      ) {
        return;
      }
      const runs = await db.pool.query(
        `select id,space_id,vault_id,trigger,detectors,status,idempotency_key,
                cursor,attempts,max_attempts,lease_owner,lease_expires_at,
                cancel_requested_at,next_attempt_at,started_at,completed_at,
                error,result_summary,created_at,updated_at
           from assurance_runs
          where space_id=$1 and vault_id=$2
          order by created_at desc
          limit $3`,
        [parsed.data.spaceId, parsed.data.vaultId, parsed.data.limit],
      );
      return { runs: runs.rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/assurance/runs/:id",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      if (!UUID.safeParse(request.params.id).success) {
        return reply.code(400).send({ code: "INVALID_ASSURANCE_RUN_ID" });
      }
      const run = await db.pool.query(
        `select id,space_id,vault_id,trigger,detectors,status,idempotency_key,
                cursor,attempts,max_attempts,lease_owner,lease_expires_at,
                cancel_requested_at,next_attempt_at,started_at,completed_at,
                error,result_summary,created_at,updated_at
           from assurance_runs
          where id=$1`,
        [request.params.id],
      );
      const row = run.rows[0];
      if (!row) {
        return reply.code(404).send({ code: "ASSURANCE_RUN_NOT_FOUND" });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "knowledge:read",
          String(row.space_id),
          String(row.vault_id),
        ))
      ) {
        return;
      }
      const findings = await db.pool.query(
        `select id,detector,detector_version,severity,category,scope_id,
                target_ids,evidence_refs evidence_ids,support_set_ids,code,
                summary,status,proposed_action,revision_set,metadata,
                first_seen_at,last_seen_at,resolved_at
           from assurance_findings
          where run_id=$1
          order by last_seen_at,id
          limit 1000`,
        [request.params.id],
      );
      return { run: row, findings: findings.rows };
    },
  );

  app.get(
    "/v1/assurance/findings",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const parsed = FindingQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_ASSURANCE_FINDING_QUERY",
          issues: parsed.error.issues,
        });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "knowledge:read",
          parsed.data.spaceId,
          parsed.data.vaultId,
        ))
      ) {
        return;
      }
      const findings = await db.pool.query(
        `select id,run_id,detector,detector_version,severity,category,scope_id,
                target_ids,evidence_refs evidence_ids,support_set_ids,code,
                summary,status,proposed_action,revision_set,metadata,
                first_seen_at,last_seen_at,resolved_at
           from assurance_findings
          where space_id=$1 and vault_id=$2
            and ($3::text is null or status=$3)
            and ($4::text is null or detector=$4)
            and ($5::text is null or severity=$5)
            and ($6::text is null or category=$6)
          order by
            case severity
              when 'CRITICAL' then 1
              when 'HIGH' then 2
              when 'MEDIUM' then 3
              when 'LOW' then 4
              else 5
            end,
            last_seen_at desc,id
          limit $7`,
        [
          parsed.data.spaceId,
          parsed.data.vaultId,
          parsed.data.status ?? null,
          parsed.data.detector ?? null,
          parsed.data.severity ?? null,
          parsed.data.category ?? null,
          parsed.data.limit,
        ],
      );
      return { findings: findings.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/assurance/findings/:id/status",
    { preHandler: requirePermission("knowledge:review") },
    async (request, reply) => {
      if (!UUID.safeParse(request.params.id).success) {
        return reply.code(400).send({ code: "INVALID_ASSURANCE_FINDING_ID" });
      }
      const parsed = FindingStatusBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_ASSURANCE_FINDING_STATUS",
          issues: parsed.error.issues,
        });
      }
      const current = await db.pool.query<{
        space_id: string;
        vault_id: string;
      }>("select space_id,vault_id from assurance_findings where id=$1", [
        request.params.id,
      ]);
      const scope = current.rows[0];
      if (!scope) {
        return reply.code(404).send({ code: "ASSURANCE_FINDING_NOT_FOUND" });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "knowledge:review",
          scope.space_id,
          scope.vault_id,
        ))
      ) {
        return;
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });

      const finding = await transitionAssuranceFindingStatus(db, {
        findingId: request.params.id,
        spaceId: scope.space_id,
        vaultId: scope.vault_id,
        status: parsed.data.status,
        actorUserId: actor.id,
        actorPrincipalId: actor.principalId,
        reason: parsed.data.reason ?? null,
      });
      if (!finding) {
        return reply.code(404).send({ code: "ASSURANCE_FINDING_NOT_FOUND" });
      }
      await audit(
        db,
        request,
        "assurance.finding.status",
        "assurance_finding",
        request.params.id,
        {
          vaultId: scope.vault_id,
          status: parsed.data.status,
          reason: parsed.data.reason ?? null,
        },
        scope.space_id,
      );
      return { finding };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/assurance/runs/:id/cancel",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      if (!UUID.safeParse(request.params.id).success) {
        return reply.code(400).send({ code: "INVALID_ASSURANCE_RUN_ID" });
      }
      const run = await db.pool.query<{
        space_id: string;
        vault_id: string;
      }>("select space_id,vault_id from assurance_runs where id=$1", [
        request.params.id,
      ]);
      const row = run.rows[0];
      if (!row) {
        return reply.code(404).send({ code: "ASSURANCE_RUN_NOT_FOUND" });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "admin",
          row.space_id,
          row.vault_id,
        ))
      ) {
        return;
      }
      const cancelled = await cancelAssuranceRun(db, request.params.id);
      if (!cancelled) {
        return reply.code(409).send({ code: "ASSURANCE_RUN_NOT_CANCELLABLE" });
      }
      await audit(
        db,
        request,
        "assurance.run.cancel",
        "assurance_run",
        request.params.id,
        { vaultId: row.vault_id },
        row.space_id,
      );
      return { id: request.params.id, status: "CANCELLED" };
    },
  );
}
