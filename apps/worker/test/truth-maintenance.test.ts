import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmbeddingGenerationManager } from "@akp/indexing";
import {
  Postgres,
  PostgresTemporalTruthStore,
  type OutboxEventRecord,
} from "@akp/postgres";
import { DurableEventWorker } from "../src/event-worker.js";
import {
  createTruthMaintenanceHandlers,
  projectionInputFromEvent,
} from "../src/truth-maintenance.js";

const databaseUrl = process.env.DATABASE_URL;

function invalidationEvent(
  overrides: Partial<OutboxEventRecord> = {},
): OutboxEventRecord {
  const sourceEpisodeId = "00000000-0000-0000-0000-000000000043";
  return {
    eventId: "00000000-0000-0000-0000-000000000042",
    eventType: "DerivedSupportInvalidationRequested",
    eventVersion: 1,
    resourceId: sourceEpisodeId,
    organizationId: null,
    spaceId: "00000000-0000-0000-0000-000000000044",
    vaultId: "00000000-0000-0000-0000-000000000045",
    correlationId: null,
    causationId: null,
    occurredAt: "2026-09-19T00:00:00.000Z",
    createdAt: "2026-09-19T00:00:00.000Z",
    payload: {
      reason: "SOURCE_WITHDRAWN",
      sourceEpisodeId,
      truthRevisionHash: "a".repeat(64),
    },
    ...overrides,
  };
}

