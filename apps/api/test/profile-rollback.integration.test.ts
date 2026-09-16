import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import {
  Postgres,
  activateKnowledgeProfile,
  createKnowledgeProfileDraft,
  recordKnowledgeProfileDryRun,
  registerVault,
} from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const token = `profile-rollback-api-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };
const emptyFingerprint = createHash("sha256").update("").digest("hex");

let app: FastifyInstance;
let db: Postgres;
let vaultId: string;

function profileMaterial(profile: unknown) {
  const parsed = KnowledgeProfileV1.parse(profile);
  const canonicalProfile = canonicalKnowledgeProfileJson(parsed);
  return {
    parsed,
    canonicalProfile,
    profileHash: createHash("sha256").update(canonicalProfile).digest("hex"),
  };
}

async function createValidatedRevision(
  profile: unknown,
  supersedesRevisionId: string | null,
) {
  const candidate = profileMaterial(profile);
  const revision = await createKnowledgeProfileDraft(db, {
    spaceId,
    vaultId,
    profileId: candidate.parsed.profileId,
    version: candidate.parsed.version,
    canonicalProfile: candidate.canonicalProfile,
    profileHash: candidate.profileHash,
    supersedesRevisionId,
    createdBy: adminId,
  });
  const dryRun = await recordKnowledgeProfileDryRun(db, {
    spaceId,
    vaultId,
    revisionId: revision.id,
    actorId: adminId,
    expectedCorpusRevision: "profile-rollback-api-r1",
    compatibilityClass: "NON_BREAKING",
    affectedDocumentCount: 0,
    report: { currentProfile: { revisionId: supersedesRevisionId } },
    corpusFingerprintBefore: emptyFingerprint,
    corpusFingerprintAfter: emptyFingerprint,
  });
  return { candidate, revision: dryRun.revision, dryRunId: dryRun.id };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'P1 profile rollback API',$3::jsonb)`,
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
      vaultKey: `profile-rollback-api-${randomUUID().slice(0, 8)}`,
      name: "P1 profile rollback API vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `profile-rollback-api-${randomUUID()}`),
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
    "update vaults set current_revision='profile-rollback-api-r1' where id=$1",
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

describe("KnowledgeProfile rollback API", () => {
  it("revalidates the historical profile through dry-run before restoring it", async () => {
    const baseline = await createValidatedRevision(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
      null,
    );
    await activateKnowledgeProfile(db, {
      spaceId,
      vaultId,
      revisionId: baseline.revision.id,
      dryRunId: baseline.dryRunId,
      expectedProfileHash: baseline.candidate.profileHash,
      expectedCorpusRevision: "profile-rollback-api-r1",
      actorId: adminId,
      traceId: "profile-rollback-api-baseline",
    });

    const successor = await createValidatedRevision(
      {
        ...DEFAULT_KNOWLEDGE_PROFILE_V1,
        version: "0.4-profile-rollback-api-successor",
        displayName: "P1 profile rollback API successor",
      },
      baseline.revision.id,
    );
    await activateKnowledgeProfile(db, {
      spaceId,
      vaultId,
      revisionId: successor.revision.id,
      dryRunId: successor.dryRunId,
      expectedProfileHash: successor.candidate.profileHash,
      expectedCorpusRevision: "profile-rollback-api-r1",
      actorId: adminId,
      traceId: "profile-rollback-api-successor",
    });

    const dryRunResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: {
        spaceId,
        vaultId,
        profile: DEFAULT_KNOWLEDGE_PROFILE_V1,
      },
    });
    expect(dryRunResponse.statusCode).toBe(200);
    const rollbackEvidence = dryRunResponse.json<{
      id: string;
      profileRevisionId: string;
      profileRevisionStatus: string;
      compatibilityClass: string;
      currentProfile: { revisionId: string | null };
    }>();
    expect(rollbackEvidence.profileRevisionId).toBe(baseline.revision.id);
    expect(rollbackEvidence.profileRevisionStatus).toBe("SUPERSEDED");
    expect(rollbackEvidence.compatibilityClass).toBe("NON_BREAKING");
    expect(rollbackEvidence.currentProfile.revisionId).toBe(
      successor.revision.id,
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/rollback",
      headers,
      payload: {
        spaceId,
        vaultId,
        targetRevisionId: baseline.revision.id,
        dryRunId: rollbackEvidence.id,
        expectedProfileHash: baseline.candidate.profileHash,
        expectedCorpusRevision: "profile-rollback-api-r1",
        expectedActiveRevisionId: successor.revision.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profileRevisionId: baseline.revision.id,
      status: "ACTIVE",
      rolledBackFromRevisionId: successor.revision.id,
      alreadyActive: false,
    });
  });
});
