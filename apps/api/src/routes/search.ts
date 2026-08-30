import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  SearchRequest,
  type SearchHit,
  type SearchRequest as SearchInput,
} from "@akp/contracts";
import {
  buildContextPacket,
  contextBudgetForIntent,
  deterministicEmbedding,
  planQuery,
  rehydrateStructuralContext,
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

const UNSAFE_LOCATOR_KEY =
  /^(?:source(?:uri|_uri)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|canonical(?:path|_path)|object(?:key|_key)|endpoint|host|file|url|uri)$/i;
const ABSOLUTE_LOCATOR_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/;

function kindOf(
  layer: string,
  type: string,
):
  | "rule"
  | "workflow"
  | "concept"
  | "profile"
  | "decision"
  | "example"
  | "counterexample"
  | "evidence"
  | "source" {
  const value = `${layer} ${type}`.toLowerCase();
  if (value.includes("rule") || value.includes("policy")) return "rule";
  if (value.includes("workflow")) return "workflow";
  if (value.includes("profile")) return "profile";
  if (value.includes("decision") || value.includes("adr")) return "decision";
  if (value.includes("counterexample") || value.includes("contraejemplo"))
    return "counterexample";
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
  vaultIds?: string[];
  /** Applied after policy/trust filtering so a scoped caller never receives a
   * path it is not allowed to read. */
  pathAuthorizer?: (path: string, vaultId?: string) => boolean;
}

type RetrievalChannel = NonNullable<
  RetrievalExecutionOptions["channels"]
>[number];

type IndexRevisionRow = Record<string, unknown> & {
  vault_id?: string;
  corpus_revision?: string;
};

function combineVaultIndexRows(rows: IndexRevisionRow[]): IndexRevisionRow {
  if (rows.length === 0) return {};
  if (rows.length === 1) return rows[0] ?? {};
  const stable = rows
    .map((row) => ({
      vaultId: String(row.vault_id ?? ""),
      corpusRevision: String(row.corpus_revision ?? ""),
    }))
    .sort((left, right) => left.vaultId.localeCompare(right.vaultId));
  const corpusRevision = `federated:${createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")}`;
  const result: IndexRevisionRow = {
    corpus_revision: corpusRevision,
    status: rows.every((row) => String(row.status) === "CONSISTENT")
      ? "CONSISTENT"
      : "DEGRADED",
    warnings: rows.flatMap((row) =>
      Array.isArray(row.warnings) ? row.warnings : [],
    ),
    retrieval_configuration_version: "federated-rrf-v1",
  };
  for (const field of [
    "lexical_revision",
    "vector_revision",
    "graph_revision",
    "context_pack_revision",
  ]) {
    result[field] = rows.every(
      (row) =>
        String(row[field] ?? "") === String(row.corpus_revision ?? "") &&
        String(row[field] ?? "") !== "",
    )
      ? corpusRevision
      : null;
  }
  return result;
}

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

/**
 * Evidence locators are corpus data and can contain local paths.  A
 * path-scoped caller must not receive a locator for a path outside its
 * membership prefix, even when the matched document itself is readable.
 * Synthetic `source:<uuid>` locators identify an already scoped source and
 * are not filesystem paths.
 */
export function evidenceLocatorAllowed(
  locator: unknown,
  pathAuthorizer?: (path: string) => boolean,
): boolean {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return false;
  }
  const candidate = locator as Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate)) {
    if (UNSAFE_LOCATOR_KEY.test(key)) return false;
    if (typeof value === "string" && ABSOLUTE_LOCATOR_TOKEN.test(value)) {
      return false;
    }
    if (Array.isArray(value)) {
      if (
        value.some(
          (entry) =>
            (typeof entry === "string" && ABSOLUTE_LOCATOR_TOKEN.test(entry)) ||
            (entry !== null &&
              typeof entry === "object" &&
              !evidenceLocatorAllowed(entry, pathAuthorizer)),
        )
      ) {
        return false;
      }
    } else if (value && typeof value === "object") {
      if (!evidenceLocatorAllowed(value, pathAuthorizer)) return false;
    }
  }
  for (const key of ["path", "source_path", "document_path"]) {
    const value = candidate[key];
    if (typeof value !== "string") continue;
    if (value.startsWith("source:")) {
      if (
        !/^source:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        )
      ) {
        return false;
      }
      continue;
    }
    if (pathAuthorizer && !pathAuthorizer(value)) return false;
  }
  return true;
}

