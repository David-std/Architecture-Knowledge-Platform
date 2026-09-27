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

    const companionPath = path.join(fixtureRoot, "companion.md");
    const companionExternalId = "RULE-STABLE-COMPANION-001";
    await writeFile(
      companionPath,
      [
        "---",
        `id: ${companionExternalId}`,
        "type: rule",
        "layer: rule",
        "status: active",
        "---",
        "# Companion policy",
        "",
        "This policy depends on [[renamed-policy]].",
      ].join("\n"),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });

    const linked = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_relations r
         join knowledge_documents f on f.id=r.from_document_id
         join knowledge_documents t on t.id=r.to_document_id
        where f.vault_id=$1 and t.vault_id=$1
          and f.external_id=$2 and t.external_id=$3
          and r.provenance='markdown'`,
      [vaultId, companionExternalId, externalId],
    );
    expect(linked.rows[0]?.count).toBe(1);

    await rm(renamedPath);
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });

    const deleted = await db.pool.query<{
      id: string;
      lifecycle: string;
      refresh_status: string;
      body_cache: string;
    }>(
      `select id,lifecycle,refresh_status,body_cache
         from knowledge_documents
        where vault_id=$1 and external_id=$2`,
      [vaultId, externalId],
    );
    expect(deleted.rows).toEqual([
      {
        id: stableDocumentId,
        lifecycle: "DELETED_TOMBSTONE",
        refresh_status: "INVALID",
        body_cache: "",
      },
    ]);

    const deletedUnits = await db.pool.query<{
      total: number;
      non_tombstone: number;
    }>(
      `select count(*)::int total,
              count(*) filter (
                where lifecycle <> 'DELETED_TOMBSTONE'
              )::int non_tombstone
         from knowledge_units
        where document_id=$1`,
      [stableDocumentId],
    );
    expect(deletedUnits.rows[0]?.total).toBeGreaterThan(0);
    expect(deletedUnits.rows[0]?.non_tombstone).toBe(0);

    const staleMarkdownEdges = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_relations
        where provenance='markdown'
          and (from_document_id=$1 or to_document_id=$1)`,
      [stableDocumentId],
    );
    expect(staleMarkdownEdges.rows[0]?.count).toBe(0);

    const restoredBody = [
      "---",
      `id: ${externalId}`,
      "type: rule",
      "layer: rule",
      "status: active",
      "---",
      "# Stable identity policy",
      "",
      "A file rename must preserve the canonical document identity and its version history.",
      "",
      "The restored revision remains attached to the same stable identity.",
    ].join("\n");
    await writeFile(renamedPath, restoredBody, "utf8");
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });

    const restored = await db.pool.query<{
      id: string;
      path: string;
      lifecycle: string;
      refresh_status: string;
    }>(
      `select id,path,lifecycle,refresh_status
         from knowledge_documents
        where vault_id=$1 and external_id=$2`,
      [vaultId, externalId],
    );
    expect(restored.rows).toEqual([
      {
        id: stableDocumentId,
        path: "renamed-policy.md",
        lifecycle: "ACTIVE",
        refresh_status: "CURRENT",
      },
    ]);

    const restoredUnits = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_units u
         join knowledge_documents d on d.id=u.document_id
        where u.document_id=$1
          and u.corpus_revision=(
            select corpus_revision
              from vault_index_revisions
             where vault_id=d.vault_id and space_id=d.space_id
          )
          and u.lifecycle='ACTIVE'`,
      [stableDocumentId],
    );
    expect(restoredUnits.rows[0]?.count).toBeGreaterThan(0);

    const rebuiltMarkdownEdge = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_relations r
         join knowledge_documents f on f.id=r.from_document_id
         join knowledge_documents t on t.id=r.to_document_id
        where f.vault_id=$1 and t.vault_id=$1
          and f.external_id=$2 and t.external_id=$3
          and r.provenance='markdown'`,
      [vaultId, companionExternalId, externalId],
    );
    expect(rebuiltMarkdownEdge.rows[0]?.count).toBe(1);

    const restoredHistory = await db.pool.query<{ versions: number }>(
      `select count(*)::int versions
         from knowledge_versions
        where document_id=$1`,
      [stableDocumentId],
    );
    expect(restoredHistory.rows[0]?.versions).toBeGreaterThanOrEqual(4);
  });

  it("fails closed when a stable external identity tries to take another document path", async () => {
    if (!db || !fixtureRoot) {
      throw new Error("integration fixture was not initialized");
    }

    const sourcePath = path.join(fixtureRoot, "identity-source.md");
    const occupiedPath = path.join(fixtureRoot, "identity-occupied.md");
    const sourceExternalId = "RULE-STABLE-CONFLICT-SOURCE-001";
    const occupiedExternalId = "RULE-STABLE-CONFLICT-OCCUPIED-001";
    const sourceBody = [
      "---",
      `id: ${sourceExternalId}`,
      "type: rule",
      "layer: rule",
      "status: active",
      "---",
      "# Conflict source",
      "",
      "This document owns its stable external identity.",
    ].join("\n");
    const occupiedBody = [
      "---",
      `id: ${occupiedExternalId}`,
      "type: rule",
      "layer: rule",
      "status: active",
      "---",
      "# Occupied path",
      "",
      "This document owns the destination path.",
    ].join("\n");

    await writeFile(sourcePath, sourceBody, "utf8");
    await writeFile(occupiedPath, occupiedBody, "utf8");
    const seeded = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    vaultId = seeded.vaultId;

    const before = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
           from knowledge_documents
          where vault_id=$1 and external_id=any($2::text[])
          order by external_id`,
      [vaultId, [sourceExternalId, occupiedExternalId]],
    );
    expect(before.rows).toHaveLength(2);
    const sourceBefore = before.rows.find(
      (row) => row.external_id === sourceExternalId,
    );
    const occupiedBefore = before.rows.find(
      (row) => row.external_id === occupiedExternalId,
    );
    expect(sourceBefore).toBeDefined();
    expect(occupiedBefore).toBeDefined();

    await rm(sourcePath);
    await writeFile(occupiedPath, sourceBody, "utf8");

    await expect(
      importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey }),
    ).rejects.toThrow(
      `VAULT_DOCUMENT_IDENTITY_CONFLICT:identity-occupied.md:${sourceExternalId}`,
    );

    const after = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
           from knowledge_documents
          where vault_id=$1 and external_id=any($2::text[])
          order by external_id`,
      [vaultId, [sourceExternalId, occupiedExternalId]],
    );
    expect(after.rows).toEqual(before.rows);
    expect(sourceBefore?.path).toBe("identity-source.md");
    expect(sourceBefore?.lifecycle).toBe("ACTIVE");
    expect(occupiedBefore?.path).toBe("identity-occupied.md");
    expect(occupiedBefore?.lifecycle).toBe("ACTIVE");
  });
});
