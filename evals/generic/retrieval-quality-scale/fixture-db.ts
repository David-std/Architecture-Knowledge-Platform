import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ParsedKnowledgeUnit } from "../../../packages/retrieval/src/chunking.js";
import { parseKnowledgeUnits } from "../../../packages/retrieval/src/chunking.js";
import type { Postgres } from "../../../packages/postgres/src/index.js";
import {
  R8_QUALITY_SCALE_FIXTURE,
  type ScaleCaseDefinition,
  type ScaleDocumentDefinition,
  type ScaleFixtureDefinition,
  type ScaleGoldTargetDefinition,
  type ScaleVaultKey,
} from "./fixture.js";

export interface ResolvedGoldTarget {
  documentKey: string;
  unitKey: string;
  identityKey: string;
  unitType: ParsedKnowledgeUnit["unitType"];
  span: { startOffset: number; endOffset: number };
  sourceHash: string;
}

export interface ResolvedScaleCase {
  definition: ScaleCaseDefinition;
  gold: readonly ResolvedGoldTarget[];
}

export interface ScaleDatabaseFixture {
  seed: string;
  runId: string;
  corpusRevision: string;
  organizationId: string;
  spaceId: string;
  vaultIds: Map<ScaleVaultKey, string>;
  documentIds: Map<string, string>;
  unitIds: Map<string, string>;
  identityToLogicalKey: Map<string, string>;
  documentById: Map<string, string>;
  resolvedCases: ResolvedScaleCase[];
  generatedDistractors: number;
  generatedPrefix: string;
  fixedDocumentCount: number;
}

export interface StorageSnapshot {
  databaseBytes: number;
  documentsBytes: number;
  unitsBytes: number;
  embeddingsBytes: number;
}

export interface FixtureRowCounts {
  documents: number;
  units: number;
  embeddings: number;
}

export const GENERATED_DISTRACTOR_FAMILIES = [
  "UNRELATED",
  "NEAR_DUPLICATE",
  "STALE_VERSION",
  "SAME_TITLE_OTHER_VAULT",
  "WRONG_RELATION",
  "CLOSE_NUMBER_DATE",
  "CONTRADICTORY_POLICY",
] as const;

export type GeneratedDistractorFamily =
  (typeof GENERATED_DISTRACTOR_FAMILIES)[number];

export function generatedDistractorFamilyCounts(
  targetCount: number,
): Record<GeneratedDistractorFamily, number> {
  if (!Number.isSafeInteger(targetCount) || targetCount < 0) {
    throw new Error(
      "Generated distractor count must be a non-negative safe integer",
    );
  }
  const base = Math.floor(targetCount / GENERATED_DISTRACTOR_FAMILIES.length);
  const remainder = targetCount % GENERATED_DISTRACTOR_FAMILIES.length;
  return Object.fromEntries(
    GENERATED_DISTRACTOR_FAMILIES.map((family, index) => [
      family,
      base + (index < remainder ? 1 : 0),
    ]),
  ) as Record<GeneratedDistractorFamily, number>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  const hex = Buffer.from(bytes).toString("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join(""),
  ].join("-");
}

function numeric(value: unknown): number {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(
      `Expected a finite PostgreSQL number, received ${String(value)}`,
    );
  }
  return result;
}

function documentLifecycle(document: ScaleDocumentDefinition): string {
  return document.lifecycle ?? "ACTIVE";
}

function documentRefreshStatus(document: ScaleDocumentDefinition): string {
  return document.refreshStatus ?? "CURRENT";
}

function targetMatches(
  unit: ParsedKnowledgeUnit,
  target: ScaleGoldTargetDefinition,
): boolean {
  return (
    unit.unitType === target.unitType && unit.body.includes(target.bodyIncludes)
  );
}

