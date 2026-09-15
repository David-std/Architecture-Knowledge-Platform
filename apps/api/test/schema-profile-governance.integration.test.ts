import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_PROFILE_V1 } from "@akp/contracts/knowledge-profile";
import { Postgres, registerVault } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const token = `profile-admin-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let vaultId: string;
let documentId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'P1 profile governance integration',$3::jsonb)`,
    [
      adminId,
      tokenHash,
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

  const vault = await registerVault(
    db,
    {
      vaultKey: `profile-governance-${randomUUID().slice(0, 8)}`,
      name: "P1 profile governance vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `profile-governance-${randomUUID()}`),
      contentRoots: ["."],
      sourceRoots: [],
      schemaProfile: { legacy: true },
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
    "update vaults set current_revision='profile-api-r1' where id=$1",
    [vaultId],
  );

  documentId = randomUUID();
  await db.pool.query(
    `insert into knowledge_documents(
       id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
       current_revision,body_cache,frontmatter,aliases,layer,raw_links
     ) values(
       $1,$2,$3,'knowledge/claim/profile-test.md','PROFILE-CLAIM-1',
       'Profile migration claim','claim','ACTIVE','HUMAN_REVIEWED','profile-api-r1',
       'Existing claim body',$4::jsonb,'{}','compiled','[]'
     )`,
    [
      documentId,
      spaceId,
      vaultId,
      JSON.stringify({ statement: "Existing claim", scope: "test" }),
    ],
  );

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
  await db.pool.query("delete from schema_dry_runs where vault_id=$1", [vaultId]);
  await db.pool.query("delete from knowledge_documents where id=$1", [documentId]);
  await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [vaultId]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [tokenHash]);
  await db.close();
});

describe("KnowledgeProfile schema governance integration", () => {
  it("classifies a full profile against real corpus usage without activating it", async () => {
    const candidate = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    candidate.version = "0.4-profile-required-owner";
    candidate.knowledgeKinds.claim!.fields.owner = {
      type: "string",
      required: true,
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      id: string;
      profileRevisionId: string;
      profileRevisionStatus: string;
      compatibilityClass: string;
      compatibilityStatus: string;
      affectedDocumentCount: number;
      corpusUsage: { kindCounts: Record<string, number> };
    }>();
    expect(body.compatibilityClass).toBe("MIGRATION_REQUIRED");
    expect(body.compatibilityStatus).toBe("MIGRATION_REQUIRED");
    expect(body.profileRevisionStatus).toBe("REVIEW_REQUIRED");
    expect(body.affectedDocumentCount).toBe(1);
    expect(body.corpusUsage.kindCounts.claim).toBe(1);

    const revision = await db.pool.query<{
      status: string;
      compatibility_class: string;
    }>(
      "select status,compatibility_class from knowledge_profile_revisions where id=$1 and vault_id=$2",
      [body.profileRevisionId, vaultId],
    );
    expect(revision.rows[0]).toEqual({
      status: "REVIEW_REQUIRED",
      compatibility_class: "MIGRATION_REQUIRED",
    });

    const dryRun = await db.pool.query<{
      profile_revision_id: string;
      compatibility_class: string;
    }>(
      "select profile_revision_id,compatibility_class from schema_dry_runs where id=$1 and vault_id=$2",
      [body.id, vaultId],
    );
    expect(dryRun.rows[0]).toEqual({
      profile_revision_id: body.profileRevisionId,
      compatibility_class: "MIGRATION_REQUIRED",
    });

    const binding = await db.pool.query<{
      active_knowledge_profile_revision_id: string | null;
    }>("select active_knowledge_profile_revision_id from vaults where id=$1", [
      vaultId,
    ]);
    expect(binding.rows[0]?.active_knowledge_profile_revision_id).toBeNull();
  });

  it("preserves the legacy dry-run request and response contract", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: {
        spaceId,
        vaultId,
        candidateVersion: "legacy-schema-v2",
        allowedTypes: ["decision"],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      compatibilityStatus: string;
      compatibilityClass: string;
      candidateHash: string;
      affectedDocumentCount: number;
    }>();
    expect(body.compatibilityStatus).toBe("MIGRATION_REQUIRED");
    expect(body.compatibilityClass).toBe("MIGRATION_REQUIRED");
    expect(body.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.affectedDocumentCount).toBe(1);
  });
});
