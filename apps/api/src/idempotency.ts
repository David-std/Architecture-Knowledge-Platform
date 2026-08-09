import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Postgres } from "@akp/postgres";
import { actorOf } from "./auth.js";

interface IdempotencyContext {
  actorId: string;
  credentialFingerprint: string;
  operation: string;
  key: string;
  requestHash: string;
  replayed: boolean;
  owner: boolean;
}

type RequestWithIdempotency = FastifyRequest & {
  idempotencyContext?: IdempotencyContext;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function hashRequest(operation: string, body: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, body: body ?? null }))
    .digest("hex");
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return { code: "NON_JSON_RESPONSE" };
  }
}

export function registerWriteIdempotency(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || !request.url.startsWith("/v1/")) return;
    // Session exchange returns one-time bearer material in Set-Cookie. The
    // platform intentionally does not persist raw session/CSRF secrets merely
    // to replay them, so this credential-issuance endpoint is excluded from
    // generic idempotent replay. All knowledge/source mutations remain scoped.
    if (request.url.split("?")[0] === "/v1/auth/session") return;
    const keyHeader = request.headers["idempotency-key"];
    const bodyKey =
      request.url.split("?")[0] === "/v1/ingest" &&
      request.body &&
      typeof request.body === "object" &&
      typeof (request.body as Record<string, unknown>).idempotencyKey ===
        "string"
        ? String((request.body as Record<string, unknown>).idempotencyKey)
        : undefined;
    const key = Array.isArray(keyHeader)
      ? keyHeader[0]
      : (keyHeader ?? bodyKey);
    if (!key) return;
    if (key.length < 8 || key.length > 200) {
      await reply.code(400).send({ code: "INVALID_IDEMPOTENCY_KEY" });
      return;
    }
    const actor = actorOf(request);
    if (!actor) return;
    // Use the concrete URL, not Fastify's parameterized route template. A key
    // for /reviews/A must never replay a response or skip authorization for
    // /reviews/B. Query parameters remain part of the identity as well.
    const operation = `${request.method} ${request.raw.url ?? request.url}`;
    const requestHash = hashRequest(operation, request.body);
    const claimed = await db.pool.query(
      `
      insert into idempotency_records(
        actor_id,credential_fingerprint,operation,idempotency_key,resource_id,response,request_hash,response_status,
        state,lease_owner,lease_expires_at
      ) values($1,$2,$3,$4,$5,null,$6,0,'IN_PROGRESS',$5,now()+interval '10 minutes')
      on conflict(actor_id,credential_fingerprint,operation,idempotency_key) do nothing
      returning request_hash,response_status,response,state,lease_owner
      `,
      [
        actor.id,
        actor.idempotencyScopeFingerprint,
        operation,
        key,
        request.id,
        requestHash,
      ],
    );
    if (claimed.rowCount) {
      (request as RequestWithIdempotency).idempotencyContext = {
        actorId: actor.id,
        credentialFingerprint: actor.idempotencyScopeFingerprint,
        operation,
        key,
        requestHash,
        replayed: false,
        owner: true,
      };
      return;
    }
    const existing = await db.pool.query(
      `
      select request_hash,response_status,response,state,lease_owner,lease_expires_at
        from idempotency_records
       where actor_id=$1 and credential_fingerprint=$2 and operation=$3 and idempotency_key=$4
       for key share
      `,
      [actor.id, actor.idempotencyScopeFingerprint, operation, key],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.request_hash && String(row.request_hash) !== requestHash) {
        await reply
          .code(409)
          .send({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" });
        return;
      }
      if (String(row.state) === "ABANDONED") {
        await reply.code(409).send({
          code: "IDEMPOTENCY_RECOVERY_REQUIRED",
          retryable: false,
        });
        return;
      }
      if (String(row.state) !== "COMPLETED" || row.response === null) {
        const expired =
          row.lease_expires_at !== null &&
          new Date(String(row.lease_expires_at)).getTime() <= Date.now();
        if (expired) {
          await db.pool.query(
            `
            update idempotency_records
               set state='ABANDONED',lease_owner=null
             where actor_id=$1 and credential_fingerprint=$2 and operation=$3
               and idempotency_key=$4 and state='IN_PROGRESS'
               and lease_expires_at <= now()
            `,
            [actor.id, actor.idempotencyScopeFingerprint, operation, key],
          );
          await reply.code(409).send({
            code: "IDEMPOTENCY_LEASE_EXPIRED_REQUIRES_RECOVERY",
            retryable: false,
          });
          return;
        }
        await reply.code(425).send({
          code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          retryable: false,
        });
        return;
      }
      (request as RequestWithIdempotency).idempotencyContext = {
        actorId: actor.id,
        credentialFingerprint: actor.idempotencyScopeFingerprint,
        operation,
        key,
        requestHash,
        replayed: true,
        owner: false,
      };
      await reply.code(Number(row.response_status ?? 200)).send(row.response);
      return;
    }
    await reply.code(409).send({ code: "IDEMPOTENCY_CLAIM_UNAVAILABLE" });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const context = (request as RequestWithIdempotency).idempotencyContext;
    if (!context || context.replayed || !context.owner) {
      return payload;
    }
    const response = parsePayload(payload);
    if (reply.statusCode >= 500) {
      // A 5xx may have happened after a side effect. Never auto-reclaim this
      // key: an operator must reconcile the target state before a new write.
      await db.pool.query(
        `
        update idempotency_records
           set state='ABANDONED',lease_owner=null
         where actor_id=$1 and credential_fingerprint=$2 and operation=$3
           and idempotency_key=$4 and state='IN_PROGRESS' and lease_owner=$5
        `,
        [
          context.actorId,
          context.credentialFingerprint,
          context.operation,
          context.key,
          request.id,
        ],
      );
      return payload;
    }
    const completed = reply.statusCode >= 200 && reply.statusCode < 500;
    if (!completed) return payload;
    const resourceId =
      response && typeof response === "object" && "id" in response
        ? String((response as Record<string, unknown>).id)
        : response && typeof response === "object" && "reviewId" in response
          ? String((response as Record<string, unknown>).reviewId)
          : response && typeof response === "object" && "jobId" in response
            ? String((response as Record<string, unknown>).jobId)
            : request.id;
    await db.pool.query(
      `
      update idempotency_records
         set resource_id=$5,response=$6::jsonb,response_status=$7,state='COMPLETED',
             lease_owner=null,lease_expires_at=null
       where actor_id=$1 and credential_fingerprint=$2 and operation=$3 and idempotency_key=$4
         and state='IN_PROGRESS' and lease_owner=$8
      `,
      [
        context.actorId,
        context.credentialFingerprint,
        context.operation,
        context.key,
        resourceId,
        JSON.stringify(response),
        reply.statusCode,
        request.id,
      ],
    );
    return payload;
  });
}
