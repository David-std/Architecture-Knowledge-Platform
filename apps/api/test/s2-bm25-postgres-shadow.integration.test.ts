import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { shadowS2Bm25SamePool } from "../../../packages/evaluation/src/s2-bm25-same-pool-shadow.js";

/**
 * Contrasts exact PostgreSQL lexical query primitives from queryKnowledge
 * with a genuine BM25 formula on the same synthetic, already-authorized
 * passage set. Does not replace the full weighted lexical+assertion-recall
 * production query, its RRF stage or the source/Reader/Writer gate.
 */
describe("S2 PostgreSQL lexical vs offline BM25 same-pool development probe", () => {
  const url = process.env.DATABASE_URL;
  it.skipIf(!url)(
    "shows exact Spanish query terms can suppress recall before a later semantic reader",
    async () => {
      const query = "¿Quién aprobó M-7 tras la auditoría?";
      const rows = [
        {
          key: "generic",
          text: "La auditoría aprobó el informe general. Auditoría general.",
        },
        {
          key: "exact",
          text: "M-7 fue aprobado por Lira después de la auditoría.",
        },
        {
          key: "wrong",
          text: "M-9 fue rechazado por Lira antes de la auditoría.",
        },
      ];
      const db = new Postgres(url!);
      try {
        const sql = await db.pool.query<{
          key: string;
          strict_hit: boolean;
          lexical_rank: number;
        }>(
          `with candidates as (
             select * from unnest($1::text[], $2::text[]) as t(key, passage)
           ), q as (select plainto_tsquery('simple',$3) terms)
           select key,
                  to_tsvector('simple',passage) @@ q.terms strict_hit,
                  ts_rank_cd(to_tsvector('simple',passage),q.terms) lexical_rank
             from candidates cross join q
            order by key`,
          [rows.map((r) => r.key), rows.map((r) => r.text), query],
        );
        const strictMatches = sql.rows.filter((r) => r.strict_hit);
        expect(strictMatches).toEqual([]);
        // A Spanish stemmer corrects the approved/aprobo morphological
        // mismatch for bounded terms, but does NOT cure a long natural
        // question that still requires words not present in the passage.
        const morphology = await db.pool.query<{
          full_query_hit: boolean;
          bounded_query_hit: boolean;
          simple_morph_match: boolean;
        }>(
          `select
             to_tsvector('spanish',$1) @@
               plainto_tsquery('spanish',$2) full_query_hit,
             to_tsvector('spanish',$1) @@
               plainto_tsquery('spanish',$3) bounded_query_hit,
             to_tsvector('simple',$1) @@
               plainto_tsquery('simple',$3) simple_morph_match`,
          [
            "M-7 fue aprobado por Lira despues de la auditoria.",
            "quien aprobo M-7 tras la auditoria",
            "M-7 aprobo auditoria",
          ],
        );
        expect(morphology.rows[0]).toEqual({
          full_query_hit: false,
          bounded_query_hit: true,
          simple_morph_match: false,
        });
        const shadow = shadowS2Bm25SamePool({
          query,
          candidates: rows.map((r, index) => ({
            candidateKey: r.key,
            passage: r.text,
            baselineRank: index + 1,
          })),
        });
        // BM25 no longer requires *all* query terms, but can still put an
        // irrelevant on-topic document first. This is diagnostic, not a win.
        expect(shadow.ordered[0]?.candidateKey).toBe("generic");
        expect(
          shadow.ordered.some((r) => r.candidateKey === "exact" && r.score > 0),
        ).toBe(true);
        expect(shadow.releaseGateAccepted).toBe(false);
      } finally {
        await db.close();
      }
    },
  );
});
