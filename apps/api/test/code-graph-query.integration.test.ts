import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CodeGraphArtifact } from "@akp/contracts";
import {
  Postgres,
  PostgresFederatedGraphStore,
  grantVaultMembership,
} from "@akp/postgres";
import { planCodeGraphProjection } from "@akp/project-adapter";

const spaceId = "00000000-0000-0000-0000-000000000003";
const vaultId = randomUUID();
const actorId = randomUUID();
const narrowActorId = randomUUID();
const token = `code-api-${randomUUID()}`;
const narrowToken = `code-api-narrow-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const narrowTokenHash = createHash("sha256").update(narrowToken).digest("hex");
const headers = { authorization: `Bearer ${token}` };
const narrowHeaders = { authorization: `Bearer ${narrowToken}` };
const commitSha = "1".repeat(40);
const configurationHash = "2".repeat(64);
const repository = "payments-fixture";
const scopeId = `repo:${repository}`;

let app: FastifyInstance;
let db: Postgres;

const artifact: CodeGraphArtifact = {
  schemaVersion: 1,
  repository,
  commitSha,
  provider: "integration-fixture",
  providerVersion: "1",
  configurationHash,
  generatedAt: "2026-09-18T00:00:00.000Z",
  languages: ["typescript"],
  nodes: [
    {
      id: "function:entry",
      kind: "FUNCTION",
      name: "entry",
      qualifiedName: "entry",
      path: "src/entry.ts",
      lineStart: 1,
      lineEnd: 10,
    },
    {
      id: "function:helper",
      kind: "FUNCTION",
      name: "helper",
      qualifiedName: "helper",
      path: "src/helper.ts",
      lineStart: 1,
      lineEnd: 8,
    },
    {
      id: "function:hidden",
      kind: "FUNCTION",
      name: "hidden",
      qualifiedName: "hidden",
      path: "private/hidden.ts",
      lineStart: 1,
      lineEnd: 6,
    },
    {
      id: "function:target",
      kind: "FUNCTION",
      name: "target",
      qualifiedName: "target",
      path: "src/target.ts",
      lineStart: 1,
      lineEnd: 6,
    },
    {
      id: "test:entry",
      kind: "TEST",
      name: "entry test",
      qualifiedName: "entry test",
      path: "test/entry.test.ts",
      lineStart: 1,
      lineEnd: 12,
    },
  ],
  edges: [
    {
      id: "edge:entry-helper",
      sourceId: "function:entry",
      targetId: "function:helper",
      relation: "CALLS",
      derivation: "STATICALLY_RESOLVED",
    },
    {
      id: "edge:entry-hidden",
      sourceId: "function:entry",
      targetId: "function:hidden",
      relation: "CALLS",
      derivation: "STATICALLY_RESOLVED",
    },
    {
      id: "edge:hidden-target",
      sourceId: "function:hidden",
      targetId: "function:target",
      relation: "CALLS",
      derivation: "STATICALLY_RESOLVED",
    },
    {
      id: "edge:test-entry",
      sourceId: "test:entry",
      targetId: "function:entry",
      relation: "TESTS",
      derivation: "STATICALLY_RESOLVED",
    },
  ],
  warnings: [],
};

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/code-api-${vaultId}`,
      "Code API integration vault",
      commitSha,
      `code-api-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values
      ($1,$2,'Code API Actor'),
      ($3,$4,'Code API Narrow Actor')`,
    [
      actorId,
      `${actorId}@example.test`,
      narrowActorId,
      `${narrowActorId}@example.test`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
      ($1,$3,'VIEWER',null),
      ($2,$3,'VIEWER','src')`,
    [actorId, narrowActorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "VIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "source:read"],
  });
  await grantVaultMembership(db, {
    userId: narrowActorId,
    vaultId,
    role: "VIEWER",
    pathPrefix: "src",
    permissions: ["knowledge:read", "source:read"],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes) values
      ($1,$2,'code api actor',$3::jsonb),
      ($4,$5,'code api narrow actor',$6::jsonb)`,
    [
      actorId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
        ],
      }),
      narrowActorId,
      narrowTokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: "src",
            permissions: ["knowledge:read"],
          },
        ],
      }),
    ],
  );

  const plan = planCodeGraphProjection({
    artifact,
    spaceId,
    vaultId,
    scopeId,
  });
  expect(plan.skippedCandidateEdgeIds).toEqual([]);
  await new PostgresFederatedGraphStore(db).build(plan.projection);

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query("delete from event_outbox where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query(
      "delete from federated_graph_projection_revisions where vault_id=$1",
      [vaultId],
    );
    await db.pool.query("delete from federated_graph_edges where space_id=$1", [
      spaceId,
    ]);
    await db.pool.query("delete from federated_graph_nodes where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query(
      "delete from api_tokens where token_hash=any($1::text[])",
      [[tokenHash, narrowTokenHash]],
    );
    await db.pool.query(
      "delete from memberships where user_id=any($1::uuid[]) and space_id=$2",
      [[actorId, narrowActorId], spaceId],
    );
    await db.pool.query("delete from users where id=any($1::uuid[])", [
      [actorId, narrowActorId],
    ]);
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.close();
  }
});

function scope() {
  return {
    spaceId,
    vaultId,
    freshnessPolicy: "FRESH_ONLY",
  };
}

function selector(qualifiedName: string) {
  return {
    repository,
    commitSha,
    qualifiedName,
  };
}

