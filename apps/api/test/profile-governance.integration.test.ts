import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_PROFILE_V1 } from "@akp/contracts/knowledge-profile";
import { Postgres, registerVault } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const token = `profile-governance-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let vaultId: string;
let candidateRevisionId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'Profile governance integration',$3::jsonb)`,
    [
      adminId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "admin"],
          },
        ],
      }),
    ],
  );
  const vault = await registerVault(
    db,
    {
      vaultKey: `profile-govern-${randomUUID().slice(0, 8)}`,
      name: "Profile governance vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `profile-govern-${randomUUID()}`),
      contentRoots: ["."],
      sourceRoots: [],
      schemaProfile: {},
      evalPack: {
        name: "generic",
        version: "1",
        enabled: true,
        criticalCases: [],
      },
      retrievalConfig: {},
      permissions: {},
      enabled: true,
    },
    { ownerUserId: adminId },
  );
  vaultId = vault.id;
  await db.pool.query(
    "update vaults set current_revision='profile-govern-r1' where id=$1",
    [vaultId],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query(
    "update vaults set active_knowledge_profile_revision_id=null where id=$1",
    [vaultId],
  );
  await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
  await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [vaultId]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [
    tokenHash,
  ]);
  await db.close();
});

describe("KnowledgeProfile governance surfaces", () => {
  it("validates a profile without persisting a revision", async () => {
    const before = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    const candidate = {
      ...DEFAULT_KNOWLEDGE_PROFILE_V1,
      version: "0.4-governance-validate",
      displayName: "Governance validation profile",
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/profiles/validate",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      valid: true,
      profileId: "default",
      version: "0.4-governance-validate",
    });
    const after = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("rejects malformed profile references during validation", async () => {
    const invalid = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    invalid.knowledgeKinds.rule.lifecycle = "missing-lifecycle";
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/profiles/validate",
      headers,
      payload: { spaceId, vaultId, profile: invalid },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_KNOWLEDGE_PROFILE",
    });
  });

  it("lists and gets durable revisions with latest impact evidence", async () => {
    const candidate = {
      ...DEFAULT_KNOWLEDGE_PROFILE_V1,
      version: "0.4-governance-list",
      displayName: "Governance list profile",
    };
    const dryRun = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(dryRun.statusCode).toBe(200);
    candidateRevisionId = dryRun.json<{ profileRevisionId: string }>()
      .profileRevisionId;

    const query = new URLSearchParams({ spaceId, vaultId }).toString();
    const listed = await app.inject({
      method: "GET",
      url: `/v1/schema/profiles?${query}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json<{
      active: { source: string; version: string };
      revisions: Array<Record<string, unknown>>;
    }>();
    expect(listedBody.active).toMatchObject({
      source: "V03_DEFAULT",
      version: "0.3-compat",
    });
    expect(listedBody.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: candidateRevisionId,
          version: "0.4-governance-list",
          status: "VALIDATED",
          latest_dry_run_id: expect.any(String),
          affected_document_count: 0,
        }),
      ]),
    );

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/schema/profiles/${candidateRevisionId}?${query}`,
      headers,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      id: candidateRevisionId,
      profileId: "default",
      version: "0.4-governance-list",
      active: false,
      latestDryRun: {
        affected_document_count: 0,
        compatibility_class: "NON_BREAKING",
      },
    });
  });

  it("diffs a durable candidate without creating another revision", async () => {
    const before = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/profiles/diff",
      headers,
      payload: {
        spaceId,
        vaultId,
        candidateRevisionId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      compatibilityClass: "NON_BREAKING",
      usageAware: false,
      candidate: { revisionId: candidateRevisionId },
    });
    const after = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
