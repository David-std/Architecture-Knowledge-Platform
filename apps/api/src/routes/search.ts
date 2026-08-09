import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import {
  SearchRequest,
  type SearchHit,
  type SearchRequest as SearchInput,
} from "@akp/contracts";
import {
  buildContextPacket,
  deterministicEmbedding,
  planQuery,
  reciprocalRankFusion,
  toPgVector,
} from "@akp/retrieval";
import {
  actorOf,
  hasPathAccess,
  hasSpaceAccess,
  requirePermission,
} from "../auth.js";

const TRUST_RANK: Record<string, number> = {
  UNVERIFIED: 0,
  MACHINE_SUPPORTED: 1,
  HUMAN_REVIEWED: 2,
  ATTESTED: 3,
};

function kindOf(
  layer: string,
  type: string,
):
  | "rule"
  | "workflow"
  | "concept"
  | "profile"
  | "example"
  | "evidence"
  | "source" {
  const value = `${layer} ${type}`.toLowerCase();
  if (value.includes("rule") || value.includes("policy")) return "rule";
  if (value.includes("workflow")) return "workflow";
  if (value.includes("profile")) return "profile";
  if (value.includes("example")) return "example";
  if (value.includes("evidence")) return "evidence";
  if (value.includes("source") || value.includes("resource")) return "source";
  return "concept";
}

export interface RetrievalExecutionOptions {
  channels?: Array<
    "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
  >;
  allowVectorForBenchmark?: boolean;
  deterministicRerank?: boolean;
  /** Applied after policy/trust filtering so a scoped caller never receives a
   * path it is not allowed to read. */
  pathAuthorizer?: (path: string) => boolean;
}

type RetrievalChannel = NonNullable<
  RetrievalExecutionOptions["channels"]
>[number];

export function channelsConsistentWithIndex(
  requested: Iterable<RetrievalChannel>,
  index: Record<string, unknown> | undefined,
  vectorAllowed: boolean,
): { channels: RetrievalChannel[]; warnings: string[] } {
  const channels = new Set(requested);
  const warnings: string[] = [];
  const corpus = index?.corpus_revision ? String(index.corpus_revision) : null;
  const derived: Array<[RetrievalChannel, string]> = [
    ["lexical", "lexical_revision"],
    ["graph", "graph_revision"],
    ["context-pack", "context_pack_revision"],
    ["vector", "vector_revision"],
  ];
  for (const [channel, field] of derived) {
    if (!channels.has(channel)) continue;
    const revision = index?.[field] ? String(index[field]) : null;
    if (!corpus || !revision || revision !== corpus) {
      channels.delete(channel);
      warnings.push(`INDEX_REVISION_MISMATCH:${channel}`);
    }
  }
  if (channels.has("vector") && !vectorAllowed) {
    channels.delete("vector");
    warnings.push("VECTOR_DISABLED");
  }
  return { channels: [...channels], warnings };
}

