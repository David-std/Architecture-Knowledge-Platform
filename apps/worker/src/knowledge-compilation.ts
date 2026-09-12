import {
  CompilationPlan,
  ExistingKnowledgeCandidate,
  KnowledgeCompilerInput,
  resultToCompilationPlan,
  type CompilerEvidence,
  type ConfiguredKnowledgeCompiler,
  type KnowledgeCompilerInput as KnowledgeCompilerInputType,
  type KnowledgeCompilerResult,
} from "@akp/compiler";
import type { DocumentArtifact } from "@akp/contracts";
import type { Postgres } from "@akp/postgres";

const DEFAULT_CANDIDATE_LIMIT = 12;
const MAX_CANDIDATE_LIMIT = 20;
const CANDIDATE_EXCERPT_CHARACTERS = 2_000;

interface CandidateRow {
  document_id: string;
  external_id: string | null;
  path: string;
  title: string;
  type: string;
  lifecycle: string;
  trust_tier: string;
  current_revision: string;
  content_excerpt: string;
  score: number | string | null;
  reason: string;
}

export interface ExistingKnowledgeRetrievalInput {
  spaceId: string;
  vaultId: string;
  title: string;
  sourceId?: string;
  sourceSha256?: string;
  evidenceExcerpt: string;
  limit?: number;
  vectorEnabled?: boolean;
}

export interface ExistingKnowledgeRetrievalResult {
  candidates: Array<ReturnType<typeof ExistingKnowledgeCandidate.parse>>;
  warnings: string[];
  channels: string[];
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CANDIDATE_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CANDIDATE_LIMIT
  ) {
    throw new Error("COMPILER_CANDIDATE_LIMIT_INVALID");
  }
  return value;
}

function compactSearchText(title: string, excerpt: string): string {
  const normalizedTitle = title.replaceAll(/\s+/g, " ").trim();
  const normalizedExcerpt = excerpt.replaceAll(/\s+/g, " ").trim();
  return `${normalizedTitle} ${normalizedExcerpt.slice(0, 1_200)}`.trim();
}

function parseCandidate(row: CandidateRow) {
  return ExistingKnowledgeCandidate.parse({
    documentId: row.document_id,
    externalId: row.external_id,
    path: row.path,
    title: row.title,
    type: row.type,
    lifecycle: row.lifecycle,
    trust: row.trust_tier,
    revision: row.current_revision,
    contentExcerpt: row.content_excerpt.slice(0, CANDIDATE_EXCERPT_CHARACTERS),
    score: Math.max(0, Number(row.score ?? 0)),
    reasons: [row.reason],
  });
}

function mergeCandidates(
  rows: CandidateRow[],
  limit: number,
): Array<ReturnType<typeof ExistingKnowledgeCandidate.parse>> {
  const merged = new Map<
    string,
    ReturnType<typeof ExistingKnowledgeCandidate.parse>
  >();
  for (const row of rows) {
    const candidate = parseCandidate(row);
    const current = merged.get(candidate.documentId);
    if (!current) {
      merged.set(candidate.documentId, candidate);
      continue;
    }
    merged.set(
      candidate.documentId,
      ExistingKnowledgeCandidate.parse({
        ...current,
        score: Math.max(current.score ?? 0, candidate.score ?? 0),
        reasons: [...new Set([...current.reasons, ...candidate.reasons])].slice(
          0,
          20,
        ),
        contentExcerpt:
          (candidate.score ?? 0) > (current.score ?? 0)
            ? candidate.contentExcerpt
            : current.contentExcerpt,
      }),
    );
  }
  return [...merged.values()]
    .sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) ||
        left.documentId.localeCompare(right.documentId),
    )
    .slice(0, limit);
}