describe("code graph query API", () => {
  it("exposes revisioned code product queries through the authorized graph boundary", async () => {
    const symbol = await app.inject({
      method: "POST",
      url: "/v1/code/symbol",
      headers,
      payload: {
        ...scope(),
        selector: selector("entry"),
      },
    });
    expect(symbol.statusCode, symbol.body).toBe(200);
    expect(symbol.json()).toMatchObject({
      symbols: [
        {
          payload: {
            repository,
            commitSha,
            qualifiedName: "entry",
            path: "src/entry.ts",
          },
          projection: {
            lifecycle: "ACTIVE",
            freshness: "FRESH",
          },
        },
      ],
    });

    const callees = await app.inject({
      method: "POST",
      url: "/v1/code/callees",
      headers,
      payload: {
        ...scope(),
        selector: selector("entry"),
      },
    });
    expect(callees.statusCode, callees.body).toBe(200);
    expect(
      (callees.json() as { paths: Array<{ target: { payload: unknown } }> })
        .paths,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            payload: expect.objectContaining({ qualifiedName: "helper" }),
          }),
          steps: [
            expect.objectContaining({
              relation: "calls",
              provenance: expect.objectContaining({
                derivation: "STATICALLY_RESOLVED",
              }),
            }),
          ],
        }),
      ]),
    );

    const callers = await app.inject({
      method: "POST",
      url: "/v1/code/callers",
      headers,
      payload: {
        ...scope(),
        selector: selector("helper"),
      },
    });
    expect(callers.statusCode, callers.body).toBe(200);
    expect(
      (callers.json() as { paths: Array<{ target: { payload: unknown } }> })
        .paths,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            payload: expect.objectContaining({ qualifiedName: "entry" }),
          }),
        }),
      ]),
    );

    const path = await app.inject({
      method: "POST",
      url: "/v1/code/path",
      headers,
      payload: {
        ...scope(),
        source: selector("entry"),
        target: selector("target"),
        options: { maxHops: 3, relationTypes: ["calls"] },
      },
    });
    expect(path.statusCode, path.body).toBe(200);
    expect(
      (path.json() as { paths: Array<{ steps: unknown[] }> }).paths.some(
        (candidate) => candidate.steps.length === 2,
      ),
    ).toBe(true);

    const explain = await app.inject({
      method: "POST",
      url: "/v1/code/explain",
      headers,
      payload: {
        ...scope(),
        source: selector("entry"),
        target: selector("target"),
        options: { maxHops: 3, relationTypes: ["calls"] },
      },
    });
    expect(explain.statusCode, explain.body).toBe(200);
    expect(explain.json()).toMatchObject({
      paths: expect.any(Array),
    });

    const tests = await app.inject({
      method: "POST",
      url: "/v1/code/tests",
      headers,
      payload: {
        ...scope(),
        selector: selector("entry"),
      },
    });
    expect(tests.statusCode, tests.body).toBe(200);
    expect(
      (tests.json() as { paths: Array<{ target: { payload: unknown } }> })
        .paths,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            payload: expect.objectContaining({ kind: "TEST" }),
          }),
        }),
      ]),
    );

    const impact = await app.inject({
      method: "POST",
      url: "/v1/code/impact",
      headers,
      payload: {
        ...scope(),
        selector: selector("entry"),
        options: {
          maxHops: 2,
          direction: "both",
          includeTests: true,
        },
      },
    });
    expect(impact.statusCode, impact.body).toBe(200);
    expect(impact.json()).toMatchObject({
      impact: {
        seed: {
          payload: { qualifiedName: "entry" },
        },
        revisionSet: {
          CODE: expect.any(String),
        },
      },
    });

    const changeImpact = await app.inject({
      method: "POST",
      url: "/v1/code/change-impact",
      headers,
      payload: {
        ...scope(),
        repository,
        commitSha,
        changedPaths: ["src/entry.ts"],
        options: { maxHops: 2 },
      },
    });
    expect(changeImpact.statusCode, changeImpact.body).toBe(200);
    expect(changeImpact.json()).toMatchObject({
      changedNodes: [
        expect.objectContaining({
          payload: expect.objectContaining({ path: "src/entry.ts" }),
        }),
      ],
      unmatchedPaths: [],
      impacts: [expect.any(Object)],
    });
  });

  it("does not traverse an unauthorized code node as an invisible bridge", async () => {
    const hiddenBridge = await app.inject({
      method: "POST",
      url: "/v1/code/path",
      headers: narrowHeaders,
      payload: {
        ...scope(),
        source: selector("entry"),
        target: selector("target"),
        options: { maxHops: 3, relationTypes: ["calls"] },
      },
    });
    expect(hiddenBridge.statusCode, hiddenBridge.body).toBe(200);
    expect(hiddenBridge.json()).toEqual({ paths: [] });

    const hiddenSymbol = await app.inject({
      method: "POST",
      url: "/v1/code/symbol",
      headers: narrowHeaders,
      payload: {
        ...scope(),
        selector: selector("hidden"),
      },
    });
    expect(hiddenSymbol.statusCode, hiddenSymbol.body).toBe(200);
    expect(hiddenSymbol.json()).toEqual({ symbols: [] });

    const hiddenTest = await app.inject({
      method: "POST",
      url: "/v1/code/tests",
      headers: narrowHeaders,
      payload: {
        ...scope(),
        selector: selector("entry"),
      },
    });
    expect(hiddenTest.statusCode, hiddenTest.body).toBe(200);
    expect(hiddenTest.json()).toEqual({ paths: [] });
  });
});
