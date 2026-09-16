import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();
const token = `presence-${randomUUID()}`;
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
     ) values($1,$2,$3,$4,true,'presence:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/presence-${vaultId}`,
      "Presence integration vault",
      `presence-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Presence Actor')",
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
     values($1,$2,'presence actor',$3::jsonb)`,
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
  if (db) await db.close();
});

describe("workspace presence", () => {
  it("uses an expiring presence lease without granting work ownership", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Presence lease fixture",
        contextBudget: 1024,
      },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { id: string }).id;

    const initialPresence = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/presence`,
      headers,
    });
    expect(initialPresence.statusCode).toBe(200);
    expect(
      (
        initialPresence.json() as {
          participants: Array<{
            userId: string;
            lastSeenAt: string;
            online: boolean;
          }>;
        }
      ).participants,
    ).toContainEqual(
      expect.objectContaining({
        userId: actorId,
        lastSeenAt: expect.any(String),
        online: false,
      }),
    );

    const invalid = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/presence/heartbeat`,
      headers,
      payload: { ttlSeconds: 2 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "INVALID_PRESENCE_TTL" });

    const heartbeat = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/presence/heartbeat`,
      headers,
      payload: { ttlSeconds: 60 },
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({
      sessionId,
      userId: actorId,
      role: "OWNER",
      online: true,
    });

    const listed = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/presence`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (
        listed.json() as {
          participants: Array<{ userId: string; online: boolean }>;
        }
      ).participants,
    ).toContainEqual(
      expect.objectContaining({ userId: actorId, online: true }),
    );

    const claims = await db.pool.query<{ count: number }>(
      "select count(*)::int count from workspace_claims where session_id=$1",
      [sessionId],
    );
    expect(claims.rows[0]?.count).toBe(0);
  });
});
