import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Postgres,
  PostgresFederatedGraphStore,
  grantVaultMembership,
} from "@akp/postgres";
import type { CodeGraphArtifact } from "@akp/contracts";
import {
  planCodeGraphProjection,
  projectCodeGraphIdentity,
} from "@akp/project-adapter";

const spaceId = "00000000-0000-0000-0000-000000000003";
const vaultId = randomUUID();
const actorId = randomUUID();
const token = `project-code-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = {
  authorization: `Bearer ${token}`,
  "idempotency-key": "project-code-graph-scan-1",
};
const slug = "payments-project";
let app: FastifyInstance;
let db: Postgres;
let root = "";
let commit = "";
let projectId = "";

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  process.env.AKP_CODE_GRAPH_ENABLED = "true";

  root = await mkdtemp(path.join(tmpdir(), "akp-project-scan-"));
  process.env.AKP_PROJECT_ROOTS = root;
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  expect(git("init", "-b", "main").status).toBe(0);
  expect(git("config", "user.name", "AKP Project Test").status).toBe(0);
  expect(git("config", "user.email", "akp-project@localhost").status).toBe(0);
  await writeFile(
    path.join(root, "index.ts"),
    "export function projectEntry() { return 1; }\n",
  );
  expect(git("add", ".").status).toBe(0);
  expect(git("commit", "-m", "fixture").status).toBe(0);
  commit = git("rev-parse", "HEAD").stdout.trim();

  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/project-code-${vaultId}`,
      "Project Code Graph API vault",
      commit,
      `project-code-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Project Code Actor')",
    [actorId, `${actorId}@example.test`],
  );
  await db.pool.query(
    "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'CONTRIBUTOR',null)",
    [actorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "CONTRIBUTOR",
    pathPrefix: null,
    permissions: ["knowledge:read", "knowledge:propose", "source:read"],
  });
  await db.pool.query(
    "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'project code actor',$3::jsonb)",
    [
      actorId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "knowledge:propose", "source:read"],
          },
        ],
      }),
    ],
  );

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  delete process.env.AKP_CODE_GRAPH_ENABLED;
  delete process.env.AKP_PROJECT_ROOTS;
  if (db) {
    await db.pool.query(
      "delete from federated_graph_projection_revisions where vault_id=$1",
      [vaultId],
    );
    await db.pool.query(
      `delete from federated_graph_edges
        where from_node_id in (
          select id from federated_graph_nodes where vault_id=$1
        )
           or to_node_id in (
             select id from federated_graph_nodes where vault_id=$1
           )`,
      [vaultId],
    );
    await db.pool.query("delete from federated_graph_nodes where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query(
      "delete from knowledge_documents where vault_id=$1 and path=$2",
      [vaultId, `projects/${slug}/snapshot.md`],
    );
    await db.pool.query("delete from projects where vault_id=$1 and slug=$2", [
      vaultId,
      slug,
    ]);
    await db.pool.query("delete from idempotency_records where actor_id=$1", [
      actorId,
    ]);
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe("project scan Code Graph request", () => {
  it("persists one idempotent logical refresh request without leaking the local root", async () => {
    const payload = {
      slug,
      rootPath: root,
      spaceId,
      vaultId,
      commit,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/projects/scan",
      headers,
      payload,
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json() as {
      id: string;
      codeGraph: Record<string, unknown>;
    };
    projectId = firstBody.id;
    const identity = projectCodeGraphIdentity(vaultId, slug);
    expect(firstBody.codeGraph).toMatchObject({
      ...identity,
      sourceRevision: commit,
      status: "REQUESTED",
    });
    expect(JSON.stringify(firstBody)).not.toContain(root);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/projects/scan",
      headers,
      payload,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const events = await db.pool.query<{
      resource_id: string;
      payload: Record<string, unknown>;
    }>(
      `select resource_id,payload
         from event_outbox
        where event_type='CodeGraphRefreshRequested'
          and vault_id=$1
          and resource_id=$2`,
      [vaultId, firstBody.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      resource_id: firstBody.id,
      payload: {
        projectId: firstBody.id,
        slug,
        commit,
        ...identity,
      },
    });
    expect(JSON.stringify(events.rows[0]?.payload ?? {})).not.toContain(root);

    const project = await db.pool.query<{ metadata: Record<string, unknown> }>(
      "select metadata from projects where id=$1",
      [firstBody.id],
    );
    expect(project.rows[0]?.metadata).toMatchObject({
      commit,
      codeGraph: {
        ...identity,
        sourceRevision: commit,
        status: "REQUESTED",
      },
    });
  });

  it("fences project queries to the current immutable project revision", async () => {
    expect(projectId).not.toBe("");
    const identity = projectCodeGraphIdentity(vaultId, slug);
    const graph = new PostgresFederatedGraphStore(db);
    const artifact = (commitSha: string): CodeGraphArtifact => ({
      schemaVersion: 1,
      repository: identity.repository,
      commitSha,
      provider: "query-fence-fixture",
      providerVersion: "1",
      configurationHash: "9".repeat(64),
      generatedAt: "2026-09-18T00:00:00.000Z",
      languages: ["TypeScript"],
      nodes: [
        {
          id: "function:projectEntry",
          kind: "FUNCTION",
          name: "projectEntry",
          qualifiedName: "projectEntry",
          path: "index.ts",
          lineStart: 1,
          lineEnd: 1,
        },
      ],
      edges: [],
      warnings: [],
    });

    const oldCommit = "e".repeat(40);
    await graph.build(
      planCodeGraphProjection({
        artifact: artifact(oldCommit),
        spaceId,
        vaultId,
        scopeId: identity.scopeId,
        authorizationPathPrefix: identity.authorizationPathPrefix,
      }).projection,
    );

    const staleAsFresh = await app.inject({
      method: "POST",
      url: "/v1/code/symbol",
      headers: { authorization: headers.authorization },
      payload: {
        spaceId,
        vaultId,
        freshnessPolicy: "FRESH_ONLY",
        selector: {
          repository: identity.repository,
          qualifiedName: "projectEntry",
        },
      },
    });
    expect(staleAsFresh.statusCode, staleAsFresh.body).toBe(409);
    expect(staleAsFresh.json()).toEqual({
      code: "CODE_GRAPH_SOURCE_REVISION_STALE",
    });

    await graph.markStale(
      "CODE",
      spaceId,
      identity.scopeId,
      "project revision advanced",
    );
    const allowedStale = await app.inject({
      method: "POST",
      url: "/v1/code/symbol",
      headers: { authorization: headers.authorization },
      payload: {
        spaceId,
        vaultId,
        freshnessPolicy: "ALLOW_STALE",
        selector: {
          repository: identity.repository,
          qualifiedName: "projectEntry",
        },
      },
    });
    expect(allowedStale.statusCode, allowedStale.body).toBe(200);
    expect(allowedStale.json()).toMatchObject({
      symbols: [
        {
          payload: {
            repository: identity.repository,
            commitSha: oldCommit,
            qualifiedName: "projectEntry",
          },
          projection: {
            freshness: "STALE",
          },
        },
      ],
    });

    await graph.build(
      planCodeGraphProjection({
        artifact: artifact(commit),
        spaceId,
        vaultId,
        scopeId: identity.scopeId,
        authorizationPathPrefix: identity.authorizationPathPrefix,
      }).projection,
    );
    const current = await app.inject({
      method: "POST",
      url: "/v1/code/symbol",
      headers: { authorization: headers.authorization },
      payload: {
        spaceId,
        vaultId,
        freshnessPolicy: "FRESH_ONLY",
        selector: {
          repository: identity.repository,
          qualifiedName: "projectEntry",
        },
      },
    });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      symbols: [
        {
          payload: {
            repository: identity.repository,
            commitSha: commit,
            qualifiedName: "projectEntry",
          },
          projection: {
            freshness: "FRESH",
          },
        },
      ],
    });
  });
});
