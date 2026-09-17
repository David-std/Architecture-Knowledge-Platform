import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Postgres, grantVaultMembership } from "@akp/postgres";
import { buildServer } from "../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

run("P2 principal credential expiry", () => {
  const db = new Postgres(databaseUrl!);
  const app = buildServer();
  const humanToken = `principal-expiry-${randomUUID()}`;
  const humanHeaders = { authorization: `Bearer ${humanToken}` };
  const orgId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  let sessionId = "";

  beforeAll(async () => {
    await app.ready();
    await db.pool.query(
      `insert into organizations(id,slug,name) values($1,$2,$3)`,
      [orgId, `principal-expiry-${orgId}`, "Principal expiry fixture"],
    );
    await db.pool.query(
      `insert into users(id,email,display_name) values($1,$2,$3)`,
      [userId, `principal-expiry-${userId}@example.test`, "Expiry Human"],
    );
    await db.pool.query(
      `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
       values($1,$2,$3,$4,'TEAM','')`,
      [spaceId, orgId, `principal-expiry-${spaceId}`, "Expiry space"],
    );
    await db.pool.query(
      `insert into memberships(user_id,space_id,role) values($1,$2,'ADMIN')`,
      [userId, spaceId],
    );
    await db.pool.query(
      `insert into vaults(id,space_id,canonical_path,name,vault_key,local_path,read_only,visibility,enabled)
       values($1,$2,$3,$4,$5,$3,true,'TEAM',true)`,
      [
        vaultId,
        spaceId,
        `/tmp/principal-expiry-${vaultId}`,
        "Expiry vault",
        `principal-expiry-${vaultId.slice(0, 8)}`,
      ],
    );
    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "ADMIN",
      pathPrefix: null,
      permissions: [
        "knowledge:read",
        "source:read",
        "source:write",
        "knowledge:propose",
        "knowledge:review",
        "eval:run",
        "admin",
      ],
    });
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
       values($1,$2,$3,$4::jsonb)`,
      [
        userId,
        tokenHash(humanToken),
        "principal expiry human",
        JSON.stringify({
          spaces: [
            {
              spaceId,
              pathPrefix: null,
              permissions: [
                "knowledge:read",
                "source:read",
                "source:write",
                "knowledge:propose",
                "knowledge:review",
                "eval:run",
                "admin",
              ],
            },
          ],
        }),
      ],
    );
  });

  afterAll(async () => {
    await app.close();
    await db.pool.query(
      "delete from audit_events where actor_id=$1 or principal_id in (select id from principals where user_id=$1)",
      [userId],
    );
    await db.pool.query(
      "delete from principals where user_id=$1 and kind='AGENT_PROCESS'",
      [userId],
    );
    await db.pool.query("delete from principals where user_id=$1", [userId]);
    await db.pool.query("delete from agent_sessions where actor_id=$1", [
      userId,
    ]);
    await db.pool.query("delete from api_tokens where user_id=$1", [userId]);
    await db.pool.query("delete from vault_memberships where user_id=$1", [
      userId,
    ]);
    await db.pool.query("delete from memberships where user_id=$1", [userId]);
    await db.pool.query("delete from users where id=$1", [userId]);
    await db.pool.query("update vaults set enabled=false where id=$1", [vaultId]);
    await db.close();
  });

  it("rejects replay immediately after a principal credential expires", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: humanHeaders,
      payload: {
        purpose: "Prove principal credential expiry is enforced on every request",
        contextBudget: 2048,
        spaceId,
        vaultId,
      },
    });
    expect(created.statusCode).toBe(201);
    sessionId = String(created.json().id);

    const issued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/agent-processes`,
      headers: humanHeaders,
      payload: {
        label: "Expiring workspace agent",
        durationMinutes: 5,
        allowedActions: ["workspace:read", "knowledge:read"],
      },
    });
    expect(issued.statusCode).toBe(201);
    const issuance = issued.json() as {
      token: string;
      principal: { id: string; state: string };
    };
    const agentHeaders = { authorization: `Bearer ${issuance.token}` };

    const beforeExpiry = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: agentHeaders,
    });
    expect(beforeExpiry.statusCode).toBe(200);

    await db.pool.query(
      `update principal_credentials
          set expires_at=now()-interval '1 second'
        where principal_id=$1 and revoked_at is null`,
      [issuance.principal.id],
    );
    const principalState = await db.pool.query<{ state: string }>(
      "select state from principals where id=$1",
      [issuance.principal.id],
    );
    expect(principalState.rows[0]?.state).toBe("ACTIVE");

    const replayAfterExpiry = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: agentHeaders,
    });
    expect(replayAfterExpiry.statusCode).toBe(401);
    expect(replayAfterExpiry.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });
});