describe("derived truth maintenance event boundary", () => {
  it("maps a scoped invalidation event and rejects resource mismatches", () => {
    expect(projectionInputFromEvent(invalidationEvent())).toMatchObject({
      eventId: "00000000-0000-0000-0000-000000000042",
      spaceId: "00000000-0000-0000-0000-000000000044",
      vaultId: "00000000-0000-0000-0000-000000000045",
      reason: "SOURCE_WITHDRAWN",
      resourceId: "00000000-0000-0000-0000-000000000043",
      truthRevisionHash: "a".repeat(64),
      validAt: "2026-09-19T00:00:00.000Z",
    });

    const factId = "00000000-0000-0000-0000-000000000046";
    expect(
      projectionInputFromEvent(
        invalidationEvent({
          resourceId: factId,
          payload: {
            reason: "FACT_SUPERSEDED",
            factId,
            replacementFactId: "00000000-0000-0000-0000-000000000047",
            truthRevisionHash: "b".repeat(64),
          },
        }),
      ),
    ).toMatchObject({
      reason: "FACT_SUPERSEDED",
      resourceId: factId,
      truthRevisionHash: "b".repeat(64),
    });

    const evidenceId = "00000000-0000-0000-0000-000000000048";
    expect(
      projectionInputFromEvent(
        invalidationEvent({
          resourceId: evidenceId,
          payload: {
            reason: "EVIDENCE_INVALIDATED",
            evidenceId,
            truthRevisionHash: "c".repeat(64),
          },
        }),
      ),
    ).toMatchObject({
      reason: "EVIDENCE_INVALIDATED",
      resourceId: evidenceId,
      truthRevisionHash: "c".repeat(64),
    });

    expect(() =>
      projectionInputFromEvent(
        invalidationEvent({
          resourceId: "00000000-0000-0000-0000-000000000099",
        }),
      ),
    ).toThrow("TRUTH_INVALIDATION_EVENT_RESOURCE_MISMATCH");
  });

  it.skipIf(!databaseUrl)(
    "rebuilds only affected current truth while preserving historical dependencies",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const store = new PostgresTemporalTruthStore(db);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const sourceA = randomUUID();
      const sourceB = randomUUID();
      const artifactA = randomUUID();
      const artifactB = randomUUID();
      const consumerName = `truth-maintenance-${randomUUID()}`;
      try {
        await db.pool.query(
          "insert into organizations(id,slug,name) values($1,$2,'Truth maintenance')",
          [organizationId, `truth-maint-${organizationId.slice(0, 8)}`],
        );
        await db.pool.query(
          `insert into spaces(
             id,organization_id,slug,name,visibility,knowledge_repo_path
           ) values($1,$2,$3,'Truth maintenance','PRIVATE',$4)`,
          [
            spaceId,
            organizationId,
            `truth-maint-${spaceId.slice(0, 8)}`,
            `/tmp/truth-maint-${spaceId}`,
          ],
        );
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,vault_key,
             local_path,visibility,enabled
           ) values($1,$2,$3,'Truth maintenance',true,'truth-maint:r0',$4,$3,'PRIVATE',true)`,
          [
            vaultId,
            spaceId,
            `/tmp/truth-maint-vault-${vaultId}`,
            `truth-maint-${vaultId.slice(0, 8)}`,
          ],
        );

        for (const [sourceId, artifactId, hash, suffix] of [
          [sourceA, artifactA, "a".repeat(64), "a"],
          [sourceB, artifactB, "b".repeat(64), "b"],
        ]) {
          await db.pool.query(
            `insert into sources(
               id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
               object_key,status,metadata
             ) values($1,$2,$3,$4,$5,'text/plain',$6,4,$7,'ACTIVE','{}'::jsonb)`,
            [
              sourceId,
              spaceId,
              vaultId,
              `Source ${suffix}`,
              `https://example.test/truth-maint-${suffix}`,
              hash,
              `truth-maint/${suffix}.txt`,
            ],
          );
          await db.pool.query(
            `insert into source_artifacts(
               id,source_id,kind,object_key,source_hash,extractor,extractor_version,
               quality,metadata
             ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
            [artifactId, sourceId, `truth-maint/${suffix}.json`, hash],
          );
        }

        const episodeA = await store.createSourceEpisode({
          spaceId,
          vaultId,
          sourceId: sourceA,
          sourceArtifactId: artifactA,
          sourceHash: "a".repeat(64),
          locatorRefs: ["source:a#conclusion"],
        });
        const episodeB = await store.createSourceEpisode({
          spaceId,
          vaultId,
          sourceId: sourceB,
          sourceArtifactId: artifactB,
          sourceHash: "b".repeat(64),
          locatorRefs: ["source:b#conclusion"],
        });
        const conclusionSupport = await store.createSupportSet({
          spaceId,
          vaultId,
          sourceEpisodeIds: [episodeA.id, episodeB.id],
          alternativeSupportGroups: [
            [`source_episode:${episodeA.id}`],
            [`source_episode:${episodeB.id}`],
          ],
        });
        const fact = await store.recordFact({
          spaceId,
          vaultId,
          scopeId: "security:conclusion",
          authorizationPath: "security/conclusion.md",
          subjectRef: "policy:conclusion",
          predicate: "supported",
          object: { value: true },
          validFrom: "2025-01-01T00:00:00.000Z",
          supportSetId: conclusionSupport.id,
          sourceEpisodeId: episodeA.id,
        });
        const aOnlySupport = await store.createSupportSet({
          spaceId,
          vaultId,
          sourceEpisodeIds: [episodeA.id],
        });
        const aOnlyFact = await store.recordFact({
          spaceId,
          vaultId,
          scopeId: "security:a-only-fact",
          authorizationPath: "security/a-only-fact.md",
          subjectRef: "policy:a-only",
          predicate: "supported",
          object: { value: true },
          validFrom: "2025-01-01T00:00:00.000Z",
          supportSetId: aOnlySupport.id,
          sourceEpisodeId: episodeA.id,
        });
        const factBackedSupport = await store.createSupportSet({
          spaceId,
          vaultId,
          factIds: [aOnlyFact.fact.id],
        });

        const physicalDocumentId = randomUUID();
        const physicalUnitId = randomUUID();
        const physicalContentHash = "d".repeat(64);
        await db.pool.query(
          `insert into knowledge_documents(
             id,space_id,vault_id,path,external_id,title,type,lifecycle,
             trust_tier,current_revision,body_cache,frontmatter,aliases,
             raw_links,layer,content_hash,token_estimate
           ) values(
             $1,$2,$3,$4,$5,'Truth cleanup vector','note','ACTIVE',
             'HUMAN_REVIEWED','truth-maint:r0','cleanup vector',
             '{}'::jsonb,'{}','[]'::jsonb,'concept',$6,4
           )`,
          [
            physicalDocumentId,
            spaceId,
            vaultId,
            `truth-cleanup/${physicalDocumentId}.md`,
            `TRUTH-CLEANUP-${physicalDocumentId.slice(0, 8)}`,
            "e".repeat(64),
          ],
        );
        await db.pool.query(
          `insert into knowledge_units(
             id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
             body,content_hash,corpus_revision,lifecycle,trust_tier,source_ids,
             token_estimate,parent_unit_id,document_revision,permissions,locator,
             structural_order,container_only,embedding_eligible
           ) values(
             $1,$2,$3,$4,$5,'PARAGRAPH','{}','cleanup vector',$6,
             'truth-maint:r0','ACTIVE','HUMAN_REVIEWED','{}',4,null,
             'truth-maint:r0','{}'::jsonb,'{}'::jsonb,1,false,true
           )`,
          [
            physicalUnitId,
            physicalDocumentId,
            spaceId,
            vaultId,
            `truth-cleanup-${physicalUnitId.slice(0, 8)}`,
            physicalContentHash,
          ],
        );
        await db.pool.query(
          `insert into vault_index_revisions(
             space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
             graph_revision,context_pack_revision,status,warnings
           ) values(
             $1,$2,'truth-maint:r0','truth-maint:r0',null,
             'truth-maint:r0','truth-maint:r0','CONSISTENT','[]'::jsonb
           )`,
          [spaceId, vaultId],
        );
        const embeddingManager = new EmbeddingGenerationManager(db);
        const requestedGeneration = await embeddingManager.request({
          spaceId,
          vaultId,
          corpusRevision: "truth-maint:r0",
          descriptor: {
            provider: "truth-maintenance-test",
            model: "cleanup-vector",
            modelRevision: "r1",
            dimensions: 3,
            normalization: "l2",
            inputStrategy: "semantic-query-passage-v1",
            configurationVersion: "p5-cleanup-v1",
            runtime: "test",
          },
        });
        await embeddingManager.build(requestedGeneration.generationId);
        await embeddingManager.writeEmbedding({
          generationId: requestedGeneration.generationId,
          unitId: physicalUnitId,
          contentHash: physicalContentHash,
          embedding: [1, 0, 0],
        });
        await embeddingManager.ready(requestedGeneration.generationId, 1);
        const activeGeneration = await embeddingManager.activate(
          requestedGeneration.generationId,
        );
        const physicalVectorRef =
          `vector:${activeGeneration.generationId}:${physicalUnitId}`;

        const vectorRef = `vector:generation-a:${randomUUID()}`;
        const factBackedVectorRef = `vector:generation-fact:${randomUUID()}`;
        const synthesisRef = `synthesis:conclusion:${randomUUID()}`;
        await store.registerDerivedDependency({
          spaceId,
          vaultId,
          derivedStoreKind: "VECTOR",
          derivedItemRef: vectorRef,
          supportSetId: aOnlySupport.id,
          truthRevisionHash: fact.revision.revisionHash,
          projectionRevision: "vector:r1",
        });
        await store.registerDerivedDependency({
          spaceId,
          vaultId,
          derivedStoreKind: "VECTOR",
          derivedItemRef: factBackedVectorRef,
          supportSetId: factBackedSupport.id,
          truthRevisionHash: aOnlyFact.revision.revisionHash,
          projectionRevision: "vector:r1",
        });
        await store.registerDerivedDependency({
          spaceId,
          vaultId,
          derivedStoreKind: "VECTOR",
          derivedItemRef: physicalVectorRef,
          supportSetId: aOnlySupport.id,
          truthRevisionHash: aOnlyFact.revision.revisionHash,
          projectionRevision: "truth-maint:r0",
        });
        await store.registerDerivedDependency({
          spaceId,
          vaultId,
          derivedStoreKind: "CACHED_SYNTHESIS",
          derivedItemRef: synthesisRef,
          supportSetId: conclusionSupport.id,
          truthRevisionHash: fact.revision.revisionHash,
          projectionRevision: "synthesis:r1",
        });

        const physicalBefore = await db.pool.query<{ count: string }>(
          `select count(*)::text count
             from unit_embeddings
            where generation_id=$1 and unit_id=$2`,
          [activeGeneration.generationId, physicalUnitId],
        );
        expect(physicalBefore.rows[0]?.count).toBe("1");

        const withdrawn = await store.withdrawSourceEpisode({
          spaceId,
          vaultId,
          sourceEpisodeId: episodeA.id,
          reason: "Source A withdrawn for truth-maintenance integration",
        });
        const event = await db.pool.query<{
          event_id: string;
          occurred_at: Date | string;
        }>(
          `select event_id,occurred_at
             from event_outbox
            where event_type='DerivedSupportInvalidationRequested'
              and resource_id=$1 and space_id=$2 and vault_id=$3
            order by created_at desc
            limit 1`,
          [episodeA.id, spaceId, vaultId],
        );
        const targetEvent = event.rows[0];
        expect(targetEvent?.event_id).toBeTruthy();
        if (!targetEvent) throw new Error("truth invalidation event missing");

        const handlers = createTruthMaintenanceHandlers(db);
        const worker = new DurableEventWorker(db, {
          consumerName,
          workerId: `${consumerName}:worker`,
          handlers,
          listenNotify: false,
          maxAttempts: 2,
          leaseSeconds: 20,
        });
        await worker.register();
        await db.pool.query(
          "delete from event_deliveries where consumer_name=$1 and event_id<>$2",
          [consumerName, targetEvent.event_id],
        );
        expect(await worker.runOnce()).toBe(true);

        const delivery = await db.pool.query<{ status: string }>(
          `select status from event_deliveries
            where consumer_name=$1 and event_id=$2`,
          [consumerName, targetEvent.event_id],
        );
        expect(delivery.rows[0]?.status).toBe("SUCCEEDED");

        const projected = await store.listDerivedProjectionItems({
          spaceId,
          vaultId,
          truthRevisionHash: withdrawn.revisionHash,
          derivedItemRefs: [
            vectorRef,
            factBackedVectorRef,
            physicalVectorRef,
            synthesisRef,
          ],
        });
        const byRef = new Map(
          projected.map((item) => [item.derivedItemRef, item]),
        );
        expect(byRef.get(vectorRef)).toMatchObject({
          derivedStoreKind: "VECTOR",
          state: "UNSUPPORTED",
          valid: false,
          triggerEventId: targetEvent.event_id,
          reason: "SOURCE_WITHDRAWN",
          resourceId: episodeA.id,
        });
        expect(byRef.get(factBackedVectorRef)).toMatchObject({
          derivedStoreKind: "VECTOR",
          state: "UNSUPPORTED",
          valid: false,
          triggerEventId: targetEvent.event_id,
          reason: "SOURCE_WITHDRAWN",
          resourceId: episodeA.id,
        });
        expect(byRef.get(physicalVectorRef)).toMatchObject({
          derivedStoreKind: "VECTOR",
          state: "UNSUPPORTED",
          valid: false,
          triggerEventId: targetEvent.event_id,
          reason: "SOURCE_WITHDRAWN",
          resourceId: episodeA.id,
        });
        expect(byRef.get(synthesisRef)).toMatchObject({
          derivedStoreKind: "CACHED_SYNTHESIS",
          state: "SUPPORTED",
          valid: true,
          triggerEventId: targetEvent.event_id,
          reason: "SOURCE_WITHDRAWN",
          resourceId: episodeA.id,
        });

        expect(
          await store.validateDerivedItems({
            spaceId,
            vaultId,
            derivedStoreKind: "VECTOR",
            derivedItemRefs: [factBackedVectorRef],
            truthRevisionHash: withdrawn.revisionHash,
            validAt: "2026-09-01T00:00:00.000Z",
          }),
        ).toMatchObject([{ state: "UNSUPPORTED", valid: false }]);
        expect(
          await store.validateDerivedItems({
            spaceId,
            vaultId,
            derivedStoreKind: "VECTOR",
            derivedItemRefs: [factBackedVectorRef],
            truthRevisionHash: aOnlyFact.revision.revisionHash,
            validAt: "2026-09-01T00:00:00.000Z",
          }),
        ).toMatchObject([{ state: "SUPPORTED", valid: true }]);

        expect(
          await store.validateDerivedItems({
            spaceId,
            vaultId,
            derivedStoreKind: "VECTOR",
            derivedItemRefs: [vectorRef],
            truthRevisionHash: fact.revision.revisionHash,
            validAt: "2026-09-01T00:00:00.000Z",
          }),
        ).toMatchObject([{ state: "SUPPORTED", valid: true }]);
        expect(
          await store.validateDerivedItems({
            spaceId,
            vaultId,
            derivedStoreKind: "CACHED_SYNTHESIS",
            derivedItemRefs: [synthesisRef],
            truthRevisionHash: fact.revision.revisionHash,
            validAt: "2026-09-01T00:00:00.000Z",
          }),
        ).toMatchObject([{ state: "SUPPORTED", valid: true }]);

        const physical = await db.pool.query<{ count: string }>(
          `select count(*)::text count
             from derived_truth_dependencies
            where space_id=$1 and vault_id=$2
              and derived_item_ref=any($3::text[])`,
          [spaceId, vaultId, [vectorRef, factBackedVectorRef, synthesisRef]],
        );
        expect(physical.rows[0]?.count).toBe("3");

        const physicalAfter = await db.pool.query<{ count: string }>(
          `select count(*)::text count
             from unit_embeddings
            where generation_id=$1 and unit_id=$2`,
          [activeGeneration.generationId, physicalUnitId],
        );
        expect(physicalAfter.rows[0]?.count).toBe("0");
        const historicalDependency = await db.pool.query<{ count: string }>(
          `select count(*)::text count
             from derived_truth_dependencies
            where space_id=$1 and vault_id=$2
              and derived_store_kind='VECTOR'
              and derived_item_ref=$3`,
          [spaceId, vaultId, physicalVectorRef],
        );
        expect(historicalDependency.rows[0]?.count).toBe("1");

        const projectionId = projected[0]?.projectionRevisionId;
        expect(projectionId).toBeTruthy();
        const replayed = await store.rebuildDerivedProjection({
          eventId: targetEvent.event_id,
          spaceId,
          vaultId,
          truthRevisionHash: withdrawn.revisionHash,
          reason: "SOURCE_WITHDRAWN",
          resourceId: episodeA.id,
          validAt:
            targetEvent.occurred_at instanceof Date
              ? targetEvent.occurred_at.toISOString()
              : new Date(targetEvent.occurred_at).toISOString(),
        });
        expect(replayed.id).toBe(projectionId);
        if (!projectionId) throw new Error("truth projection missing");
        const replayCleanup = await store.cleanupInvalidDerivedItems({
          projectionRevisionId: projectionId,
          spaceId,
          vaultId,
        });
        expect(replayCleanup).toMatchObject({
          removedVectors: 0,
          revalidatedUnsupported: 1,
        });
        const projectionCount = await db.pool.query<{ count: string }>(
          `select count(*)::text count
             from derived_truth_projection_revisions
            where trigger_event_id=$1`,
          [targetEvent.event_id],
        );
        expect(projectionCount.rows[0]?.count).toBe("1");
      } finally {
        await db.pool
          .query("delete from event_deliveries where consumer_name=$1", [
            consumerName,
          ])
          .catch(() => undefined);
        await db.pool
          .query("delete from event_consumers where consumer_name=$1", [
            consumerName,
          ])
          .catch(() => undefined);
        await db.pool
          .query("update vaults set enabled=false where id=$1", [vaultId])
          .catch(() => undefined);
        await db.close();
      }
    },
  );
});