function deterministicLexicalRerank(
  query: string,
  hits: SearchHit[],
): SearchHit[] {
  const terms = new Set(
    query
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase()
      .split(/[^\p{Letter}\p{Number}]+/u)
      .filter((term) => term.length >= 3),
  );
  return hits
    .map((hit) => {
      const haystack = `${hit.title} ${hit.excerpt}`
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLocaleLowerCase();
      const overlap = [...terms].filter((term) =>
        haystack.includes(term),
      ).length;
      return {
        ...hit,
        score: hit.score + overlap * 0.001,
        reasons: [...hit.reasons, "deterministic-lexical-rerank"],
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.documentId.localeCompare(right.documentId),
    );
}

export async function queryKnowledge(
  db: Postgres,
  input: SearchInput,
  options: RetrievalExecutionOptions = {},
): Promise<SearchHit[]> {
  const spaceId = input.spaceId ?? "00000000-0000-0000-0000-000000000003";
  const plan = planQuery(input.query);
  const requestedChannels = options.channels ?? plan.channels;
  const index = await db.pool.query(
    "select corpus_revision,lexical_revision,vector_revision,graph_revision,context_pack_revision,status,warnings from index_revisions where space_id=$1",
    [spaceId],
  );
  const consistency = channelsConsistentWithIndex(
    requestedChannels,
    index.rows[0],
    process.env.AKP_VECTOR_ENABLED === "true" ||
      Boolean(options.allowVectorForBenchmark),
  );
  const channels = new Set(consistency.channels);
  const modeClause =
    input.mode === "RAW_ONLY"
      ? "and (layer = 'resource' or type = 'raw-resource')"
      : input.mode === "COMPILED_ONLY"
        ? "and layer not in ('resource', 'source')"
        : input.mode === "SOURCE_BACKED"
          ? "and not (layer = 'resource' or type = 'raw-resource')"
          : "";

  const exact = channels.has("exact")
    ? await db.pool.query(
        `
    select id
      from knowledge_documents
     where space_id = $1
       and lifecycle in ('ACTIVE','DISPUTED')
       and refresh_status not in ('STALE_BLOCKED','INVALID')
       and (
         lower(external_id) = lower($2)
         or lower(path) = lower($2)
         or lower(title) = lower($2)
         or exists (select 1 from unnest(aliases) alias where lower(alias) = lower($2))
       )
       ${modeClause}
     limit $3
    `,
        [spaceId, input.query, input.limit],
      )
    : { rows: [] as Array<{ id: string }> };

  const lexical =
    channels.has("lexical") || channels.has("graph")
      ? await db.pool.query(
          `
    select u.document_id id, u.id unit_id, u.unit_type,
           ts_rank_cd(u.search_vector, websearch_to_tsquery('simple', $2)) score
      from knowledge_units u
      join knowledge_documents d on d.id=u.document_id
     where u.space_id = $1
       and u.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
       and u.search_vector @@ websearch_to_tsquery('simple', $2)
       ${modeClause}
     order by score desc, u.id
     limit $3
    `,
          [spaceId, input.query, Math.max(input.limit * 3, 30)],
        )
      : {
          rows: [] as Array<{
            id: string;
            unit_id: string;
            unit_type: string;
            score: number;
          }>,
        };

  const stopWords = new Set([
    "para",
    "como",
    "esta",
    "este",
    "esto",
    "puede",
    "usar",
    "misma",
    "base",
    "datos",
    "sigue",
    "quinta",
    "capa",
    "the",
    "and",
    "with",
    "from",
    "what",
    "does",
  ]);
  const baseTerms = input.query
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((term) => term.length >= 4 && !stopWords.has(term))
    .slice(0, 8);
  const synonymMap: Record<string, string[]> = {
    domain: ["dominio"],
    events: ["eventos", "eventstorming"],
    event: ["evento", "eventstorming"],
    explicitly: ["explicitamente", "evidencia"],
    explicita: ["evidence", "evidencia"],
    enseno: ["curso", "evidencia"],
    taught: ["curso", "evidencia"],
    despues: ["fases", "secuencia", "workflow", "flujo"],
  };
  const terms = [
    ...new Set(
      baseTerms.flatMap((term) => [term, ...(synonymMap[term] ?? [])]),
    ),
  ].slice(0, 12);
  const fallback =
    terms.length === 0 || !channels.has("lexical")
      ? { rows: [] as Array<{ id: string }> }
      : await db.pool.query(
          `
          select id
            from knowledge_documents
           where space_id=$1 and lifecycle in ('ACTIVE','DISPUTED')
             and refresh_status not in ('STALE_BLOCKED','INVALID')
             and exists (
               select 1 from unnest($2::text[]) pattern
                where lower(title || ' ' || body_cache) like pattern
             )
             ${modeClause}
           order by
             (select count(*) from unnest($2::text[]) pattern
               where lower(title || ' ' || body_cache) like pattern) desc,
             path
           limit $3
          `,
          [
            spaceId,
            terms.map((term) => `%${term}%`),
            Math.max(input.limit * 3, 30),
          ],
        );

  const vector =
    (process.env.AKP_VECTOR_ENABLED === "true" ||
      options.allowVectorForBenchmark) &&
    channels.has("vector")
      ? await db.pool.query(
          `
          select u.document_id id, u.id unit_id, u.unit_type,
                 1 - (e.embedding <=> $2::vector) score
            from unit_embeddings e
            join embedding_generations g on g.id=e.generation_id
            join knowledge_units u on u.id=e.unit_id
            join knowledge_documents d on d.id=u.document_id
           where u.space_id=$1 and g.status in ('READY','ACTIVE')
             and g.corpus_revision=u.corpus_revision
             and d.lifecycle in ('ACTIVE','DISPUTED')
             and d.refresh_status not in ('STALE_BLOCKED','INVALID')
           order by e.embedding <=> $2::vector
           limit $3
          `,
          [
            spaceId,
            toPgVector(deterministicEmbedding(input.query)),
            Math.max(input.limit * 3, 30),
          ],
        )
      : {
          rows: [] as Array<{
            id: string;
            unit_id: string;
            unit_type: string;
            score: number;
          }>,
        };

  const seedIds = [
    ...new Set(
      [...exact.rows, ...lexical.rows, ...vector.rows, ...fallback.rows].map(
        (row) => String(row.id),
      ),
    ),
  ];
  const contextPack =
    channels.has("context-pack") && terms.length > 0
      ? await db.pool.query(
          `
          select id from knowledge_documents
           where space_id=$1
             and lifecycle in ('ACTIVE','DISPUTED')
             and refresh_status not in ('STALE_BLOCKED','INVALID')
             and path like '90-agent-layer/context-packs/%'
             and exists (
               select 1 from unnest($2::text[]) pattern
                where lower(title || ' ' || body_cache) like pattern
             )
           order by path limit $3
          `,
          [
            spaceId,
            terms.map((term) => `%${term}%`),
            Math.max(input.limit, 10),
          ],
        )
      : { rows: [] as Array<{ id: string }> };

  const rawFallback =
    channels.has("raw") && terms.length > 0
      ? await db.pool.query(
          `
          select id from knowledge_documents
           where space_id=$1 and lifecycle in ('ACTIVE','DISPUTED')
             and refresh_status not in ('STALE_BLOCKED','INVALID')
             and (layer in ('source','resource') or type='raw-resource')
             and exists (
               select 1 from unnest($2::text[]) pattern
                where lower(title || ' ' || body_cache) like pattern
             )
           order by trust_tier desc,path limit $3
          `,
          [
            spaceId,
            terms.map((term) => `%${term}%`),
            Math.max(input.limit, 10),
          ],
        )
      : { rows: [] as Array<{ id: string }> };

  const codeFallback =
    channels.has("code") && terms.length > 0
      ? await db.pool.query(
          `
          select id from knowledge_documents
           where space_id=$1 and lifecycle in ('ACTIVE','DISPUTED')
             and refresh_status not in ('STALE_BLOCKED','INVALID')
             and layer='project'
             and exists (
               select 1 from unnest($2::text[]) pattern
                where lower(title || ' ' || body_cache) like pattern
             )
           order by updated_at desc limit $3
          `,
          [
            spaceId,
            terms.map((term) => `%${term}%`),
            Math.max(input.limit, 10),
          ],
        )
      : { rows: [] as Array<{ id: string }> };

  const graph =
    seedIds.length === 0 || !channels.has("graph")
      ? { rows: [] as Array<{ id: string; weight: number }> }
      : await db.pool.query(
          `
          select candidate.id, max(r.weight) weight
            from knowledge_relations r
            join knowledge_documents candidate
              on candidate.id = case
                when r.from_document_id = any($2::uuid[]) then r.to_document_id
                else r.from_document_id
              end
           where r.space_id = $1
             and (r.from_document_id = any($2::uuid[]) or r.to_document_id = any($2::uuid[]))
             and candidate.lifecycle in ('ACTIVE','DISPUTED')
             and candidate.refresh_status not in ('STALE_BLOCKED','INVALID')
           group by candidate.id
           order by
             case candidate.layer when 'workflow' then 0 when 'claim' then 1
               when 'evidence' then 2 else 3 end,
             weight desc
           limit $3
          `,
          [spaceId, seedIds, Math.max(input.limit * 2, 20)],
        );

  const fused = reciprocalRankFusion([
    exact.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 3,
      reason: "exact-or-alias",
    })),
    ...(channels.has("lexical")
      ? [
          lexical.rows.map((row, index) => ({
            id: String(row.id),
            rank: index + 1,
            weight: 1.5,
            reason: "lexical",
          })),
        ]
      : []),
    vector.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 1,
      reason: "vector",
    })),
    contextPack.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 2.5,
      reason: "context-pack",
    })),
    rawFallback.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 1.2,
      reason: "raw-source-fallback",
    })),
    codeFallback.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 1.2,
      reason: "project-code-fallback",
    })),
    fallback.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 0.8,
      reason: "lexical-fallback",
    })),
    graph.rows.map((row, index) => ({
      id: String(row.id),
      rank: index + 1,
      weight: 1.4 * Number(row.weight ?? 1),
      reason: "graph-neighbor",
    })),
  ]).slice(0, input.limit * 2);
  if (fused.length === 0) return [];

  const details = await db.pool.query(
    `
    select d.id, d.space_id, d.external_id, d.current_revision, d.path, d.title, d.type, d.layer,
           d.trust_tier, d.lifecycle, d.body_cache,
           d.refresh_status,
           coalesce(
             jsonb_agg(distinct jsonb_build_object(
               'id',cited.id,'path',cited.path,'revision',cited.current_revision
             ))
               filter (where cited.id is not null),
             '[]'::jsonb
           ) citations,
           coalesce(jsonb_agg(distinct e.locator) filter (where e.id is not null),'[]'::jsonb)
             evidence_locators
      from knowledge_documents d
      left join knowledge_relations r
        on r.from_document_id = d.id and r.relation_type in ('supports', 'derives_from', 'related_to')
      left join knowledge_documents cited
        on cited.id = r.to_document_id
       and (cited.layer in ('source', 'resource', 'evidence') or cited.type like '%evidence%')
      left join document_evidence de on de.document_id=d.id
      left join evidence e on e.id=de.evidence_id
     where d.id = any($1::uuid[])
     group by d.id
    `,
    [fused.map((item) => item.id)],
  );
  const byId = new Map(details.rows.map((row) => [String(row.id), row]));
  const bestUnitByDocument = new Map<
    string,
    { unitId: string; unitType: string }
  >();
  for (const row of [...lexical.rows, ...vector.rows]) {
    const documentId = String(row.id);
    if (!bestUnitByDocument.has(documentId) && row.unit_id) {
      bestUnitByDocument.set(documentId, {
        unitId: String(row.unit_id),
        unitType: String(row.unit_type),
      });
    }
  }
  const minimumTrust = TRUST_RANK[input.minimumTrust] ?? 1;

  const results = fused
    .map((item): SearchHit | null => {
      const row = byId.get(item.id);
      if (
        !row ||
        (TRUST_RANK[String(row.trust_tier)] ?? 0) < minimumTrust ||
        (options.pathAuthorizer && !options.pathAuthorizer(String(row.path)))
      )
        return null;
      const documentCitations = ["source", "resource"].includes(
        String(row.layer),
      )
        ? [`${row.path}@${row.current_revision}`]
        : ((row.citations ?? []) as Array<Record<string, unknown>>)
            .filter(
              (citation) =>
                !options.pathAuthorizer ||
                options.pathAuthorizer(String(citation.path ?? "")),
            )
            .map(
              (citation) =>
                `${String(citation.path)}@${String(citation.revision ?? row.current_revision)}`,
            );
      const citations = [
        ...documentCitations,
        ...(
          (row.evidence_locators ?? []) as Array<Record<string, unknown>>
        ).map((locator) => `evidence:${JSON.stringify(locator)}`),
      ];
      return {
        documentId: String(row.id),
        ...bestUnitByDocument.get(item.id),
        revision: String(row.current_revision),
        title: String(row.title),
        type: String(row.type),
        trust: String(row.trust_tier) as SearchHit["trust"],
        lifecycle: String(row.lifecycle) as SearchHit["lifecycle"],
        score: item.score,
        reasons: item.reasons,
        excerpt: String(row.body_cache).slice(0, 1200),
        citations,
        warnings:
          String(row.refresh_status ?? "CURRENT") === "STALE_PENDING_REVIEW"
            ? ["STALE_PENDING_REVIEW"]
            : [],
      };
    })
    .filter((hit): hit is SearchHit => hit !== null);
  return (
    options.deterministicRerank
      ? deterministicLexicalRerank(input.query, results)
      : results
  ).slice(0, input.limit);
}