async function exactAndLexicalCandidates(
  db: Postgres,
  input: ExistingKnowledgeRetrievalInput,
  query: string,
  limit: number,
): Promise<CandidateRow[]> {
  const result = await db.pool.query<CandidateRow>(
    `
    with q as (
      select websearch_to_tsquery('simple',$4) terms
    )
    select d.id document_id,d.external_id,d.path,d.title,d.type,d.lifecycle,
           d.trust_tier,d.current_revision,
           left(coalesce(nullif(d.body_cache,''),d.title),$6) content_excerpt,
           greatest(
             case
               when nullif($7,'') is not null and d.frontmatter->>'source_id'=$7 then 120
               when nullif($8,'') is not null and d.frontmatter->>'source_sha256'=$8 then 110
               when lower(coalesce(d.external_id,''))=lower($3) then 100
               when exists(select 1 from unnest(d.aliases) a where lower(a)=lower($3)) then 90
               when lower(d.title)=lower($3) then 80
               when lower(d.path)=lower($3) then 70
               else 0
             end,
             20 * ts_rank_cd(d.lexical_title_vector,q.terms) +
             16 * ts_rank_cd(d.lexical_alias_vector,q.terms) +
             12 * ts_rank_cd(d.lexical_path_vector,q.terms) +
              2 * ts_rank_cd(d.lexical_body_vector,q.terms)
           ) score,
           case
             when nullif($7,'') is not null and d.frontmatter->>'source_id'=$7 then 'exact:source-id'
             when nullif($8,'') is not null and d.frontmatter->>'source_sha256'=$8 then 'exact:source-sha256'
             when lower(coalesce(d.external_id,''))=lower($3) then 'exact:external-id'
             when exists(select 1 from unnest(d.aliases) a where lower(a)=lower($3)) then 'exact:alias'
             when lower(d.title)=lower($3) then 'exact:title'
             when lower(d.path)=lower($3) then 'exact:path'
             else 'lexical:terms'
           end reason
      from knowledge_documents d
      cross join q
     where d.space_id=$1 and d.vault_id=$2
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
       and (
         (nullif($7,'') is not null and d.frontmatter->>'source_id'=$7)
         or (nullif($8,'') is not null and d.frontmatter->>'source_sha256'=$8)
         or lower(coalesce(d.external_id,''))=lower($3)
         or exists(select 1 from unnest(d.aliases) a where lower(a)=lower($3))
         or lower(d.title)=lower($3)
         or lower(d.path)=lower($3)
         or d.lexical_search_vector @@ q.terms
       )
     order by score desc,d.updated_at desc,d.id
     limit $5
    `,
    [
      input.spaceId,
      input.vaultId,
      input.title,
      query,
      Math.max(limit * 2, 10),
      CANDIDATE_EXCERPT_CHARACTERS,
      input.sourceId ?? "",
      input.sourceSha256 ?? "",
    ],
  );
  return result.rows;
}

/**
 * Expand source-relevant exact/lexical seeds through the active semantic
 * generation. This deliberately reuses already-persisted P1 vectors instead
 * of loading an embedding provider into the ingest worker. Every compared
 * vector belongs to the same active generation and vault/corpus revision.
 */
