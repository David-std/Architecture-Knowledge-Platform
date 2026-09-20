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
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = "00000000-0000-0000-0000-000000000002";
const emptyFingerprint = createHash("sha256").update("").digest("hex");

function profileMaterial(profile: unknown) {
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
      '{}'::jsonb,'{}'::jsonb,true,'PRIVATE','activation-r1'
    ) returning id
    `,
    [
      spaceId,
      `/tmp/profile-activation-${marker}`,
      `profile-activation-${marker}`,
    ],
  );
  return String(result.rows[0]?.id);
}

async function draftAndValidate(
  db: Postgres,
  vaultId: string,
  profile: unknown,
  compatibilityClass: "NON_BREAKING" | "MIGRATION_REQUIRED",
  supersedesRevisionId: string | null = null,
) {
  const material = profileMaterial(profile);
  const draft = await createKnowledgeProfileDraft(db, {
    spaceId,
    vaultId,
    profileId: material.parsed.profileId,
    version: material.parsed.version,
    canonicalProfile: material.canonicalProfile,
    profileHash: material.profileHash,
    supersedesRevisionId,
    createdBy: actorId,
  });
  const dryRun = await recordKnowledgeProfileDryRun(db, {
    spaceId,
    vaultId,
    revisionId: draft.id,
    actorId,
    expectedCorpusRevision: "activation-r1",
    compatibilityClass,
    affectedDocumentCount: 0,
    report: { test: true, compatibilityClass },
    corpusFingerprintBefore: emptyFingerprint,
    corpusFingerprintAfter: emptyFingerprint,
  });
  return { material, draft: dryRun.revision, dryRunId: dryRun.id };
}

describe("knowledge profile activation integration", () => {
  it.skipIf(!databaseUrl)(
    "atomically activates only current non-breaking profile evidence",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const vaultId = await createVault(db);
      try {
        const first = await draftAndValidate(
          db,
          vaultId,
          DEFAULT_KNOWLEDGE_PROFILE_V1,
          "NON_BREAKING",
        );
        await expect(
          activateKnowledgeProfile(db, {
            spaceId,
            vaultId,
            revisionId: first.draft.id,
            dryRunId: first.dryRunId,
            expectedProfileHash: "0".repeat(64),
            expectedCorpusRevision: "activation-r1",
            actorId,
            traceId: "activation-wrong-hash",
          }),
        ).rejects.toThrow("CONTEXT_REVISION_CHANGED");

        const activated = await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: first.draft.id,
          dryRunId: first.dryRunId,
          expectedProfileHash: first.material.profileHash,
          expectedCorpusRevision: "activation-r1",
          actorId,
          traceId: "activation-first",
        });
        expect(activated.revision.status).toBe("ACTIVE");
        expect(activated.previousRevisionId).toBeNull();
        expect(activated.alreadyActive).toBe(false);

        const repeated = await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: first.draft.id,
          dryRunId: first.dryRunId,
          expectedProfileHash: first.material.profileHash,
          expectedCorpusRevision: "activation-r1",
          actorId,
          traceId: "activation-repeat",
        });
        expect(repeated.alreadyActive).toBe(true);
        const firstAuditCount = await db.pool.query<{ count: string }>(
          `
          select count(*)::text count from audit_events
           where vault_id=$1 and action='schema.profile_activate'
          `,
          [vaultId],
        );
        expect(Number(firstAuditCount.rows[0]?.count ?? 0)).toBe(1);

        const successorProfile = {
          ...DEFAULT_KNOWLEDGE_PROFILE_V1,
          version: "0.4-activation-successor",
          displayName: "AKP v0.4 activation successor",
        };
        const successor = await draftAndValidate(
          db,
          vaultId,
          successorProfile,
          "NON_BREAKING",
          first.draft.id,
        );
        const successorActivation = await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: successor.draft.id,
          dryRunId: successor.dryRunId,
          expectedProfileHash: successor.material.profileHash,
          expectedCorpusRevision: "activation-r1",
          actorId,
          traceId: "activation-successor",
        });
        expect(successorActivation.previousRevisionId).toBe(first.draft.id);
        expect(successorActivation.revision.status).toBe("ACTIVE");
        const firstAfter = await db.pool.query<{ status: string }>(
          "select status from knowledge_profile_revisions where id=$1",
          [first.draft.id],
        );
        expect(firstAfter.rows[0]?.status).toBe("SUPERSEDED");

        const breakingProfile = {
          ...DEFAULT_KNOWLEDGE_PROFILE_V1,
          version: "0.4-activation-breaking",
          displayName: "AKP v0.4 breaking profile",
        };
        const breaking = await draftAndValidate(
          db,
          vaultId,
          breakingProfile,
          "MIGRATION_REQUIRED",
          successor.draft.id,
        );
        expect(breaking.draft.status).toBe("REVIEW_REQUIRED");
        await expect(
          activateKnowledgeProfile(db, {
            spaceId,
            vaultId,
            revisionId: breaking.draft.id,
            dryRunId: breaking.dryRunId,
            expectedProfileHash: breaking.material.profileHash,
            expectedCorpusRevision: "activation-r1",
            actorId,
            traceId: "activation-breaking",
          }),
        ).rejects.toThrow("PROFILE_REVIEW_REQUIRED");

        const binding = await db.pool.query<{
          active_knowledge_profile_revision_id: string | null;
        }>(
          "select active_knowledge_profile_revision_id from vaults where id=$1",
          [vaultId],
        );
        expect(binding.rows[0]?.active_knowledge_profile_revision_id).toBe(
          successor.draft.id,
        );

        await db.pool.query(
          "update vaults set current_revision='activation-r2' where id=$1",
          [vaultId],
        );
        await expect(
          activateKnowledgeProfile(db, {
            spaceId,
            vaultId,
            revisionId: successor.draft.id,
            dryRunId: successor.dryRunId,
            expectedProfileHash: successor.material.profileHash,
            expectedCorpusRevision: "activation-r1",
            actorId,
            traceId: "activation-stale-corpus",
          }),
        ).rejects.toThrow("CONTEXT_REVISION_CHANGED");
      } finally {
        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=null where id=$1",
          [vaultId],
        );
        await db.pool.query("delete from audit_events where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from vaults where id=$1", [vaultId]);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "serializes concurrent successor activation without split brain",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const vaultId = await createVault(db);
      try {
        const baseline = await draftAndValidate(
          db,
          vaultId,
          DEFAULT_KNOWLEDGE_PROFILE_V1,
          "NON_BREAKING",
        );
        await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: baseline.draft.id,
          dryRunId: baseline.dryRunId,
          expectedProfileHash: baseline.material.profileHash,
          expectedCorpusRevision: "activation-r1",
          actorId,
          traceId: "activation-concurrent-baseline",
        });

        const successorA = await draftAndValidate(
          db,
          vaultId,
          {
            ...DEFAULT_KNOWLEDGE_PROFILE_V1,
            version: "0.4-concurrent-a",
            displayName: "AKP v0.4 concurrent successor A",
          },
          "NON_BREAKING",
          baseline.draft.id,
        );
        const successorB = await draftAndValidate(
          db,
          vaultId,
          {
            ...DEFAULT_KNOWLEDGE_PROFILE_V1,
            version: "0.4-concurrent-b",
            displayName: "AKP v0.4 concurrent successor B",
          },
          "NON_BREAKING",
          baseline.draft.id,
        );

        const attempts = await Promise.allSettled([
          activateKnowledgeProfile(db, {
            spaceId,
            vaultId,
            revisionId: successorA.draft.id,
            dryRunId: successorA.dryRunId,
            expectedProfileHash: successorA.material.profileHash,
            expectedCorpusRevision: "activation-r1",
            actorId,
            traceId: "activation-concurrent-a",
          }),
          activateKnowledgeProfile(db, {
            spaceId,
            vaultId,
            revisionId: successorB.draft.id,
            dryRunId: successorB.dryRunId,
            expectedProfileHash: successorB.material.profileHash,
            expectedCorpusRevision: "activation-r1",
            actorId,
            traceId: "activation-concurrent-b",
          }),
        ]);
        const fulfilled = attempts.filter(
          (
            attempt,
          ): attempt is PromiseFulfilledResult<
            Awaited<ReturnType<typeof activateKnowledgeProfile>>
          > => attempt.status === "fulfilled",
        );
        const rejected = attempts.filter(
          (attempt): attempt is PromiseRejectedResult =>
            attempt.status === "rejected",
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const winnerId = fulfilled[0]!.value.revision.id;
        const loserId =
          winnerId === successorA.draft.id
            ? successorB.draft.id
            : successorA.draft.id;
        const binding = await db.pool.query<{
          active_knowledge_profile_revision_id: string | null;
        }>(
          "select active_knowledge_profile_revision_id from vaults where id=$1",
          [vaultId],
        );
        expect(binding.rows[0]?.active_knowledge_profile_revision_id).toBe(
          winnerId,
        );

        const statuses = await db.pool.query<{ id: string; status: string }>(
          `
          select id,status from knowledge_profile_revisions
           where id = any($1::uuid[])
          `,
          [[baseline.draft.id, successorA.draft.id, successorB.draft.id]],
        );
        const statusById = new Map(
          statuses.rows.map((row) => [row.id, row.status]),
        );
        expect(statusById.get(baseline.draft.id)).toBe("SUPERSEDED");
        expect(statusById.get(winnerId)).toBe("ACTIVE");
        expect(statusById.get(loserId)).toBe("VALIDATED");
        expect(
          [successorA.draft.id, successorB.draft.id].filter(
            (id) => statusById.get(id) === "ACTIVE",
          ),
        ).toHaveLength(1);

        const auditCount = await db.pool.query<{ count: string }>(
          `
          select count(*)::text count from audit_events
           where vault_id=$1 and action='schema.profile_activate'
          `,
          [vaultId],
        );
        expect(Number(auditCount.rows[0]?.count ?? 0)).toBe(2);
      } finally {
        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=null where id=$1",
          [vaultId],
        );
        await db.pool.query("delete from audit_events where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from vaults where id=$1", [vaultId]);
        await db.close();
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "rolls back profile activation when a late durable side effect fails",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const vaultId = await createVault(db);
      try {
        const baseline = await draftAndValidate(
          db,
          vaultId,
          DEFAULT_KNOWLEDGE_PROFILE_V1,
          "NON_BREAKING",
        );
        await activateKnowledgeProfile(db, {
          spaceId,
          vaultId,
          revisionId: baseline.draft.id,
          dryRunId: baseline.dryRunId,
          expectedProfileHash: baseline.material.profileHash,
          expectedCorpusRevision: "activation-r1",
          actorId,
          traceId: "activation-crash-baseline",
        });

        const successor = await draftAndValidate(
          db,
          vaultId,
          {
            ...DEFAULT_KNOWLEDGE_PROFILE_V1,
            version: "0.4-activation-crash",
            displayName: "AKP v0.4 activation crash fixture",
          },
          "NON_BREAKING",
          baseline.draft.id,
        );

        await db.pool.query(`
          create or replace function akp_test_profile_activation_crash()
          returns trigger language plpgsql as $$
          begin
            if new.action='schema.profile_activate' then
              raise exception 'PROFILE_ACTIVATION_TEST_CRASH';
            end if;
            return new;
          end;
          $$
        `);
        await db.pool.query(`
          create trigger akp_test_profile_activation_crash
          before insert on audit_events
          for each row execute function akp_test_profile_activation_crash()
        `);
        try {
          await expect(
            activateKnowledgeProfile(db, {
              spaceId,
              vaultId,
              revisionId: successor.draft.id,
              dryRunId: successor.dryRunId,
              expectedProfileHash: successor.material.profileHash,
              expectedCorpusRevision: "activation-r1",
              actorId,
              traceId: "activation-crash-successor",
            }),
          ).rejects.toThrow("PROFILE_ACTIVATION_TEST_CRASH");
        } finally {
          await db.pool.query(
            "drop trigger if exists akp_test_profile_activation_crash on audit_events",
          );
          await db.pool.query(
            "drop function if exists akp_test_profile_activation_crash()",
          );
        }

        const binding = await db.pool.query<{
          active_knowledge_profile_revision_id: string | null;
        }>(
          "select active_knowledge_profile_revision_id from vaults where id=$1",
          [vaultId],
        );
        expect(binding.rows[0]?.active_knowledge_profile_revision_id).toBe(
          baseline.draft.id,
        );

        const statuses = await db.pool.query<{ id: string; status: string }>(
          `select id,status from knowledge_profile_revisions
            where id=any($1::uuid[])`,
          [[baseline.draft.id, successor.draft.id]],
        );
        const statusById = new Map(
          statuses.rows.map((row) => [row.id, row.status]),
        );
        expect(statusById.get(baseline.draft.id)).toBe("ACTIVE");
        expect(statusById.get(successor.draft.id)).toBe("VALIDATED");

        const auditCount = await db.pool.query<{ count: string }>(
          `select count(*)::text count from audit_events
            where vault_id=$1 and action='schema.profile_activate'`,
          [vaultId],
        );
        expect(Number(auditCount.rows[0]?.count ?? 0)).toBe(1);
      } finally {
        await db.pool
          .query(
            "drop trigger if exists akp_test_profile_activation_crash on audit_events",
          )
          .catch(() => undefined);
        await db.pool
          .query(
            "drop function if exists akp_test_profile_activation_crash()",
          )
          .catch(() => undefined);
        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=null where id=$1",
          [vaultId],
        );
        await db.pool.query("delete from audit_events where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
          vaultId,
        ]);
        await db.pool.query("delete from vaults where id=$1", [vaultId]);
        await db.close();
      }
    },
  );

});
