import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchRequest } from "../packages/contracts/src/index.js";
import { scoreBenchmarkObservation } from "../packages/evaluation/src/index.js";
import { Postgres } from "../packages/postgres/src/index.js";
import { buildContextPacket } from "../packages/retrieval/src/index.js";
import { queryKnowledge } from "../apps/api/src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const outputPath = path.resolve(
  process.env.AKP_REGISTERED_RETRIEVAL_DIAGNOSTICS_REPORT ??
    "reports/ci/registered-retrieval-diagnostics.json",
);

type MeasuredMetric = {
  measured: true;
  value: number;
  numerator: number;
  denominator: number;
  sampleCount: number;
  unit: "ratio";
  scope: "REGISTERED_DIAGNOSTIC_FIXTURE";
  evidence: string;
  limitation: string;
};

function measured(
  value: number,
  numerator: number,
  denominator: number,
  evidence: string,
  limitation: string,
): MeasuredMetric {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    throw new Error("REGISTERED_RETRIEVAL_DIAGNOSTIC_METRIC_INVALID");
  }
  return {
    measured: true,
    value,
    numerator,
    denominator,
    sampleCount: denominator,
    unit: "ratio",
    scope: "REGISTERED_DIAGNOSTIC_FIXTURE",
    evidence,
    limitation,
  };
}

const db = new Postgres(databaseUrl);
const organizationId = randomUUID();
const spaceId = randomUUID();
const vaultId = randomUUID();
const corpusRevision = `registered-retrieval-diagnostic-${randomUUID()}`;
const currentId = randomUUID();
const legacyId = randomUUID();
const distractorId = randomUUID();
const currentUnitId = randomUUID();
const legacyUnitId = randomUUID();
const distractorUnitId = randomUUID();
const contradictionId = randomUUID();

const documents = [
  {
    id: currentId,
    unitId: currentUnitId,
    path: "security/tls-current.md",
    externalId: "tls-current",
    title: "Current TLS transport policy",
    body: "TLS transport policy minimum is TLS 1.3 for current production traffic.",
  },
  {
    id: legacyId,
    unitId: legacyUnitId,
    path: "security/tls-legacy.md",
    externalId: "tls-legacy",
    title: "Legacy TLS transport policy",
    body: "TLS transport policy minimum was TLS 1.2 for the retired legacy environment.",
  },
  {
    id: distractorId,
    unitId: distractorUnitId,
    path: "operations/backup-window.md",
    externalId: "backup-window",
    title: "Backup retention window",
    body: "Backups are retained according to the recovery schedule.",
  },
] as const;

