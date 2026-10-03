import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeGraphArtifact } from "../packages/contracts/src/index.js";
import {
  assertSyntheticFixtureDatabaseSafety,
  Postgres,
  PostgresFederatedGraphStore,
} from "../packages/postgres/src/index.js";
import {
  planCodeGraphProjection,
  projectCodeGraphIdentity,
} from "../packages/project-adapter/src/index.js";

type RegisteredDocument = {
  id: string;
  title: string;
  aliases: string[];
  sourcePath: string;
  related: string[];
  evidence: string[];
  citations: string[];
};

type RegisteredVault = {
  id: string;
  kind: string;
  documents: RegisteredDocument[];
};

type RegisteredManifest = {
  name: string;
  vaults: RegisteredVault[];
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
assertSyntheticFixtureDatabaseSafety(databaseUrl);

const SPACE_ID = "00000000-0000-0000-0000-000000000003";
const USER_ID = "00000000-0000-0000-0000-000000000002";
const CORPUS_REVISION =
  process.env.AKP_AGENT_AB_CORPUS_REVISION ?? "agent-ab-public-product-v1";
const VAULT_IDS: Record<string, string> = {
  "product-architecture": "10000000-0000-4000-8000-000000000001",
  "product-operations": "10000000-0000-4000-8000-000000000002",
};
const PROJECT_CODE_FIXTURE = {
  id: "20000000-0000-4000-8000-000000000001",
  vaultId: VAULT_IDS["product-operations"]!,
  slug: "runtime-health",
  commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  configurationHash:
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function provisionProjectCodeFixture(db: Postgres): Promise<void> {
  const fixture = PROJECT_CODE_FIXTURE;
  const identity = projectCodeGraphIdentity(fixture.vaultId, fixture.slug);
  const snapshotPath = `projects/${fixture.slug}/snapshot.md`;
  const snapshotBody = [
    "# Runtime health code fixture",
    "",
    "The project fixture exposes deterministic Code Graph relationships only.",
    "healthLiveness calls apiProcessAlive.",
    "healthReadiness calls requiredRuntimeDependencies.",
  ].join("\n");
  const metadata = {
    commit: fixture.commit,
    snapshot: {
      files: [{ path: "src/health.ts" }],
      symbols: [
        { name: "healthLiveness", locator: { path: "src/health.ts" } },
        { name: "apiProcessAlive", locator: { path: "src/health.ts" } },
        { name: "healthReadiness", locator: { path: "src/health.ts" } },
        {
          name: "requiredRuntimeDependencies",
          locator: { path: "src/health.ts" },
        },
      ],
    },
    codeGraph: {
      repository: identity.repository,
      scopeId: identity.scopeId,
      sourceRevision: fixture.commit,
      status: "ACTIVE",
    },
  };

  await db.pool.query(
    `insert into projects(id,space_id,vault_id,slug,root_path,metadata)
     values($1,$2,$3,$4,$5,$6::jsonb)
     on conflict(id) do update set
       root_path=excluded.root_path,
       metadata=excluded.metadata`,
    [
      fixture.id,
      SPACE_ID,
      fixture.vaultId,
      fixture.slug,
      `benchmark/agent-ab/${fixture.slug}`,
      JSON.stringify(metadata),
    ],
  );

  const documentId = randomUUID();
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
       current_revision,body_cache,frontmatter,aliases,layer,content_hash,
       token_estimate,raw_links
     ) values($1,$2,$3,$4,$5,$6,'source','ACTIVE','HUMAN_REVIEWED',$7,$8,
              $9::jsonb,'{}','source',$10,$11,'[]'::jsonb)`,
    [
      documentId,
      SPACE_ID,
      fixture.vaultId,
      snapshotPath,
      "agent-public-project-runtime-health",
      "Runtime health project snapshot",
      CORPUS_REVISION,
      snapshotBody,
      JSON.stringify({
        benchmark_corpus: "architecture-knowledge-platform-public-product-docs",
        project_id: fixture.id,
        project_slug: fixture.slug,
      }),
      sha256(snapshotBody),
      Math.max(1, snapshotBody.split(/\s+/u).length),
    ],
  );
  await db.pool.query(
    `insert into knowledge_units(
       id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
       content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
       source_ids,token_estimate,parent_unit_id,permissions,locator,
       structural_order,container_only,embedding_eligible
     ) values($1,$2,$3,$4,'document','PARAGRAPH',$5,$6,$7,$8,$8,'ACTIVE',
              'HUMAN_REVIEWED','{}',$9,null,'{}'::jsonb,$10::jsonb,1,false,true)`,
    [
      randomUUID(),
      documentId,
      SPACE_ID,
      fixture.vaultId,
      ["Runtime health project snapshot"],
      snapshotBody,
      sha256(snapshotBody),
      CORPUS_REVISION,
      Math.max(1, snapshotBody.split(/\s+/u).length),
      JSON.stringify({
        sourcePath: snapshotPath,
        projectId: fixture.id,
      }),
    ],
  );

  const artifact: CodeGraphArtifact = {
    schemaVersion: 1,
    repository: identity.repository,
    commitSha: fixture.commit,
    provider: "agent-ab-deterministic-fixture",
    providerVersion: "1",
    configurationHash: fixture.configurationHash,
    generatedAt: "2026-09-28T00:00:00.000Z",
    languages: ["TypeScript"],
    nodes: [
      {
        id: "function:healthLiveness",
        kind: "FUNCTION",
        name: "healthLiveness",
        qualifiedName: "healthLiveness",
        path: "src/health.ts",
        lineStart: 1,
        lineEnd: 1,
      },
      {
        id: "function:apiProcessAlive",
        kind: "FUNCTION",
        name: "apiProcessAlive",
        qualifiedName: "apiProcessAlive",
        path: "src/health.ts",
        lineStart: 2,
        lineEnd: 2,
      },
      {
        id: "function:healthReadiness",
        kind: "FUNCTION",
        name: "healthReadiness",
        qualifiedName: "healthReadiness",
        path: "src/health.ts",
        lineStart: 4,
        lineEnd: 4,
      },
      {
        id: "function:requiredRuntimeDependencies",
        kind: "FUNCTION",
        name: "requiredRuntimeDependencies",
        qualifiedName: "requiredRuntimeDependencies",
        path: "src/health.ts",
        lineStart: 5,
        lineEnd: 5,
      },
    ],
    edges: [
      {
        id: "edge:healthLiveness-apiProcessAlive",
        sourceId: "function:healthLiveness",
        targetId: "function:apiProcessAlive",
        relation: "CALLS",
        derivation: "STATICALLY_RESOLVED",
      },
      {
        id: "edge:healthReadiness-requiredRuntimeDependencies",
        sourceId: "function:healthReadiness",
        targetId: "function:requiredRuntimeDependencies",
        relation: "CALLS",
        derivation: "STATICALLY_RESOLVED",
      },
    ],
    warnings: [],
  };

  await new PostgresFederatedGraphStore(db).build(
    planCodeGraphProjection({
      artifact,
      spaceId: SPACE_ID,
      vaultId: fixture.vaultId,
      scopeId: identity.scopeId,
      authorizationPathPrefix: identity.authorizationPathPrefix,
    }).projection,
  );
}

async function main(): Promise<void> {
  const manifestPath =
    process.env.AKP_AGENT_AB_CORPUS ??
    "evals/registered/public-product-corpus.json";
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as RegisteredManifest;
  const db = new Postgres(databaseUrl);
  const documentIds = new Map<string, string>();

  try {
    for (const vault of manifest.vaults) {
      const vaultId = VAULT_IDS[vault.id];
      if (!vaultId)
        throw new Error(`No live-comparison vault id for ${vault.id}`);
      const vaultKey = `agent-ab-${vault.id.replace(/^product-/u, "")}`;
      await db.pool.query(
        `insert into vaults(
           id,space_id,canonical_path,name,read_only,current_revision,vault_key,
           local_path,visibility,enabled
         ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)
         on conflict(id) do update set current_revision=excluded.current_revision, enabled=true`,
        [
          vaultId,
          SPACE_ID,
          `benchmark/agent-ab/${vault.id}`,
          `Agent comparison ${vault.kind}`,
          CORPUS_REVISION,
          vaultKey,
        ],
      );
      await db.pool.query(
        `insert into vault_memberships(user_id,vault_id,role,path_prefix,permissions,enabled)
         values($1,$2,'ADMIN',null,$3::jsonb,true)
         on conflict(user_id,vault_id,role,path_prefix)
         do update set permissions=excluded.permissions,enabled=true`,
        [
          USER_ID,
          vaultId,
          JSON.stringify([
            "knowledge:read",
            "source:read",
            "source:write",
            "knowledge:propose",
            "knowledge:review",
            "eval:run",
            "admin",
          ]),
        ],
      );
      await db.pool.query(
        `insert into vault_index_revisions(
           space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
           graph_revision,context_pack_revision,status,warnings
         ) values($1,$2,$3,$3,null,$3,$3,'CONSISTENT','[]'::jsonb)
         on conflict(space_id,vault_id) do update set
           corpus_revision=excluded.corpus_revision,
           lexical_revision=excluded.lexical_revision,
           vector_revision=null,
           graph_revision=excluded.graph_revision,
           context_pack_revision=excluded.context_pack_revision,
           status='CONSISTENT',warnings='[]'::jsonb`,
        [SPACE_ID, vaultId, CORPUS_REVISION],
      );

      for (const document of vault.documents) {
        const documentId = randomUUID();
        documentIds.set(document.id, documentId);
        const body = await readFile(path.resolve(document.sourcePath), "utf8");
        const contentHash = sha256(body);
        await db.pool.query(
          `insert into knowledge_documents(
             id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
             current_revision,body_cache,frontmatter,aliases,layer,content_hash,
             token_estimate,raw_links
           ) values($1,$2,$3,$4,$5,$6,'source','ACTIVE','HUMAN_REVIEWED',$7,$8,
                    $9::jsonb,$10,'source',$11,$12,'[]'::jsonb)`,
          [
            documentId,
            SPACE_ID,
            vaultId,
            document.sourcePath,
            document.id,
            document.title,
            CORPUS_REVISION,
            body,
            JSON.stringify({
              benchmark_corpus: manifest.name,
              logical_id: document.id,
              source_path: document.sourcePath,
            }),
            document.aliases,
            contentHash,
            Math.max(1, body.split(/\s+/u).length),
          ],
        );
        await db.pool.query(
          `insert into knowledge_units(
             id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
             content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
             source_ids,token_estimate,parent_unit_id,permissions,locator,
             structural_order,container_only,embedding_eligible
           ) values($1,$2,$3,$4,'document','PARAGRAPH',$5,$6,$7,$8,$8,'ACTIVE',
                    'HUMAN_REVIEWED',$9,$10,null,'{}'::jsonb,$11::jsonb,1,false,true)`,
          [
            randomUUID(),
            documentId,
            SPACE_ID,
            vaultId,
            [document.title],
            body,
            contentHash,
            CORPUS_REVISION,
            document.evidence,
            Math.max(1, body.split(/\s+/u).length),
            JSON.stringify({
              sourcePath: document.sourcePath,
              citations: document.citations,
              logicalDocumentId: document.id,
            }),
          ],
        );
      }
    }

    for (const vault of manifest.vaults) {
      for (const document of vault.documents) {
        for (const related of document.related) {
          const from = documentIds.get(document.id);
          const to = documentIds.get(related);
          if (!from || !to) continue;
          await db.pool.query(
            `insert into knowledge_relations(
               space_id,from_document_id,to_document_id,relation_type,weight,provenance
             ) values($1,$2,$3,'related_to',1,'agent-ab-live-comparison')
             on conflict do nothing`,
            [SPACE_ID, from, to],
          );
        }
      }
    }

    await provisionProjectCodeFixture(db);

    console.log(
      JSON.stringify({
        status: "PROVISIONED",
        evidenceLevel: "REGISTERED_PUBLIC_PRODUCT_CORPUS",
        spaceId: SPACE_ID,
        vaultIds: Object.values(VAULT_IDS),
        corpusRevision: CORPUS_REVISION,
        documents: documentIds.size,
      }),
    );
  } finally {
    await db.close();
  }
}

await main();