function resolveTarget(
  document: ScaleDocumentDefinition,
  parsedUnits: readonly ParsedKnowledgeUnit[],
  target: ScaleGoldTargetDefinition,
  unitIds: ReadonlyMap<string, string>,
): ResolvedGoldTarget {
  if (target.document !== document.key) {
    throw new Error(
      `Gold target ${target.document} was resolved against ${document.key}`,
    );
  }
  const matches = parsedUnits.filter((unit) => targetMatches(unit, target));
  if (matches.length !== 1) {
    throw new Error(
      `Gold target ${document.key}:${target.bodyIncludes} matched ${matches.length} parser units`,
    );
  }
  const unit = matches[0]!;
  const unitId = unitIds.get(`${document.key}:${unit.unitKey}`);
  if (!unitId)
    throw new Error(`Missing unit id for ${document.key}:${unit.unitKey}`);
  const startOffset = document.body.indexOf(target.spanText);
  if (startOffset < 0) {
    throw new Error(`Gold span is absent from source body: ${document.key}`);
  }
  const secondOffset = document.body.indexOf(
    target.spanText,
    startOffset + target.spanText.length,
  );
  if (secondOffset >= 0) {
    throw new Error(`Gold span is not unique in source body: ${document.key}`);
  }
  return {
    documentKey: document.key,
    unitKey: unit.unitKey,
    identityKey: `${document.key}:${unit.unitKey}`,
    unitType: unit.unitType,
    span: {
      startOffset,
      endOffset: startOffset + target.spanText.length,
    },
    sourceHash: sha256(document.body),
  };
}

export function fixtureDefinitionHash(
  definition: ScaleFixtureDefinition = R8_QUALITY_SCALE_FIXTURE,
): string {
  return sha256(JSON.stringify(definition));
}

export function createScaleDatabaseFixture(
  seed: string,
  definition: ScaleFixtureDefinition = R8_QUALITY_SCALE_FIXTURE,
): ScaleDatabaseFixture {
  if (!seed.trim()) throw new Error("R8 benchmark seed must not be empty");
  const runId = randomUUID();
  return {
    seed,
    runId,
    corpusRevision: `r8-quality-scale-${seed}-${runId.slice(0, 8)}`,
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    vaultIds: new Map(),
    documentIds: new Map(),
    unitIds: new Map(),
    identityToLogicalKey: new Map(),
    documentById: new Map(),
    resolvedCases: [],
    generatedDistractors: 0,
    generatedPrefix: `r8-${seed}-${runId.slice(0, 8)}-`,
    fixedDocumentCount: definition.documents.length,
  };
}

async function insertOrganizationAndVaults(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
  definition: ScaleFixtureDefinition,
): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name) values($1,$2,$3)`,
    [
      fixture.organizationId,
      `r8-quality-scale-${fixture.runId.slice(0, 8)}`,
      "R8 synthetic quality scale benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
     values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `r8-quality-scale-${fixture.runId.slice(0, 8)}`,
      "R8 synthetic quality scale benchmark",
      `benchmark/r8/${fixture.runId}`,
    ],
  );
  for (const vault of definition.vaults) {
    const vaultId = randomUUID();
    fixture.vaultIds.set(vault.key, vaultId);
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        vault.canonicalPath,
        vault.name,
        fixture.corpusRevision,
        `r8-${vault.key}-${fixture.runId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `insert into vault_index_revisions(
         space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
         graph_revision,context_pack_revision,status,warnings
       ) values($1,$2,$3,$3,null,null,null,'CONSISTENT','[]'::jsonb)`,
      [fixture.spaceId, vaultId, fixture.corpusRevision],
    );
  }
}

function documentIdFor(
  fixture: ScaleDatabaseFixture,
  document: ScaleDocumentDefinition,
): string {
  const value = deterministicUuid(`${fixture.runId}:document:${document.key}`);
  fixture.documentIds.set(document.key, value);
  fixture.documentById.set(value, document.key);
  return value;
}

function unitIdFor(
  fixture: ScaleDatabaseFixture,
  document: ScaleDocumentDefinition,
  unit: ParsedKnowledgeUnit,
): string {
  const value = deterministicUuid(
    `${fixture.runId}:unit:${document.key}:${unit.unitKey}`,
  );
  fixture.unitIds.set(`${document.key}:${unit.unitKey}`, value);
  return value;
}

