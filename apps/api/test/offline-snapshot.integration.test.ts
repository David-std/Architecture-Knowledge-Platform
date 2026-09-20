import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();
const token = `offline-snapshot-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
const sessionIds: string[] = [];

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
     ) values($1,$2,$3,$4,true,'offline:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/offline-snapshot-${vaultId}`,
      "Offline snapshot integration vault",
      `offline-snapshot-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Offline Snapshot Actor')",
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
     values($1,$2,'offline snapshot integration',$3::jsonb)`,
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

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    for (const sessionId of sessionIds) {
      await db.pool.query(
        "delete from audit_events where resource_id=$1 or metadata->>'sessionId'=$1",
        [sessionId],
      );
      await db.pool.query("delete from context_packets where session_id=$1", [
        sessionId,
      ]);
      await db.pool.query("delete from agent_sessions where id=$1", [
        sessionId,
      ]);
    }
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

async function createSession(purpose: string): Promise<{
  id: string;
  contextRevisionSetHash: string;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers,
    payload: {
      spaceId,
      vaultId,
      purpose,
      contextBudget: 2048,
    },
  });
  expect(response.statusCode).toBe(201);
  const session = response.json() as {
    id: string;
    contextRevisionSetHash: string;
  };
  sessionIds.push(session.id);
  expect(session.contextRevisionSetHash).toMatch(/^[a-f0-9]{64}$/);
  return session;
}

describe("offline context snapshot reconnect semantics", () => {
  it("captures one coherent revision, rejects stale reconnect, and revalidates through a new session", async () => {
    const r1Session = await createSession("Offline work pinned to R1");
    const queuedDraft = await app.inject({
      method: "POST",
      url: `/v1/sessions/${r1Session.id}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "snapshot-queued-draft",
        baseRevisionSetHash: r1Session.contextRevisionSetHash,
        eventType: "NOTE",
        payload: { note: "queued while offline" },
      },
    });
    expect(queuedDraft.statusCode).toBe(201);

    const capturedR1 = await app.inject({
      method: "POST",
      url: `/v1/sessions/${r1Session.id}/offline-snapshot`,
      headers,
      payload: {
        query: "offline compiler context",
        intent: "WORKFLOW_EXECUTION",
      },
    });
    expect(capturedR1.statusCode).toBe(200);
    const r1Snapshot = capturedR1.json() as {
      schemaVersion: number;
      offline: boolean;
      stale: boolean;
      status: string;
      pinnedRevisionSetHash: string;
      currentRevisionSetHash: string;
      snapshotHash: string;
      ageSeconds: number;
      mustRevalidateOnReconnect: boolean;
      queuedDraftCount: number;
      unavailableLiveChannels: string[];
      snapshotRevisionSet: {
        spaceId: string;
        vaultId: string;
        profile: { profileId: string };
        policy: { revision: string };
        dimensions: {
          knowledgeGit: { status: string; revision: string | null };
          corpus: { status: string; revision: string | null };
        };
      };
      snapshotManifest: {
        node: { claimed: boolean };
        spaceId: string;
        vaultId: string;
        createdAt: string;
        staleAfter: string;
        expiresAt: string;
        integrity: {
          algorithm: string;
          scope: string;
          hash: string;
          signature: null;
        };
      };
      context: Record<string, unknown>;
    };
    expect(r1Snapshot).toMatchObject({
      schemaVersion: 1,
      offline: true,
      stale: false,
      status: "CURRENT",
      pinnedRevisionSetHash: r1Session.contextRevisionSetHash,
      currentRevisionSetHash: r1Session.contextRevisionSetHash,
      mustRevalidateOnReconnect: true,
      queuedDraftCount: 1,
      unavailableLiveChannels: [
        "FEDERATION_REMOTE_QUERY",
        "CONNECTOR_LIVE_READ",
      ],
      snapshotRevisionSet: {
        spaceId,
        vaultId,
      },
      snapshotManifest: {
        spaceId,
        vaultId,
        integrity: {
          algorithm: "SHA-256",
          scope: "CONTEXT_PACKET",
          hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          signature: null,
        },
      },
    });
    expect(r1Snapshot.snapshotHash).toBe(
      createHash("sha256")
        .update(JSON.stringify(r1Snapshot.context))
        .digest("hex"),
    );
    expect(r1Snapshot.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(r1Snapshot.ageSeconds).toBeLessThan(120);
    expect(r1Snapshot.snapshotManifest.integrity.hash).toBe(
      r1Snapshot.snapshotHash,
    );
    expect(
      new Date(r1Snapshot.snapshotManifest.expiresAt).getTime(),
    ).toBeGreaterThan(new Date(r1Snapshot.snapshotManifest.createdAt).getTime());
    expect(r1Snapshot.snapshotRevisionSet.dimensions.knowledgeGit).toMatchObject(
      { status: "AVAILABLE", revision: "offline:r1" },
    );
    expect(r1Snapshot.snapshotRevisionSet.policy.revision).toMatch(
      /^[a-f0-9]{64}$/,
    );

    await db.pool.query(
      "update vaults set current_revision='offline:r2' where id=$1",
      [vaultId],
    );

    const staleReconnect = await app.inject({
      method: "POST",
      url: `/v1/sessions/${r1Session.id}/offline-snapshot`,
      headers,
      payload: {
        query: "offline compiler context",
        intent: "WORKFLOW_EXECUTION",
      },
    });
    expect(staleReconnect.statusCode).toBe(409);
    const staleBody = staleReconnect.json() as {
      offline: boolean;
      stale: boolean;
      status: string;
      pinnedRevisionSetHash: string;
      currentRevisionSetHash: string;
      ageSeconds: number;
      mustRevalidateOnReconnect: boolean;
      changedDimensions: string[];
      queuedDraftCount: number;
      unavailableLiveChannels: string[];
      snapshotRevisionSet: Record<string, unknown>;
      context: unknown;
    };
    expect(staleBody).toMatchObject({
      offline: true,
      stale: true,
      status: "CHANGED",
      pinnedRevisionSetHash: r1Session.contextRevisionSetHash,
      mustRevalidateOnReconnect: true,
      queuedDraftCount: 1,
      unavailableLiveChannels: [
        "FEDERATION_REMOTE_QUERY",
        "CONNECTOR_LIVE_READ",
      ],
      context: null,
    });
    expect(staleBody.currentRevisionSetHash).not.toBe(
      r1Session.contextRevisionSetHash,
    );
    expect(staleBody.ageSeconds).toBeGreaterThanOrEqual(r1Snapshot.ageSeconds);
    expect(staleBody.ageSeconds).toBeLessThan(120);
    expect(staleBody.changedDimensions).toContain("knowledgeGit");

    const r2Session = await createSession("Offline work revalidated at R2");
    expect(r2Session.contextRevisionSetHash).not.toBe(
      r1Session.contextRevisionSetHash,
    );

    const capturedR2 = await app.inject({
      method: "POST",
      url: `/v1/sessions/${r2Session.id}/offline-snapshot`,
      headers,
      payload: {
        query: "offline compiler context",
        intent: "WORKFLOW_EXECUTION",
      },
    });
    expect(capturedR2.statusCode).toBe(200);
    expect(capturedR2.json()).toMatchObject({
      schemaVersion: 1,
      offline: true,
      stale: false,
      status: "CURRENT",
      pinnedRevisionSetHash: r2Session.contextRevisionSetHash,
      currentRevisionSetHash: r2Session.contextRevisionSetHash,
      mustRevalidateOnReconnect: true,
    });
  });
});
