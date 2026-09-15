import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import {
  Postgres,
  createKnowledgeProfileDraft,
  resolveEffectiveKnowledgeProfile,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = "00000000-0000-0000-0000-000000000002";

async function createVault(
  db: Postgres,
  marker: string,
): Promise<{ id: string; vaultKey: string }> {
  const vaultKey = `profile-test-${randomUUID()}`;
  const result = await db.pool.query<{ id: string }>(
    `
    insert into vaults(
      space_id,canonical_path,name,read_only,vault_key,git_repository,
      default_branch,local_path,content_roots,source_roots,schema_profile,
      eval_pack,retrieval_config,permissions,enabled,visibility,current_revision
    ) values(
      $1,$2,$3,true,$4,null,'main',$2,array['.']::text[],array[]::text[],
      $5::jsonb,'{"name":"generic","version":"1","enabled":true,"criticalCases":[]}'::jsonb,
      '{}'::jsonb,'{}'::jsonb,true,'PRIVATE','profile-test-corpus'
    ) returning id
    `,
    [spaceId, `/tmp/${vaultKey}`, vaultKey, vaultKey, JSON.stringify({ marker })],
  );
  return { id: String(result.rows[0]?.id), vaultKey };
}

describe("knowledge profile registry integration", () => {
  it.skipIf(!databaseUrl)(
    "persists immutable canonical drafts without replacing v0.3 fallback semantics",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const firstVault = await createVault(db, "legacy-a");
      const secondVault = await createVault(db, "legacy-b");
      try {
        const fallback = await resolveEffectiveKnowledgeProfile(
          db,
          spaceId,
          firstVault.id,
        );
        expect(fallback.source).toBe("V03_DEFAULT");
        expect(fallback.revisionId).toBeNull();
        expect(fallback.profile.profileId).toBe("default");
        expect(fallback.profile.version).toBe("0.3-compat");
        expect(fallback.legacySchemaProfile).toEqual({ marker: "legacy-a" });

        const firstDraft = await createKnowledgeProfileDraft(db, {
          spaceId,
          vaultId: firstVault.id,
          profile: DEFAULT_KNOWLEDGE_PROFILE_V1,
          createdBy: actorId,
        });
        expect(firstDraft.status).toBe("DRAFT");
        expect(firstDraft.compatibilityClass).toBeNull();
        expect(firstDraft.corpusRevision).toBe("profile-test-corpus");
        expect(firstDraft.canonicalProfile).toBe(
          canonicalKnowledgeProfileJson(DEFAULT_KNOWLEDGE_PROFILE_V1),
        );

        const reordered = {
          ...DEFAULT_KNOWLEDGE_PROFILE_V1,
          knowledgeKinds: Object.fromEntries(
            Object.entries(DEFAULT_KNOWLEDGE_PROFILE_V1.knowledgeKinds).reverse(),
          ),
        };
        const duplicate = await createKnowledgeProfileDraft(db, {
          spaceId,
          vaultId: firstVault.id,
          profile: reordered,
          createdBy: actorId,
        });
        expect(duplicate.id).toBe(firstDraft.id);
        expect(duplicate.profileHash).toBe(firstDraft.profileHash);

        const nextProfile = {
          ...DEFAULT_KNOWLEDGE_PROFILE_V1,
          version: "0.3-compat-next",
        };
        const successor = await createKnowledgeProfileDraft(db, {
          spaceId,
          vaultId: firstVault.id,
          profile: nextProfile,
          supersedesRevisionId: firstDraft.id,
          createdBy: actorId,
        });
        expect(successor.id).not.toBe(firstDraft.id);
        expect(successor.supersedesRevisionId).toBe(firstDraft.id);

        await expect(
          db.pool.query(
            "update knowledge_profile_revisions set version='mutated' where id=$1",
            [firstDraft.id],
          ),
        ).rejects.toThrow("KNOWLEDGE_PROFILE_REVISION_IMMUTABLE");

        const stillFallback = await resolveEffectiveKnowledgeProfile(
          db,
          spaceId,
          firstVault.id,
        );
        expect(stillFallback.source).toBe("V03_DEFAULT");
        expect(stillFallback.revisionId).toBeNull();

        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=$1 where id=$2",
          [firstDraft.id, firstVault.id],
        );
        await expect(
          resolveEffectiveKnowledgeProfile(db, spaceId, firstVault.id),
        ).rejects.toThrow("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID");
        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=null where id=$1",
          [firstVault.id],
        );

        await expect(
          db.pool.query(
            "update vaults set active_knowledge_profile_revision_id=$1 where id=$2",
            [firstDraft.id, secondVault.id],
          ),
        ).rejects.toThrow();

        await expect(
          createKnowledgeProfileDraft(db, {
            spaceId: randomUUID(),
            vaultId: firstVault.id,
            profile: DEFAULT_KNOWLEDGE_PROFILE_V1,
            createdBy: actorId,
          }),
        ).rejects.toThrow("VAULT_NOT_FOUND_OR_SCOPE_MISMATCH");
      } finally {
        await db.pool.query(
          "update vaults set active_knowledge_profile_revision_id=null where id=any($1::uuid[])",
          [[firstVault.id, secondVault.id]],
        );
        await db.pool.query("delete from vaults where id=any($1::uuid[])", [
          [firstVault.id, secondVault.id],
        ]);
        await db.close();
      }
    },
  );
});