async function insertFixedDocument(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
  document: ScaleDocumentDefinition,
): Promise<void> {
  const vaultId = fixture.vaultIds.get(document.vault);
  if (!vaultId) throw new Error(`Missing vault ${document.vault}`);
  const documentId = documentIdFor(fixture, document);
  const contentHash = sha256(document.body);
  const lifecycle = documentLifecycle(document);
  const refreshStatus = documentRefreshStatus(document);
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,
       trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
       content_hash,token_estimate,raw_links,refresh_status
     ) values($1,$2,$3,$4,$5,$6,'claim',$7,$8,$9,$10,$11::jsonb,$12,'concept',
              $13,$14,'[]'::jsonb,$15)`,
    [
      documentId,
      fixture.spaceId,
      vaultId,
      document.path,
      `r8-${document.key}`,
      document.title,
      lifecycle,
      document.trustTier ?? "HUMAN_REVIEWED",
      lifecycle === "SUPERSEDED"
        ? `${fixture.corpusRevision}-superseded`
        : fixture.corpusRevision,
      document.body,
      JSON.stringify({
        benchmark_fixture: R8_QUALITY_SCALE_FIXTURE.version,
        synthetic: true,
        logical_key: document.key,
      }),
      document.aliases ?? [],
      contentHash,
      Math.max(1, document.body.split(/\s+/u).filter(Boolean).length),
      refreshStatus,
    ],
  );

  const parsedUnits = parseKnowledgeUnits(document.title, document.body);
  const ids = new Map(
    parsedUnits.map((unit) => [
      unit.unitKey,
      unitIdFor(fixture, document, unit),
    ]),
  );
  for (const unit of parsedUnits) {
    const unitId = ids.get(unit.unitKey);
    if (!unitId) throw new Error(`Missing parsed unit id ${unit.unitKey}`);
    const parentUnitId = unit.parentUnitKey
      ? (ids.get(unit.parentUnitKey) ?? null)
      : null;
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
         content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
         source_ids,token_estimate,parent_unit_id,permissions,locator,
         structural_order,container_only,embedding_eligible
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,'{}'::text[],$13,$14,
                '{}'::jsonb,$15::jsonb,$16,$17,$18)`,
      [
        unitId,
        documentId,
        fixture.spaceId,
        vaultId,
        unit.unitKey,
        unit.unitType,
        unit.headingPath,
        unit.body,
        unit.contentHash,
        fixture.corpusRevision,
        lifecycle,
        document.trustTier ?? "HUMAN_REVIEWED",
        unit.tokenEstimate,
        parentUnitId,
        JSON.stringify(unit.locator),
        unit.structuralOrder,
        unit.containerOnly,
        unit.embeddingEligible,
      ],
    );
    // A unit identity is document-scoped. Store the actual pair used by
    // queryKnowledge separately after the document ID is known.
    fixture.identityToLogicalKey.set(
      `${documentId}:${unitId}`,
      `${document.key}:${unit.unitKey}`,
    );
  }
}

function resolveCases(
  fixture: ScaleDatabaseFixture,
  definition: ScaleFixtureDefinition,
): ResolvedScaleCase[] {
  const resolved: ResolvedScaleCase[] = [];
  for (const testCase of definition.cases) {
    const gold = testCase.gold.map((target) => {
      const document = definition.documents.find(
        (entry) => entry.key === target.document,
      );
      if (!document)
        throw new Error(`Unknown gold document ${target.document}`);
      const parsed = parseKnowledgeUnits(document.title, document.body);
      return resolveTarget(document, parsed, target, fixture.unitIds);
    });
    resolved.push({ definition: testCase, gold });
  }
  return resolved;
}

export async function seedFixedFixture(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
  definition: ScaleFixtureDefinition = R8_QUALITY_SCALE_FIXTURE,
): Promise<void> {
  await insertOrganizationAndVaults(db, fixture, definition);
  for (const document of definition.documents) {
    await insertFixedDocument(db, fixture, document);
  }
  fixture.resolvedCases = resolveCases(fixture, definition);
  await db.pool.query("analyze knowledge_documents; analyze knowledge_units;");
}

