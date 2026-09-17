import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ContextFabricNodeError,
  Postgres,
  claimContextFabricNode,
  grantVaultMembership,
  readContextFabricNodeClaim,
  resolveContextFabricIdentity,
} from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();
const token = `fabric-node-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;

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
     ) values($1,$2,$3,$4,true,'fabric-node:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/fabric-node-${vaultId}`,
      "Context fabric node integration vault",
      `fabric-node-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Fabric Node Actor')",
    [actorId, `${actorId}@example.test`],
  );
  await db.pool.query(
    "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'VIEWER',null)",
    [actorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "VIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "source:read"],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'fabric node actor',$3::jsonb)`,
    [
      actorId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "source:read"],
          },
        ],
      }),
    ],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

beforeEach(async () => {
  // The claim is a singleton for the whole database, so each case starts from
  // an unclaimed database rather than inheriting the previous one.
  await db.pool.query("delete from context_fabric_node_claim");
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query("delete from context_fabric_node_claim");
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from vault_memberships where user_id=$1 and vault_id=$2",
      [actorId, vaultId],
    );
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
});

describe("context fabric node identity", () => {
  it("requires a deliberate node id for the modes that own shared derived state", () => {
    expect(resolveContextFabricIdentity({})).toEqual({
      deploymentMode: "SOLO_LOCAL",
      nodeId: "local-context-node",
    });

    // A single workstation keeps working with no new configuration.
    expect(
      resolveContextFabricIdentity({
        AKP_CONTEXT_FABRIC_MODE: "GIT_SYNC_SMALL_TEAM",
      }),
    ).toMatchObject({ deploymentMode: "GIT_SYNC_SMALL_TEAM" });

    // The shared modes do not get an implicit identity, because that identity
    // is what a second node is later checked against.
    for (const mode of ["TEAM_NODE", "FEDERATED_ORG"]) {
      expect(() =>
        resolveContextFabricIdentity({ AKP_CONTEXT_FABRIC_MODE: mode }),
      ).toThrow(/CONTEXT_FABRIC_NODE_ID_REQUIRED|requires an explicit/);
    }

    expect(() =>
      resolveContextFabricIdentity({
        AKP_CONTEXT_FABRIC_MODE: "TEAM_NODE_PLEASE",
      }),
    ).toThrow(/AKP_CONTEXT_FABRIC_MODE must be one of/);

    expect(() =>
      resolveContextFabricIdentity({
        AKP_CONTEXT_FABRIC_MODE: "TEAM_NODE",
        AKP_CONTEXT_FABRIC_NODE_ID: "team node/one",
      }),
    ).toThrow(/must be 1-200 characters/);

    expect(
      resolveContextFabricIdentity({
        AKP_CONTEXT_FABRIC_MODE: "TEAM_NODE",
        AKP_CONTEXT_FABRIC_NODE_ID: "  team-node-1  ",
      }),
    ).toEqual({ deploymentMode: "TEAM_NODE", nodeId: "team-node-1" });
  });

  it("lets replicas of one node share a database but refuses a second node", async () => {
    const first = await claimContextFabricNode(db, {
      nodeId: "team-node-1",
      deploymentMode: "TEAM_NODE",
    });
    expect(first).toMatchObject({
      nodeId: "team-node-1",
      deploymentMode: "TEAM_NODE",
      adoptedFrom: null,
    });

    // A Team Context Node may run more than one API or worker process. Identity,
    // not process count, is what the mode constrains.
    const replica = await claimContextFabricNode(db, {
      nodeId: "team-node-1",
      deploymentMode: "TEAM_NODE",
    });
    expect(replica.claimedAt.getTime()).toBe(first.claimedAt.getTime());
    expect(replica.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
      first.lastSeenAt.getTime(),
    );
    expect(replica.adoptedFrom).toBeNull();

    // A different node pointed at the same shared derived state is the failure
    // the deployment guidance forbids, so it fails closed.
    await expect(
      claimContextFabricNode(db, {
        nodeId: "team-node-2",
        deploymentMode: "TEAM_NODE",
      }),
    ).rejects.toThrow(/already claimed by context-fabric node "team-node-1"/);

    let conflict: unknown;
    try {
      await claimContextFabricNode(db, {
        nodeId: "team-node-2",
        deploymentMode: "TEAM_NODE",
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(ContextFabricNodeError);
    expect((conflict as ContextFabricNodeError).code).toBe(
      "CONTEXT_FABRIC_NODE_CONFLICT",
    );

    // The refusal changed nothing: the original owner still holds the claim.
    expect(await readContextFabricNodeClaim(db)).toMatchObject({
      nodeId: "team-node-1",
      adoptedFrom: null,
    });

    // Restoring someone else's database and running it under a local identity
    // is the same conflict, including when the mode differs.
    await expect(
      claimContextFabricNode(db, {
        nodeId: "laptop-copy",
        deploymentMode: "SOLO_LOCAL",
      }),
    ).rejects.toThrow(/CONTEXT_FABRIC_NODE_CONFLICT|already claimed/);
  });

  it("records an intentional rename as an adoption rather than a silent takeover", async () => {
    const original = await claimContextFabricNode(db, {
      nodeId: "team-node-1",
      deploymentMode: "TEAM_NODE",
    });

    const adopted = await claimContextFabricNode(db, {
      nodeId: "team-node-renamed",
      deploymentMode: "TEAM_NODE",
      adopt: true,
    });
    expect(adopted).toMatchObject({
      nodeId: "team-node-renamed",
      deploymentMode: "TEAM_NODE",
      adoptedFrom: "team-node-1",
    });
    expect(adopted.claimedAt.getTime()).toBeGreaterThanOrEqual(
      original.claimedAt.getTime(),
    );

    // After adopting, the new identity is the one enforced.
    await expect(
      claimContextFabricNode(db, {
        nodeId: "team-node-1",
        deploymentMode: "TEAM_NODE",
      }),
    ).rejects.toThrow(
      /already claimed by context-fabric node "team-node-renamed"/,
    );

    expect(
      await claimContextFabricNode(db, {
        nodeId: "team-node-renamed",
        deploymentMode: "TEAM_NODE",
      }),
    ).toMatchObject({ nodeId: "team-node-renamed" });
  });

  it("reports the claim the database carries rather than this process's environment", async () => {
    const previousMode = process.env.AKP_CONTEXT_FABRIC_MODE;
    const previousNodeId = process.env.AKP_CONTEXT_FABRIC_NODE_ID;
    try {
      // An unclaimed database must not describe itself as owning shared state,
      // however the environment is configured.
      process.env.AKP_CONTEXT_FABRIC_MODE = "TEAM_NODE";
      process.env.AKP_CONTEXT_FABRIC_NODE_ID = "claims-to-be-a-team-node";
      const unclaimed = await app.inject({
        method: "GET",
        url: "/v1/context-fabric/capabilities",
        headers,
      });
      expect(unclaimed.statusCode).toBe(200);
      expect(unclaimed.json()).toMatchObject({
        node: { claimed: false, sharedDerivedState: false },
      });

      await claimContextFabricNode(db, {
        nodeId: "team-node-1",
        deploymentMode: "TEAM_NODE",
      });
      const claimed = await app.inject({
        method: "GET",
        url: "/v1/context-fabric/capabilities",
        headers,
      });
      expect(claimed.statusCode).toBe(200);
      const body = claimed.json() as {
        deploymentMode: string;
        node: {
          id: string;
          claimed: boolean;
          claimedAt: string | null;
          sharedDerivedState: boolean;
        };
        capabilities: Record<string, boolean>;
      };
      // The environment says "claims-to-be-a-team-node"; the database says
      // "team-node-1", and the database is the authority.
      expect(body.node.id).toBe("team-node-1");
      expect(body.node.claimed).toBe(true);
      expect(body.node.sharedDerivedState).toBe(true);
      expect(body.deploymentMode).toBe("TEAM_NODE");
      expect(body.node.claimedAt).toBeTruthy();
      // Whatever the topology, syncing a writable database is never offered.
      expect(body.capabilities.writableDatabaseFileSync).toBe(false);

      // A solo node claims its database too, and is honestly reported as not
      // owning shared derived state.
      await db.pool.query("delete from context_fabric_node_claim");
      await claimContextFabricNode(db, {
        nodeId: "local-context-node",
        deploymentMode: "SOLO_LOCAL",
      });
      const solo = await app.inject({
        method: "GET",
        url: "/v1/context-fabric/capabilities",
        headers,
      });
      expect(solo.json()).toMatchObject({
        deploymentMode: "SOLO_LOCAL",
        node: {
          id: "local-context-node",
          claimed: true,
          sharedDerivedState: false,
        },
      });
    } finally {
      if (previousMode === undefined)
        delete process.env.AKP_CONTEXT_FABRIC_MODE;
      else process.env.AKP_CONTEXT_FABRIC_MODE = previousMode;
      if (previousNodeId === undefined)
        delete process.env.AKP_CONTEXT_FABRIC_NODE_ID;
      else process.env.AKP_CONTEXT_FABRIC_NODE_ID = previousNodeId;
    }
  });
});
