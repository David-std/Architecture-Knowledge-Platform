import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("audit event resource filters", () => {
  let db: Postgres;
  let app: FastifyInstance;
  const spaceId = "00000000-0000-0000-0000-000000000003";
  const actorId = randomUUID();
  const vaultId = randomUUID();
  const targetResourceId = randomUUID();
  const otherResourceId = randomUUID();
  const token = `audit-filter-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");

  beforeAll(async () => {
    db = new Postgres(databaseUrl!);
    await db.pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3)",
      [actorId, `${actorId}@example.test`, "Audit Filter Actor"],
    );
    await db.pool.query(
      `insert into memberships(user_id,space_id,role,path_prefix)
       values($1,$2,'ADMIN',null)`,
      [actorId, spaceId],
    );
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,'Audit filter vault',true,'audit:r1',$4,$3,'PRIVATE',true)`,
      [
        vaultId,
        spaceId,
        `/tmp/audit-filter-${vaultId}`,
        `audit-filter-${vaultId.slice(0, 8)}`,
      ],
    );
    await grantVaultMembership(db, {
      userId: actorId,
      vaultId,
      role: "ADMIN",
      pathPrefix: null,
      permissions: ["admin"],
    });
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
       values($1,$2,'audit filter actor',$3::jsonb)`,
      [
        actorId,
        tokenHash,
        JSON.stringify({
          spaces: [
            {
              spaceId,
              pathPrefix: null,
              permissions: ["admin"],
            },
          ],
        }),
      ],
    );
    await db.pool.query(
      `insert into audit_events(
         space_id,actor_id,action,resource_type,resource_id,metadata,vault_id
       ) values
         ($1,$2,'workspace.bootstrap','agent_session',$3,'{}'::jsonb,$5),
         ($1,$2,'workspace.bootstrap','agent_session',$4,'{}'::jsonb,$5),
         ($1,$2,'review.read','review',$3,'{}'::jsonb,$5)`,
      [spaceId, actorId, targetResourceId, otherResourceId, vaultId],
    );
    const module = await import("../src/server.js");
    app = module.buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
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
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.close();
  });

  it("filters one authorized resource without returning adjacent audit rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/audit-events?resourceType=agent_session&resourceId=${targetResourceId}&limit=20`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      events: Array<{
        resource_type: string;
        resource_id: string;
        principal_id?: string | null;
      }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      resource_type: "agent_session",
      resource_id: targetResourceId,
    });
    expect(body.events[0]).toHaveProperty("principal_id");
  });
});