/** Keep only portable locator data in a retrieval response. */
function sanitizeEvidenceLocator(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEvidenceLocator);
  if (typeof value === "string") {
    return value.replace(
      /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g,
      "[REDACTED_PATH]",
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !UNSAFE_LOCATOR_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeEvidenceLocator(entry)]),
  );
}

export async function queryKnowledge(
  db: Postgres,
  input: SearchInput,
  options: RetrievalExecutionOptions = {},
): Promise<SearchHit[]> {
  if (!input.spaceId) throw new Error("SPACE_ID_REQUIRED");
  const spaceId = input.spaceId;
  const vaultIds = [
    ...new Set([
      ...(options.vaultIds ?? []),
      ...(input.vaultId ? [input.vaultId] : []),
      ...(input.vaultIds ?? []),
    ]),
  ];
  if (vaultIds.length === 0) {
    throw new Error("VAULT_SCOPE_REQUIRED");
  }
  if (vaultIds.length > 1 && !input.federated) {
    throw new Error("FEDERATED_QUERY_REQUIRES_EXPLICIT_OPT_IN");
  }
  if (
    vaultIds.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  ) {
    throw new Error("INVALID_VAULT_ID");
  }
  const vaultFilter = (alias = "") =>
    vaultIds.length === 0
      ? ""
      : `and ${alias}vault_id=any(array[${vaultIds
          .map((id) => `'${id}'::uuid`)
          .join(",")}])`;
  const plan = planQuery(input.query);
  const requestedChannels = options.channels ?? plan.channels;
  const indexRows = await db.pool.query(
    `select vault_id,corpus_revision,lexical_revision,vector_revision,
            graph_revision,context_pack_revision,status,warnings,
            retrieval_configuration_version
       from vault_index_revisions
      where space_id=$1 and vault_id=any($2::uuid[])
      order by vault_id`,
    [spaceId, vaultIds],
  );
  const index = combineVaultIndexRows(indexRows.rows);
  const consistency = channelsConsistentWithIndex(
    requestedChannels,
    index,
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
       ${vaultFilter()}
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
       ${vaultFilter("u.")}
       and u.lifecycle in ('ACTIVE','DISPUTED')
       and u.embedding_eligible
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
  const terms = [...new Set(baseTerms)].slice(0, 12);
  const fallback =
    terms.length === 0 || !channels.has("lexical")
      ? { rows: [] as Array<{ id: string }> }
      : await db.pool.query(
          `
          select id
            from knowledge_documents
           where space_id=$1
             ${vaultFilter()}
             and lifecycle in ('ACTIVE','DISPUTED')
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
             and u.embedding_eligible
             ${vaultFilter("u.")}
             and g.vault_id=u.vault_id
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
             ${vaultFilter()}
             and lifecycle in ('ACTIVE','DISPUTED')
             and refresh_status not in ('STALE_BLOCKED','INVALID')
             and (layer='context-pack' or type='context-pack')
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
           where space_id=$1
             ${vaultFilter()}
             and lifecycle in ('ACTIVE','DISPUTED')
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
           where space_id=$1
             ${vaultFilter()}
             and lifecycle in ('ACTIVE','DISPUTED')
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
             and candidate.space_id = $1
           where r.space_id = $1
             ${vaultFilter("candidate.")}
             and (r.from_document_id = any($2::uuid[]) or r.to_document_id = any($2::uuid[]))
             and exists (
               select 1 from knowledge_documents edge_from
                where edge_from.id=r.from_document_id
                  and edge_from.space_id=$1
                  and edge_from.vault_id=candidate.vault_id
             )
             and exists (
               select 1 from knowledge_documents edge_to
                where edge_to.id=r.to_document_id
                  and edge_to.space_id=$1
                  and edge_to.vault_id=candidate.vault_id
             )
             and exists (
               select 1 from knowledge_documents seed
                where seed.id=any($2::uuid[])
                  and seed.space_id=$1
                  and seed.vault_id=candidate.vault_id
             )
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
    select d.id, d.space_id, d.vault_id, d.external_id, d.current_revision, d.path, d.title, d.type, d.layer,
           d.trust_tier, d.lifecycle, d.body_cache,
           d.refresh_status,
           coalesce(
             jsonb_agg(distinct jsonb_build_object(
               'id',cited.id,'spaceId',cited.space_id,'vaultId',cited.vault_id,
               'path',cited.path,'revision',cited.current_revision
             ))
               filter (where cited.id is not null),
             '[]'::jsonb
           ) citations,
           coalesce(jsonb_agg(distinct e.locator) filter (where e.id is not null),'[]'::jsonb)
             evidence_locators
      from knowledge_documents d
      left join knowledge_relations r
        on r.from_document_id = d.id
       and r.space_id = d.space_id
       and r.relation_type in ('supports', 'derives_from', 'related_to')
      left join knowledge_documents cited
        on cited.id = r.to_document_id
       and (cited.layer in ('source', 'resource', 'evidence') or cited.type like '%evidence%')
       and cited.space_id = d.space_id
       and cited.vault_id is not distinct from d.vault_id
       and cited.lifecycle in ('ACTIVE','DISPUTED')
       and cited.refresh_status not in ('STALE_BLOCKED','INVALID')
      left join document_evidence de on de.document_id=d.id
      left join evidence e on e.id=de.evidence_id
       and e.space_id = d.space_id
       and e.vault_id is not distinct from d.vault_id
     where d.id = any($1::uuid[])
       and d.space_id = $2
       ${vaultFilter("d.")}
     group by d.id
    `,
    [fused.map((item) => item.id), spaceId],
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
  const selectedUnits =
    bestUnitByDocument.size === 0
      ? { rows: [] }
      : await db.pool.query(
          `
          select u.id, u.document_id, u.unit_type, u.body, u.parent_unit_id,
                 p.unit_type parent_unit_type, p.body parent_body
            from knowledge_units u
            left join knowledge_units p
              on p.id=u.parent_unit_id
             and p.document_id=u.document_id
             and p.space_id=u.space_id
             and p.vault_id=u.vault_id
           where u.id=any($1::uuid[])
             and u.space_id=$2
             and u.vault_id=any($3::uuid[])
          `,
          [
            [...bestUnitByDocument.values()].map((unit) => unit.unitId),
            spaceId,
            vaultIds,
          ],
        );
  const structuralContextByUnit = new Map(
    selectedUnits.rows.map((row) => [
      String(row.id),
      {
        body: String(row.body),
        ...(row.parent_unit_id
          ? { parentUnitId: String(row.parent_unit_id) }
          : {}),
        context: rehydrateStructuralContext({
          body: String(row.body),
          unitType: String(row.unit_type),
          parentBody: row.parent_body ? String(row.parent_body) : null,
          parentUnitType: row.parent_unit_type
            ? String(row.parent_unit_type)
            : null,
        }),
      },
    ]),
  );
  const minimumTrust = TRUST_RANK[input.minimumTrust] ?? 1;

  const results = fused
    .map((item): SearchHit | null => {
      const row = byId.get(item.id);
      if (
        !row ||
        (TRUST_RANK[String(row.trust_tier)] ?? 0) < minimumTrust ||
        (options.pathAuthorizer &&
          !options.pathAuthorizer(String(row.path), String(row.vault_id)))
      )
        return null;
      const documentCitations = ["source", "resource"].includes(
        String(row.layer),
      )
        ? [`${row.path}@${row.current_revision}`]
        : ((row.citations ?? []) as Array<Record<string, unknown>>)
            .filter(
              (citation) =>
                String(citation.spaceId ?? citation.space_id ?? "") ===
                  String(row.space_id) &&
                String(citation.vaultId ?? citation.vault_id ?? "") ===
                  String(row.vault_id) &&
                (!options.pathAuthorizer ||
                  options.pathAuthorizer(
                    String(citation.path ?? ""),
                    String(
                      citation.vaultId ?? citation.vault_id ?? row.vault_id,
                    ),
                  )),
            )
            .map(
              (citation) =>
                `${String(citation.path)}@${String(citation.revision ?? row.current_revision)}`,
            );
      const rowPathAuthorizer = options.pathAuthorizer
        ? (value: string) =>
            options.pathAuthorizer!(value, String(row.vault_id))
        : undefined;
      const citations = [
        ...documentCitations,
        ...((row.evidence_locators ?? []) as Array<Record<string, unknown>>)
          .filter((locator) =>
            evidenceLocatorAllowed(locator, rowPathAuthorizer),
          )
          .map(
            (locator) =>
              `evidence:${JSON.stringify(sanitizeEvidenceLocator(locator))}`,
          ),
      ];
      const matchedUnit = bestUnitByDocument.get(item.id);
      const structuralContext = matchedUnit
        ? structuralContextByUnit.get(matchedUnit.unitId)
        : undefined;
      return {
        documentId: String(row.id),
        vaultId: String(row.vault_id),
        ...matchedUnit,
        ...(structuralContext?.parentUnitId
          ? { parentUnitId: structuralContext.parentUnitId }
          : {}),
        ...(structuralContext?.context
          ? { parentContext: structuralContext.context }
          : {}),
        revision: String(row.current_revision),
        title: String(row.title),
        type: String(row.type),
        trust: String(row.trust_tier) as SearchHit["trust"],
        lifecycle: String(row.lifecycle) as SearchHit["lifecycle"],
        score: item.score,
        reasons: item.reasons,
        excerpt: (structuralContext?.body ?? String(row.body_cache)).slice(
          0,
          1200,
        ),
        citations,
        warnings: [
          "UNTRUSTED_RETRIEVED_CONTENT",
          ...(String(row.refresh_status ?? "CURRENT") === "STALE_PENDING_REVIEW"
            ? ["STALE_PENDING_REVIEW"]
            : []),
        ],
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
      const requestedSpace = parsed.data.spaceId;
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!hasSpaceAccess(actor, requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      let vaultIds: string[];
      let accessByVault: Awaited<
        ReturnType<typeof resolveAuthorizedVaultScope>
      >["accessByVault"] = {};
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: requestedSpace,
          permission: "knowledge:read",
          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
        });
        vaultIds = scope.vaultIds;
        accessByVault = scope.accessByVault;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "INVALID_VAULT_SCOPE";
        return reply
          .code(
            code === "VAULT_SCOPE_NOT_FOUND"
              ? 404
              : code === "VAULT_ACCESS_DENIED"
                ? 403
                : 400,
          )
          .send({ code });
      }
      const scopedRequest: SearchInput = {
        ...parsed.data,
        vaultIds,
        ...(vaultIds.length === 1 ? { vaultId: vaultIds[0] } : {}),
      };
      const hits = await queryKnowledge(db, scopedRequest, {
        vaultIds,
        pathAuthorizer: (documentPath, vaultId) => {
          const access = accessByVault[String(vaultId ?? "")];
          if (!access) return false;
          return (
            pathMatchesVaultPrefix(documentPath, access.pathPrefix) &&
            hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath)
          );
        },
      });
      const plan = planQuery(parsed.data.query);
      const indexRows = await db.pool.query(
        "select * from vault_index_revisions where space_id=$1 and vault_id=any($2::uuid[]) order by vault_id",
        [requestedSpace, vaultIds],
      );
      const index = combineVaultIndexRows(indexRows.rows);
      return {
        mode: parsed.data.mode,
        scope: {
          spaceId: requestedSpace,
          vaultIds,
          federated: parsed.data.federated,
        },
        intent: plan.intent,
        plan,
        degraded:
          process.env.AKP_VECTOR_ENABLED !== "true" ||
          String(index.status ?? "DEGRADED") !== "CONSISTENT",
        channels: channelsConsistentWithIndex(
          plan.channels,
          index,
          process.env.AKP_VECTOR_ENABLED === "true",
        ).channels,
        warnings: channelsConsistentWithIndex(
          plan.channels,
          index,
          process.env.AKP_VECTOR_ENABLED === "true",
        ).warnings,
        indexRevisions: index,
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
      const plan = planQuery(parsed.data.query, String(body.intent ?? ""));
      const intent = plan.intent;
      const maxTokens = contextBudgetForIntent(
        intent,
        body.maxTokens === undefined ? undefined : Number(body.maxTokens),
      );
      const requestedSpace = parsed.data.spaceId;
      if (!hasSpaceAccess(actorOf(request), requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      let vaultIds: string[];
      let accessByVault: Awaited<
        ReturnType<typeof resolveAuthorizedVaultScope>
      >["accessByVault"] = {};
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: requestedSpace,
          permission: "knowledge:read",
          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
        });
        vaultIds = scope.vaultIds;
        accessByVault = scope.accessByVault;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "INVALID_VAULT_SCOPE";
        return reply
          .code(
            code === "VAULT_SCOPE_NOT_FOUND"
              ? 404
              : code === "VAULT_ACCESS_DENIED"
                ? 403
                : 400,
          )
          .send({ code });
      }
      const scopedRequest: SearchInput = {
        ...parsed.data,
        vaultIds,
        ...(vaultIds.length === 1 ? { vaultId: vaultIds[0] } : {}),
      };
      const hits = await queryKnowledge(db, scopedRequest, {
        vaultIds,
        pathAuthorizer: (documentPath, vaultId) => {
          const access = accessByVault[String(vaultId ?? "")];
          if (!access) return false;
          return (
            pathMatchesVaultPrefix(documentPath, access.pathPrefix) &&
            hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath)
          );
        },
      });
      const details =
        hits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `select id, layer, type from knowledge_documents where id = any($1::uuid[]) and space_id=$2 and vault_id=any($3::uuid[])`,
              [hits.map((hit) => hit.documentId), requestedSpace, vaultIds],
            );
      const detailById = new Map(
        details.rows.map((row) => [String(row.id), row]),
      );
      const indexRows = await db.pool.query(
        `
        select vault_id,corpus_revision,lexical_revision,vector_revision,
               graph_revision,context_pack_revision,status,warnings,
               retrieval_configuration_version
          from vault_index_revisions
         where space_id=$1 and vault_id=any($2::uuid[])
         order by vault_id
        `,
        [requestedSpace, vaultIds],
      );
      const indexRow = combineVaultIndexRows(indexRows.rows);
      const conflicts =
        hits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `
              select distinct c.id,c.topic,c.status,c.resolution
               from contradiction_clusters c
               join contradiction_members m on m.cluster_id=c.id
               where m.document_id=any($1::uuid[])
                 and c.space_id=$2
                 and c.vault_id=any($3::uuid[])
                 and c.status <> 'RESOLVED'
              `,
              [hits.map((hit) => hit.documentId), requestedSpace, vaultIds],
            );
      const packet = buildContextPacket({
        request: scopedRequest,
        intent,
        corpusRevision: String(indexRow.corpus_revision ?? "unknown"),
        maxTokens,
        indexRevisions: {
          corpus: String(indexRow.corpus_revision ?? "unknown"),
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
            content: hit.parentContext ?? hit.excerpt,
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
        insert into context_packets(id, space_id, vault_id, actor_id, corpus_revision,
                                    query_hash, packet_hash, request, packet, scope)
        values ($1,$2,$3,$4,$5,encode(digest($6,'sha256'),'hex'),$7,$8::jsonb,$9::jsonb,$10::jsonb)
        `,
        [
          packet.packetId,
          requestedSpace,
          vaultIds.length === 1 ? vaultIds[0] : null,
          actorOf(request)?.id ?? null,
          packet.corpusRevision,
          parsed.data.query,
          packet.packetHash,
          JSON.stringify(scopedRequest),
          JSON.stringify(packet),
          JSON.stringify({
            spaceId: requestedSpace,
            vaultIds,
            federated: parsed.data.federated,
          }),
        ],
      );
      return packet;
    },
  );
}
