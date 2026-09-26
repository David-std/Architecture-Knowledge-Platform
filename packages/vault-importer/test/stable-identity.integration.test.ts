import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { importVaultReadOnly } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("vault importer stable document identity", () => {
  let db: Postgres | undefined;
  let fixtureRoot: string | undefined;
  let organizationId = "";
  let spaceId = "";
  let vaultId = "";
  const vaultKey = `identity-import-${randomUUID().slice(0, 8)}`;
  const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.AKP_VECTOR_ENABLED = "false";
    db = new Postgres(databaseUrl);
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-import-identity-"));
    organizationId = randomUUID();
    spaceId = randomUUID();
    await db.pool.query(
      "insert into organizations(id,slug,name) values($1,$2,$3)",
      [
        organizationId,
        `identity-org-${organizationId.slice(0, 8)}`,
        "Importer identity integration",
      ],
    );
    await db.pool.query(
      `insert into spaces(
         id,organization_id,slug,name,visibility,knowledge_repo_path
       ) values($1,$2,$3,$4,'PRIVATE',$5)`,
      [
        spaceId,
        organizationId,
        `identity-space-${spaceId.slice(0, 8)}`,
        "Importer identity integration",
        fixtureRoot,
      ],
    );
  });

  afterAll(async () => {
    try {
      if (db) {
        if (vaultId) {
          await db.pool.query(
            `delete from knowledge_relations
              where from_document_id in (
                select id from knowledge_documents where vault_id=$1
              )
                 or to_document_id in (
                select id from knowledge_documents where vault_id=$1
              )`,
            [vaultId],
          );
          await db.pool.query(
            `delete from knowledge_versions
              where document_id in (
                select id from knowledge_documents where vault_id=$1
              )`,
            [vaultId],
          );
          await db.pool.query(
            `delete from unit_embeddings
              where generation_id in (
                select id from embedding_generations where vault_id=$1
              )`,
            [vaultId],
          );
          await db.pool.query("delete from knowledge_units where vault_id=$1", [
            vaultId,
          ]);
          await db.pool.query(
            "delete from knowledge_documents where vault_id=$1",
            [vaultId],
          );
          await db.pool.query(
            "delete from vault_import_runs where vault_id=$1",
            [vaultId],
          );
          await db.pool.query(
            "delete from vault_index_revisions where vault_id=$1",
            [vaultId],
          );
          await db.pool.query(
            "delete from embedding_generations where vault_id=$1",
            [vaultId],
          );
          await db.pool.query("delete from vaults where id=$1", [vaultId]);
        }
        if (spaceId) {
          await db.pool.query("delete from spaces where id=$1", [spaceId]);
        }
        if (organizationId) {
          await db.pool.query("delete from organizations where id=$1", [
            organizationId,
          ]);
        }
        await db.close();
      }
    } finally {
      if (previousVectorEnabled === undefined) {
        delete process.env.AKP_VECTOR_ENABLED;
      } else {
        process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
      }
      if (fixtureRoot) {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("preserves document_id and history when a Markdown file is renamed", async () => {
    if (!db || !fixtureRoot) {
      throw new Error("integration fixture was not initialized");
    }
    const originalPath = path.join(fixtureRoot, "original-policy.md");
    const renamedPath = path.join(fixtureRoot, "renamed-policy.md");
    const externalId = "RULE-STABLE-RENAME-001";
    const body = [
      "---",
      `id: ${externalId}`,
      "type: rule",
      "layer: rule",
      "status: active",
      "---",
      "# Stable identity policy",
      "",
      "A file rename must preserve the canonical document identity and its version history.",
    ].join("\n");
    await writeFile(originalPath, body, "utf8");

    const first = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    vaultId = first.vaultId;
    const before = await db.pool.query<{
      id: string;
      path: string;
      lifecycle: string;
    }>(
      `select id,path,lifecycle
         from knowledge_documents
        where vault_id=$1 and external_id=$2`,
      [vaultId, externalId],
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({
      path: "original-policy.md",
      lifecycle: "ACTIVE",
    });
    const stableDocumentId = before.rows[0]!.id;

    await rename(originalPath, renamedPath);
    const second = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    expect(second.vaultId).toBe(vaultId);

    const after = await db.pool.query<{
      id: string;
      path: string;
      lifecycle: string;
    }>(
      `select id,path,lifecycle
         from knowledge_documents
        where vault_id=$1 and external_id=$2`,
      [vaultId, externalId],
    );
    expect(after.rows).toEqual([
      {
        id: stableDocumentId,
        path: "renamed-policy.md",
        lifecycle: "ACTIVE",
      },
    ]);

    const history = await db.pool.query<{
      document_ids: number;
      versions: number;
    }>(
      `select count(distinct v.document_id)::int document_ids,
              count(*)::int versions
         from knowledge_versions v
        where v.document_id=$1`,
      [stableDocumentId],
    );
    expect(history.rows[0]?.document_ids).toBe(1);
    expect(history.rows[0]?.versions).toBeGreaterThanOrEqual(2);

    const tombstones = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_documents
        where vault_id=$1 and external_id=$2
          and lifecycle='DELETED_TOMBSTONE'`,
      [vaultId, externalId],
    );
    expect(tombstones.rows[0]?.count).toBe(0);
  });
});
