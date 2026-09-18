import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeGraphArtifact } from "@akp/contracts";
import {
  Postgres,
  PostgresFederatedGraphStore,
  type OutboxEventRecord,
} from "@akp/postgres";
import {
  CodeGraphQueryService,
  planCodeGraphProjection,
  projectCodeGraphIdentity,
} from "@akp/project-adapter";
import { createCodeKnowledgeLinkHandlers } from "../src/code-knowledge-link.js";

const spaceId = "00000000-0000-0000-0000-000000000003";
const vaultId = randomUUID();
const userId = randomUUID();
const projectId = randomUUID();
const documentId = randomUUID();
const reviewId = randomUUID();
const mappingId = randomUUID();
const slug = "worker-code-link";
const commitSha = "9".repeat(40);
const documentPath = "20-decisions/worker-code-link.md";
let db: Postgres;
let codeNodeIdentity: Record<string, unknown>;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/worker-code-link-${vaultId}`,
      "Worker code link vault",
      commitSha,
      `worker-link-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Worker Code Link Reviewer')",
    [userId, `${userId}@example.test`],
  );
  const principal = await db.pool.query<{ id: string }>(
    "select id from principals where user_id=$1 and kind='HUMAN'",
    [userId],
  );
  const principalId = principal.rows[0]?.id;
  if (!principalId) throw new Error("HUMAN_PRINCIPAL_REQUIRED");

  const identity = projectCodeGraphIdentity(vaultId, slug);
  await db.pool.query(
    `insert into projects(id,space_id,vault_id,slug,root_path,metadata)
     values($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      projectId,
      spaceId,
      vaultId,
      slug,
      `/tmp/worker-link-project-${projectId}`,
      JSON.stringify({ commit: commitSha }),
    ],
  );
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
       current_revision,body_cache,frontmatter,aliases,layer,content_hash,
       token_estimate,raw_links
     ) values(
       $1,$2,$3,$4,$5,$6,'decision','ACTIVE','HUMAN_REVIEWED',
       $7,$8,'{}'::jsonb,'{}','decision',$9,16,'[]'::jsonb
     )`,
    [
      documentId,
      spaceId,
      vaultId,
      documentPath,
      `DEC-${documentId.slice(0, 8)}`,
      "Worker reviewed decision",
      commitSha,
      "Reviewed retry rationale.",
      createHash("sha256").update("worker reviewed decision").digest("hex"),
    ],
  );
  await db.pool.query(
    `insert into reviews(
       id,space_id,vault_id,branch_name,base_commit,head_commit,status,author_id,
       impact_manifest,validation_report,merged_commit
     ) values($1,$2,$3,$4,$5,$5,'APPROVED',$6,$7::jsonb,'{}'::jsonb,$5)`,
    [
      reviewId,
      spaceId,
      vaultId,
      `review/${reviewId}`,
      commitSha,
      userId,
      JSON.stringify({
        proposedChanges: [{ path: documentPath, operation: "UPDATE" }],
      }),
    ],
  );

  const artifact: CodeGraphArtifact = {
    schemaVersion: 1,
    repository: identity.repository,
    commitSha,
    provider: "worker-fixture",
    providerVersion: "1",
    configurationHash: "a".repeat(64),
    generatedAt: "2026-09-18T00:00:00.000Z",
    languages: ["TypeScript"],
    nodes: [
      {
        id: "function:retryWorker",
        kind: "FUNCTION",
        name: "retryWorker",
        qualifiedName: "retryWorker",
        path: "src/worker.ts",
        lineStart: 1,
        lineEnd: 4,
      },
    ],
    edges: [],
    warnings: [],
  };
  const store = new PostgresFederatedGraphStore(db);
  await store.build(
    planCodeGraphProjection({
      artifact,
      spaceId,
      vaultId,
      scopeId: identity.scopeId,
      authorizationPathPrefix: identity.authorizationPathPrefix,
    }).projection,
  );
  const nodes = await store.findNodes({
    authorization: {
      spaceId,
      vaults: [{ vaultId, pathPrefix: null }],
      allowSpaceScoped: false,
    },
    domains: ["CODE"],
    payloadContains: {
      repository: identity.repository,
      commitSha,
      qualifiedName: "retryWorker",
    },
    freshnessPolicy: "FRESH_ONLY",
    limit: 10,
  });
  expect(nodes).toHaveLength(1);
  codeNodeIdentity = nodes[0]!.identity;

  const mappingHash = createHash("sha256")
    .update(`mapping:${mappingId}`)
    .digest("hex");
  await db.pool.query(
    `insert into code_knowledge_links(
       id,space_id,vault_id,project_id,document_id,review_id,relation_type,
       knowledge_revision,code_repository,code_commit_sha,code_node_identity,
       code_selector,mapping_hash,approved_by_user_id,approved_by_principal_id
     ) values(
       $1,$2,$3,$4,$5,$6,'rationale_ref',$7,$8,$9,$10::jsonb,$11::jsonb,
       $12,$13,$14
     )`,
    [
      mappingId,
      spaceId,
      vaultId,
      projectId,
      documentId,
      reviewId,
      commitSha,
      identity.repository,
      commitSha,
      JSON.stringify(codeNodeIdentity),
      JSON.stringify({ qualifiedName: "retryWorker" }),
      mappingHash,
      userId,
      principalId,
    ],
  );
});

afterAll(async () => {
  if (!db) return;
  await db.pool.query("update vaults set enabled=false where id=$1", [vaultId]);
  await db.close();
});

describe.skipIf(!process.env.DATABASE_URL)(
  "reviewed code knowledge link worker",
  () => {
    it("projects HUMAN_ASSERTED rationale into code impact traversal", async () => {
      const event: OutboxEventRecord = {
        eventId: randomUUID(),
        eventType: "CodeKnowledgeLinkApproved",
        eventVersion: 1,
        resourceId: mappingId,
        organizationId: null,
        spaceId,
        vaultId,
        correlationId: null,
        causationId: null,
        occurredAt: new Date().toISOString(),
        payload: { mappingId },
        createdAt: new Date().toISOString(),
      };
      const handlers = createCodeKnowledgeLinkHandlers(db);
      await handlers.CodeKnowledgeLinkApproved!(event);

      const identity = projectCodeGraphIdentity(vaultId, slug);
      const impact = await new CodeGraphQueryService(
        new PostgresFederatedGraphStore(db),
      ).impact(
        {
          authorization: {
            spaceId,
            vaults: [{ vaultId, pathPrefix: null }],
            allowSpaceScoped: false,
          },
          freshnessPolicy: "FRESH_ONLY",
        },
        {
          repository: identity.repository,
          commitSha,
          qualifiedName: "retryWorker",
        },
        {
          includeRulesDecisions: true,
          direction: "both",
          maxHops: 2,
        },
      );

      const rationale = impact.affected.find(
        (path) =>
          path.target.identity.graphDomain === "EPISTEMIC" &&
          path.target.payload.mappingId === mappingId,
      );
      expect(rationale).toBeDefined();
      expect(rationale?.steps).toHaveLength(1);
      expect(rationale?.steps[0]).toMatchObject({
        relation: "rationale_ref",
        direction: "incoming",
        provenance: {
          derivation: "HUMAN_ASSERTED",
          evidenceIds: [
            `review:${reviewId}`,
            `mapping:${mappingId}`,
          ],
        },
      });
      expect(rationale?.revisionSet).toMatchObject({
        CODE: codeNodeIdentity.revision,
        EPISTEMIC: `link:${mappingId}`,
      });
    });
  },
);
