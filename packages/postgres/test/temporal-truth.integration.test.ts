import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres, PostgresTemporalTruthStore } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const organizationId = randomUUID();
const spaceId = randomUUID();
const vaultId = randomUUID();
let db: Postgres;
let store: PostgresTemporalTruthStore;
let sourceA = "";
let sourceB = "";
let artifactA = "";
let artifactB = "";

beforeAll(async () => {
  if (!databaseUrl) return;
  db = new Postgres(databaseUrl);
  store = new PostgresTemporalTruthStore(db);
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Temporal truth integration')`,
    [organizationId, `truth-${organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Temporal truth space','PRIVATE',$4)`,
    [
      spaceId,
      organizationId,
      `truth-${spaceId.slice(0, 8)}`,
      `/tmp/truth-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,'Temporal truth vault',true,'truth:r0',$4,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/truth-vault-${vaultId}`,
      `truth-${vaultId.slice(0, 8)}`,
    ],
  );

  sourceA = randomUUID();
  sourceB = randomUUID();
  artifactA = randomUUID();
  artifactB = randomUUID();
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
        `https://example.test/${suffix}`,
        hash,
        `truth/${suffix}.txt`,
      ],
    );
    await db.pool.query(
      `insert into source_artifacts(
         id,source_id,kind,object_key,source_hash,extractor,extractor_version,
         quality,metadata
       ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
      [artifactId, sourceId, `truth/${suffix}.json`, hash],
    );
  }
});

afterAll(async () => {
  if (!db) return;
  await db.pool.query("update vaults set enabled=false where id=$1", [vaultId]);
  await db.close();
});

describe.skipIf(!databaseUrl)("temporal truth store", () => {
  it("preserves alternative support and historical truth after withdrawals", async () => {
    const episodeA = await store.createSourceEpisode({
      spaceId,
      vaultId,
      sourceId: sourceA,
      sourceArtifactId: artifactA,
      sourceHash: "a".repeat(64),
      observedAt: "2025-01-02T00:00:00.000Z",
      ingestedAt: "2025-01-10T00:00:00.000Z",
      locatorRefs: ["source:a#policy"],
    });
    const episodeB = await store.createSourceEpisode({
      spaceId,
      vaultId,
      sourceId: sourceB,
      sourceArtifactId: artifactB,
      sourceHash: "b".repeat(64),
      observedAt: "2025-01-03T00:00:00.000Z",
      ingestedAt: "2025-01-11T00:00:00.000Z",
      locatorRefs: ["source:b#policy"],
    });
    const support = await store.createSupportSet({
      spaceId,
      vaultId,
      sourceEpisodeIds: [episodeA.id, episodeB.id],
      alternativeSupportGroups: [
        [`source_episode:${episodeA.id}`],
        [`source_episode:${episodeB.id}`],
      ],
    });
    const recorded = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:admin",
      authorizationPath: "security/admin.md",
      subjectRef: "policy:admin-access",
      predicate: "requires_mfa",
      object: { required: true },
      validFrom: "2025-01-01T00:00:00.000Z",
      supportSetId: support.id,
      sourceEpisodeId: episodeA.id,
    });

    const initial = await store.listFacts({
      spaceId,
      vaultId,
      subjectRef: "policy:admin-access",
      predicate: "requires_mfa",
      validAt: "2025-02-01T00:00:00.000Z",
      truthRevisionHash: recorded.revision.revisionHash,
    });
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ supportState: "SUPPORTED" });

    const afterA = await store.withdrawSourceEpisode({
      spaceId,
      vaultId,
      sourceEpisodeId: episodeA.id,
      reason: "Source A withdrawn",
    });
    const stillSupported = await store.listFacts({
      spaceId,
      vaultId,
      subjectRef: "policy:admin-access",
      predicate: "requires_mfa",
      validAt: "2025-02-01T00:00:00.000Z",
      truthRevisionHash: afterA.revisionHash,
    });
    expect(stillSupported).toHaveLength(1);
    expect(stillSupported[0]?.supportState).toBe("SUPPORTED");

    const afterB = await store.withdrawSourceEpisode({
      spaceId,
      vaultId,
      sourceEpisodeId: episodeB.id,
      reason: "Source B withdrawn",
    });
    expect(
      await store.listFacts({
        spaceId,
        vaultId,
        subjectRef: "policy:admin-access",
        predicate: "requires_mfa",
        validAt: "2025-02-01T00:00:00.000Z",
        truthRevisionHash: afterB.revisionHash,
      }),
    ).toEqual([]);

    const historical = await store.listFacts({
      spaceId,
      vaultId,
      subjectRef: "policy:admin-access",
      predicate: "requires_mfa",
      validAt: "2025-02-01T00:00:00.000Z",
      truthRevisionHash: recorded.revision.revisionHash,
    });
    expect(historical).toHaveLength(1);
    const history = await store.supportHistory(recorded.fact.id);
    expect(history.sourceWithdrawals).toHaveLength(2);
  });

  it("invalidates evidence without erasing the historical supported fact", async () => {
    const evidenceId = randomUUID();
    await db.pool.query(
      `insert into evidence(
         id,space_id,vault_id,source_id,artifact_id,locator,content_hash,
         excerpt,review_status
       ) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'REVIEWED')`,
      [
        evidenceId,
        spaceId,
        vaultId,
        sourceA,
        artifactA,
        JSON.stringify({ source: "a", paragraph: 1 }),
        "c".repeat(64),
        "Evidence-backed transport rule",
      ],
    );
    const support = await store.createSupportSet({
      spaceId,
      vaultId,
      evidenceIds: [evidenceId],
    });
    const recorded = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:evidence",
      authorizationPath: "security/evidence.md",
      subjectRef: "policy:evidence-backed",
      predicate: "enabled",
      object: { value: true },
      validFrom: "2025-01-01T00:00:00.000Z",
      supportSetId: support.id,
    });
    expect(
      await store.listFacts({
        spaceId,
        vaultId,
        subjectRef: "policy:evidence-backed",
        truthRevisionHash: recorded.revision.revisionHash,
        validAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject([{ supportState: "SUPPORTED" }]);

    const invalidated = await store.invalidateEvidence({
      spaceId,
      vaultId,
      evidenceId,
      reason: "Evidence failed integrity review",
    });
    expect(
      await store.listFacts({
        spaceId,
        vaultId,
        subjectRef: "policy:evidence-backed",
        truthRevisionHash: invalidated.revisionHash,
        validAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual([]);
    expect(
      await store.listFacts({
        spaceId,
        vaultId,
        subjectRef: "policy:evidence-backed",
        truthRevisionHash: recorded.revision.revisionHash,
        validAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject([{ supportState: "SUPPORTED" }]);

    const history = await store.supportHistory(recorded.fact.id);
    expect(history.evidenceInvalidations).toHaveLength(1);
    expect(history.evidenceInvalidations[0]).toMatchObject({
      evidence_id: evidenceId,
      truth_revision_hash: invalidated.revisionHash,
    });
    const events = await db.pool.query<{ event_type: string }>(
      `select event_type from event_outbox
        where resource_id=$1 and space_id=$2 and vault_id=$3
          and event_type in ('EvidenceInvalidated','DerivedSupportInvalidationRequested')
        order by event_type`,
      [evidenceId, spaceId, vaultId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "DerivedSupportInvalidationRequested",
      "EvidenceInvalidated",
    ]);
  });

  it("separates valid time from recorded truth and delays future supersession", async () => {
    const episode = await store.createSourceEpisode({
      spaceId,
      vaultId,
      sourceId: sourceA,
      sourceArtifactId: artifactA,
      sourceHash: "a".repeat(64),
      locatorRefs: ["source:a#tls"],
    });
    const support = await store.createSupportSet({
      spaceId,
      vaultId,
      sourceEpisodeIds: [episode.id],
    });
    const old = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:tls",
      authorizationPath: "security/tls.md",
      subjectRef: "policy:transport",
      predicate: "tls_minimum",
      object: { version: "1.2" },
      validFrom: "2024-01-01T00:00:00.000Z",
      supportSetId: support.id,
    });
    const future = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:tls",
      authorizationPath: "security/tls.md",
      subjectRef: "policy:transport",
      predicate: "tls_minimum",
      object: { version: "1.3" },
      validFrom: "2027-01-01T00:00:00.000Z",
      supportSetId: support.id,
      supersedesFactId: old.fact.id,
    });

    const beforeEffective = await store.listFacts({
      spaceId,
      vaultId,
      subjectRef: "policy:transport",
      predicate: "tls_minimum",
      validAt: "2026-06-01T00:00:00.000Z",
      truthRevisionHash: future.revision.revisionHash,
    });
    expect(beforeEffective.map((fact) => fact.object)).toEqual([
      { version: "1.2" },
    ]);

    const afterEffective = await store.listFacts({
      spaceId,
      vaultId,
      subjectRef: "policy:transport",
      predicate: "tls_minimum",
      validAt: "2027-02-01T00:00:00.000Z",
      truthRevisionHash: future.revision.revisionHash,
    });
    expect(afterEffective.map((fact) => fact.object)).toEqual([
      { version: "1.3" },
    ]);

    const late = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:legacy",
      authorizationPath: "security/legacy.md",
      subjectRef: "policy:legacy",
      predicate: "effective_rule",
      object: { value: "older-but-learned-later" },
      validFrom: "2020-01-01T00:00:00.000Z",
      supportSetId: support.id,
    });
    expect(
      await store.listFacts({
        spaceId,
        vaultId,
        subjectRef: "policy:legacy",
        validAt: "2026-01-01T00:00:00.000Z",
        truthRevisionHash: future.revision.revisionHash,
      }),
    ).toEqual([]);
    expect(
      await store.listFacts({
        spaceId,
        vaultId,
        subjectRef: "policy:legacy",
        validAt: "2026-01-01T00:00:00.000Z",
        truthRevisionHash: late.revision.revisionHash,
      }),
    ).toHaveLength(1);
  });

  it("keeps facts append-only and exposes disputed support", async () => {
    const episode = await store.createSourceEpisode({
      spaceId,
      vaultId,
      sourceId: sourceA,
      sourceArtifactId: artifactA,
      sourceHash: "a".repeat(64),
      locatorRefs: ["source:a#dispute"],
    });
    const support = await store.createSupportSet({
      spaceId,
      vaultId,
      state: "DISPUTED",
      sourceEpisodeIds: [episode.id],
    });
    const recorded = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:disputed",
      authorizationPath: "security/disputed.md",
      subjectRef: "policy:disputed",
      predicate: "setting",
      object: { enabled: false },
      validFrom: "2025-01-01T00:00:00.000Z",
      supportSetId: support.id,
      lifecycle: "DISPUTED",
    });
    const facts = await store.listFacts({
      spaceId,
      vaultId,
      subjectRef: "policy:disputed",
      truthRevisionHash: recorded.revision.revisionHash,
      validAt: "2026-01-01T00:00:00.000Z",
    });
    expect(facts[0]?.supportState).toBe("DISPUTED");
    await expect(
      db.pool.query(
        "update temporal_facts set predicate='mutated' where id=$1",
        [recorded.fact.id],
      ),
    ).rejects.toThrow("TEMPORAL_TRUTH_IMMUTABLE");
  });

  it("validates immutable derived dependencies against a captured truth revision", async () => {
    const episode = await store.createSourceEpisode({
      spaceId,
      vaultId,
      sourceId: sourceA,
      sourceArtifactId: artifactA,
      sourceHash: "a".repeat(64),
      locatorRefs: ["source:a#derived-vector"],
    });
    const support = await store.createSupportSet({
      spaceId,
      vaultId,
      sourceEpisodeIds: [episode.id],
      sourceRevisionHashes: ["d".repeat(64)],
    });
    const recorded = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:derived",
      authorizationPath: "security/derived.md",
      subjectRef: "policy:derived-vector",
      predicate: "setting",
      object: { enabled: true },
      validFrom: "2025-01-01T00:00:00.000Z",
      supportSetId: support.id,
      sourceEpisodeId: episode.id,
    });
    const dependency = await store.registerDerivedDependency({
      spaceId,
      vaultId,
      derivedStoreKind: "VECTOR",
      derivedItemRef: "vector:generation-a:unit-a",
      supportSetId: support.id,
      sourceRevisionHashes: ["d".repeat(64)],
      truthRevisionHash: recorded.revision.revisionHash,
      projectionRevision: "vector:r1",
    });
    expect(dependency).toMatchObject({
      derivedStoreKind: "VECTOR",
      derivedItemRef: "vector:generation-a:unit-a",
      supportSetId: support.id,
      truthRevisionHash: recorded.revision.revisionHash,
    });

    const snapshot = await store.captureSnapshot(spaceId, [vaultId]);
    expect(snapshot.vaults).toEqual([
      {
        vaultId,
        revisionHash: recorded.revision.revisionHash,
        revisionSeq: recorded.revision.revisionSeq,
      },
    ]);
    expect(await store.snapshotUnchanged(snapshot)).toBe(true);
    expect(
      await store.validateDerivedItems({
        spaceId,
        vaultId,
        derivedStoreKind: "VECTOR",
        derivedItemRefs: [
          "vector:generation-a:unit-a",
          "vector:generation-a:unit-unannotated",
        ],
        truthRevisionHash: recorded.revision.revisionHash,
        validAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject([
      {
        derivedItemRef: "vector:generation-a:unit-a",
        state: "SUPPORTED",
        valid: true,
      },
      {
        derivedItemRef: "vector:generation-a:unit-unannotated",
        state: "UNANNOTATED",
        valid: true,
      },
    ]);

    const withdrawn = await store.withdrawSourceEpisode({
      spaceId,
      vaultId,
      sourceEpisodeId: episode.id,
      reason: "Derived vector support withdrawn",
    });
    expect(await store.snapshotUnchanged(snapshot)).toBe(false);
    expect(
      await store.validateDerivedItems({
        spaceId,
        vaultId,
        derivedStoreKind: "VECTOR",
        derivedItemRefs: ["vector:generation-a:unit-a"],
        truthRevisionHash: withdrawn.revisionHash,
        validAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject([
      {
        derivedItemRef: "vector:generation-a:unit-a",
        state: "UNSUPPORTED",
        valid: false,
        dependency: {
          id: dependency.id,
          supportSetId: support.id,
        },
        queryRevisionHash: withdrawn.revisionHash,
      },
    ]);
    expect(
      await store.validateDerivedItems({
        spaceId,
        vaultId,
        derivedStoreKind: "VECTOR",
        derivedItemRefs: ["vector:generation-a:unit-a"],
        truthRevisionHash: recorded.revision.revisionHash,
        validAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject([
      {
        state: "SUPPORTED",
        valid: true,
        queryRevisionHash: recorded.revision.revisionHash,
      },
    ]);
  });

  it("rejects a derived item that only becomes annotated in a future truth revision", async () => {
    const episode = await store.createSourceEpisode({
      spaceId,
      vaultId,
      sourceId: sourceA,
      sourceArtifactId: artifactA,
      sourceHash: "e".repeat(64),
      locatorRefs: ["source:a#future-derived"],
    });
    const support = await store.createSupportSet({
      spaceId,
      vaultId,
      sourceEpisodeIds: [episode.id],
      sourceRevisionHashes: ["e".repeat(64)],
    });
    const historical = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:historical-derived",
      authorizationPath: "security/historical-derived.md",
      subjectRef: "policy:historical-derived",
      predicate: "setting",
      object: { version: "old" },
      validFrom: "2025-01-01T00:00:00.000Z",
      supportSetId: support.id,
      sourceEpisodeId: episode.id,
    });
    const current = await store.recordFact({
      spaceId,
      vaultId,
      scopeId: "security:future-derived",
      authorizationPath: "security/future-derived.md",
      subjectRef: "policy:future-derived",
      predicate: "setting",
      object: { version: "new" },
      validFrom: "2026-01-01T00:00:00.000Z",
      supportSetId: support.id,
      sourceEpisodeId: episode.id,
    });
    const dependency = await store.registerDerivedDependency({
      spaceId,
      vaultId,
      derivedStoreKind: "VECTOR",
      derivedItemRef: "vector:generation-future:unit-future",
      supportSetId: support.id,
      sourceRevisionHashes: ["e".repeat(64)],
      truthRevisionHash: current.revision.revisionHash,
      projectionRevision: "vector:future",
    });

    expect(
      await store.validateDerivedItems({
        spaceId,
        vaultId,
        derivedStoreKind: "VECTOR",
        derivedItemRefs: [
          "vector:generation-future:unit-future",
          "vector:never-annotated:unit",
        ],
        truthRevisionHash: historical.revision.revisionHash,
        validAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toMatchObject([
      {
        derivedItemRef: "vector:generation-future:unit-future",
        state: "UNSUPPORTED",
        valid: false,
        dependency: {
          id: dependency.id,
          truthRevisionHash: current.revision.revisionHash,
        },
        queryRevisionHash: historical.revision.revisionHash,
      },
      {
        derivedItemRef: "vector:never-annotated:unit",
        state: "UNANNOTATED",
        valid: true,
        dependency: null,
        queryRevisionHash: historical.revision.revisionHash,
      },
    ]);
  });
});