export function registerSearchRoutes(app: FastifyInstance, db: Postgres): void {
  app.post(
    "/v1/search",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const parsed = SearchRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_SEARCH_REQUEST",
          issues: parsed.error.issues,
        });
      }
      const actor = actorOf(request);
      const requestedSpace =
        parsed.data.spaceId ?? "00000000-0000-0000-0000-000000000003";
      if (!hasSpaceAccess(actor, requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const hits = await queryKnowledge(db, parsed.data, {
        pathAuthorizer: (documentPath) =>
          hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath),
      });
      const plan = planQuery(parsed.data.query);
      const index = await db.pool.query(
        "select * from index_revisions where space_id=$1",
        [requestedSpace],
      );
      return {
        mode: parsed.data.mode,
        intent: plan.intent,
        plan,
        degraded:
          process.env.AKP_VECTOR_ENABLED !== "true" ||
          String(index.rows[0]?.status ?? "DEGRADED") !== "CONSISTENT",
        channels: channelsConsistentWithIndex(
          plan.channels,
          index.rows[0],
          process.env.AKP_VECTOR_ENABLED === "true",
        ).channels,
        warnings: channelsConsistentWithIndex(
          plan.channels,
          index.rows[0],
          process.env.AKP_VECTOR_ENABLED === "true",
        ).warnings,
        indexRevisions: index.rows[0] ?? null,
        hits,
        noAnswer:
          hits.length === 0
            ? {
                reason: "NO_SUPPORTED_MATCH",
                guidance:
                  "Broaden the query or lower the minimum trust explicitly.",
              }
            : null,
      };
    },
  );

  app.post(
    "/v1/context",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const parsed = SearchRequest.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CONTEXT_REQUEST",
          issues: parsed.error.issues,
        });
      }
      const maxTokens = Math.max(
        256,
        Math.min(Number(body.maxTokens ?? 6000), 32000),
      );
      const plan = planQuery(parsed.data.query, String(body.intent ?? ""));
      const intent = plan.intent;
      const requestedSpace =
        parsed.data.spaceId ?? "00000000-0000-0000-0000-000000000003";
      if (!hasSpaceAccess(actorOf(request), requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const actor = actorOf(request);
      const hits = await queryKnowledge(db, parsed.data, {
        pathAuthorizer: (documentPath) =>
          hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath),
      });
      const details =
        hits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `select id, layer, type, body_cache from knowledge_documents where id = any($1::uuid[])`,
              [hits.map((hit) => hit.documentId)],
            );
      const detailById = new Map(
        details.rows.map((row) => [String(row.id), row]),
      );
      const revision = await db.pool.query(
        `select current_revision from vaults where space_id = $1 order by last_imported_at desc limit 1`,
        [parsed.data.spaceId ?? "00000000-0000-0000-0000-000000000003"],
      );
      const index = await db.pool.query(
        `
        select corpus_revision,lexical_revision,vector_revision,graph_revision,
               context_pack_revision,status,warnings,retrieval_configuration_version
          from index_revisions where space_id=$1
        `,
        [requestedSpace],
      );
      const indexRow = index.rows[0] ?? {};
      const conflicts =
        hits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `
              select distinct c.id,c.topic,c.status,c.resolution
                from contradiction_clusters c
                join contradiction_members m on m.cluster_id=c.id
               where m.document_id=any($1::uuid[]) and c.status <> 'RESOLVED'
              `,
              [hits.map((hit) => hit.documentId)],
            );
      const packet = buildContextPacket({
        request: parsed.data,
        intent,
        corpusRevision: String(
          indexRow.corpus_revision ??
            revision.rows[0]?.current_revision ??
            "unknown",
        ),
        maxTokens,
        indexRevisions: {
          corpus: String(
            indexRow.corpus_revision ??
              revision.rows[0]?.current_revision ??
              "unknown",
          ),
          lexical: indexRow.lexical_revision
            ? String(indexRow.lexical_revision)
            : null,
          vector: indexRow.vector_revision
            ? String(indexRow.vector_revision)
            : null,
          graph: indexRow.graph_revision
            ? String(indexRow.graph_revision)
            : null,
          contextPack: indexRow.context_pack_revision
            ? String(indexRow.context_pack_revision)
            : null,
        },
        retrievalConfiguration: {
          version: String(indexRow.retrieval_configuration_version ?? "rrf-v1"),
          channels: plan.channels,
          vectorEnabled: process.env.AKP_VECTOR_ENABLED === "true",
        },
        candidates: hits.map((hit) => {
          const detail = detailById.get(hit.documentId);
          return {
            hit,
            content: String(detail?.body_cache ?? hit.excerpt),
            kind: kindOf(
              String(detail?.layer ?? ""),
              String(detail?.type ?? hit.type),
            ),
          };
        }),
        gaps:
          hits.length === 0
            ? ["No source-backed material matched the request."]
            : [],
        conflicts: conflicts.rows.map((row) => `${row.topic} (${row.status})`),
      });
      await db.pool.query(
        `
        insert into context_packets(id, space_id, actor_id, corpus_revision, query_hash,
                                    packet_hash, request, packet)
        values ($1,$2,$3,$4,encode(digest($5,'sha256'),'hex'),$6,$7::jsonb,$8::jsonb)
        `,
        [
          packet.packetId,
          parsed.data.spaceId ?? "00000000-0000-0000-0000-000000000003",
          actorOf(request)?.id ?? null,
          packet.corpusRevision,
          parsed.data.query,
          packet.packetHash,
          JSON.stringify(parsed.data),
          JSON.stringify(packet),
        ],
      );
      return packet;
    },
  );
}
