import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Postgres, PostgresTemporalTruthStore } from "../packages/postgres/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const outputPath = path.resolve(
  process.env.AKP_REGISTERED_TEMPORAL_TRUTH_METRICS_REPORT ??
    "reports/ci/registered-temporal-truth-metrics.json",
);

type RateMetric = {
  measured: true;
  value: number;
  numerator: number;
  denominator: number;
  sampleCount: number;
  unit: "ratio";
  scope: "REGISTERED_FIXTURE";
  evidence: string;
  limitation: string;
};

function rate(
  numerator: number,
  denominator: number,
  evidence: string,
  limitation: string,
): RateMetric {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    throw new Error("REGISTERED_TEMPORAL_METRIC_DENOMINATOR_INVALID");
  }
  return {
    measured: true,
    value: numerator / denominator,
    numerator,
    denominator,
    sampleCount: denominator,
    unit: "ratio",
    scope: "REGISTERED_FIXTURE",
    evidence,
    limitation,
  };
}

function ids(values: Array<{ id: string }>): Set<string> {
  return new Set(values.map((value) => value.id));
}

function sameSet(
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): boolean {
  return (
    actual.size === expected.size &&
    [...actual].every((value) => expected.has(value))
  );
}

const db = new Postgres(databaseUrl);
const store = new PostgresTemporalTruthStore(db);
const organizationId = randomUUID();
const spaceId = randomUUID();
const vaultId = randomUUID();

const sourceRows = [
  {
    sourceId: randomUUID(),
    artifactId: randomUUID(),
    hash: "a".repeat(64),
    suffix: "a",
  },
  {
    sourceId: randomUUID(),
    artifactId: randomUUID(),
    hash: "b".repeat(64),
    suffix: "b",
  },
  {
    sourceId: randomUUID(),
    artifactId: randomUUID(),
    hash: "c".repeat(64),
    suffix: "c",
  },
] as const;

