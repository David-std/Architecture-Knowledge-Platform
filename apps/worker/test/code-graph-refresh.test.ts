import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  Postgres,
  PostgresFederatedGraphStore,
  type OutboxEventRecord,
} from "@akp/postgres";
import { projectCodeGraphIdentity } from "@akp/project-adapter";
import { createCodeGraphRefreshHandlers } from "../src/code-graph-refresh.js";

const spaceId = "00000000-0000-0000-0000-000000000003";
const vaultId = randomUUID();
const projectId = randomUUID();
const slug = "payments-refresh";
const roots: string[] = [];
let db: Postgres;

async function fixtureRepository(): Promise<{
  root: string;
  commit: string;
  providerScript: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "akp-worker-code-graph-"));
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  expect(git("init", "-b", "main").status).toBe(0);
  expect(git("config", "user.name", "AKP Worker Test").status).toBe(0);
  expect(git("config", "user.email", "akp-worker@localhost").status).toBe(0);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "entry.ts"),
    'import { helper } from "./helper.js";\nexport function entry() { return helper(); }\n',
  );
  await writeFile(
    path.join(root, "src", "helper.ts"),
    "export function helper() { return 1; }\n",
  );
  expect(git("add", ".").status).toBe(0);
  expect(git("commit", "-m", "fixture").status).toBe(0);
  const commit = git("rev-parse", "HEAD").stdout.trim();

  const providerScript = path.join(root, "fake-graphify.mjs");
  await writeFile(
    providerScript,
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      'if (args.includes("--version")) { console.log("graphify 0.9.63"); process.exit(0); }',
      'if (args[0] !== "extract") process.exit(17);',
      'await mkdir(path.join(process.cwd(), "graphify-out"), { recursive: true });',
      "const graph = { nodes: [",
      '  { id: "entry", label: "entry", node_type: "function", source_file: "src/entry.ts", source_location: "L2", language: "TypeScript" },',
      '  { id: "helper", label: "helper", node_type: "function", source_file: "src/helper.ts", source_location: "L1", language: "TypeScript" }',
      "], edges: [",
      '  { id: "call", source: "entry", target: "helper", relation: "calls", confidence: "STATICALLY_RESOLVED", source_file: "src/entry.ts", source_location: "L2" }',
      "] };",
      'await writeFile(path.join(process.cwd(), "graphify-out", "graph.json"), JSON.stringify(graph));',
    ].join("\n"),
  );
  return { root, commit, providerScript };
}

function event(commit: string): OutboxEventRecord {
  const identity = projectCodeGraphIdentity(vaultId, slug);
  return {
    eventId: randomUUID(),
    eventType: "CodeGraphRefreshRequested",
    eventVersion: 1,
    resourceId: projectId,
    organizationId: null,
    spaceId,
    vaultId,
    correlationId: null,
    causationId: null,
    occurredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    payload: {
      projectId,
      slug,
      commit,
      ...identity,
    },
  };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,'worker-code:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/worker-code-${vaultId}`,
      "Worker code graph test vault",
      `worker-code-${vaultId.slice(0, 8)}`,
    ],
  );
});

afterEach(async () => {
  delete process.env.AKP_CODE_GRAPH_ENABLED;
  delete process.env.AKP_GRAPHIFY_EXECUTABLE;
  delete process.env.AKP_GRAPHIFY_EXECUTABLE_ARGS;
  delete process.env.AKP_PROJECT_ROOTS;
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
  if (!db) return;
  await db.pool.query("delete from projects where id=$1", [projectId]);
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
});

afterAll(async () => {
  if (!db) return;
  await db.pool.query("update vaults set enabled=false where id=$1", [vaultId]);
  await db.close();
});

describe.skipIf(!process.env.DATABASE_URL)(
  "project code graph refresh worker",
  () => {
    it("turns a durable refresh event into an authorized active CODE projection", async () => {
      const fixture = await fixtureRepository();
      const identity = projectCodeGraphIdentity(vaultId, slug);
      await db.pool.query(
        `insert into projects(id,space_id,vault_id,slug,root_path,metadata)
       values($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          projectId,
          spaceId,
          vaultId,
          slug,
          fixture.root,
          JSON.stringify({
            commit: fixture.commit,
            codeGraph: {
              ...identity,
              sourceRevision: fixture.commit,
              status: "REQUESTED",
            },
          }),
        ],
      );
      process.env.AKP_CODE_GRAPH_ENABLED = "true";
      process.env.AKP_PROJECT_ROOTS = fixture.root;
      process.env.AKP_GRAPHIFY_EXECUTABLE = process.execPath;
      process.env.AKP_GRAPHIFY_EXECUTABLE_ARGS = JSON.stringify([
        fixture.providerScript,
      ]);

      const handlers = createCodeGraphRefreshHandlers(db);
      await handlers.CodeGraphRefreshRequested!(event(fixture.commit));

      const project = await db.pool.query<{
        metadata: Record<string, unknown>;
      }>("select metadata from projects where id=$1", [projectId]);
      const metadataJson = JSON.stringify(project.rows[0]?.metadata ?? {});
      expect(metadataJson).not.toContain(fixture.root);
      expect(project.rows[0]?.metadata).toMatchObject({
        codeGraph: {
          ...identity,
          status: "ACTIVE",
          sourceRevision: fixture.commit,
          provider: "graphify",
          providerVersion: "0.9.63",
          nodeCount: 2,
          edgeCount: 1,
        },
      });

      const store = new PostgresFederatedGraphStore(db);
      const nodes = await store.findNodes({
        authorization: {
          spaceId,
          vaults: [{ vaultId, pathPrefix: `projects/${slug}` }],
        },
        domains: ["CODE"],
        payloadContains: {
          repository: identity.repository,
          commitSha: fixture.commit,
          qualifiedName: "entry",
        },
        freshnessPolicy: "FRESH_ONLY",
        limit: 10,
      });
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({
        authorizationPath: `projects/${slug}/src/entry.ts`,
        payload: {
          path: "src/entry.ts",
          repository: identity.repository,
          commitSha: fixture.commit,
        },
        projection: {
          lifecycle: "ACTIVE",
          freshness: "FRESH",
        },
      });
    });

    it("acknowledges an obsolete refresh request without rebuilding an older commit", async () => {
      const fixture = await fixtureRepository();
      const identity = projectCodeGraphIdentity(vaultId, slug);
      await db.pool.query(
        `insert into projects(id,space_id,vault_id,slug,root_path,metadata)
       values($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          projectId,
          spaceId,
          vaultId,
          slug,
          fixture.root,
          JSON.stringify({
            commit: "f".repeat(40),
            codeGraph: {
              ...identity,
              sourceRevision: "f".repeat(40),
              status: "REQUESTED",
            },
          }),
        ],
      );
      process.env.AKP_CODE_GRAPH_ENABLED = "true";
      process.env.AKP_PROJECT_ROOTS = fixture.root;
      process.env.AKP_GRAPHIFY_EXECUTABLE = process.execPath;
      process.env.AKP_GRAPHIFY_EXECUTABLE_ARGS = JSON.stringify([
        fixture.providerScript,
      ]);

      const handlers = createCodeGraphRefreshHandlers(db);
      await handlers.CodeGraphRefreshRequested!(event(fixture.commit));

      const state = await new PostgresFederatedGraphStore(db).revisionState(
        "CODE",
        spaceId,
        identity.scopeId,
      );
      expect(state.active).toBeNull();
    });
  },
);
