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
          await db.pool.query("delete from index_revisions where space_id=$1", [
            spaceId,
          ]);
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
    const sourceDocumentWithId = (
      id: string,
      heading: string,
      body: string,
    ): string =>
      [
        "---",
        `id: ${id}`,
        "type: source-note",
        "status: active",
        "---",
        `# ${heading}`,
        "",
        body,
      ].join("\n");
    const sourceDocument = (heading: string, body: string): string =>
      sourceDocumentWithId(sharedId, heading, body);
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
      "# First source\n\nThe first source body.",
      "# Second source\n\nThe second source body.",
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
        { code: "AMBIGUOUS_DOCUMENT_REFERENCE", path: "consumer.md" },
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

    const sourceSpanRows = await db.pool.query<{
      path: string;
      body: string;
      locator_path: string | null;
    }>(
      `select d.path,u.body,u.locator->>'path' locator_path
         from knowledge_units u
         join knowledge_documents d on d.id=u.document_id
        where u.vault_id=$1 and d.vault_id=$1
          and d.path=any($2::text[])
          and u.unit_type='PARAGRAPH'
        order by d.path,u.structural_order`,
      [vaultId, ["sources/first.md", "sources/second.md"]],
    );
    expect(sourceSpanRows.rows).toEqual(
      expect.arrayContaining([
        {
          path: "sources/first.md",
          body: "The first source body.",
          locator_path: "sources/first.md",
        },
        {
          path: "sources/second.md",
          body: "The second source body.",
          locator_path: "sources/second.md",
        },
      ]),
    );

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
          body_cache:
            "# First source updated\n\nThe first source body was updated.",
        },
        {
          path: "sources/second.md",
          external_id: expect.any(String),
          id: expect.any(String),
          body_cache: "# Second source\n\nThe second source body.",
        },
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

    const latePathId = "SRC-LATE-PATH-DB-001";
    const latePath = path.join(fixtureRoot, "z-late-source.md");
    const earlyPath = path.join(fixtureRoot, "a-early-source.md");
    await writeFile(
      latePath,
      sourceDocumentWithId(latePathId, "Late source", "The late source body."),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const lateBefore = await db.pool.query<{ id: string; external_id: string }>(
      `select id,external_id
         from knowledge_documents
        where vault_id=$1 and path=$2`,
      [vaultId, "z-late-source.md"],
    );
    expect(lateBefore.rows).toHaveLength(1);
    await writeFile(
      earlyPath,
      sourceDocumentWithId(
        latePathId,
        "Early source",
        "The early source body.",
      ),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const orderedCollision = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
    }>(
      `select id,path,external_id,body_cache
         from knowledge_documents
        where vault_id=$1 and path=any($2::text[])
        order by path`,
      [vaultId, ["a-early-source.md", "z-late-source.md"]],
    );
    expect(orderedCollision.rows).toEqual([
      expect.objectContaining({
        path: "a-early-source.md",
        external_id: expect.stringMatching(/^SOURCE-OCCURRENCE-/),
        body_cache: "# Early source\n\nThe early source body.",
      }),
      {
        id: lateBefore.rows[0]!.id,
        path: "z-late-source.md",
        external_id: lateBefore.rows[0]!.external_id,
        body_cache: "# Late source\n\nThe late source body.",
      },
    ]);

    const transitionId = "SRC-TRANSITION-DB-001";
    const transitionFirstPath = path.join(fixtureRoot, "transition-first.md");
    const transitionSecondPath = path.join(fixtureRoot, "transition-second.md");
    const transitionSecondRenamedPath = path.join(
      fixtureRoot,
      "transition-second-renamed.md",
    );
    await writeFile(
      transitionFirstPath,
      sourceDocumentWithId(
        transitionId,
        "Transition first",
        "The first transition body.",
      ),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const transitionBefore = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
    }>(
      `select id,path,external_id,body_cache
         from knowledge_documents
        where vault_id=$1 and path=$2`,
      [vaultId, "transition-first.md"],
    );
    expect(transitionBefore.rows).toHaveLength(1);
    expect(transitionBefore.rows[0]).toMatchObject({
      path: "transition-first.md",
      external_id: transitionId,
      body_cache: "# Transition first\n\nThe first transition body.",
    });

    await writeFile(
      transitionSecondPath,
      sourceDocumentWithId(
        transitionId,
        "Transition second",
        "The second transition body.",
      ),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const transitionCollision = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
    }>(
      `select id,path,external_id,body_cache
         from knowledge_documents
        where vault_id=$1 and path=any($2::text[])
        order by path`,
      [vaultId, ["transition-first.md", "transition-second.md"]],
    );
    expect(transitionCollision.rows).toEqual(
      expect.arrayContaining([
        {
          id: transitionBefore.rows[0]!.id,
          path: "transition-first.md",
          external_id: transitionId,
          body_cache: "# Transition first\n\nThe first transition body.",
        },
        expect.objectContaining({
          path: "transition-second.md",
          external_id: expect.stringMatching(/^SOURCE-OCCURRENCE-/),
          body_cache: "# Transition second\n\nThe second transition body.",
        }),
      ]),
    );
    expect(
      new Set(transitionCollision.rows.map((row) => row.external_id)).size,
    ).toBe(2);
    const transitionSecond = transitionCollision.rows.find(
      (row) => row.path === "transition-second.md",
    );
    expect(transitionSecond).toBeDefined();
    if (!transitionSecond) throw new Error("transition collision row missing");

    const transitionUnits = await db.pool.query<{
      document_id: string;
      path: string;
      body: string;
      locator_path: string | null;
    }>(
      `select u.document_id,d.path,u.body,u.locator->>'path' locator_path
         from knowledge_units u
         join knowledge_documents d on d.id=u.document_id
        where u.vault_id=$1 and d.path=any($2::text[])
          and u.unit_type='PARAGRAPH'
        order by d.path,u.structural_order`,
      [vaultId, ["transition-first.md", "transition-second.md"]],
    );
    expect(transitionUnits.rows).toEqual(
      expect.arrayContaining([
        {
          document_id: transitionBefore.rows[0]!.id,
          path: "transition-first.md",
          body: "The first transition body.",
          locator_path: "transition-first.md",
        },
        expect.objectContaining({
          path: "transition-second.md",
          body: "The second transition body.",
          locator_path: "transition-second.md",
        }),
      ]),
    );

    await rename(transitionSecondPath, transitionSecondRenamedPath);
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const renamedTransition = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and id=$2`,
      [vaultId, transitionSecond.id],
    );
    expect(renamedTransition.rows).toEqual([
      {
        id: transitionSecond.id,
        path: "transition-second-renamed.md",
        external_id: transitionSecond.external_id,
        lifecycle: "ACTIVE",
      },
    ]);

    await rm(transitionSecondRenamedPath);
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const transitionUnique = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and id=any($2::uuid[])
        order by id`,
      [vaultId, [transitionBefore.rows[0]!.id, transitionSecond.id]],
    );
    expect(transitionUnique.rows).toEqual(
      expect.arrayContaining([
        {
          id: transitionBefore.rows[0]!.id,
          path: "transition-first.md",
          external_id: transitionId,
          lifecycle: "ACTIVE",
        },
        expect.objectContaining({
          id: transitionSecond.id,
          lifecycle: "DELETED_TOMBSTONE",
        }),
      ]),
    );

    const transitionSnapshot = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and id=any($2::uuid[])
        order by id`,
      [vaultId, [transitionBefore.rows[0]!.id, transitionSecond.id]],
    );
    const transitionUnitCount = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_units
        where vault_id=$1 and document_id=any($2::uuid[])`,
      [vaultId, [transitionBefore.rows[0]!.id, transitionSecond.id]],
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const transitionIdempotent = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and id=any($2::uuid[])
        order by id`,
      [vaultId, [transitionBefore.rows[0]!.id, transitionSecond.id]],
    );
    const transitionUnitCountAfter = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_units
        where vault_id=$1 and document_id=any($2::uuid[])`,
      [vaultId, [transitionBefore.rows[0]!.id, transitionSecond.id]],
    );
    expect(transitionIdempotent.rows).toEqual(transitionSnapshot.rows);
    expect(transitionUnitCountAfter.rows).toEqual(transitionUnitCount.rows);

    const sameBodyId = "SRC-SAME-BODY-DB-001";
    await writeFile(
      path.join(fixtureRoot, "same-body-one.md"),
      sourceDocumentWithId(sameBodyId, "Same locator", "Same source body."),
      "utf8",
    );
    await writeFile(
      path.join(fixtureRoot, "same-body-two.md"),
      sourceDocumentWithId(sameBodyId, "Same locator", "Same source body."),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const sameBodyRows = await db.pool.query<{
      path: string;
      external_id: string;
      body_cache: string;
    }>(
      `select path,external_id,body_cache
         from knowledge_documents
        where vault_id=$1 and path=any($2::text[])
        order by path`,
      [vaultId, ["same-body-one.md", "same-body-two.md"]],
    );
    expect(sameBodyRows.rows).toHaveLength(2);
    expect(new Set(sameBodyRows.rows.map((row) => row.external_id)).size).toBe(
      2,
    );
    expect(new Set(sameBodyRows.rows.map((row) => row.body_cache)).size).toBe(
      1,
    );

    const reverseId = "SRC-REVERSE-TRANSITION-DB-001";
    const reverseOriginalPath = path.join(fixtureRoot, "reverse-original.md");
    const reverseSurvivorPath = path.join(fixtureRoot, "reverse-survivor.md");
    const reverseConsumerPath = path.join(fixtureRoot, "reverse-consumer.md");
    const reverseConsumerId = "CONSUMER-REVERSE-TRANSITION-DB-001";
    const reverseConsumer = (targetPath: string): string =>
      [
        "---",
        `id: ${reverseConsumerId}`,
        "type: source-note",
        "status: active",
        "supports:",
        `  - ${reverseId}`,
        "---",
        "# Reverse transition consumer",
        "",
        `The path relation is [[${targetPath.replace(/\.md$/i, "")}]].`,
      ].join("\n");
    await writeFile(
      reverseOriginalPath,
      sourceDocumentWithId(
        reverseId,
        "Reverse original",
        "The reverse original body.",
      ),
      "utf8",
    );
    await writeFile(
      reverseConsumerPath,
      reverseConsumer("reverse-original.md"),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const reverseOriginalBefore = await db.pool.query<{
      id: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and path=$2`,
      [vaultId, "reverse-original.md"],
    );
    expect(reverseOriginalBefore.rows).toHaveLength(1);
    expect(reverseOriginalBefore.rows[0]).toMatchObject({
      external_id: reverseId,
      lifecycle: "ACTIVE",
    });
    const reverseOriginalUnitBefore = await db.pool.query<{
      id: string;
      unit_key: string;
      corpus_revision: string;
    }>(
      `select id,unit_key,corpus_revision
         from knowledge_units
        where document_id=$1
        order by unit_key,corpus_revision`,
      [reverseOriginalBefore.rows[0]!.id],
    );
    const reverseOriginalHistoryBefore = await db.pool.query<{
      id: string;
      document_id: string;
      git_commit: string;
    }>(
      `select id,document_id,git_commit
         from knowledge_versions
        where document_id=$1
        order by git_commit`,
      [reverseOriginalBefore.rows[0]!.id],
    );
    expect(reverseOriginalUnitBefore.rows.length).toBeGreaterThan(0);
    expect(reverseOriginalHistoryBefore.rows.length).toBeGreaterThan(0);

    const reverseInitialRelations = await db.pool.query<{
      relation_type: string;
      target_path: string;
      target_ref: string;
    }>(
      `select r.relation_type,t.path target_path,r.metadata->>'target' target_ref
         from knowledge_relations r
         join knowledge_documents f on f.id=r.from_document_id
         join knowledge_documents t on t.id=r.to_document_id
        where f.vault_id=$1 and f.path=$2
          and r.provenance='markdown'
        order by r.relation_type`,
      [vaultId, "reverse-consumer.md"],
    );
    expect(reverseInitialRelations.rows).toEqual([
      {
        relation_type: "related_to",
        target_path: "reverse-original.md",
        target_ref: "reverse-original",
      },
      {
        relation_type: "supports",
        target_path: "reverse-original.md",
        target_ref: reverseId,
      },
    ]);

    await writeFile(
      reverseSurvivorPath,
      sourceDocumentWithId(
        reverseId,
        "Reverse survivor",
        "The reverse survivor body.",
      ),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const reverseCollision = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and path=any($2::text[])
        order by path`,
      [vaultId, ["reverse-original.md", "reverse-survivor.md"]],
    );
    expect(reverseCollision.rows).toEqual([
      {
        id: reverseOriginalBefore.rows[0]!.id,
        path: "reverse-original.md",
        external_id: reverseId,
        lifecycle: "ACTIVE",
      },
      expect.objectContaining({
        path: "reverse-survivor.md",
        external_id: expect.stringMatching(/^SOURCE-OCCURRENCE-/),
        lifecycle: "ACTIVE",
      }),
    ]);
    const reverseSurvivorCollision = reverseCollision.rows.find(
      (row) => row.path === "reverse-survivor.md",
    );
    expect(reverseSurvivorCollision).toBeDefined();
    if (!reverseSurvivorCollision) {
      throw new Error("reverse collision survivor row missing");
    }
    const reverseSurvivorUnitBefore = await db.pool.query<{
      id: string;
      unit_key: string;
      corpus_revision: string;
    }>(
      `select id,unit_key,corpus_revision
         from knowledge_units
        where document_id=$1
        order by unit_key,corpus_revision`,
      [reverseSurvivorCollision.id],
    );
    const reverseSurvivorHistoryBefore = await db.pool.query<{
      id: string;
      document_id: string;
      git_commit: string;
    }>(
      `select id,document_id,git_commit
         from knowledge_versions
        where document_id=$1
        order by git_commit`,
      [reverseSurvivorCollision.id],
    );
    expect(reverseSurvivorUnitBefore.rows.length).toBeGreaterThan(0);
    expect(reverseSurvivorHistoryBefore.rows.length).toBeGreaterThan(0);

    const reverseCollisionRelations = await db.pool.query<{
      relation_type: string;
      target_path: string;
      target_ref: string;
    }>(
      `select r.relation_type,t.path target_path,r.metadata->>'target' target_ref
         from knowledge_relations r
         join knowledge_documents f on f.id=r.from_document_id
         join knowledge_documents t on t.id=r.to_document_id
        where f.vault_id=$1 and f.path=$2
          and r.provenance='markdown'
        order by r.relation_type`,
      [vaultId, "reverse-consumer.md"],
    );
    expect(reverseCollisionRelations.rows).toEqual([
      {
        relation_type: "related_to",
        target_path: "reverse-original.md",
        target_ref: "reverse-original",
      },
    ]);

    await rm(reverseOriginalPath);
    await writeFile(
      reverseConsumerPath,
      reverseConsumer("reverse-survivor.md"),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const reverseAfter = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,lifecycle
         from knowledge_documents
        where vault_id=$1 and id=any($2::uuid[])
        order by path`,
      [
        vaultId,
        [reverseOriginalBefore.rows[0]!.id, reverseSurvivorCollision.id],
      ],
    );
    expect(reverseAfter.rows).toEqual([
      {
        id: reverseOriginalBefore.rows[0]!.id,
        path: "reverse-original.md",
        external_id: reverseId,
        lifecycle: "DELETED_TOMBSTONE",
      },
      {
        id: reverseSurvivorCollision.id,
        path: "reverse-survivor.md",
        external_id: reverseSurvivorCollision.external_id,
        lifecycle: "ACTIVE",
      },
    ]);
    const reverseSurvivorIdentity = await db.pool.query<{
      frontmatter: Record<string, unknown>;
    }>(
      `select frontmatter
         from knowledge_documents
        where id=$1`,
      [reverseSurvivorCollision.id],
    );
    expect(reverseSurvivorIdentity.rows[0]?.frontmatter).toMatchObject({
      __akp_import_identity: expect.objectContaining({
        declaredId: reverseId,
        externalId: reverseSurvivorCollision.external_id,
      }),
    });
    const reverseSurvivorUnitAfter = await db.pool.query<{
      id: string;
      document_id: string;
      unit_key: string;
      corpus_revision: string;
      lifecycle: string;
    }>(
      `select id,document_id,unit_key,corpus_revision,lifecycle
         from knowledge_units
        where document_id=$1
        order by unit_key,corpus_revision`,
      [reverseSurvivorCollision.id],
    );
    const reverseSurvivorHistoryAfter = await db.pool.query<{
      id: string;
      document_id: string;
      git_commit: string;
    }>(
      `select id,document_id,git_commit
         from knowledge_versions
        where document_id=$1
        order by git_commit`,
      [reverseSurvivorCollision.id],
    );
    expect(reverseSurvivorUnitAfter.rows).toEqual(
      expect.arrayContaining(
        reverseSurvivorUnitBefore.rows.map((row) => ({
          ...row,
          document_id: reverseSurvivorCollision.id,
          lifecycle: "ACTIVE",
        })),
      ),
    );
    expect(reverseSurvivorHistoryAfter.rows).toEqual(
      expect.arrayContaining(reverseSurvivorHistoryBefore.rows),
    );
    const reverseOriginalUnitAfter = await db.pool.query<{
      id: string;
      document_id: string;
      lifecycle: string;
    }>(
      `select id,document_id,lifecycle
         from knowledge_units
        where document_id=$1`,
      [reverseOriginalBefore.rows[0]!.id],
    );
    expect(reverseOriginalUnitAfter.rows).toEqual(
      expect.arrayContaining(
        reverseOriginalUnitBefore.rows.map((row) => ({
          id: row.id,
          document_id: reverseOriginalBefore.rows[0]!.id,
          lifecycle: "DELETED_TOMBSTONE",
        })),
      ),
    );
    const reverseAfterRelations = await db.pool.query<{
      relation_type: string;
      target_path: string;
      target_ref: string;
    }>(
      `select r.relation_type,t.path target_path,r.metadata->>'target' target_ref
         from knowledge_relations r
         join knowledge_documents f on f.id=r.from_document_id
         join knowledge_documents t on t.id=r.to_document_id
        where f.vault_id=$1 and f.path=$2
          and r.provenance='markdown'
        order by r.relation_type`,
      [vaultId, "reverse-consumer.md"],
    );
    expect(reverseAfterRelations.rows).toEqual([
      {
        relation_type: "related_to",
        target_path: "reverse-survivor.md",
        target_ref: "reverse-survivor",
      },
      {
        relation_type: "supports",
        target_path: "reverse-survivor.md",
        target_ref: reverseId,
      },
    ]);

    const reverseNewAPath = path.join(fixtureRoot, "reverse-new-a.md");
    const reverseNewBPath = path.join(fixtureRoot, "reverse-new-b.md");
    await rm(reverseSurvivorPath);
    await writeFile(
      reverseNewAPath,
      sourceDocumentWithId(
        reverseId,
        "Reverse new A",
        "A new occurrence with no prior path.",
      ),
      "utf8",
    );
    await writeFile(
      reverseNewBPath,
      sourceDocumentWithId(
        reverseId,
        "Reverse new B",
        "A different new occurrence with no prior path.",
      ),
      "utf8",
    );
    await importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey });
    const reverseNewRows = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
      lifecycle: string;
    }>(
      `select id,path,external_id,body_cache,lifecycle
         from knowledge_documents
        where vault_id=$1 and path=any($2::text[])
        order by path`,
      [vaultId, ["reverse-new-a.md", "reverse-new-b.md"]],
    );
    expect(reverseNewRows.rows).toHaveLength(2);
    expect(reverseNewRows.rows).toEqual([
      expect.objectContaining({
        path: "reverse-new-a.md",
        external_id: expect.stringMatching(/^SOURCE-OCCURRENCE-/),
        body_cache: "# Reverse new A\n\nA new occurrence with no prior path.",
        lifecycle: "ACTIVE",
      }),
      expect.objectContaining({
        path: "reverse-new-b.md",
        external_id: expect.stringMatching(/^SOURCE-OCCURRENCE-/),
        body_cache:
          "# Reverse new B\n\nA different new occurrence with no prior path.",
        lifecycle: "ACTIVE",
      }),
    ]);
    expect(reverseNewRows.rows.map((row) => row.id)).not.toContain(
      reverseOriginalBefore.rows[0]!.id,
    );
    expect(reverseNewRows.rows.map((row) => row.id)).not.toContain(
      reverseSurvivorCollision.id,
    );
    expect(reverseNewRows.rows.map((row) => row.external_id)).not.toContain(
      reverseId,
    );
  });

  it("fails closed when a source-supplied identity metadata value claims a new stable id", async () => {
    if (!db || !fixtureRoot) {
      throw new Error("integration fixture was not initialized");
    }

    const originalId = "SRC-SPOOF-ORIGINAL-DB-001";
    const replacementId = "SRC-SPOOF-REPLACEMENT-DB-001";
    const spoofedPath = path.join(fixtureRoot, "spoofed-source.md");
    const sourceWithForgedProjectionMetadata = [
      "---",
      `id: ${originalId}`,
      "type: source-note",
      "status: active",
      "__akp_import_identity:",
      "  version: 1",
      "  kind: declared-id-path-occurrence",
      "  collision: duplicate-declared-id",
      `  declaredId: ${replacementId}`,
      "  externalId: SOURCE-OCCURRENCE-FORGED-DB",
      "  occurrenceKey: path:spoofed-source.md",
      "  path: spoofed-source.md",
      "  resolution: exact-path-only",
      "---",
      "# Spoofed source identity",
      "",
      "The first source body is authoritative.",
    ].join("\n");
    await writeFile(spoofedPath, sourceWithForgedProjectionMetadata, "utf8");

    const first = await importVaultReadOnly(db, fixtureRoot, {
      spaceId,
      vaultKey,
    });
    vaultId = first.vaultId;
    const before = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
      content_hash: string;
      frontmatter: Record<string, unknown>;
    }>(
      `select id,path,external_id,body_cache,content_hash,frontmatter
         from knowledge_documents
        where vault_id=$1 and path=$2`,
      [vaultId, "spoofed-source.md"],
    );
    expect(before.rows).toHaveLength(1);
    const stableDocumentId = before.rows[0]!.id;
    expect(before.rows[0]).toMatchObject({
      path: "spoofed-source.md",
      external_id: originalId,
      body_cache:
        "# Spoofed source identity\n\nThe first source body is authoritative.",
    });
    expect(before.rows[0]?.frontmatter.__akp_import_identity).toBeUndefined();
    await db.pool.query(
      `update knowledge_documents
          set frontmatter = jsonb_set(
            coalesce(frontmatter,'{}'::jsonb),
            '{__akp_import_identity}',
            $1::jsonb,
            true
          )
        where id=$2`,
      [
        JSON.stringify({
          version: 1,
          kind: "declared-id-path-occurrence",
          collision: "duplicate-declared-id",
          declaredId: replacementId,
          externalId: originalId,
          occurrenceKey: "path:spoofed-source.md",
          path: "spoofed-source.md",
          resolution: "exact-path-only",
          sourceType: "source-note",
          sourceContentHash: before.rows[0]!.content_hash,
        }),
        stableDocumentId,
      ],
    );

    await writeFile(
      spoofedPath,
      [
        "---",
        `id: ${replacementId}`,
        "type: source-note",
        "status: active",
        "---",
        "# Replacement source identity",
        "",
        "The replacement id was never declared by the first source.",
      ].join("\n"),
      "utf8",
    );

    await expect(
      importVaultReadOnly(db, fixtureRoot, { spaceId, vaultKey }),
    ).rejects.toThrow(
      `VAULT_DOCUMENT_IDENTITY_CONFLICT:spoofed-source.md:${replacementId}`,
    );

    const after = await db.pool.query<{
      id: string;
      path: string;
      external_id: string;
      body_cache: string;
    }>(
      `select id,path,external_id,body_cache
         from knowledge_documents
        where vault_id=$1 and path=$2`,
      [vaultId, "spoofed-source.md"],
    );
    expect(after.rows).toEqual([
      {
        id: stableDocumentId,
        path: "spoofed-source.md",
        external_id: originalId,
        body_cache:
          "# Spoofed source identity\n\nThe first source body is authoritative.",
      },
    ]);
  });
});