async function semanticNeighborhoodCandidates(
  db: Postgres,
  input: ExistingKnowledgeRetrievalInput,
  seedDocumentIds: string[],
  limit: number,
): Promise<{ rows: CandidateRow[]; warning?: string }> {
  if (!input.vectorEnabled) {
    return { rows: [], warning: "COMPILER_SEMANTIC_RETRIEVAL_DISABLED" };
  }
  if (!seedDocumentIds.length) {
    return { rows: [], warning: "COMPILER_SEMANTIC_SEED_UNAVAILABLE" };
  }
  try {
    const result = await db.pool.query<CandidateRow>(
      `
      with active_generation as (
        select g.id,g.corpus_revision
          from embedding_generations g
          join vault_index_revisions i
            on i.space_id=g.space_id and i.vault_id=g.vault_id
           and i.vector_revision=g.corpus_revision
         where g.space_id=$1 and g.vault_id=$2 and g.status='ACTIVE'
         order by g.activated_at desc nulls last,g.created_at desc
         limit 1
      ), seed_vectors as (
        select e.embedding,e.embedding_dimensions
          from active_generation g
          join unit_embeddings e on e.generation_id=g.id
          join knowledge_units u on u.id=e.unit_id
         where u.space_id=$1 and u.vault_id=$2
           and u.document_id=any($3::uuid[])
           and u.corpus_revision=g.corpus_revision
           and u.content_hash=e.content_hash
           and u.embedding_eligible
         order by u.structural_order,u.id
         limit 24
      ), ranked as (
        select d.id document_id,d.external_id,d.path,d.title,d.type,d.lifecycle,
               d.trust_tier,d.current_revision,
               left(coalesce(nullif(u.body,''),nullif(d.body_cache,''),d.title),$5) content_excerpt,
               greatest(0,1-(e.embedding <=> s.embedding)) score,
               row_number() over (
                 partition by d.id
                 order by e.embedding <=> s.embedding,u.id
               ) document_rank
          from active_generation g
          join unit_embeddings e on e.generation_id=g.id
          join knowledge_units u on u.id=e.unit_id
          join knowledge_documents d on d.id=u.document_id
          cross join seed_vectors s
         where u.space_id=$1 and u.vault_id=$2
           and u.corpus_revision=g.corpus_revision
           and u.content_hash=e.content_hash
           and u.embedding_eligible
           and e.embedding_dimensions=s.embedding_dimensions
           and not (d.id=any($3::uuid[]))
           and d.lifecycle in ('ACTIVE','DISPUTED')
           and d.refresh_status not in ('STALE_BLOCKED','INVALID')
      )
      select document_id,external_id,path,title,type,lifecycle,trust_tier,
             current_revision,content_excerpt,score,'semantic:neighbor' reason
        from ranked
       where document_rank=1
       order by score desc,document_id
       limit $4
      `,
      [
        input.spaceId,
        input.vaultId,
        seedDocumentIds,
        Math.max(limit * 2, 10),
        CANDIDATE_EXCERPT_CHARACTERS,
      ],
    );
    if (!result.rows.length) {
      return { rows: [], warning: "COMPILER_SEMANTIC_NEIGHBORHOOD_EMPTY" };
    }
    return { rows: result.rows };
  } catch (error) {
    return {
      rows: [],
      warning: `COMPILER_SEMANTIC_RETRIEVAL_UNAVAILABLE:${
        error instanceof Error ? error.message : "UNKNOWN"
      }`,
    };
  }
}

async function graphCandidates(
  db: Postgres,
  input: ExistingKnowledgeRetrievalInput,
  seedDocumentIds: string[],
  limit: number,
): Promise<CandidateRow[]> {
  if (!seedDocumentIds.length) return [];
  const result = await db.pool.query<CandidateRow>(
    `
    with neighbors as (
      select case
               when r.from_document_id=any($3::uuid[]) then r.to_document_id
               else r.from_document_id
             end document_id,
             r.relation_type,
             greatest(0,coalesce(r.weight,1)::double precision) relation_weight
        from knowledge_relations r
       where r.space_id=$1
         and (
           r.from_document_id=any($3::uuid[])
           or r.to_document_id=any($3::uuid[])
         )
    )
    select d.id document_id,d.external_id,d.path,d.title,d.type,d.lifecycle,
           d.trust_tier,d.current_revision,
           left(coalesce(nullif(d.body_cache,''),d.title),$5) content_excerpt,
           max(n.relation_weight) score,
           'graph:' || min(n.relation_type) reason
      from neighbors n
      join knowledge_documents d on d.id=n.document_id
     where d.space_id=$1 and d.vault_id=$2
       and not (d.id=any($3::uuid[]))
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
     group by d.id,d.external_id,d.path,d.title,d.type,d.lifecycle,d.trust_tier,
              d.current_revision,d.body_cache
     order by score desc,d.id
     limit $4
    `,
    [
      input.spaceId,
      input.vaultId,
      seedDocumentIds,
      Math.max(limit, 8),
      CANDIDATE_EXCERPT_CHARACTERS,
    ],
  );
  return result.rows;
}

