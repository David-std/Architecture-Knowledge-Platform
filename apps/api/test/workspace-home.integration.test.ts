import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("workspace home operator projection", () => {
  let db: Postgres;
  let app: FastifyInstance;
  const spaceId = "00000000-0000-0000-0000-000000000003";
  const actorId = randomUUID();
  const visibleVaultId = randomUUID();
  const hiddenVaultId = randomUUID();
  const token = `workspace-home-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");

  beforeAll(async () => {
    db = new Postgres(databaseUrl!);
    await db.pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3)",
      [actorId, `${actorId}@example.test`, "Workspace Home Actor"],
    );
    await db.pool.query(
      `insert into memberships(user_id,space_id,role,path_prefix)
       values($1,$2,'VIEWER',null)`,
      [actorId, spaceId],
    );
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values
         ($1,$3,$4,'Visible workspace vault',true,'rev-visible',$5,$4,'PRIVATE',true),
         ($2,$3,$6,'Hidden workspace vault',true,'rev-hidden',$7,$6,'PRIVATE',true)`,
      [
        visibleVaultId,
        hiddenVaultId,
        spaceId,
        `/tmp/workspace-home-visible-${visibleVaultId}`,
        `workspace-visible-${visibleVaultId}`,
        `/tmp/workspace-home-hidden-${hiddenVaultId}`,
        `workspace-hidden-${hiddenVaultId}`,
      ],
    );
    await grantVaultMembership(db, {
      userId: actorId,
      vaultId: visibleVaultId,
      role: "VIEWER",
      pathPrefix: null,
      permissions: ["knowledge:read"],
    });
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
       values($1,$2,'workspace home actor',$3::jsonb)`,
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
      ],
    );
    await db.pool.query(
      `insert into projects(space_id,vault_id,slug,root_path,metadata)
       values($1,$2,'visible-project','/secret/local/project',$3::jsonb)`,
      [
        spaceId,
        visibleVaultId,
        JSON.stringify({
          commit: "a".repeat(40),
          localPath: "/secret/local/project",
          repositoryPath: "/another/private/path",
        }),
      ],
    );
    await db.pool.query(
      `insert into external_object_refs(
         space_id,vault_id,provider,object_type,external_id,title,authority,
         metadata,work_object_class
       ) values
         ($1,$2,'fixture','ticket','VISIBLE-1','Visible work item',
          'SYSTEM_OF_RECORD','{}'::jsonb,'WORK_ITEM'),
         ($1,$3,'fixture','ticket','HIDDEN-1','Hidden work item',
          'SYSTEM_OF_RECORD','{}'::jsonb,'WORK_ITEM')`,
      [spaceId, visibleVaultId, hiddenVaultId],
    );

    const module = await import("../src/server.js");
    app = module.buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!db) return;
    await db.pool.query(
      "delete from external_object_refs where vault_id=any($1::uuid[])",
      [[visibleVaultId, hiddenVaultId]],
    );
    await db.pool.query("delete from projects where vault_id=$1", [
      visibleVaultId,
    ]);
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from vault_memberships where vault_id=any($1::uuid[])",
      [[visibleVaultId, hiddenVaultId]],
    );
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("delete from vaults where id=any($1::uuid[])", [
      [visibleVaultId, hiddenVaultId],
    ]);
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.close();
  });

  it("orients the user around authorized work without leaking hidden vaults or local paths", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/operator/workspace-home",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode, response.body).toBe(200);

    const body = response.json() as {
      scope: { vaultIds: string[] };
      projects: Array<Record<string, unknown>>;
      workItems: Array<Record<string, unknown>>;
      pendingReviews: unknown[];
      assuranceFindings: unknown[];
      activeSessions: unknown[];
      activeClaims: unknown[];
      recentHandoffs: unknown[];
      freshness: unknown[];
      connectors: unknown[];
      federation: unknown[];
    };
    expect(body.scope.vaultIds).toEqual([visibleVaultId]);
    expect(body.workItems).toEqual([
      expect.objectContaining({
        vault_id: visibleVaultId,
        external_id: "VISIBLE-1",
        title: "Visible work item",
        work_object_class: "WORK_ITEM",
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("HIDDEN-1");
    expect(JSON.stringify(body)).not.toContain(hiddenVaultId);
    expect(body.projects).toEqual([
      expect.objectContaining({
        vault_id: visibleVaultId,
        slug: "visible-project",
        metadata: expect.objectContaining({
          commit: "a".repeat(40),
        }),
      }),
    ]);
    expect(JSON.stringify(body.projects)).not.toContain(
      "/secret/local/project",
    );
    expect(JSON.stringify(body.projects)).not.toContain(
      "/another/private/path",
    );
    for (const key of [
      "pendingReviews",
      "assuranceFindings",
      "activeSessions",
      "activeClaims",
      "recentHandoffs",
      "freshness",
      "connectors",
      "federation",
    ] as const) {
      expect(Array.isArray(body[key]), key).toBe(true);
    }
  });
});