export async function appendGeneratedDistractors(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
  targetCount: number,
): Promise<{ indexMs: number; appended: number }> {
  if (
    !Number.isSafeInteger(targetCount) ||
    targetCount < fixture.generatedDistractors
  ) {
    throw new Error("Generated distractor target must be ascending and safe");
  }
  const from = fixture.generatedDistractors;
  if (targetCount === from) return { indexMs: 0, appended: 0 };
  const goldVaultId = fixture.vaultIds.get("gold");
  const otherVaultId = fixture.vaultIds.get("other-vault");
  if (!goldVaultId || !otherVaultId) {
    throw new Error("Missing R8 benchmark vaults");
  }
  const started = performance.now();
  await db.pool.query(
    `with generated as (
       select ordinal, ((ordinal - 1) % 7)::integer family_index
         from generate_series($7::integer + 1,$8::integer) as generated(ordinal)
     ), projected as (
       select ordinal,family_index,
              case family_index
                when 0 then 'UNRELATED'
                when 1 then 'NEAR_DUPLICATE'
                when 2 then 'STALE_VERSION'
                when 3 then 'SAME_TITLE_OTHER_VAULT'
                when 4 then 'WRONG_RELATION'
                when 5 then 'CLOSE_NUMBER_DATE'
                else 'CONTRADICTORY_POLICY'
              end family,
              case when family_index=3 then $3::uuid else $2::uuid end vault_id,
              case family_index
                when 0 then 'Synthetic unrelated architecture note ' || ordinal
                when 1 then 'Audit Retention Policy'
                when 2 then 'Audit Retention Policy'
                when 3 then 'Audit Retention Policy'
                when 4 then 'Ingress boundary relation'
                when 5 then 'Approved maintenance window'
                else 'Public data sharing policy'
              end title,
              case family_index
                when 0 then format(
                  'Synthetic unrelated architecture note %s for scale seed %s. This note describes a generic deployment observation.',
                  ordinal,$6::text
                )
                when 1 then format(
                  'Production audit logs must be retained for %s days from creation. Near-duplicate variant %s.',
                  case when ordinal % 2 = 0 then 364 else 366 end,ordinal
                )
                when 2 then format(
                  'Production audit logs must be retained for 365 days from creation. Superseded source variant %s.',
                  ordinal
                )
                when 3 then format(
                  'Audit logs in the research vault must be retained for %s days. Same-title other-vault variant %s.',
                  30 + (ordinal % 3),ordinal
                )
                when 4 then format(
                  'The ingress validation service consumes the boundary decision record. Wrong-relation variant %s.',
                  ordinal
                )
                when 5 then format(
                  'The approved maintenance window is 2026-11-%s at 02:00 UTC and the gold service timeout is %s ms. Close-value variant %s.',
                  case when ordinal % 2 = 0 then '14' else '16' end,
                  case when ordinal % 2 = 0 then 799 else 801 end,
                  ordinal
                )
                else format(
                  'Public data may be shared with external partners without security approval. Contradictory policy variant %s.',
                  ordinal
                )
              end body,
              case
                when family_index=2 then 'SUPERSEDED'
                when family_index=6 then 'DISPUTED'
                else 'ACTIVE'
              end lifecycle,
              case
                when family_index=2 then 'STALE_BLOCKED'
                when family_index=6 then 'STALE_PENDING_REVIEW'
                else 'CURRENT'
              end refresh_status
         from generated
     ), inserted_documents as (
       insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,
         token_estimate,raw_links,refresh_status
       )
       select gen_random_uuid(),$1,vault_id,
              $4 || 'distractor-' || ordinal || '.md',
              $4 || 'distractor-' || ordinal,
              title,'concept',lifecycle,'HUMAN_REVIEWED',$5,body,
              jsonb_build_object(
                'benchmark_fixture','r8-quality-scale-v1',
                'synthetic',true,
                'ordinal',ordinal,
                'adversarial_family',family
              ),
              '{}'::text[],'concept',encode(digest(body,'sha256'),'hex'),
              greatest(18,ceil(length(body)::numeric / 4)::integer),
              '[]'::jsonb,refresh_status
         from projected
       returning id,vault_id,external_id,title,body_cache,content_hash,lifecycle,refresh_status
     )
     insert into knowledge_units(
       id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
       content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
       source_ids,token_estimate,parent_unit_id,permissions,locator,
       structural_order,container_only,embedding_eligible
     )
     select gen_random_uuid(),id,$1,vault_id,
            'paragraph-' || external_id,'PARAGRAPH',array[title],body_cache,
            content_hash,$5,$5,lifecycle,'HUMAN_REVIEWED','{}'::text[],
            greatest(18,ceil(length(body_cache)::numeric / 4)::integer),null,
            '{}'::jsonb,
            jsonb_build_object(
              'kind','markdown','startLine',1,'endLine',1,'contentHash',content_hash
            ),
            1,false,true
       from inserted_documents`,
    [
      fixture.spaceId,
      goldVaultId,
      otherVaultId,
      fixture.generatedPrefix,
      fixture.corpusRevision,
      fixture.seed,
      from,
      targetCount,
    ],
  );
  await db.pool.query(
    `update vault_index_revisions
        set lexical_revision=$2,status='CONSISTENT',warnings='[]'::jsonb,updated_at=now()
      where space_id=$1 and vault_id=any($3::uuid[])`,
    [fixture.spaceId, fixture.corpusRevision, [goldVaultId, otherVaultId]],
  );
  await db.pool.query("analyze knowledge_documents; analyze knowledge_units;");
  fixture.generatedDistractors = targetCount;
  return { indexMs: performance.now() - started, appended: targetCount - from };
}