export async function retrieveExistingKnowledgeCandidates(
  db: Postgres,
  input: ExistingKnowledgeRetrievalInput,
): Promise<ExistingKnowledgeRetrievalResult> {
  const limit = boundedLimit(input.limit);
  const query = compactSearchText(input.title, input.evidenceExcerpt);
  if (!query) throw new Error("COMPILER_RETRIEVAL_QUERY_REQUIRED");

  const lexical = await exactAndLexicalCandidates(db, input, query, limit);
  const lexicalSeeds = mergeCandidates(lexical, limit).map(
    (candidate) => candidate.documentId,
  );
  const semantic = await semanticNeighborhoodCandidates(
    db,
    input,
    lexicalSeeds,
    limit,
  );
  const firstPass = mergeCandidates([...lexical, ...semantic.rows], limit);
  const graph = await graphCandidates(
    db,
    input,
    firstPass.map((candidate) => candidate.documentId),
    limit,
  );
  const candidates = mergeCandidates(
    [...lexical, ...semantic.rows, ...graph],
    limit,
  );
  return {
    candidates,
    warnings: semantic.warning ? [semantic.warning] : [],
    channels: [
      "exact",
      "lexical",
      ...(semantic.rows.length ? ["semantic"] : []),
      ...(graph.length ? ["graph"] : []),
    ],
  };
}

export interface GroundedCompilationRequest {
  source: {
    sourceId: string;
    sourceArtifactId: string;
    sha256: string;
    title: string;
    mediaType: string;
  };
  documentArtifact: DocumentArtifact;
  evidence: CompilerEvidence[];
  schemaProfile: Record<string, unknown>;
  corpusRevision: string;
  spaceId: string;
  vaultId: string;
  vectorEnabled?: boolean;
  candidateLimit?: number;
}

export interface GroundedCompilationResult {
  input: KnowledgeCompilerInputType;
  result: KnowledgeCompilerResult;
  plan: CompilationPlan;
  retrievalWarnings: string[];
  retrievalChannels: string[];
  provider: ConfiguredKnowledgeCompiler["descriptor"];
}

export async function compileGroundedKnowledgeProposal(
  db: Postgres,
  configured: ConfiguredKnowledgeCompiler,
  request: GroundedCompilationRequest,
): Promise<GroundedCompilationResult> {
  const primaryEvidence = request.evidence[0];
  if (!primaryEvidence) throw new Error("COMPILER_EVIDENCE_REQUIRED");
  const retrieval = await retrieveExistingKnowledgeCandidates(db, {
    spaceId: request.spaceId,
    vaultId: request.vaultId,
    title: request.source.title,
    sourceId: request.source.sourceId,
    sourceSha256: request.source.sha256,
    evidenceExcerpt: primaryEvidence.excerpt,
    limit: request.candidateLimit,
    vectorEnabled: request.vectorEnabled,
  });
  const input = KnowledgeCompilerInput.parse({
    source: request.source,
    documentArtifact: request.documentArtifact,
    evidence: request.evidence,
    existingCandidates: retrieval.candidates,
    schemaProfile: request.schemaProfile,
    policy: {
      reviewRequired: true,
      allowDirectPublication: false,
    },
    budget: {
      maxInputCharacters: 80_000,
      maxEvidence: 20,
      maxExistingCandidates: MAX_CANDIDATE_LIMIT,
      maxProposedChanges: 8,
      maxProbes: 8,
    },
    corpusRevision: request.corpusRevision,
    spaceId: request.spaceId,
    vaultId: request.vaultId,
  });
  const result = await configured.compiler.compile(input);
  return {
    input,
    result,
    plan: CompilationPlan.parse(resultToCompilationPlan(input, result)),
    retrievalWarnings: retrieval.warnings,
    retrievalChannels: retrieval.channels,
    provider: configured.descriptor,
  };
}
