import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { importVaultReadOnly } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("vault importer source occurrence identity", () => {
  let db: Postgres | undefined;
  let fixtureRoot: string | undefined;
  let organizationId = "";
  let spaceId = "";
  let vaultId = "";
  const vaultKey = `occurrence-import-${randomUUID().slice(0, 8)}`;
  const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.AKP_VECTOR_ENABLED = "false";
    db = new Postgres(databaseUrl);
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-import-occurrence-"));
    organizationId = randomUUID();
    spaceId = randomUUID();
    await db.pool.query(
      "insert into organizations(id,slug,name) values($1,$2,$3)",
      [
        organizationId,
        `occurrence-org-${organizationId.slice(0, 8)}`,
        "Importer source occurrence integration",
      ],
    );
    await db.pool.query(
      `insert into spaces(
         id,organization_id,slug,name,visibility,knowledge_repo_path
       ) values($1,$2,$3,$4,'PRIVATE',$5)`,
      [
        spaceId,
        organizationId,
        `occurrence-space-${spaceId.slice(0, 8)}`,
        "Importer source occurrence integration",
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

  it("persists every collision occurrence and reimports by path identity", async () => {
    if (!db || !fixtureRoot) {
      throw new Error("integration fixture was not initialized");
    }

    const sourceDirectory = path.join(fixtureRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });
    const sharedId = "SRC-DUPLICATE-DB-001";
    const sourceDocument = (heading: string, body: string): string =>
      [
        "---",
        `id: ${sharedId}`,
        "type: source-note",
        "status: active",
        "---",
        `# ${heading}`,
        "",
        body,
      ].join("\n");
    await writeFile(
      path.join(sourceDirectory, "first.md"),
      sourceDocument("First source", "The first source body."),
      "utf8",
    );
    await writeFile(
      path.join(sourceDirectory, "second.md"),
      sourceDocument("Second source", "The second source body."),
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "consumer.md"),
      [
        "---",
        "id: CONSUMER-DB-001",
        "type: source-note",
        "status: active",
        "---",
        "# Consumer",
        "",
        `An ambiguous alias [[${sharedId}]] must abstain.`,
        "The exact path [[sources/first]] remains resolvable.",
      ].join("\n"),
      "utf8",
    );

    const imported = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    vaultId = imported.vaultId;
    expect(imported.status).toBe("COMPLETED_WITH_WARNINGS");

    const firstRows = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
      aliases: string[];
      frontmatter: Record<string, unknown>;
    }>(
      `select id,path,external_id,body_cache,aliases,frontmatter
         from knowledge_documents
        where vault_id=$1
        order by path`,
      [vaultId],
    );
    expect(firstRows.rows).toHaveLength(3);
    const collisionRows = firstRows.rows.filter((row) =>
      ["sources/first.md", "sources/second.md"].includes(row.path),
    );
    expect(collisionRows).toHaveLength(2);
    expect(new Set(collisionRows.map((row) => row.external_id)).size).toBe(2);
    expect(collisionRows.map((row) => row.body_cache)).toEqual([
      "The first source body.",
      "The second source body.",
    ]);
    expect(
      collisionRows.every(
        (row) =>
          row.external_id.startsWith("SOURCE-OCCURRENCE-") &&
          row.aliases.includes(sharedId) &&
          (row.frontmatter.__akp_import_identity as Record<string, unknown>)
            ?.declaredId === sharedId,
      ),
    ).toBe(true);

    const issueRows = await db.pool.query<{
      code: string;
      path: string | null;
    }>(
      `select code,path
         from vault_import_issues
        where run_id=$1
        order by code,path`,
      [imported.runId],
    );
    expect(issueRows.rows).toEqual(
      expect.arrayContaining([
        { code: "DUPLICATE_STABLE_ID", path: "sources/second.md" },
      ]),
    );

    const relationRows = await db.pool.query<{
      from_path: string;
      to_path: string;
      target: string;
    }>(
      `select source.path from_path,target.path to_path,r.metadata->>'target' target
         from knowledge_relations r
         join knowledge_documents source on source.id=r.from_document_id
         join knowledge_documents target on target.id=r.to_document_id
        where source.vault_id=$1 and target.vault_id=$1
          and source.path='consumer.md'
          and r.provenance='markdown'`,
      [vaultId],
    );
    expect(relationRows.rows).toEqual([
      {
        from_path: "consumer.md",
        to_path: "sources/first.md",
        target: "sources/first",
      },
    ]);

    const unitRows = await db.pool.query<{ documents: number; units: number }>(
      `select count(distinct u.document_id)::int documents,count(*)::int units
         from knowledge_units u
         join knowledge_documents d on d.id=u.document_id
        where u.vault_id=$1 and d.vault_id=$1`,
      [vaultId],
    );
    expect(unitRows.rows[0]).toMatchObject({ documents: 3 });
    expect(unitRows.rows[0]?.units).toBeGreaterThanOrEqual(3);

    const firstCollisionId = collisionRows.find(
      (row) => row.path === "sources/first.md",
    )?.id;
    const firstCollisionExternalId = collisionRows.find(
      (row) => row.path === "sources/first.md",
    )?.external_id;
    expect(firstCollisionId).toBeDefined();
    expect(firstCollisionExternalId).toBeDefined();

    await writeFile(
      path.join(sourceDirectory, "first.md"),
      sourceDocument(
        "First source updated",
        "The first source body was updated.",
      ),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const reimported = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
    }>(
      `select id,path,external_id,body_cache
         from knowledge_documents
        where vault_id=$1 and path=any($2::text[])
        order by path`,
      [vaultId, ["sources/first.md", "sources/second.md"]],
    );
    expect(reimported.rows).toHaveLength(2);
    expect(reimported.rows).toEqual(
      expect.arrayContaining([
        {
          id: firstCollisionId,
          path: "sources/first.md",
          external_id: firstCollisionExternalId,
          body_cache: "The first source body was updated.",
        },
        expect.objectContaining({
          path: "sources/second.md",
          body_cache: "The second source body.",
        }),
      ]),
    );

    const uniquePath = path.join(fixtureRoot, "unique.md");
    const renamedUniquePath = path.join(fixtureRoot, "unique-renamed.md");
    const uniqueId = "SRC-UNIQUE-RENAME-DB-001";
    const uniqueDocument = (body: string): string =>
      [
        "---",
        `id: ${uniqueId}`,
        "type: source-note",
        "status: active",
        "---",
        "# Unique source",
        "",
        body,
      ].join("\n");
    await writeFile(uniquePath, uniqueDocument("Before rename."), "utf8");
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const uniqueBefore = await db.pool.query<{ id: string; path: string }>(
      `select id,path from knowledge_documents
        where vault_id=$1 and external_id=$2`,
      [vaultId, uniqueId],
    );
    expect(uniqueBefore.rows).toHaveLength(1);
    await rename(uniquePath, renamedUniquePath);
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const uniqueAfter = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
    }>(
      `select id,path,external_id from knowledge_documents
        where vault_id=$1 and external_id=$2`,
      [vaultId, uniqueId],
    );
    expect(uniqueAfter.rows).toEqual([
      {
        id: uniqueBefore.rows[0]!.id,
        path: "unique-renamed.md",
        external_id: uniqueId,
      },
    ]);
  });
});