try {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Registered retrieval diagnostics')`,
    [organizationId, `registered-retrieval-${organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Registered retrieval diagnostics','PRIVATE',$4)`,
    [
      spaceId,
      organizationId,
      `registered-retrieval-${spaceId.slice(0, 8)}`,
      `/tmp/registered-retrieval-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,'Registered retrieval diagnostics vault',true,$4,$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/registered-retrieval-vault-${vaultId}`,
      corpusRevision,
      `registered-retrieval-${vaultId.slice(0, 8)}`,
    ],
  );

  for (const [index, document] of documents.entries()) {
    const contentHash = createHash("sha256")
      .update(document.body)
      .digest("hex");
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,layer,content_hash,
         token_estimate,raw_links
       ) values(
         $1,$2,$3,$4,$5,'{}',$6,'source','ACTIVE','HUMAN_REVIEWED',
         $7,$8,$9::jsonb,'source',$10,30,'[]'::jsonb
       )`,
      [
        document.id,
        spaceId,
        vaultId,
        document.path,
        document.externalId,
        document.title,
        corpusRevision,
        document.body,
        JSON.stringify({ id: document.externalId, title: document.title }),
        contentHash,
      ],
    );
    await db.pool.query(
      `insert into knowledge_units(
         id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
         content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
         token_estimate,parent_unit_id,document_revision,permissions,locator,
         structural_order,container_only,embedding_eligible
       ) values(
         $1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8,$9,'ACTIVE',
         'HUMAN_REVIEWED',$10,30,null,$9,'{}'::jsonb,$11::jsonb,
         $12,false,true
       )`,
      [
        document.unitId,
        document.id,
        spaceId,
        vaultId,
        `${document.externalId}-unit`,
        [document.title],
        document.body,
        contentHash,
        corpusRevision,
        [`support:${document.externalId}`],
        JSON.stringify({ path: document.path }),
        index + 1,
      ],
    );
  }

  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,status,warnings
     ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
    [spaceId, vaultId, corpusRevision],
  );
  await db.pool.query(
    `insert into contradiction_clusters(id,space_id,vault_id,topic,status)
     values($1,$2,$3,'TLS transport minimum','OPEN')`,
    [contradictionId, spaceId, vaultId],
  );
  await db.pool.query(
    `insert into contradiction_members(cluster_id,document_id,authority,scope)
     values
       ($1,$2,'CURRENT_POLICY','production'),
       ($1,$3,'LEGACY_POLICY','legacy')`,
    [contradictionId, currentId, legacyId],
  );

  const request: SearchRequest = {
    query: "TLS transport policy minimum",
    spaceId,
    vaultId,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 10,
  };
  const hits = await queryKnowledge(db, request, {
    vaultIds: [vaultId],
    channels: ["exact", "lexical"],
    deterministicRerank: false,
  });
  const relevantIds = new Set([currentId, legacyId]);
  const relevantHits = hits.filter((hit) => relevantIds.has(hit.documentId));
  if (relevantHits.length !== 2) {
    throw new Error(
      `REGISTERED_RETRIEVAL_DIAGNOSTIC_RELEVANT_HITS:${relevantHits.length}`,
    );
  }

  const clusters = await db.pool.query<{
    id: string;
    topic: string;
    status: string;
    members: string[];
  }>(
    `select c.id,c.topic,c.status,
            array_agg(distinct all_members.document_id)::uuid[] members
       from contradiction_clusters c
       join contradiction_members matched on matched.cluster_id=c.id
       join contradiction_members all_members on all_members.cluster_id=c.id
      where matched.document_id=any($1::uuid[])
        and c.space_id=$2
        and c.vault_id=$3
        and c.status <> 'RESOLVED'
      group by c.id,c.topic,c.status
      order by c.id`,
    [hits.map((hit) => hit.documentId), spaceId, vaultId],
  );
  const materialConflicts = clusters.rows.map((cluster) => ({
    id: String(cluster.id),
    documentIds: cluster.members.map(String),
  }));

  const packet = buildContextPacket({
    request,
    intent: "SOURCE_VERIFICATION",
    corpusRevision,
    maxTokens: 6000,
    requestedContextLevel: "L2",
    candidates: hits.map((hit) => ({
      hit,
      content: hit.excerpt,
      kind: "source" as const,
    })),
    conflicts: clusters.rows.map((row) => `${row.topic} (${row.status})`),
    materialConflicts,
    searchedChannels: ["exact", "lexical"],
    retrievalConfiguration: {
      version: "registered-retrieval-diagnostics-v1",
      purpose: "diagnostic-metric-coverage",
    },
  });

  const sectionExternalIds = packet.sections.flatMap((section) =>
    section.document.externalId ? [section.document.externalId] : [],
  );
  const retrievedCitations = [
    ...new Set(
      packet.sections.flatMap((section) => section.sourceOrEvidenceIds),
    ),
  ];
  const goldDocuments = ["tls-current", "tls-legacy"];
  const goldCitations = [
    `security/tls-current.md@${corpusRevision}`,
    `security/tls-legacy.md@${corpusRevision}`,
  ];
  const scored = scoreBenchmarkObservation({
    configurationName: "registered-diagnostic-context",
    caseId: "registered-tls-conflict",
    slice: "diagnostic-context-support-citation",
    rankedDocumentIds: hits.flatMap((hit) =>
      hit.document.externalId ? [hit.document.externalId] : [],
    ),
    goldDocumentIds: goldDocuments,
    contextDocumentIds: sectionExternalIds,
    goldSupportIds: goldDocuments,
    retrievedSupportIds: sectionExternalIds,
    goldCitationIds: goldCitations,
    retrievedCitationIds: retrievedCitations,
    returnedAnswer: packet.sections.length > 0,
  });

  const cluster = clusters.rows.find(
    (entry) => String(entry.id) === contradictionId,
  );
  const clusterMembers = new Set((cluster?.members ?? []).map(String));
  const contextMembers = new Set(
    packet.sections
      .map((section) => section.documentId)
      .filter((documentId) => relevantIds.has(documentId)),
  );
  const contradictionRecovered =
    clusterMembers.has(currentId) &&
    clusterMembers.has(legacyId) &&
    contextMembers.has(currentId) &&
    contextMembers.has(legacyId) &&
    packet.conflicts.length > 0;
  const contradictionRecall = measured(
    contradictionRecovered ? 1 : 0,
    contradictionRecovered ? 1 : 0,
    1,
    "Production retrieval candidates + persisted contradiction cluster + ContextPacket material conflict coverage",
    "Recall covers one registered explicit material-conflict fixture; it is not a domain-general contradiction detector recall estimate.",
  );

  const contextRelevant = sectionExternalIds.filter((id) =>
    goldDocuments.includes(id),
  ).length;
  const supportRecovered = new Set(sectionExternalIds).size;
  const citationRelevant = retrievedCitations.filter((citation) =>
    goldCitations.includes(citation),
  ).length;
  const metrics = {
    contextPrecision: measured(
      scored.contextPrecision,
      contextRelevant,
      Math.max(1, sectionExternalIds.length),
      "buildContextPacket sections scored against explicit relevant document labels",
      "Measured on one diagnostic TLS conflict fixture with a deliberately unrelated persisted distractor.",
    ),
    claimSupportRecall: measured(
      scored.claimSupportRecall,
      Math.min(supportRecovered, goldDocuments.length),
      goldDocuments.length,
      "ContextPacket document support set scored against both explicit claim-support documents",
      "Support IDs are the two explicitly labelled policy documents required to support/surface the material conflict.",
    ),
    citationPrecision: measured(
      scored.citationPrecision,
      citationRelevant,
      Math.max(1, retrievedCitations.length),
      "ContextPacket sourceOrEvidenceIds scored against explicit source citations",
      "Precision is measured on source-layer path@revision citations in one registered fixture.",
    ),
    contradictionRecall,
  };

  const status =
    scored.contextPrecisionScored &&
    scored.claimSupportScored &&
    scored.citationScored &&
    Object.values(metrics).every((metric) => metric.value === 1)
      ? "PROVEN"
      : "FAILED";
  const report = {
    schemaVersion: 1,
    benchmark: "AKP_REGISTERED_RETRIEVAL_DIAGNOSTICS",
    commit: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    evidenceLevel: "REGISTERED_DIAGNOSTIC_RUNTIME_FIXTURE",
    claimPolicy: {
      productionQualityClaimAllowed: false,
      externalParityClaimAllowed: false,
      diagnosticFixtureRatesAreProductionRates: false,
      rankedDocumentPrecisionRelabelledAsContextPrecision: false,
      retrievalRecallRelabelledAsContradictionRecall: false,
    },
    status,
    fixture: {
      spaceId,
      vaultId,
      persistedDocuments: documents.length,
      relevantDocuments: goldDocuments.length,
      contradictionClusters: clusters.rows.length,
      contextSections: packet.sections.length,
      packetStatus: packet.status,
    },
    metrics,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        status,
        outputPath,
        metrics: Object.fromEntries(
          Object.entries(metrics).map(([name, metric]) => [name, metric.value]),
        ),
      },
      null,
      2,
    ),
  );
  if (status !== "PROVEN") process.exitCode = 1;
} finally {
  await db.pool
    .query("delete from contradiction_clusters where id=$1", [contradictionId])
    .catch(() => undefined);
  await db.pool
    .query("delete from knowledge_units where vault_id=$1", [vaultId])
    .catch(() => undefined);
  await db.pool
    .query("delete from knowledge_documents where vault_id=$1", [vaultId])
    .catch(() => undefined);
  await db.pool
    .query("delete from vault_index_revisions where vault_id=$1", [vaultId])
    .catch(() => undefined);
  await db.pool
    .query("delete from vaults where id=$1", [vaultId])
    .catch(() => undefined);
  await db.pool
    .query("delete from spaces where id=$1", [spaceId])
    .catch(() => undefined);
  await db.pool
    .query("delete from organizations where id=$1", [organizationId])
    .catch(() => undefined);
  await db.close();
}
