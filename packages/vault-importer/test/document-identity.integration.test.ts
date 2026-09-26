import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { importVaultReadOnly } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

function note(id: string, title: string, body: string): string {
  return [
    "---",
    `id: ${id}`,
    "type: claim",
    "layer: claim",
    "status: active",
    "---",
    `# ${title}`,
    "",
    body,
  ].join("\n");
}

integration("vault document identity integration", () => {
  it("preserves document identity, history and non-derived relations across a path rename", async () => {
    if (!databaseUrl) return;
    const db = new Postgres(databaseUrl);
    const organizationId = randomUUID();
    const spaceId = randomUUID();
    const vaultKey = `identity-${randomUUID().slice(0, 8)}`;
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-vault-identity-"));
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVector = process.env.AKP_VECTOR_ENABLED;
    const previousProvider = process.env.AKP_EMBEDDING_PROVIDER;
    let vaultId: string | undefined;

    try {
      process.env.NODE_ENV = "test";
      process.env.AKP_VECTOR_ENABLED = "false";
      delete process.env.AKP_EMBEDDING_PROVIDER;

      await db.pool.query(
        "insert into organizations(id,slug,name) values($1,$2,$3)",
        [organizationId, `identity-${organizationId.slice(0, 8)}`, "Identity test"],
      );
      await db.pool.query(
        "insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path) values($1,$2,$3,$4,'PRIVATE','')",
        [spaceId, organizationId, `identity-${spaceId.slice(0, 8)}`, "Identity test"],
      );

      const anchorPath = path.join(fixtureRoot, "anchor.md");
      const originalPath = path.join(fixtureRoot, "original.md");
      const movedPath = path.join(fixtureRoot, "moved.md");
      await writeFile(
        anchorPath,
        note("CLM-IDENTITY-ANCHOR", "Anchor", "Stable relation source."),
        "utf8",
      );
      await writeFile(
        originalPath,
        note(
          "CLM-IDENTITY-TARGET",
          "Target before move",
          "The same logical document will move to another path.",
        ),
        "utf8",
      );

      const first = await importVaultReadOnly(db, fixtureRoot, {
        spaceId,
        vaultKey,
      });
      vaultId = first.vaultId;
      const before = await db.pool.query<{
        id: string;
        path: string;
      }>(
        "select id,path from knowledge_documents where vault_id=$1 and external_id='CLM-IDENTITY-TARGET'",
        [vaultId],
      );
      const anchor = await db.pool.query<{ id: string }>(
        "select id from knowledge_documents where vault_id=$1 and external_id='CLM-IDENTITY-ANCHOR'",
        [vaultId],
      );
      const targetId = before.rows[0]?.id;
      const anchorId = anchor.rows[0]?.id;
      expect(targetId).toBeTruthy();
      expect(anchorId).toBeTruthy();

      await db.pool.query(
        "insert into knowledge_relations(space_id,from_document_id,to_document_id,relation_type,provenance,metadata) values($1,$2,$3,'related_to','identity-regression','{}'::jsonb)",
        [spaceId, anchorId, targetId],
      );

      await rename(originalPath, movedPath);
      await writeFile(
        movedPath,
        note(
          "CLM-IDENTITY-TARGET",
          "Target after move",
          "The logical identity and its prior history must survive this rename.",
        ),
        "utf8",
      );

      await expect(
        importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey }),
      ).resolves.toMatchObject({ vaultId });

      const after = await db.pool.query<{
        id: string;
        path: string;
        lifecycle: string;
      }>(
        "select id,path,lifecycle from knowledge_documents where vault_id=$1 and external_id='CLM-IDENTITY-TARGET'",
        [vaultId],
      );
      expect(after.rows).toEqual([
        {
          id: targetId,
          path: "moved.md",
          lifecycle: "ACTIVE",
        },
      ]);

      const oldPath = await db.pool.query<{ count: number }>(
        "select count(*)::int count from knowledge_documents where vault_id=$1 and path='original.md'",
        [vaultId],
      );
      expect(oldPath.rows[0]?.count).toBe(0);

      const versions = await db.pool.query<{ count: number }>(
        "select count(*)::int count from knowledge_versions where document_id=$1",
        [targetId],
      );
      expect(versions.rows[0]?.count).toBeGreaterThanOrEqual(2);

      const relation = await db.pool.query<{ count: number }>(
        "select count(*)::int count from knowledge_relations where from_document_id=$1 and to_document_id=$2 and provenance='identity-regression'",
        [anchorId, targetId],
      );
      expect(relation.rows[0]?.count).toBe(1);
    } finally {
      if (vaultId) {
        await db.pool.query(
          "delete from knowledge_relations where space_id=$1 and (from_document_id in (select id from knowledge_documents where vault_id=$2) or to_document_id in (select id from knowledge_documents where vault_id=$2))",
          [spaceId, vaultId],
        );
        await db.pool.query(
          "delete from knowledge_versions where document_id in (select id from knowledge_documents where vault_id=$1)",
          [vaultId],
        );
        await db.pool.query(
          "delete from unit_embeddings where generation_id in (select id from embedding_generations where vault_id=$1)",
          [vaultId],
        );
        await db.pool.query("delete from knowledge_units where vault_id=$1", [vaultId]);
        await db.pool.query("delete from knowledge_documents where vault_id=$1", [vaultId]);
        await db.pool.query("delete from vault_import_runs where vault_id=$1", [vaultId]);
        await db.pool.query("delete from vault_index_revisions where vault_id=$1", [vaultId]);
        await db.pool.query("delete from embedding_generations where vault_id=$1", [vaultId]);
        await db.pool.query("delete from vaults where id=$1", [vaultId]);
      }
      await db.pool.query("delete from index_revisions where space_id=$1", [spaceId]);
      await db.pool.query("delete from spaces where id=$1", [spaceId]);
      await db.pool.query("delete from organizations where id=$1", [organizationId]);
      await db.close();
      await rm(fixtureRoot, { recursive: true, force: true });
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVector === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previousVector;
      if (previousProvider === undefined) delete process.env.AKP_EMBEDDING_PROVIDER;
      else process.env.AKP_EMBEDDING_PROVIDER = previousProvider;
    }
  }, 30_000);
});
