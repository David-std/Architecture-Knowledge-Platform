import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const organizationId = "00000000-0000-0000-0000-000000000001";
const adminId = "00000000-0000-0000-0000-000000000002";
const targetUserId = randomUUID();
const outsideSpaceId = randomUUID();
const vaultId = randomUUID();
const sessionId = randomUUID();
const agentPrincipalId = randomUUID();
const agentCredentialId = randomUUID();
const crossAgentPrincipalId = randomUUID();
const crossAgentCredentialId = randomUUID();
const ownCredentialId = randomUUID();
const crossCredentialId = randomUUID();
const adminToken = `team-admin-${randomUUID()}`;
const ownToken = `team-own-${randomUUID()}`;
const crossToken = `team-cross-${randomUUID()}`;
const agentTokenHash = createHash("sha256")
  .update(`agent-${randomUUID()}`)
  .digest("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const headers = { authorization: `Bearer ${adminToken}` };

let db: Postgres;
let app: FastifyInstance;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Outside team space','PRIVATE','')
     on conflict(id) do nothing`,
    [outsideSpaceId, organizationId, `outside-${outsideSpaceId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into users(id,email,display_name)
     values($1,$2,'Team Admin Target')`,
    [targetUserId, `${targetUserId}@example.test`],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix)
     values
       ($1,$2,'VIEWER',null),
       ($1,$3,'VIEWER',null)`,
    [targetUserId, spaceId, outsideSpaceId],
  );

  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,'Team Admin Vault',true,'team:r1',$4,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/team-admin-${vaultId}`,
      `team-admin-${vaultId.slice(0, 8)}`,
    ],
  );
  await grantVaultMembership(db, {
    userId: adminId,
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
    `insert into api_tokens(id,user_id,token_hash,label,scopes)
     values
       ($1,$2,$3,'Team admin test',$4::jsonb),
       ($5,$6,$7,'Target own-space',$8::jsonb),
       ($9,$6,$10,'Target cross-space',$11::jsonb)`,
    [
      randomUUID(),
      adminId,
      hash(adminToken),
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "admin"],
          },
        ],
      }),
      ownCredentialId,
      targetUserId,
      hash(ownToken),
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
        ],
      }),
      crossCredentialId,
      hash(crossToken),
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
          {
            spaceId: outsideSpaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
        ],
      }),
    ],
  );

  await db.pool.query(
    `insert into agent_sessions(
       id,space_id,vault_id,actor_id,purpose,context_budget,state
     ) values($1,$2,$3,$4,'Team admin agent fixture',2048,$5::jsonb)`,
    [
      sessionId,
      spaceId,
      vaultId,
      adminId,
      JSON.stringify({ workStatus: "OPEN" }),
    ],
  );
  await db.pool.query(
    `insert into workspace_session_participants(session_id,user_id,role)
     values($1,$2,'OWNER')`,
    [sessionId, adminId],
  );
  const parent = await db.pool.query<{ id: string }>(
    `select id from principals
      where kind='HUMAN' and user_id=$1 and state='ACTIVE'
      limit 1`,
    [adminId],
  );
  const parentPrincipalId = parent.rows[0]?.id;
  if (!parentPrincipalId) throw new Error("ADMIN_HUMAN_PRINCIPAL_REQUIRED");

  await db.pool.query(
    `insert into principals(
       id,kind,user_id,parent_principal_id,session_id,vault_id,display_name,
       allowed_actions
     ) values(
       $1,'AGENT_PROCESS',$2,$3,$4,$5,'Team Admin Agent',
       $6::text[]
     )`,
    [
      agentPrincipalId,
      adminId,
      parentPrincipalId,
      sessionId,
      vaultId,
      [
        "workspace:read",
        "workspace:claim",
        "workspace:event:append",
        "knowledge:read",
      ],
    ],
  );
  await db.pool.query(
    `insert into principal_credentials(
       id,principal_id,user_id,token_hash,label,scopes,allowed_actions,
       policy_revision,expires_at
     ) values($1,$2,$3,$4,'Team Admin Agent',$5::jsonb,$6::text[],1,$7)`,
    [
      agentCredentialId,
      agentPrincipalId,
      adminId,
      agentTokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
        ],
      }),
      [
        "workspace:read",
        "workspace:claim",
        "workspace:event:append",
        "knowledge:read",
      ],
      new Date(Date.now() + 3_600_000),
    ],
  );

  await db.pool.query(
    `insert into principals(
       id,kind,user_id,parent_principal_id,session_id,vault_id,display_name,
       allowed_actions
     ) values(
       $1,'AGENT_PROCESS',$2,$3,$4,$5,'Cross Scope Agent',
       $6::text[]
     )`,
    [
      crossAgentPrincipalId,
      adminId,
      parentPrincipalId,
      sessionId,
      vaultId,
      ["workspace:read", "knowledge:read"],
    ],
  );
  await db.pool.query(
    `insert into principal_credentials(
       id,principal_id,user_id,token_hash,label,scopes,allowed_actions,
       policy_revision,expires_at
     ) values(
       $1,$2,$3,$4,'Cross Scope Agent',$5::jsonb,$6::text[],1,$7
     )`,
    [
      crossAgentCredentialId,
      crossAgentPrincipalId,
      adminId,
      hash(`cross-agent-${crossAgentCredentialId}`),
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
          {
            spaceId: outsideSpaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
        ],
      }),
      ["workspace:read", "knowledge:read"],
      new Date(Date.now() + 3_600_000),
    ],
  );

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query(
    `delete from audit_events
      where resource_id=any($1::text[])
        and action='team.credential.revoke'`,
    [[ownCredentialId, crossCredentialId, agentPrincipalId]],
  );
  await db.pool.query(
    `delete from event_outbox
      where resource_id=$1 or correlation_id=$2`,
    [agentPrincipalId, sessionId],
  );
  await db.pool.query(
    `delete from idempotency_records
      where actor_id=$1
        and idempotency_key=any($2::text[])`,
    [
      adminId,
      [
        "team-revoke-own-token",
        "team-revoke-cross-token",
        "team-revoke-cross-agent-credential",
        "team-revoke-agent-credential",
      ],
    ],
  );
  await db.pool.query("delete from agent_sessions where id=$1", [sessionId]);
  await db.pool.query(
    "delete from api_tokens where token_hash=any($1::text[])",
    [[hash(adminToken), hash(ownToken), hash(crossToken)]],
  );
  await db.pool.query("delete from vault_memberships where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [vaultId]);
  await db.pool.query("delete from memberships where user_id=$1", [
    targetUserId,
  ]);
  await db.pool.query("delete from users where id=$1", [targetUserId]);
  await db.pool.query("delete from spaces where id=$1", [outsideSpaceId]);
  await db.close();
});

describe("team admin projection", () => {
  it("shows scoped memberships and credential metadata without secrets", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/operator/team",
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as {
      scope: { spaces: string[]; vaultIds: string[] };
      spaces: Array<{ id: string }>;
      memberships: Array<{ user_id: string; space_id: string }>;
      principals: Array<{ id: string; kind: string }>;
      apiCredentials: Array<{
        id: string;
        scopes: Array<{ spaceId: string }>;
        revocable: boolean;
        crossScope: boolean;
      }>;
      principalCredentials: Array<{
        id: string;
        principalId: string;
        scopes: Array<{ spaceId: string }>;
        revocable: boolean;
        crossScope: boolean;
      }>;
    };

    expect(body.scope.spaces).toContain(spaceId);
    expect(body.scope.spaces).not.toContain(outsideSpaceId);
    expect(body.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: targetUserId,
          space_id: spaceId,
        }),
      ]),
    );
    expect(
      body.memberships.some(
        (membership) => membership.space_id === outsideSpaceId,
      ),
    ).toBe(false);
    expect(body.principals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentPrincipalId,
          kind: "AGENT_PROCESS",
        }),
      ]),
    );

    const own = body.apiCredentials.find(
      (credential) => credential.id === ownCredentialId,
    );
    const cross = body.apiCredentials.find(
      (credential) => credential.id === crossCredentialId,
    );
    expect(own).toMatchObject({ revocable: true, crossScope: false });
    expect(cross).toMatchObject({ revocable: false, crossScope: true });
    expect(cross?.scopes.map((scope) => scope.spaceId)).toEqual([spaceId]);
    expect(body.principalCredentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: agentCredentialId,
          principalId: agentPrincipalId,
          revocable: true,
          crossScope: false,
        }),
        expect.objectContaining({
          id: crossAgentCredentialId,
          principalId: crossAgentPrincipalId,
          revocable: false,
          crossScope: true,
        }),
      ]),
    );
    const crossAgent = body.principalCredentials.find(
      (credential) => credential.id === crossAgentCredentialId,
    );
    expect(crossAgent?.scopes.map((scope) => scope.spaceId)).toEqual([spaceId]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(hash(adminToken));
    expect(serialized).not.toContain(hash(ownToken));
    expect(serialized).not.toContain(hash(crossToken));
    expect(serialized).not.toContain(agentTokenHash);
    expect(serialized).not.toContain(adminToken);
  });

  it("revokes only credentials wholly inside the admin scope", async () => {
    const ownRevocation = await app.inject({
      method: "POST",
      url: `/v1/operator/team/credentials/${ownCredentialId}/revoke`,
      headers: {
        ...headers,
        "idempotency-key": "team-revoke-own-token",
      },
      payload: { kind: "API_TOKEN" },
    });
    expect(ownRevocation.statusCode, ownRevocation.body).toBe(200);
    const ownState = await db.pool.query<{ revoked_at: Date | null }>(
      "select revoked_at from api_tokens where id=$1",
      [ownCredentialId],
    );
    expect(ownState.rows[0]?.revoked_at).toBeTruthy();

    const crossRevocation = await app.inject({
      method: "POST",
      url: `/v1/operator/team/credentials/${crossCredentialId}/revoke`,
      headers: {
        ...headers,
        "idempotency-key": "team-revoke-cross-token",
      },
      payload: { kind: "API_TOKEN" },
    });
    expect(crossRevocation.statusCode).toBe(409);
    expect(crossRevocation.json()).toMatchObject({
      code: "CREDENTIAL_CROSS_SCOPE_REVOKE_DENIED",
    });
    const crossState = await db.pool.query<{ revoked_at: Date | null }>(
      "select revoked_at from api_tokens where id=$1",
      [crossCredentialId],
    );
    expect(crossState.rows[0]?.revoked_at).toBeNull();

    const deniedAgentRevocation = await app.inject({
      method: "POST",
      url: `/v1/operator/team/credentials/${crossAgentCredentialId}/revoke`,
      headers: {
        ...headers,
        "idempotency-key": "team-revoke-cross-agent-credential",
      },
      payload: { kind: "PRINCIPAL_CREDENTIAL" },
    });
    expect(deniedAgentRevocation.statusCode).toBe(409);
    expect(deniedAgentRevocation.json()).toMatchObject({
      code: "CREDENTIAL_CROSS_SCOPE_REVOKE_DENIED",
    });
    const crossAgentState = await db.pool.query<{ state: string }>(
      "select state from principals where id=$1",
      [crossAgentPrincipalId],
    );
    expect(crossAgentState.rows[0]?.state).toBe("ACTIVE");

    const agentRevocation = await app.inject({
      method: "POST",
      url: `/v1/operator/team/credentials/${agentCredentialId}/revoke`,
      headers: {
        ...headers,
        "idempotency-key": "team-revoke-agent-credential",
      },
      payload: { kind: "PRINCIPAL_CREDENTIAL" },
    });
    expect(agentRevocation.statusCode, agentRevocation.body).toBe(200);
    expect(agentRevocation.json()).toMatchObject({
      revoked: true,
      principal: {
        id: agentPrincipalId,
        state: "REVOKED",
      },
    });
    const principalState = await db.pool.query<{
      state: string;
      revoked_at: Date | null;
    }>("select state,revoked_at from principals where id=$1", [
      agentPrincipalId,
    ]);
    expect(principalState.rows[0]).toMatchObject({
      state: "REVOKED",
    });
    expect(principalState.rows[0]?.revoked_at).toBeTruthy();
  });
});