export async function measureProjectedUpdate(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
): Promise<number | null> {
  if (fixture.generatedDistractors === 0) return null;
  const vaultId = fixture.vaultIds.get("gold");
  if (!vaultId) throw new Error("Missing gold vault");
  const started = performance.now();
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{ id: string }>(
      `select id from knowledge_documents
         where space_id=$1 and vault_id=$2 and external_id=$3
         limit 1`,
      [fixture.spaceId, vaultId, `${fixture.generatedPrefix}distractor-1`],
    );
    const documentId = selected.rows[0]?.id;
    if (!documentId) throw new Error("Update probe document was not found");
    await client.query(
      `update knowledge_documents
          set body_cache=body_cache || ' Update probe.'
        where id=$1`,
      [documentId],
    );
    await client.query(
      `update knowledge_units
          set body=body || ' Update probe.'
        where document_id=$1 and unit_type='PARAGRAPH'`,
      [documentId],
    );
    await client.query("analyze knowledge_documents; analyze knowledge_units;");
    await client.query("rollback");
    return performance.now() - started;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function storageSnapshot(db: Postgres): Promise<StorageSnapshot> {
  const result = await db.pool.query(
    `select
       pg_database_size(current_database())::bigint database_bytes,
       pg_total_relation_size('public.knowledge_documents'::regclass)::bigint documents_bytes,
       pg_total_relation_size('public.knowledge_units'::regclass)::bigint units_bytes,
       pg_total_relation_size('public.unit_embeddings'::regclass)::bigint embeddings_bytes`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL did not return storage metrics");
  return {
    databaseBytes: numeric(row.database_bytes),
    documentsBytes: numeric(row.documents_bytes),
    unitsBytes: numeric(row.units_bytes),
    embeddingsBytes: numeric(row.embeddings_bytes),
  };
}

export function storageDelta(
  after: StorageSnapshot,
  before: StorageSnapshot,
): StorageSnapshot {
  return {
    databaseBytes: after.databaseBytes - before.databaseBytes,
    documentsBytes: after.documentsBytes - before.documentsBytes,
    unitsBytes: after.unitsBytes - before.unitsBytes,
    embeddingsBytes: after.embeddingsBytes - before.embeddingsBytes,
  };
}

export async function fixtureRowCounts(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
): Promise<FixtureRowCounts> {
  const result = await db.pool.query(
    `select
       (select count(*) from knowledge_documents where space_id=$1)::bigint documents,
       (select count(*) from knowledge_units where space_id=$1)::bigint units,
       (select count(*) from unit_embeddings e
          join knowledge_units u on u.id=e.unit_id
         where u.space_id=$1)::bigint embeddings`,
    [fixture.spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL did not return fixture counts");
  return {
    documents: numeric(row.documents),
    units: numeric(row.units),
    embeddings: numeric(row.embeddings),
  };
}

export function logicalKeyForHit(
  fixture: ScaleDatabaseFixture,
  documentId: string,
  unitId: string | null | undefined,
): string {
  const unitKey = unitId
    ? fixture.identityToLogicalKey.get(`${documentId}:${unitId}`)
    : undefined;
  if (unitKey) return unitKey;
  const documentKey = fixture.documentById.get(documentId);
  if (documentKey) return `${documentKey}:document`;
  return "UNKNOWN_CANDIDATE";
}

export async function indexGenerationMarkers(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
): Promise<
  Record<ScaleVaultKey, { lexical: string | null; vector: string | null }>
> {
  const result = await db.pool.query(
    `select v.vault_key, i.lexical_revision, i.vector_revision
       from vault_index_revisions i
       join vaults v on v.id=i.vault_id
      where i.space_id=$1
      order by v.vault_key`,
    [fixture.spaceId],
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      String(row.vault_key) as ScaleVaultKey,
      {
        lexical: row.lexical_revision ? String(row.lexical_revision) : null,
        vector: row.vector_revision ? String(row.vector_revision) : null,
      },
    ]),
  ) as Record<ScaleVaultKey, { lexical: string | null; vector: string | null }>;
}

export async function cleanupScaleDatabaseFixture(
  db: Postgres,
  fixture: ScaleDatabaseFixture,
): Promise<FixtureRowCounts> {
  await db.pool.query("delete from knowledge_relations where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query(
    `delete from unit_embeddings where unit_id in
       (select id from knowledge_units where space_id=$1)`,
    [fixture.spaceId],
  );
  await db.pool.query(`delete from embedding_generations where space_id=$1`, [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_units where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_documents where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from vault_index_revisions where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from vaults where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
  return fixtureRowCounts(db, fixture).catch(() => ({
    documents: 0,
    units: 0,
    embeddings: 0,
  }));
}
