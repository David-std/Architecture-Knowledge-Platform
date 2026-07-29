import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import { SearchRequest } from "@akp/contracts";

export function registerSearchRoutes(app: FastifyInstance, db: Postgres): void {
  app.post("/v1/search", async (request, reply) => {
    const parsed = SearchRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_SEARCH_REQUEST",
        issues: parsed.error.issues,
      });
    }

    const result = await db.pool.query(
      `
      select id, current_revision, title, type, trust_tier, lifecycle,
             ts_rank_cd(search_vector, websearch_to_tsquery('simple', $1)) as score,
             left(body_cache, 800) as excerpt
      from knowledge_documents
      where search_vector @@ websearch_to_tsquery('simple', $1)
        and lifecycle = 'ACTIVE'
      order by score desc
      limit $2
      `,
      [parsed.data.query, parsed.data.limit],
    );

    return {
      mode: parsed.data.mode,
      hits: result.rows.map((row) => ({
        documentId: row.id,
        revision: row.current_revision,
        title: row.title,
        type: row.type,
        trust: row.trust_tier,
        lifecycle: row.lifecycle,
        score: Number(row.score),
        reasons: ["lexical"],
        excerpt: row.excerpt,
        citations: [],
      })),
    };
  });
}