try {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'REGISTERED temporal metrics')`,
    [organizationId, `registered-temporal-${organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'REGISTERED temporal metrics space','PRIVATE',$4)`,
    [
      spaceId,
      organizationId,
      `registered-temporal-${spaceId.slice(0, 8)}`,
      `/tmp/registered-temporal-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values(
       $1,$2,$3,'REGISTERED temporal metrics vault',true,'registered-truth:r0',
       $4,$3,'PRIVATE',true
     )`,
    [
      vaultId,
      spaceId,
      `/tmp/registered-temporal-vault-${vaultId}`,
      `registered-temporal-${vaultId.slice(0, 8)}`,
    ],
  );

  for (const source of sourceRows) {
    await db.pool.query(
      `insert into sources(
         id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
         object_key,status,metadata
       ) values(
         $1,$2,$3,$4,$5,'text/plain',$6,4,$7,'ACTIVE','{}'::jsonb
       )`,
      [
        source.sourceId,
        spaceId,
        vaultId,
        `REGISTERED source ${source.suffix}`,
        `https://example.test/registered/${source.suffix}`,
        source.hash,
        `registered/${source.suffix}.txt`,
      ],
    );
    await db.pool.query(
      `insert into source_artifacts(
         id,source_id,kind,object_key,source_hash,extractor,extractor_version,
         quality,metadata
       ) values(
         $1,$2,'normalized',$3,$4,'registered-fixture','1','HIGH','{}'::jsonb
       )`,
      [
        source.artifactId,
        source.sourceId,
        `registered/${source.suffix}.json`,
        source.hash,
      ],
    );
  }

  const episodeA = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId: sourceRows[0].sourceId,
    sourceArtifactId: sourceRows[0].artifactId,
    sourceHash: sourceRows[0].hash,
    observedAt: "2025-01-01T00:00:00.000Z",
    ingestedAt: "2025-01-02T00:00:00.000Z",
    locatorRefs: ["source:a#truth"],
  });
  const supportTime = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episodeA.id],
  });
  const oldFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:tls",
    authorizationPath: "security/tls.md",
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    object: { version: "1.2" },
    validFrom: "2025-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    supportSetId: supportTime.id,
    sourceEpisodeId: episodeA.id,
  });
  const newFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:tls",
    authorizationPath: "security/tls.md",
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    object: { version: "1.3" },
    validFrom: "2026-02-01T00:00:00.000Z",
    recordedAt: "2026-02-01T00:00:00.000Z",
    supportSetId: supportTime.id,
    sourceEpisodeId: episodeA.id,
    supersedesFactId: oldFact.fact.id,
  });

  const current = await store.listFacts({
    spaceId,
    vaultId,
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    validAt: "2026-09-01T00:00:00.000Z",
    truthRevisionHash: newFact.revision.revisionHash,
    authorizationPathPrefixes: ["security"],
  });
  const currentCorrect =
    current.length === 1 &&
    (current[0]?.object as { version?: string }).version === "1.3" &&
    current[0]?.truthState === "SUPPORTED_CURRENT";
  const currentTruthAccuracy = rate(
    currentCorrect ? 1 : 0,
    1,
    "PostgresTemporalTruthStore.listFacts CURRENT at the latest truth revision",
    "Accuracy covers one registered supersession scenario.",
  );

  const asOf = await store.listFacts({
    spaceId,
    vaultId,
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    validAt: "2026-09-01T00:00:00.000Z",
    truthRevisionHash: oldFact.revision.revisionHash,
    authorizationPathPrefixes: ["security"],
  });
  const asOfCorrect =
    asOf.length === 1 &&
    (asOf[0]?.object as { version?: string }).version === "1.2" &&
    asOf[0]?.queryRevisionHash === oldFact.revision.revisionHash;
  const asOfAccuracy = rate(
    asOfCorrect ? 1 : 0,
    1,
    "PostgresTemporalTruthStore.listFacts pinned to the historical truth revision",
    "Accuracy covers one explicit historical revision.",
  );

  const changed = await store.listFacts({
    spaceId,
    vaultId,
    mode: "HISTORY",
    subjectRef: "policy:transport",
    validAt: "2026-09-01T00:00:00.000Z",
    changedSince: "2026-01-15T00:00:00.000Z",
    truthRevisionHash: newFact.revision.revisionHash,
    authorizationPathPrefixes: ["security"],
  });
  const changedExpected = new Set([oldFact.fact.id, newFact.fact.id]);
  const changedSinceAccuracy = rate(
    sameSet(ids(changed), changedExpected) ? 1 : 0,
    1,
    "Temporal HISTORY query with changedSince across a supersession",
    "The registered fixture expects the old and replacement fact to surface as changed.",
  );

  const episodeB = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId: sourceRows[1].sourceId,
    sourceArtifactId: sourceRows[1].artifactId,
    sourceHash: sourceRows[1].hash,
    observedAt: "2025-01-03T00:00:00.000Z",
    ingestedAt: "2025-01-04T00:00:00.000Z",
    locatorRefs: ["source:b#support"],
  });
  const alternativeSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceArtifactIds: [sourceRows[1].artifactId],
    sourceEpisodeIds: [episodeA.id, episodeB.id],
    alternativeSupportGroups: [
      [`source_episode:${episodeA.id}`],
      [
        `source_episode:${episodeB.id}`,
        `source_artifact:${sourceRows[1].artifactId}`,
      ],
    ],
  });
  const resilientFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:mfa",
    authorizationPath: "security/mfa.md",
    subjectRef: "policy:mfa",
    predicate: "required",
    object: { value: true },
    validFrom: "2025-01-01T00:00:00.000Z",
    supportSetId: alternativeSupport.id,
    sourceEpisodeId: episodeA.id,
  });

  const afterA = await store.withdrawSourceEpisode({
    spaceId,
    vaultId,
    sourceEpisodeId: episodeA.id,
    reason: "REGISTERED withdraw A",
  });
  const afterAQuery = await store.listFacts({
    spaceId,
    vaultId,
    subjectRef: "policy:mfa",
    predicate: "required",
    validAt: "2026-09-01T00:00:00.000Z",
    truthRevisionHash: afterA.revisionHash,
    authorizationPathPrefixes: ["security"],
  });
  const alternativeSupportBehavior = rate(
    afterAQuery.length === 1 &&
      afterAQuery[0]?.id === resilientFact.fact.id &&
      afterAQuery[0]?.supportState === "SUPPORTED"
      ? 1
      : 0,
    1,
    "TruthSupportSet alternative support after withdrawing one source episode",
    "One OR-of-support-groups scenario is measured.",
  );

  const afterB = await store.withdrawSourceEpisode({
    spaceId,
    vaultId,
    sourceEpisodeId: episodeB.id,
    reason: "REGISTERED withdraw B",
  });
  const afterBQuery = await store.listFacts({
    spaceId,
    vaultId,
    subjectRef: "policy:mfa",
    predicate: "required",
    validAt: "2026-09-01T00:00:00.000Z",
    truthRevisionHash: afterB.revisionHash,
    authorizationPathPrefixes: ["security"],
  });
  const sourceWithdrawalBehavior = rate(
    Number(afterAQuery.length === 1) + Number(afterBQuery.length === 0),
    2,
    "Sequential source withdrawal over alternative support groups",
    "Two expected post-withdrawal states are measured in one registered fixture.",
  );

  const episodeC = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId: sourceRows[2].sourceId,
    sourceArtifactId: sourceRows[2].artifactId,
    sourceHash: sourceRows[2].hash,
    observedAt: "2025-03-01T00:00:00.000Z",
    ingestedAt: "2025-03-02T00:00:00.000Z",
    locatorRefs: ["source:c#derived"],
  });
  const derivedSupport = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episodeC.id],
    sourceRevisionHashes: ["d".repeat(64)],
  });
  const derivedFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:derived",
    authorizationPath: "security/derived.md",
    subjectRef: "policy:derived",
    predicate: "setting",
    object: { enabled: true },
    validFrom: "2025-01-01T00:00:00.000Z",
    supportSetId: derivedSupport.id,
    sourceEpisodeId: episodeC.id,
  });

  const derivedRefs = [
    { kind: "VECTOR" as const, ref: "vector:registered:unit" },
    { kind: "COMMUNITY_REPORT" as const, ref: "community:registered:summary" },
    { kind: "CACHED_SYNTHESIS" as const, ref: "cache:registered:synthesis" },
  ];
  for (const item of derivedRefs) {
    await store.registerDerivedDependency({
      spaceId,
      vaultId,
      derivedStoreKind: item.kind,
      derivedItemRef: item.ref,
      supportSetId: derivedSupport.id,
      sourceRevisionHashes: ["d".repeat(64)],
      truthRevisionHash: derivedFact.revision.revisionHash,
      projectionRevision: `registered:${item.kind.toLowerCase()}:r1`,
    });
  }
  const snapshot = await store.captureSnapshot(spaceId, [vaultId]);
  const withdrawnDerived = await store.withdrawSourceEpisode({
    spaceId,
    vaultId,
    sourceEpisodeId: episodeC.id,
    reason: "REGISTERED derived support withdrawal",
  });
  const vectorValidation = await store.validateDerivedItems({
    spaceId,
    vaultId,
    derivedStoreKind: "VECTOR",
    derivedItemRefs: ["vector:registered:unit"],
    truthRevisionHash: withdrawnDerived.revisionHash,
    validAt: "2026-09-01T00:00:00.000Z",
  });
  const vectorSuppressed =
    vectorValidation.length === 1 &&
    vectorValidation[0]?.state === "UNSUPPORTED" &&
    vectorValidation[0]?.valid === false;
  const staleVectorSuppression = rate(
    vectorSuppressed ? 1 : 0,
    1,
    "validateDerivedItems VECTOR after source support withdrawal",
    "One registered vector dependency is measured.",
  );

  let communityCacheSuppressed = 0;
  for (const item of derivedRefs.filter((entry) => entry.kind !== "VECTOR")) {
    const validation = await store.validateDerivedItems({
      spaceId,
      vaultId,
      derivedStoreKind: item.kind,
      derivedItemRefs: [item.ref],
      truthRevisionHash: withdrawnDerived.revisionHash,
      validAt: "2026-09-01T00:00:00.000Z",
    });
    if (
      validation.length === 1 &&
      validation[0]?.state === "UNSUPPORTED" &&
      validation[0]?.valid === false
    ) {
      communityCacheSuppressed += 1;
    }
  }
  const staleCommunityCacheSuppression = rate(
    communityCacheSuppressed,
    2,
    "validateDerivedItems COMMUNITY_REPORT and CACHED_SYNTHESIS after support withdrawal",
    "One community report and one cached synthesis dependency are measured.",
  );

  const mixedRevisionDetected = !(await store.snapshotUnchanged(snapshot));
  const mixedRevisionDetection = rate(
    mixedRevisionDetected ? 1 : 0,
    1,
    "TruthSnapshot captured before a later withdrawal revision",
    "Detection is measured as snapshot drift across one registered truth revision change.",
  );

  const temporal = {
    currentTruthAccuracy,
    asOfAccuracy,
    changedSinceAccuracy,
    sourceWithdrawalBehavior,
    alternativeSupportBehavior,
    staleVectorSuppression,
    staleCommunityCacheSuppression,
    mixedRevisionDetection,
  };
  const status = Object.values(temporal).every((metric) => metric.value === 1)
    ? "PROVEN"
    : "FAILED";
  const report = {
    schemaVersion: 1,
    benchmark: "AKP_REGISTERED_TEMPORAL_TRUTH_METRICS",
    commit: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    evidenceLevel: "REGISTERED_SYNTHETIC_RUNTIME_FIXTURE",
    claimPolicy: {
      externalParityClaimAllowed: false,
      fixtureRatesAreProductionRates: false,
      scenarioPassRateRelabelledAsAccuracy: false,
    },
    status,
    fixture: {
      spaceId,
      vaultId,
      sourceEpisodeCount: 3,
      supersessionScenario: true,
      alternativeSupportScenario: true,
      derivedTruthKinds: derivedRefs.map((entry) => entry.kind),
    },
    temporal,
    deferredToNextREGISTEREDSlice: {
      workspaceTeamMetrics: true,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        status,
        outputPath,
        temporal: Object.fromEntries(
          Object.entries(temporal).map(([name, metric]) => [
            name,
            metric.value,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  if (status !== "PROVEN") process.exitCode = 1;
} finally {
  await db.pool
    .query("update vaults set enabled=false where id=$1", [vaultId])
    .catch(() => undefined);
  await db.close();
}
