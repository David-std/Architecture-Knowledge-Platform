import { timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import { z } from "zod";

const ProviderTaskUpdate = z.object({
  jobId: z.string().uuid().optional(),
  sourceId: z.string().uuid().optional(),
  provider: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i),
  taskId: z.string().min(1).max(256),
  status: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  taskType: z.string().min(1).max(80).optional(),
  mode: z.string().min(1).max(40).optional(),
  eventTime: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.unknown()).optional(),
});

type ProviderTaskUpdate = z.infer<typeof ProviderTaskUpdate>;

type ResolvedJob = {
  id: string;
  state: string;
  space_id: string;
  vault_id: string | null;
};

function tokenMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string" || !candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

function boundedTaskRecord(input: ProviderTaskUpdate): Record<string, unknown> {
  const metadata = input.metadata ?? {};
  const encodedMetadata = JSON.stringify(metadata);
  if (Buffer.byteLength(encodedMetadata, "utf8") > 16 * 1024) {
    const error = new Error(
      "Provider task metadata exceeds the durable journal limit.",
    ) as Error & {
      statusCode?: number;
      code?: string;
    };
    error.statusCode = 413;
    error.code = "PROVIDER_TASK_METADATA_TOO_LARGE";
    throw error;
  }
  return {
    taskId: input.taskId,
    status: input.status,
    ...(input.taskType ? { taskType: input.taskType } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.eventTime ? { eventTime: input.eventTime } : {}),
    metadata,
    updatedAt: new Date().toISOString(),
  };
}

async function resolveActiveJob(
  client: PoolClient,
  input: ProviderTaskUpdate,
): Promise<ResolvedJob | null> {
  if (input.jobId) {
    const result = await client.query<ResolvedJob>(
      `
      select id,state,space_id,vault_id
        from ingest_jobs
       where id=$1 and cancelled_at is null
      `,
      [input.jobId],
    );
    return result.rows[0] ?? null;
  }

  if (input.sourceId) {
    const result = await client.query<ResolvedJob>(
      `
      select id,state,space_id,vault_id
        from ingest_jobs
       where cancelled_at is null
         and state='NORMALIZING'
         and stage_outputs->>'sourceId'=$1
       order by created_at desc
       limit 2
      `,
      [input.sourceId],
    );
    if (result.rows.length > 1) {
      const error = new Error(
        "More than one active ingest job matches the provider source.",
      ) as Error & { statusCode?: number; code?: string };
      error.statusCode = 409;
      error.code = "PROVIDER_TASK_SOURCE_AMBIGUOUS";
      throw error;
    }
    return result.rows[0] ?? null;
  }

  // Authenticated provider webhooks commonly carry only their task ID. The
  // creation transition must already have established this durable mapping;
  // never guess by recency or accept more than one owner.
  const result = await client.query<ResolvedJob>(
    `
    select id,state,space_id,vault_id
      from ingest_jobs
     where cancelled_at is null
       and stage_outputs->'providerTasks'->$1->>'taskId'=$2
     order by created_at desc
     limit 2
    `,
    [input.provider, input.taskId],
  );
  if (result.rows.length > 1) {
    const error = new Error(
      "Provider task is associated with more than one active ingest job.",
    ) as Error & { statusCode?: number; code?: string };
    error.statusCode = 409;
    error.code = "PROVIDER_TASK_OWNER_AMBIGUOUS";
    throw error;
  }
  return result.rows[0] ?? null;
}

async function webhookAlreadyRecorded(
  client: PoolClient,
  jobId: string,
  provider: string,
  messageId: unknown,
): Promise<boolean> {
  if (typeof messageId !== "string" || !messageId.trim()) return false;
  // Serialize duplicate Svix deliveries for the same message ID so concurrent
  // retries remain idempotent without adding a provider-specific table.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `provider-webhook:${provider}:${messageId}`,
  ]);
  const result = await client.query(
    `
    select 1
      from ingest_job_events
     where job_id=$1
       and event_type='PROVIDER_TASK_STATE'
       and payload->>'provider'=$2
       and payload->'metadata'->>'webhookMessageId'=$3
     limit 1
    `,
    [jobId, provider, messageId],
  );
  return Boolean(result.rowCount);
}

/**
 * Internal, token-authenticated journal for provider task lifecycles.
 *
 * External document-intelligence services can create an asynchronous provider
 * task before the synchronous extractor call returns. Persisting the task ID
 * here immediately makes the association survive extractor/worker crashes and
 * worker lease reclamation. The storage shape is intentionally provider
 * neutral: adding a provider never requires a schema change.
 */
export function registerProviderTaskRoutes(app: FastifyInstance, db: Postgres) {
  app.post("/internal/provider-tasks", async (request, reply) => {
    const expectedToken = process.env.AKP_PROVIDER_TASK_CALLBACK_TOKEN?.trim();
    if (!expectedToken) {
      return reply.code(503).send({
        code: "PROVIDER_TASK_JOURNAL_NOT_CONFIGURED",
        message: "The provider-task journal is not configured.",
      });
    }
    const suppliedToken = request.headers["x-akp-provider-task-token"];
    if (!tokenMatches(suppliedToken, expectedToken)) {
      return reply.code(401).send({
        code: "PROVIDER_TASK_JOURNAL_UNAUTHORIZED",
        message: "Provider-task journal authentication failed.",
      });
    }

    const parsed = ProviderTaskUpdate.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_PROVIDER_TASK_UPDATE",
        message: "Provider-task update did not satisfy the internal contract.",
      });
    }
    const record = boundedTaskRecord(parsed.data);
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      const job = await resolveActiveJob(client, parsed.data);
      if (!job) {
        await client.query("rollback");
        return reply.code(409).send({
          code: "INGEST_JOB_NOT_ACTIVE",
          message:
            "The provider task could not be correlated to one active ingest job.",
        });
      }

      const webhookMessageId = (parsed.data.metadata ?? {}).webhookMessageId;
      if (
        await webhookAlreadyRecorded(
          client,
          job.id,
          parsed.data.provider,
          webhookMessageId,
        )
      ) {
        await client.query("commit");
        return reply.code(202).send({
          accepted: true,
          duplicate: true,
          jobId: job.id,
          provider: parsed.data.provider,
          taskId: parsed.data.taskId,
          status: parsed.data.status,
        });
      }

      const updated = await client.query(
        `
        update ingest_jobs
           set stage_outputs = jsonb_set(
                 stage_outputs,
                 '{providerTasks}',
                 coalesce(stage_outputs->'providerTasks','{}'::jsonb)
                   || jsonb_build_object($2,$3::jsonb),
                 true
               ),
               updated_at = now()
         where id = $1 and cancelled_at is null
        `,
        [job.id, parsed.data.provider, JSON.stringify(record)],
      );
      if (!updated.rowCount) {
        await client.query("rollback");
        return reply.code(409).send({
          code: "INGEST_JOB_NOT_ACTIVE",
          message: "The ingest job became inactive before journaling completed.",
        });
      }
      await client.query(
        `
        insert into ingest_job_events(job_id,state,event_type,payload)
        values($1,$2,'PROVIDER_TASK_STATE',$3::jsonb)
        `,
        [
          job.id,
          job.state,
          JSON.stringify({
            provider: parsed.data.provider,
            sourceId: parsed.data.sourceId ?? null,
            ...record,
          }),
        ],
      );
      await client.query("commit");
      return reply.code(202).send({
        accepted: true,
        duplicate: false,
        jobId: job.id,
        provider: parsed.data.provider,
        taskId: parsed.data.taskId,
        status: parsed.data.status,
      });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
}
