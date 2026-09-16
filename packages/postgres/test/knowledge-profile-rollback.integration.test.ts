import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  rollbackKnowledgeProfile,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = "00000000-0000-0000-0000-000000000002";
const emptyFingerprint = createHash("sha256").update("").digest("hex");

function material(profile: unknown) {
  const parsed = KnowledgeProfileV1.parse(profile);
  const canonicalProfile = canonicalKnowledgeProfileJson(parsed);
  return {
    parsed,
    canonicalProfile,
    profileHash: createHash("sha256").update(canonicalProfile).digest("hex"),
  };
}

async function createVault(db: Postgres): Promise<string> {
  const marker = randomUUID();
  const result = await db.pool.query<{ id: string }>(
    `
    insert into vaults(
      space_id,canonical_path,name,read_only,vault_key,git_repository,
      default_branch,local_path,content_roots,source_roots,schema_profile,
      eval_pack,retrieval_config,permissions,enabled,visibility,current_revision
    ) values(
      $1,$2,$3,true,$3,null,'main',$2,array['.']::text[],array[]::text[],
      '{}'::jsonb,'{"name":"generic","version":"1","enabled":true,"criticalCases":[]}'::jsonb,
      '{}'::jsonb,'{}'::jsonb,true,'PRIVATE','rollback-r1'
    ) returning id
    `,
    [spaceId, `/tmp/profile-rollback-${marker}`, `profile-rollback-${marker}`],
  );
  return String(result.rows[0]?.id);
}

async function draftAndValidate(
  db: Postgres,
  vaultId: string,
  profile: unknown,
  supersedesRevisionId: string | null,
) {
  const candidate = material(profile);
  const revision = await createKnowledgeProfileDraft(db, {
    spaceId,
    vaultId,
    profileId: candidate.parsed.profileId,
    version: candidate.parsed.version,
    canonicalProfile: candidate.canonicalProfile,
    profileHash: candidate.profileHash,
    supersedesRevisionId,
    createdBy: actorId,
  });
  const dryRun = await recordKnowledgeProfileDryRun(db, {
    spaceId,
    vaultId,
    revisionId: revision.id,
    actorId,
    expectedCorpusRevision: "rollback-r1",
    compatibilityClass: "NON_BREAKING",
    affectedDocumentCount: 0,
    report: {
      currentProfile: { revisionId: supersedesRevisionId },
      compatibilityClass: "NON_BREAKING",
    },
    corpusFingerprintBefore: emptyFingerprint,
    corpusFingerprintAfter: emptyFingerprint,
  });
  return { candidate, revision: dryRun.revision, dryRunId: dryRun.id };
}

describe("knowledge profile rollback integration", () => {
  it.skipIf(!databaseUrl)(
    "revalidates and atomically restores only the immediate superseded predecessor",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const vaultId = await createVault(db);
      try {
        const baseline = await draftAndValidate(
          db,
          vaultId,
          DEFAULT_KNOWLEDGE_PROFILE_V1,
          null,
        );
        await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: baseline.revision.id,
          dryRunId: baseline.dryRunId,
          expectedProfileHash: baseline.candidate.profileHash,
          expectedCorpusRevision: "rollback-r1",
          actorId,
          traceId: "rollback-baseline-activate",
        });

        const successor = await draftAndValidate(
          db,
          vaultId,
          {
            ...DEFAULT_KNOWLEDGE_PROFILE_V1,
            version: "0.4-rollback-successor",
            displayName: "AKP v0.4 rollback successor",
          },
          baseline.revision.id,
        );
        await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: successor.revision.id,
          dryRunId: successor.dryRunId,
          expectedProfileHash: successor.candidate.profileHash,
          expectedCorpusRevision: "rollback-r1",
          actorId,
          traceId: "rollback-successor-activate",
        });

        const rollbackEvidence = await recordKnowledgeProfileDryRun(db, {
          spaceId,
          vaultId,
          revisionId: baseline.revision.id,
          actorId,
          expectedCorpusRevision: "rollback-r1",
          compatibilityClass: "NON_BREAKING",
          affectedDocumentCount: 0,
          report: {
            currentProfile: { revisionId: successor.revision.id },
            candidateProfile: { revisionId: baseline.revision.id },
            compatibilityClass: "NON_BREAKING",
          },
          corpusFingerprintBefore: emptyFingerprint,
          corpusFingerprintAfter: emptyFingerprint,
        });
        expect(rollbackEvidence.revision.status).toBe("SUPERSEDED");

        const rolledBack = await rollbackKnowledgeProfile(db, {
          spaceId,
          vaultId,
          targetRevisionId: baseline.revision.id,
          dryRunId: rollbackEvidence.id,
          expectedProfileHash: baseline.candidate.profileHash,
          expectedCorpusRevision: "rollback-r1",
          expectedActiveRevisionId: successor.revision.id,
          actorId,
          traceId: "rollback-to-baseline",
        });
        expect(rolledBack.alreadyActive).toBe(false);
        expect(rolledBack.rolledBackFromRevisionId).toBe(successor.revision.id);
        expect(rolledBack.revision.id).toBe(baseline.revision.id);
        expect(rolledBack.revision.status).toBe("ACTIVE");

        const statuses = await db.pool.query<{ id: string; status: string }>(
          `select id,status from knowledge_profile_revisions
            where id=any($1::uuid[]) order by id`,
          [[baseline.revision.id, successor.revision.id]],
        );
        expect(new Map(statuses.rows.map((row) => [row.id, row.status]))).toEqual(
          new Map([
            [baseline.revision.id, "ACTIVE"],
            [successor.revision.id, "SUPERSEDED"],
          ]),
        );
        const binding = await db.pool.query<{
          active_knowledge_profile_revision_id: string | null;
        }>("select active_knowledge_profile_revision_id from vaults where id=$1", [
          vaultId,
        ]);
        expect(binding.rows[0]?.active_knowledge_profile_revision_id).toBe(
          baseline.revision.id,
        );

        const repeated = await rollbackKnowledgeProfile(db, {
          spaceId,
          vaultId,
          targetRevisionId: baseline.revision.id,
          dryRunId: rollbackEvidence.id,
          expectedProfileHash: baseline.candidate.profileHash,
          expectedCorpusRevision: "rollback-r1",
          expectedActiveRevisionId: successor.revision.id,
          actorId,
          traceId: "rollback-to-baseline-repeat",
        });
        expect(repeated.alreadyActive).toBe(true);

        const audit = await db.pool.query<{ count: string }>(
          `select count(*)::text count from audit_events
            where vault_id=$1 and action='schema.profile_rollback'`,
          [vaultId],
        );
        expect(Number(audit.rows[0]?.count ?? 0)).toBe(1);
      } finally {
        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=null where id=$1",
          [vaultId],
        );
        await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
        await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from vaults where id=$1", [vaultId]);
        await db.close();
      }
    },
  );
});
