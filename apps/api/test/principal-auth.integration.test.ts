import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Postgres, grantVaultMembership } from "@akp/postgres";
import { buildServer } from "../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

run("P2 principal identity", () => {
  const db = new Postgres(databaseUrl!);
  const app = buildServer();
  const humanToken = `principal-human-${randomUUID()}`;
  const humanHeaders = { authorization: `Bearer ${humanToken}` };
  const orgId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  const siblingVaultId = randomUUID();
  let sessionId = "";

  beforeAll(async () => {
    await app.ready();
    await db.pool.query(
      `insert into organizations(id,slug,name) values($1,$2,$3)`,
      [orgId, `principal-${orgId}`, "Principal fixture"],
    );
    await db.pool.query(
      `insert into users(id,email,display_name) values($1,$2,$3)`,
      [userId, `principal-${userId}@example.test`, "Principal Human"],
    );
    await db.pool.query(
      `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
       values($1,$2,$3,$4,'TEAM','')`,
      [spaceId, orgId, `principal-${spaceId}`, "Principal space"],
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
        `/tmp/principal-${vaultId}`,
        "Principal vault",
        `principal-${vaultId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `insert into vaults(id,space_id,canonical_path,name,vault_key,local_path,read_only,visibility,enabled)
       values($1,$2,$3,$4,$5,$3,true,'TEAM',true)`,
      [
        siblingVaultId,
        spaceId,
        `/tmp/principal-sibling-${siblingVaultId}`,
        "Principal sibling vault",
        `principal-sibling-${siblingVaultId.slice(0, 8)}`,
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
    await grantVaultMembership(db, {
      userId,
      vaultId: siblingVaultId,
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
        "principal human",
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
    await db.pool.query(
      "update vaults set enabled=false where id=any($1::uuid[])",
      [[vaultId, siblingVaultId]],
    );
    await db.close();
  });

  it("issues a session-bound agent principal with narrowed authority and revocable identity", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: humanHeaders,
      payload: {
        purpose: "Principal-bound workspace",
        contextBudget: 2048,
        spaceId,
        vaultId,
      },
    });
    expect(created.statusCode).toBe(201);
    sessionId = String(created.json().id);

    const other = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: humanHeaders,
      payload: {
        purpose: "Other parent workspace",
        contextBudget: 2048,
        spaceId,
        vaultId,
      },
    });
    expect(other.statusCode).toBe(201);
    const otherSessionId = String(other.json().id);

    const issued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/agent-processes`,
      headers: {
        ...humanHeaders,
        "idempotency-key": "agent-secret-must-not-be-journaled",
      },
      payload: {
        label: "Compiler worker",
        allowedActions: [
          "workspace:read",
          "workspace:claim",
          "workspace:handoff",
          "workspace:event:append",
          "knowledge:read",
          "knowledge:propose",
        ],
      },
    });
    expect(issued.statusCode).toBe(201);
    const issuance = issued.json() as {
      token: string;
      principal: {
        id: string;
        kind: string;
        parentPrincipalId: string;
        sessionId: string;
        vaultId: string;
        policyRevision: number;
        allowedActions: string[];
      };
    };
    expect(issuance.token.length).toBeGreaterThan(30);
    expect(issuance.principal).toMatchObject({
      kind: "AGENT_PROCESS",
      sessionId,
      vaultId,
      policyRevision: 1,
    });
    expect(issuance.principal.allowedActions).not.toContain("workspace:create");
    expect(issuance.principal.allowedActions).not.toContain(
      "workspace:manage-participants",
    );

    const humanPrincipal = await db.pool.query<{ id: string }>(
      "select id from principals where kind='HUMAN' and user_id=$1",
      [userId],
    );
    expect(issuance.principal.parentPrincipalId).toBe(
      humanPrincipal.rows[0]?.id,
    );

    const durableCredential = await db.pool.query<{
      token_hash: string;
      scopes: { spaces?: Array<{ permissions?: string[] }> };
    }>(
      "select token_hash,scopes from principal_credentials where principal_id=$1",
      [issuance.principal.id],
    );
    expect(durableCredential.rows[0]?.token_hash).toBe(
      tokenHash(issuance.token),
    );
    expect(durableCredential.rows[0]?.token_hash).not.toBe(issuance.token);
    expect(
      durableCredential.rows[0]?.scopes.spaces?.flatMap(
        (scope) => scope.permissions ?? [],
      ),
    ).not.toEqual(expect.arrayContaining(["knowledge:review", "admin"]));
    const idempotencyLeak = await db.pool.query(
      `select 1 from idempotency_records
        where operation like '%/agent-processes%'`,
    );
    expect(idempotencyLeak.rowCount).toBe(0);

    const agentHeaders = { authorization: `Bearer ${issuance.token}` };
    const identity = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: agentHeaders,
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toMatchObject({
      actor: {
        id: userId,
        authenticationKind: "PRINCIPAL_TOKEN",
        principalId: issuance.principal.id,
        principalKind: "AGENT_PROCESS",
        parentPrincipalId: issuance.principal.parentPrincipalId,
        principalSessionId: sessionId,
        principalVaultId: vaultId,
      },
    });

    const ownState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: agentHeaders,
    });
    expect(ownState.statusCode).toBe(200);
    const otherState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${otherSessionId}/state`,
      headers: agentHeaders,
    });
    expect(otherState.statusCode).toBe(404);

    const crossVaultSearch = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: agentHeaders,
      payload: {
        query: "cross vault escape",
        spaceId,
        vaultId: siblingVaultId,
      },
    });
    expect(crossVaultSearch.statusCode).toBe(403);
    expect(crossVaultSearch.json()).toMatchObject({
      code: "PRINCIPAL_VAULT_SCOPE_DENIED",
    });

    const ambientReadDenied = await app.inject({
      method: "GET",
      url: "/v1/indexes",
      headers: agentHeaders,
    });
    expect(ambientReadDenied.statusCode).toBe(403);
    expect(ambientReadDenied.json()).toMatchObject({
      code: "PRINCIPAL_ROUTE_DENIED",
    });

    const crossVaultProposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: agentHeaders,
      payload: {
        spaceId,
        vaultId: siblingVaultId,
        summary: "must remain outside sibling vault",
        changes: [
          {
            path: "agent-scope-proof.md",
            content:
              "---\nid: AGENT-SCOPE-PROOF\ntitle: Agent scope proof\ntype: note\n---\nDenied cross-vault proposal.\n",
          },
        ],
      },
    });
    expect(crossVaultProposal.statusCode).toBe(403);
    expect(crossVaultProposal.json()).toMatchObject({
      code: "PRINCIPAL_VAULT_SCOPE_DENIED",
    });

    const createDenied = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: agentHeaders,
      payload: {
        purpose: "Escaped agent workspace",
        contextBudget: 1024,
        spaceId,
        vaultId,
      },
    });
    expect(createDenied.statusCode).toBe(403);
    expect(createDenied.json()).toMatchObject({
      code: "PRINCIPAL_ROUTE_DENIED",
    });

    const participantsDenied = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/participants`,
      headers: agentHeaders,
      payload: { userId },
    });
    expect(participantsDenied.statusCode).toBe(403);
    expect(participantsDenied.json()).toMatchObject({
      code: "PRINCIPAL_ROUTE_DENIED",
    });

    const webEscalation = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: agentHeaders,
      payload: {},
    });
    expect(webEscalation.statusCode).toBe(403);
    expect(webEscalation.json()).toMatchObject({
      code: "PRINCIPAL_WEB_SESSION_DENIED",
    });

    const claim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: agentHeaders,
      payload: { workKey: "agent:compiler", leaseSeconds: 120 },
    });
    expect(claim.statusCode).toBe(201);
    const audit = await db.pool.query<{
      actor_id: string;
      principal_id: string;
    }>(
      `select actor_id,principal_id from audit_events
        where action='workspace.claim.acquire'
        order by id desc limit 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      actor_id: userId,
      principal_id: issuance.principal.id,
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/agent-processes/${issuance.principal.id}/revoke`,
      headers: humanHeaders,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      principal: {
        id: issuance.principal.id,
        state: "REVOKED",
        policyRevision: 2,
      },
    });

    const afterRevocation = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: agentHeaders,
    });
    expect(afterRevocation.statusCode).toBe(401);
    expect(afterRevocation.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });
});
