import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import { z } from "zod";

const ProviderTaskUpdate = z.object({
  jobId: z.string().uuid().optional(),
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

/**
 * Internal, token-authenticated journal for provider task lifecycles.
 *
 * The initial task-created update carries ``jobId`` and makes the external task
 * durable immediately. A subsequently verified provider webhook can omit the
 * job ID: the API resolves it from that pre-existing durable provider/task
 * mapping. This keeps provider IDs out of the relational schema while still
 * surviving extractor/worker crashes and lease reclamation.
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
      let jobId = parsed.data.jobId;
      if (!jobId) {
        const matches = await client.query<{ id: string }>(
          `
          select id
            from ingest_jobs
           where cancelled_at is null
             and stage_outputs #>> array['providerTasks',$1,'taskId'] = $2
           order by updated_at desc,id
           limit 2
          `,
          [parsed.data.provider, parsed.data.taskId],
        );
        if (matches.rowCount !== 1) {
          await client.query("rollback");
          return reply.code(409).send({
            code:
              matches.rowCount === 0
                ? "PROVIDER_TASK_MAPPING_NOT_FOUND"
                : "PROVIDER_TASK_MAPPING_AMBIGUOUS",
            message: "The provider task could not be resolved safely.",
          });
        }
        jobId = matches.rows[0]?.id;
      }
      if (!jobId) {
        await client.query("rollback");
        return reply.code(409).send({
          code: "PROVIDER_TASK_MAPPING_NOT_FOUND",
          message: "The provider task could not be resolved safely.",
        });
      }

      const updated = await client.query<{
        id: string;
        state: string;
        space_id: string;
        vault_id: string | null;
      }>(
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
         returning id,state,space_id,vault_id
        `,
        [jobId, parsed.data.provider, JSON.stringify(record)],
      );
      const job = updated.rows[0];
      if (!job) {
        await client.query("rollback");
        return reply.code(409).send({
          code: "INGEST_JOB_NOT_ACTIVE",
          message: "The ingest job is missing or cancelled.",
        });
      }
      await client.query(
        `
        insert into ingest_job_events(job_id,state,event_type,payload)
        values($1,$2,'PROVIDER_TASK_STATE',$3::jsonb)
        `,
        [
          jobId,
          job.state,
          JSON.stringify({
            provider: parsed.data.provider,
            ...record,
          }),
        ],
      );
      await client.query("commit");
      return reply.code(202).send({
        accepted: true,
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
