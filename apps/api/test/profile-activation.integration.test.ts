import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_PROFILE_V1 } from "@akp/contracts/knowledge-profile";
import { Postgres, registerVault } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const token = `profile-activation-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let vaultId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'P1 profile activation integration',$3::jsonb)`,
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
      vaultKey: `profile-activate-${randomUUID().slice(0, 8)}`,
      name: "P1 profile activation vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `profile-activate-${randomUUID()}`),
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
    "update vaults set current_revision='profile-activation-r1' where id=$1",
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
  await db.pool.query("delete from schema_dry_runs where vault_id=$1", [vaultId]);
  await db.pool.query("delete from vaults where id=$1", [vaultId]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [tokenHash]);
  await db.close();
});

describe("KnowledgeProfile activation API integration", () => {
  it("activates only a pinned non-breaking dry-run and is state-idempotent", async () => {
    const candidate = {
      ...DEFAULT_KNOWLEDGE_PROFILE_V1,
      version: "0.4-api-activation",
      displayName: "AKP v0.4 API activation profile",
    };
    const dryRunResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(dryRunResponse.statusCode).toBe(200);
    const dryRun = dryRunResponse.json<{
      id: string;
      profileRevisionId: string;
      profileRevisionStatus: string;
      candidateHash: string;
      compatibilityClass: string;
      corpusRevision: string;
    }>();
    expect(dryRun.profileRevisionStatus).toBe("VALIDATED");
    expect(dryRun.compatibilityClass).toBe("NON_BREAKING");

    const payload = {
      spaceId,
      vaultId,
      profileRevisionId: dryRun.profileRevisionId,
      dryRunId: dryRun.id,
      expectedProfileHash: dryRun.candidateHash,
      expectedCorpusRevision: dryRun.corpusRevision,
    };
    const activationResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/activate",
      headers,
      payload,
    });
    expect(activationResponse.statusCode).toBe(200);
    const activated = activationResponse.json<{
      status: string;
      profileRevisionId: string;
      alreadyActive: boolean;
    }>();
    expect(activated.status).toBe("ACTIVE");
    expect(activated.profileRevisionId).toBe(dryRun.profileRevisionId);
    expect(activated.alreadyActive).toBe(false);

    const repeatedResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/activate",
      headers,
      payload,
    });
    expect(repeatedResponse.statusCode).toBe(200);
    expect(repeatedResponse.json<{ alreadyActive: boolean }>().alreadyActive).toBe(
      true,
    );

    const auditCount = await db.pool.query<{ count: string }>(
      `
      select count(*)::text count from audit_events
       where vault_id=$1 and action='schema.profile_activate'
      `,
      [vaultId],
    );
    expect(Number(auditCount.rows[0]?.count ?? 0)).toBe(1);
  });

  it("refuses to activate a profile whose compatibility requires review", async () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.version = "0.4-api-review-required";
    candidate.retrievalPolicy.progressiveDisclosure = ["L0", "L1"];

    const dryRunResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(dryRunResponse.statusCode).toBe(200);
    const dryRun = dryRunResponse.json<{
      id: string;
      profileRevisionId: string;
      candidateHash: string;
      compatibilityClass: string;
      corpusRevision: string;
    }>();
    expect(dryRun.compatibilityClass).not.toBe("NON_BREAKING");

    const activationResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/activate",
      headers,
      payload: {
        spaceId,
        vaultId,
        profileRevisionId: dryRun.profileRevisionId,
        dryRunId: dryRun.id,
        expectedProfileHash: dryRun.candidateHash,
        expectedCorpusRevision: dryRun.corpusRevision,
      },
    });
    expect(activationResponse.statusCode).toBe(409);
    expect(activationResponse.json<{ code: string }>().code).toBe(
      "PROFILE_REVIEW_REQUIRED",
    );
  });
});
