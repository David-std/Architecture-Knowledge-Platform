import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres, appendOutboxEvent } from "@akp/postgres";
import { MAX_EMBEDDING_UNIT_CHARACTERS } from "@akp/retrieval";
import { incrementalIndex, reconcileIncrementalIndex } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;

describe("incremental index event port", () => {
  it.skipIf(!databaseUrl)(
    "indexes changed paths, tombstones removed paths, and deduplicates a redelivery",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const repositoryPath = await mkdtemp(
        path.join(os.tmpdir(), "akp-indexing-"),
      );
      const store = new GitKnowledgeStore(repositoryPath);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const eventId = randomUUID();
      const tombstoneEventId = randomUUID();
      try {
        await db.pool.query(
          `insert into organizations(id,slug,name) values($1,$2,$3)`,
          [organizationId, `idx-${organizationId.slice(0, 8)}`, "Index test"],
        );
        await db.pool.query(
          `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
           values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `idx-${spaceId.slice(0, 8)}`,
            "Index test space",
            repositoryPath,
          ],
        );
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,
             vault_key,local_path
           ) values($1,$2,$3,$4,true,$5,$6,$3)`,
          [
            vaultId,
            spaceId,
            repositoryPath,
            "Index test vault",
            "r0",
            `idx-${vaultId.slice(0, 8)}`,
          ],
        );

        const baseRevision = await store.ensureRepository(
          "Index integration",
          "index@localhost",
        );
        const branch = await store.createDraftBranch(
          "index-integration",
          baseRevision,
        );
        await store.writeDraftFile(
          "managed/changed.md",
          "---\nid: IDX-CHANGED\ntitle: Changed\ntype: rule\n---\n\n# Changed\n\nA durable update.\n",
        );
        const draftRevision = await store.commitAll(
          "test: add changed managed document",
          "Index integration",
          "index@localhost",
        );
        const publishedRevision = await store.mergeDraft(
          branch,
          baseRevision,
          draftRevision,
          "Index integration",
          "index@localhost",
        );
        expect(
          await store.showFile(publishedRevision, "managed/changed.md"),
        ).toContain("Changed");
        await db.pool.query(
          "update vaults set current_revision=$1 where id=$2",
          [publishedRevision, vaultId],
        );

        await appendOutboxEvent(db, {
          eventId,
          eventType: "CorpusRevisionPublished",
          resourceId: randomUUID(),
          spaceId,
          vaultId,
          payload: {
            revision: publishedRevision,
            changedPaths: ["changed.md"],
          },
        });
        const first = await incrementalIndex(db, store, {
          eventId,
          spaceId,
          vaultId,
          revision: publishedRevision,
          changes: [{ path: "changed.md", operation: "CREATE" }],
        });
        expect(first.indexedPaths).toEqual(["managed/changed.md"]);
        expect(first.tombstonedPaths).toEqual([]);
        expect(first.corpusRevision).toContain(publishedRevision);
        const indexed = await db.pool.query(
          `select lifecycle,content_hash from knowledge_documents
            where space_id=$1 and vault_id=$2 and path='managed/changed.md'`,
          [spaceId, vaultId],
        );
        expect(indexed.rows[0]?.lifecycle).toBe("ACTIVE");
        const run = await db.pool.query(
          `select status,documents_rebuilt from incremental_index_runs where event_id=$1`,
          [eventId],
        );
        expect(run.rows[0]).toMatchObject({
          status: "COMPLETED",
          documents_rebuilt: 1,
        });

        const generationsBeforeTombstone = await db.pool.query<{
          count: number;
        }>(
          `select count(*)::int count from embedding_generations where vault_id=$1`,
          [vaultId],
        );

        const duplicate = await incrementalIndex(db, store, {
          eventId,
          spaceId,
          vaultId,
          revision: publishedRevision,
          changes: [{ path: "changed.md", operation: "UPDATE" }],
        });
        expect(duplicate.indexedPaths).toEqual([]);
        expect(
          (
            await db.pool.query(
              `select count(*)::int count from incremental_index_runs where event_id=$1`,
              [eventId],
            )
          ).rows[0]?.count,
        ).toBe(1);

        await appendOutboxEvent(db, {
          eventId: tombstoneEventId,
          eventType: "CorpusRevisionPublished",
          resourceId: randomUUID(),
          spaceId,
          vaultId,
          payload: { revision: baseRevision, tombstones: ["changed.md"] },
        });
        const tombstoned = await incrementalIndex(db, store, {
          eventId: tombstoneEventId,
          spaceId,
          vaultId,
          revision: baseRevision,
          changes: [{ path: "changed.md", operation: "UPDATE" }],
        });
        expect(tombstoned.tombstonedPaths).toEqual(["managed/changed.md"]);
        const removed = await db.pool.query(
          `select lifecycle from knowledge_documents
            where space_id=$1 and vault_id=$2 and path='managed/changed.md'`,
          [spaceId, vaultId],
        );
        expect(removed.rows[0]?.lifecycle).toBe("DELETED_TOMBSTONE");
        const generationsAfterTombstone = await db.pool.query<{
          count: number;
        }>(
          `select count(*)::int count from embedding_generations where vault_id=$1`,
          [vaultId],
        );
        expect(generationsAfterTombstone.rows[0]?.count).toBe(
          generationsBeforeTombstone.rows[0]?.count,
        );

        const healthy = await reconcileIncrementalIndex(db, spaceId, vaultId);
        expect(healthy.failed).toBe(0);
        expect(healthy.revisionDrift).toBe(false);
        await db.pool.query(
          `update vault_index_revisions set corpus_revision='drift' where space_id=$1 and vault_id=$2`,
          [spaceId, vaultId],
        );
        const drift = await reconcileIncrementalIndex(db, spaceId, vaultId);
        expect(drift.revisionDrift).toBe(true);
      } finally {
        await db.pool.end();
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "preserves document identity when a stable-id managed document is renamed",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const repositoryPath = await mkdtemp(
        path.join(os.tmpdir(), "akp-indexing-rename-"),
      );
      const store = new GitKnowledgeStore(repositoryPath);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const createEventId = randomUUID();
      const renameEventId = randomUUID();
      try {
        await db.pool.query(
          `insert into organizations(id,slug,name) values($1,$2,$3)`,
          [
            organizationId,
            `idx-rename-${organizationId.slice(0, 8)}`,
            "Rename index test",
          ],
        );
        await db.pool.query(
          `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
           values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `idx-rename-${spaceId.slice(0, 8)}`,
            "Rename index test space",
            repositoryPath,
          ],
        );
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,
             vault_key,local_path
           ) values($1,$2,$3,$4,true,$5,$6,$3)`,
          [
            vaultId,
            spaceId,
            repositoryPath,
            "Rename index test vault",
            "r0",
            `idx-rename-${vaultId.slice(0, 8)}`,
          ],
        );

        const baseRevision = await store.ensureRepository(
          "Index rename integration",
          "index-rename@localhost",
        );
        const createBranch = await store.createDraftBranch(
          "index-rename-create",
          baseRevision,
        );
        await store.writeDraftFile(
          "managed/original.md",
          "---\nid: IDX-RENAME\ntitle: Rename me\ntype: rule\n---\n\n# Rename me\n\nStable identity.\n",
        );
        const createDraft = await store.commitAll(
          "test: add rename fixture",
          "Index rename integration",
          "index-rename@localhost",
        );
        const createdRevision = await store.mergeDraft(
          createBranch,
          baseRevision,
          createDraft,
          "Index rename integration",
          "index-rename@localhost",
        );
        await db.pool.query(
          "update vaults set current_revision=$1 where id=$2",
          [createdRevision, vaultId],
        );
        await appendOutboxEvent(db, {
          eventId: createEventId,
          eventType: "CorpusRevisionPublished",
          resourceId: randomUUID(),
          spaceId,
          vaultId,
          payload: {
            revision: createdRevision,
            changedPaths: ["original.md"],
          },
        });
        await incrementalIndex(db, store, {
          eventId: createEventId,
          spaceId,
          vaultId,
          revision: createdRevision,
          changes: [{ path: "original.md", operation: "CREATE" }],
        });
        const before = await db.pool.query<{ id: string }>(
          `select id from knowledge_documents
            where space_id=$1 and vault_id=$2 and external_id='IDX-RENAME'`,
          [spaceId, vaultId],
        );
        const documentId = before.rows[0]?.id;
        expect(documentId).toBeDefined();

        const renameBranch = await store.createDraftBranch(
          "index-rename-move",
          createdRevision,
        );
        const renameWorktree = path.join(
          `${repositoryPath}-drafts`,
          "index-rename-move",
        );
        await rename(
          path.join(renameWorktree, "managed", "original.md"),
          path.join(renameWorktree, "managed", "renamed.md"),
        );
        const renameDraft = await store.commitAll(
          "test: rename managed document",
          "Index rename integration",
          "index-rename@localhost",
        );
        const renamedRevision = await store.mergeDraft(
          renameBranch,
          createdRevision,
          renameDraft,
          "Index rename integration",
          "index-rename@localhost",
        );
        await db.pool.query(
          "update vaults set current_revision=$1 where id=$2",
          [renamedRevision, vaultId],
        );
        await appendOutboxEvent(db, {
          eventId: renameEventId,
          eventType: "CorpusRevisionPublished",
          resourceId: randomUUID(),
          spaceId,
          vaultId,
          payload: {
            revision: renamedRevision,
            changedPaths: ["renamed.md", "original.md"],
            tombstones: ["original.md"],
          },
        });

        const renamed = await incrementalIndex(db, store, {
          eventId: renameEventId,
          spaceId,
          vaultId,
          revision: renamedRevision,
          changes: [
            // Deliberately put DELETE first: rename correctness must not depend
            // on the producer's path ordering.
            { path: "original.md", operation: "DELETE" },
            { path: "renamed.md", operation: "CREATE" },
          ],
        });
        expect(renamed.indexedPaths).toContain("managed/renamed.md");
        expect(renamed.tombstonedPaths).toContain("managed/original.md");

        const after = await db.pool.query<{
          id: string;
          path: string;
          lifecycle: string;
        }>(
          `select id,path,lifecycle from knowledge_documents
            where space_id=$1 and vault_id=$2 and external_id='IDX-RENAME'`,
          [spaceId, vaultId],
        );
        expect(after.rows).toEqual([
          {
            id: documentId,
            path: "managed/renamed.md",
            lifecycle: "ACTIVE",
          },
        ]);
        const oldPath = await db.pool.query(
          `select id from knowledge_documents
            where space_id=$1 and vault_id=$2 and path='managed/original.md'`,
          [spaceId, vaultId],
        );
        expect(oldPath.rowCount).toBe(0);

        const duplicateBranch = await store.createDraftBranch(
          "index-rename-duplicate",
          renamedRevision,
        );
        await store.writeDraftFile(
          "managed/duplicate.md",
          "---\nid: IDX-RENAME\ntitle: Duplicate identity\ntype: rule\n---\n\n# Duplicate identity\n\nThis must be rejected.\n",
        );
        const duplicateDraft = await store.commitAll(
          "test: add duplicate stable id",
          "Index rename integration",
          "index-rename@localhost",
        );
        const duplicateRevision = await store.mergeDraft(
          duplicateBranch,
          renamedRevision,
          duplicateDraft,
          "Index rename integration",
          "index-rename@localhost",
        );
        const duplicateEventId = randomUUID();
        await db.pool.query(
          "update vaults set current_revision=$1 where id=$2",
          [duplicateRevision, vaultId],
        );
        await appendOutboxEvent(db, {
          eventId: duplicateEventId,
          eventType: "CorpusRevisionPublished",
          resourceId: randomUUID(),
          spaceId,
          vaultId,
          payload: {
            revision: duplicateRevision,
            changedPaths: ["duplicate.md"],
          },
        });
        await expect(
          incrementalIndex(db, store, {
            eventId: duplicateEventId,
            spaceId,
            vaultId,
            revision: duplicateRevision,
            changes: [{ path: "duplicate.md", operation: "CREATE" }],
          }),
        ).rejects.toThrow(/VAULT_DOCUMENT_IDENTITY_CONFLICT/);

        const afterConflict = await db.pool.query<{
          id: string;
          path: string;
          lifecycle: string;
        }>(
          `select id,path,lifecycle from knowledge_documents
            where space_id=$1 and vault_id=$2 and external_id='IDX-RENAME'`,
          [spaceId, vaultId],
        );
        expect(afterConflict.rows).toEqual([
          {
            id: documentId,
            path: "managed/renamed.md",
            lifecycle: "ACTIVE",
          },
        ]);
      } finally {
        await db.pool.end();
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!databaseUrl)(
    "materializes table rows, cells and bounded long-text fragments in a fresh projection",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const repositoryPath = await mkdtemp(
        path.join(os.tmpdir(), "akp-indexing-unitization-"),
      );
      const store = new GitKnowledgeStore(repositoryPath);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const eventId = randomUUID();
      const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
      process.env.AKP_VECTOR_ENABLED = "false";
      try {
        await db.pool.query(
          `insert into organizations(id,slug,name) values($1,$2,$3)`,
          [
            organizationId,
            `idx-units-${organizationId.slice(0, 8)}`,
            "Unitization integration",
          ],
        );
        await db.pool.query(
          `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
           values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `idx-units-${spaceId.slice(0, 8)}`,
            "Unitization integration space",
            repositoryPath,
          ],
        );
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,
             vault_key,local_path
           ) values($1,$2,$3,$4,true,$5,$6,$3)`,
          [
            vaultId,
            spaceId,
            repositoryPath,
            "Unitization integration vault",
            "r0",
            `idx-units-${vaultId.slice(0, 8)}`,
          ],
        );

        const baseRevision = await store.ensureRepository(
          "Unitization integration",
          "unitization@localhost",
        );
        const branchName = await store.createDraftBranch(
          "unitization-integration",
          baseRevision,
        );
        const longText =
          "Bounded retrieval material remains structurally attributable. ".repeat(
            55,
          ) + "The terminal recovery marker is still retrievable.";
        await store.writeDraftFile(
          "managed/structured.md",
          [
            "---",
            "id: IDX-STRUCTURED-UNITIZATION",
            "title: Structured unitization",
            "type: evidence",
            "status: active",
            "---",
            "",
            "# Retrieval evidence",
            "",
            "| Metric | Value |",
            "| --- | --- |",
            "| Accuracy | 97.2% |",
            "| Window | 47 minutes |",
            "",
            longText,
            "",
          ].join("\n"),
        );
        const draftRevision = await store.commitAll(
          "test: add structured unitization fixture",
          "Unitization integration",
          "unitization@localhost",
        );
        const publishedRevision = await store.mergeDraft(
          branchName,
          baseRevision,
          draftRevision,
          "Unitization integration",
          "unitization@localhost",
        );
        await db.pool.query(
          "update vaults set current_revision=$1 where id=$2",
          [publishedRevision, vaultId],
        );
        await appendOutboxEvent(db, {
          eventId,
          eventType: "CorpusRevisionPublished",
          resourceId: randomUUID(),
          spaceId,
          vaultId,
          payload: {
            revision: publishedRevision,
            changedPaths: ["structured.md"],
          },
        });

        const result = await incrementalIndex(db, store, {
          eventId,
          spaceId,
          vaultId,
          revision: publishedRevision,
          changes: [{ path: "structured.md", operation: "CREATE" }],
        });

        const rows = await db.pool.query<{
          unit_type: string;
          body: string;
          container_only: boolean;
          embedding_eligible: boolean;
          locator: Record<string, unknown>;
        }>(
          `select u.unit_type,u.body,u.container_only,u.embedding_eligible,u.locator
             from knowledge_units u
             join knowledge_documents d on d.id=u.document_id
            where u.space_id=$1 and u.vault_id=$2
              and u.corpus_revision=$3
              and d.external_id='IDX-STRUCTURED-UNITIZATION'
            order by u.structural_order,u.id`,
          [spaceId, vaultId, result.corpusRevision],
        );

        const table = rows.rows.find((row) => row.unit_type === "TABLE");
        const tableRows = rows.rows.filter(
          (row) => row.unit_type === "TABLE_ROW",
        );
        const tableCells = rows.rows.filter(
          (row) => row.unit_type === "TABLE_CELL",
        );
        const longContainer = rows.rows.find(
          (row) =>
            row.unit_type === "PARAGRAPH" &&
            row.container_only &&
            row.body.includes("terminal recovery marker"),
        );
        const fragments = rows.rows.filter(
          (row) =>
            row.unit_type === "PARAGRAPH" &&
            row.embedding_eligible &&
            typeof row.locator.fragment === "number",
        );

        expect(table).toMatchObject({
          container_only: true,
          embedding_eligible: false,
        });
        expect(tableRows).toHaveLength(2);
        expect(
          tableRows.map((row) => [row.locator.table, row.locator.row]),
        ).toEqual([
          [1, 1],
          [1, 2],
        ]);
        expect(tableRows.every((row) => row.embedding_eligible)).toBe(true);
        expect(tableCells).toHaveLength(4);
        expect(
          tableCells.every(
            (row) =>
              row.embedding_eligible === false &&
              typeof row.locator.table === "number" &&
              typeof row.locator.row === "number" &&
              typeof row.locator.column === "number",
          ),
        ).toBe(true);
        expect(longContainer).toBeDefined();
        expect(fragments.length).toBeGreaterThan(1);
        expect(
          fragments.some((row) =>
            row.body.includes("terminal recovery marker"),
          ),
        ).toBe(true);
        expect(
          rows.rows
            .filter((row) => row.embedding_eligible)
            .every(
              (row) => row.body.length <= MAX_EMBEDDING_UNIT_CHARACTERS,
            ),
        ).toBe(true);
      } finally {
        if (previousVectorEnabled === undefined) {
          delete process.env.AKP_VECTOR_ENABLED;
        } else {
          process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
        }
        await db.pool.end();
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );
});
