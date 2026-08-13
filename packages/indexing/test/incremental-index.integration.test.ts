import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres, appendOutboxEvent } from "@akp/postgres";
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
});
