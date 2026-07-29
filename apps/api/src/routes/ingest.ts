import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import { IngestRequest } from "@akp/contracts";

export function registerIngestRoutes(app: FastifyInstance, db: Postgres): void {
  app.post("/v1/ingest", async (request, reply) => {
    const parsed = IngestRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_INGEST_REQUEST",
        issues: parsed.error.issues,
      });
    }

    const id = randomUUID();
    await db.pool.query(
      `
      insert into ingest_jobs(id, space_id, source_uri, state, payload)
      values ($1, $2, $3, 'RECEIVED', $4::jsonb)
      `,
      [id, parsed.data.spaceId, parsed.data.sourceUri, JSON.stringify(parsed.data)],
    );

    return reply.code(202).send({ jobId: id, state: "RECEIVED" });
  });

  app.get<{ Params: { id: string } }>("/v1/ingest/:id", async (request, reply) => {
    const result = await db.pool.query(
      "select id, state, result, error, attempts, updated_at from ingest_jobs where id = $1",
      [request.params.id],
    );
    if (!result.rowCount) return reply.code(404).send({ code: "JOB_NOT_FOUND" });
    return result.rows[0];
  });
}
