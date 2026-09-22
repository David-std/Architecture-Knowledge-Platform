import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
} from "../src/index.js";

type StrategyId =
  | "STRUCTURE_FIRST"
  | "CONTEXTUAL_PREFIX"
  | "PARENT_CHILD_COMPOSITION";

type Unit = {
  id: string;
  parentId: string;
  claimId: string;
  locatorRef: string;
  headingPath: string[];
  parentBody: string;
  childBody: string;
};

type QueryCase = {
  id: string;
  query: string;
  goldClaimIds: string[];
};

type QueryVector = {
  vector: number[];
  embeddingLatencyMs: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CONTEXTUAL_CHUNK_REPORT ??
    "reports/ci/contextual-chunk-benchmark.json",
);
const topK = 2;

const units: Unit[] = [
  {
    id: "payments-token-rotation",
    parentId: "payments-auth",
    claimId: "PAYMENTS_TOKEN_ROTATION_INTERVAL",
    locatorRef: "fixture://payments/auth.md#L14-L18",
    headingPath: ["Payments API", "Access token rotation"],
    parentBody:
      "Payments API access tokens use short-lived signing material. Rotation must preserve active checkout traffic while limiting replay exposure.",
    childBody:
      "Rotate active signing material every 24 hours and keep the previous key valid for a 15 minute grace window.",
  },
  {
    id: "payments-token-storage",
    parentId: "payments-auth",
    claimId: "PAYMENTS_TOKEN_STORAGE",
    locatorRef: "fixture://payments/auth.md#L20-L24",
    headingPath: ["Payments API", "Access token storage"],
    parentBody:
      "Payments API access tokens use short-lived signing material. Rotation must preserve active checkout traffic while limiting replay exposure.",
    childBody:
      "Browser-facing session material is kept in an HttpOnly cookie and is never persisted in localStorage.",
  },
  {
    id: "backup-key-rotation",
    parentId: "backup-crypto",
    claimId: "BACKUP_KEY_ROTATION_INTERVAL",
    locatorRef: "fixture://operations/backups.md#L31-L35",
    headingPath: ["Backups", "Encryption key rotation"],
    parentBody:
      "Encrypted backup archives use a separate key hierarchy from online authentication. Recovery jobs may overlap key rollover.",
    childBody:
      "Rotate active key material every 24 hours and retain the previous key until the verification job completes.",
  },
  {
    id: "backup-retention",
    parentId: "backup-crypto",
    claimId: "BACKUP_RETENTION_WINDOW",
    locatorRef: "fixture://operations/backups.md#L37-L40",
    headingPath: ["Backups", "Retention"],
    parentBody:
      "Encrypted backup archives use a separate key hierarchy from online authentication. Recovery jobs may overlap key rollover.",
    childBody:
      "Retain daily recovery points for 35 days before archival deletion.",
  },
  {
    id: "catalog-timeout",
    parentId: "catalog-runtime",
    claimId: "CATALOG_DEPENDENCY_TIMEOUT",
    locatorRef: "fixture://catalog/runtime.md#L8-L12",
    headingPath: ["Catalog service", "Dependency timeout"],
    parentBody:
      "The catalog service calls the inventory service synchronously for availability checks on the request path.",
    childBody:
      "Use a 250 millisecond request timeout and return degraded availability when the dependency does not answer.",
  },
  {
    id: "billing-timeout",
    parentId: "billing-runtime",
    claimId: "BILLING_DEPENDENCY_TIMEOUT",
    locatorRef: "fixture://billing/runtime.md#L8-L12",
    headingPath: ["Billing service", "Dependency timeout"],
    parentBody:
      "The billing service calls the tax service synchronously only while finalizing an invoice.",
    childBody:
      "Use a 250 millisecond request timeout and retry only idempotent tax lookups.",
  },
  {
    id: "portal-human-session",
    parentId: "portal-session",
    claimId: "PORTAL_SESSION_EXPIRY",
    locatorRef: "fixture://portal/sesiones.md#L11-L15",
    headingPath: ["Portal empresarial", "Expiración de sesión"],
    parentBody:
      "El portal empresarial autentica a operadores humanos y aplica controles distintos a los tokens de servicio.",
    childBody:
      "La sesión interactiva expira después de 20 minutos de inactividad y requiere autenticación nuevamente.",
  },
  {
    id: "portal-service-token",
    parentId: "portal-service-auth",
    claimId: "PORTAL_SERVICE_TOKEN_EXPIRY",
    locatorRef: "fixture://portal/servicios.md#L11-L15",
    headingPath: ["Portal empresarial", "Tokens entre servicios"],
    parentBody:
      "Los procesos internos del portal usan credenciales de servicio independientes de las sesiones humanas.",
    childBody:
      "El token técnico expira después de 20 minutos y puede renovarse de forma automática por el proceso autorizado.",
  },
];

const queries: QueryCase[] = [
  {
    id: "payments-rotation",
    query: "payments access token signing key rotation interval",
    goldClaimIds: ["PAYMENTS_TOKEN_ROTATION_INTERVAL"],
  },
  {
    id: "payments-storage",
    query: "where should the payments browser session token be stored",
    goldClaimIds: ["PAYMENTS_TOKEN_STORAGE"],
  },
  {
    id: "backup-rotation",
    query: "backup encryption key rotation interval during recovery",
    goldClaimIds: ["BACKUP_KEY_ROTATION_INTERVAL"],
  },
  {
    id: "catalog-timeout",
    query: "catalog inventory dependency timeout",
    goldClaimIds: ["CATALOG_DEPENDENCY_TIMEOUT"],
  },
  {
    id: "billing-timeout",
    query: "billing tax service dependency timeout",
    goldClaimIds: ["BILLING_DEPENDENCY_TIMEOUT"],
  },
  {
    id: "spanish-human-session",
    query:
      "cuándo expira la sesión humana del portal empresarial por inactividad",
    goldClaimIds: ["PORTAL_SESSION_EXPIRY"],
  },
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? 0;
}

function normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("CONTEXTUAL_CHUNK_ZERO_VECTOR");
  }
  return vector.map((value) => value / norm);
}

function composeParentChild(
  child: readonly number[],
  parent: readonly number[],
): number[] {
  if (child.length !== parent.length) {
    throw new Error("CONTEXTUAL_CHUNK_VECTOR_DIMENSION_MISMATCH");
  }
  return normalize(
    child.map(
      (value, index) => value * 0.7 + (parent[index] ?? 0) * 0.3,
    ),
  );
}

function dot(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error("CONTEXTUAL_CHUNK_VECTOR_DIMENSION_MISMATCH");
  }
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function contextualPrefix(unit: Unit): string {
  return [
    "Path: " + unit.headingPath.join(" > "),
    "Parent context: " + unit.parentBody,
    "Chunk: " + unit.childBody,
  ].join("\n");
}

function locatorSetHash(): string {
  return sha256(
    JSON.stringify(units.map((unit) => unit.locatorRef).sort()),
  );
}

async function buildStrategy(
  adapter: LocalSemanticEmbeddingAdapter,
  id: StrategyId,
): Promise<{
  vectors: number[][];
  buildMs: number;
  updateMs: number;
  vectorCount: number;
  representationBytes: number;
}> {
  const started = performance.now();
  let vectors: number[][] = [];
  let vectorCount = 0;
  let representationBytes = 0;

  if (id === "STRUCTURE_FIRST") {
    const texts = units.map((unit) => unit.childBody);
    vectors = await adapter.embedPassages(texts);
    vectorCount = vectors.length;
    representationBytes = texts.reduce(
      (sum, value) => sum + Buffer.byteLength(value, "utf8"),
      0,
    );
  } else if (id === "CONTEXTUAL_PREFIX") {
    const texts = units.map(contextualPrefix);
    vectors = await adapter.embedPassages(texts);
    vectorCount = vectors.length;
    representationBytes = texts.reduce(
      (sum, value) => sum + Buffer.byteLength(value, "utf8"),
      0,
    );
  } else {
    const childTexts = units.map((unit) => unit.childBody);
    const parents = [
      ...new Map(
        units.map((unit) => [unit.parentId, unit.parentBody] as const),
      ).entries(),
    ];
    const childVectors = await adapter.embedPassages(childTexts);
    const parentVectors = await adapter.embedPassages(
      parents.map(([, body]) => body),
    );
    const parentById = new Map(
      parents.map(([parentId], index) => [
        parentId,
        parentVectors[index] as number[],
      ]),
    );
    vectors = units.map((unit, index) => {
      const child = childVectors[index];
      const parent = parentById.get(unit.parentId);
      if (!child || !parent) {
        throw new Error("CONTEXTUAL_CHUNK_PARENT_VECTOR_MISSING");
      }
      return composeParentChild(child, parent);
    });
    vectorCount = childVectors.length + parentVectors.length;
    representationBytes = [
      ...childTexts,
      ...parents.map(([, body]) => body),
    ].reduce(
      (sum, value) => sum + Buffer.byteLength(value, "utf8"),
      0,
    );
  }

  const buildMs = performance.now() - started;
  if (vectors.length !== units.length) {
    throw new Error("CONTEXTUAL_CHUNK_VECTOR_COUNT_INVALID");
  }

  const changed = units[0];
  if (!changed) throw new Error("CONTEXTUAL_CHUNK_FIXTURE_EMPTY");
  const updateStarted = performance.now();
  const updatedBody = changed.childBody + " Controlled revision delta.";
  if (id === "CONTEXTUAL_PREFIX") {
    await adapter.embedPassages([
      contextualPrefix({ ...changed, childBody: updatedBody }),
    ]);
  } else {
    await adapter.embedPassages([updatedBody]);
  }

  return {
    vectors,
    buildMs,
    updateMs: performance.now() - updateStarted,
    vectorCount,
    representationBytes,
  };
}

async function measureStrategy(
  adapter: LocalSemanticEmbeddingAdapter,
  id: StrategyId,
  queryVectors: QueryVector[],
) {
  const built = await buildStrategy(adapter, id);
  let recalledClaims = 0;
  let totalGoldClaims = 0;
  let relevantRetrieved = 0;
  let totalRetrieved = 0;
  const queryLatencies: number[] = [];
  const ranking: Array<{ queryId: string; rankedClaimIds: string[] }> = [];

  for (const [queryIndex, query] of queries.entries()) {
    const prepared = queryVectors[queryIndex];
    if (!prepared) {
      throw new Error("CONTEXTUAL_CHUNK_QUERY_VECTOR_MISSING");
    }
    const rankingStarted = performance.now();
    const ranked = units
      .map((unit, index) => ({
        claimId: unit.claimId,
        score: dot(prepared.vector, built.vectors[index] ?? []),
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.claimId.localeCompare(right.claimId),
      )
      .slice(0, topK);
    const rankingMs = performance.now() - rankingStarted;
    queryLatencies.push(prepared.embeddingLatencyMs + rankingMs);
    const rankedClaimIds = ranked.map((item) => item.claimId);
    ranking.push({ queryId: query.id, rankedClaimIds });

    const gold = new Set(query.goldClaimIds);
    totalGoldClaims += gold.size;
    recalledClaims += query.goldClaimIds.filter((claimId) =>
      rankedClaimIds.includes(claimId),
    ).length;
    relevantRetrieved += rankedClaimIds.filter((claimId) =>
      gold.has(claimId),
    ).length;
    totalRetrieved += rankedClaimIds.length;
  }

  const dimensions = LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.dimensions;
  return {
    id,
    representation:
      id === "STRUCTURE_FIRST"
        ? "atomic structural child"
        : id === "CONTEXTUAL_PREFIX"
          ? "heading path + bounded parent context + atomic child"
          : "0.7 child vector + 0.3 reusable parent vector, L2 normalized",
    claimRecallAtK: recalledClaims / totalGoldClaims,
    contextPrecisionAtK: relevantRetrieved / totalRetrieved,
    storage: {
      vectorCount: built.vectorCount,
      vectorBytes: built.vectorCount * dimensions * 4,
      representationBytes: built.representationBytes,
    },
    latency: {
      buildMs: built.buildMs,
      updateMs: built.updateMs,
      meanQueryMs:
        queryLatencies.reduce((sum, value) => sum + value, 0) /
        queryLatencies.length,
      p95QueryMs: percentile(queryLatencies, 0.95),
      querySamples: queryLatencies.length,
    },
    locatorSetHash: locatorSetHash(),
    ranking,
  };
}

const adapter = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 16,
});

try {
  await adapter.load();

  const queryVectors: QueryVector[] = [];
  for (const query of queries) {
    const started = performance.now();
    const [vector] = await adapter.embedQueries([query.query]);
    if (!vector) {
      throw new Error("CONTEXTUAL_CHUNK_QUERY_VECTOR_MISSING");
    }
    queryVectors.push({
      vector,
      embeddingLatencyMs: performance.now() - started,
    });
  }

  const strategies = [];
  for (const id of [
    "STRUCTURE_FIRST",
    "CONTEXTUAL_PREFIX",
    "PARENT_CHILD_COMPOSITION",
  ] as const) {
    strategies.push(await measureStrategy(adapter, id, queryVectors));
  }

  const expectedLocatorHash = locatorSetHash();
  if (
    strategies.some(
      (strategy) => strategy.locatorSetHash !== expectedLocatorHash,
    )
  ) {
    throw new Error("CONTEXTUAL_CHUNK_LOCATOR_IDENTITY_CHANGED");
  }

  for (const strategy of strategies) {
    for (const metric of [
      strategy.claimRecallAtK,
      strategy.contextPrecisionAtK,
      strategy.latency.buildMs,
      strategy.latency.updateMs,
      strategy.latency.meanQueryMs,
      strategy.latency.p95QueryMs,
    ]) {
      if (!Number.isFinite(metric) || metric < 0) {
        throw new Error("CONTEXTUAL_CHUNK_METRIC_INVALID:" + strategy.id);
      }
    }
  }

  const report = {
    schemaVersion: 1,
    evidenceLevel:
      "REAL_PINNED_MODEL_CONTROLLED_CONTEXTUAL_CHUNK_BENCHMARK",
    status: "PROVEN",
    productionDefaultsChanged: false,
    winner: null,
    topK,
    provider: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
    fixture: {
      units: units.length,
      queries: queries.length,
      languages: ["en", "es"],
      locatorSetHash: expectedLocatorHash,
      fixtureHash: sha256(JSON.stringify({ units, queries })),
    },
    strategies,
    lateChunking: {
      status: "NOT_APPLICABLE_CURRENT_PROVIDER",
      reason:
        "The pinned multilingual-e5-small adapter exposes pooled sentence embeddings with a 512-token input bound, not token-level long-context representations required to apply late chunking faithfully.",
      providerMaxTokens:
        LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.runtime.maxTokens,
      tokenLevelOutputAvailable: false,
    },
    interpretationBoundary:
      "This benchmark measures representation trade-offs only. It does not change retrieval defaults, structural locators, authorization, provenance, or canonical knowledge.",
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        status: report.status,
        productionDefaultsChanged: report.productionDefaultsChanged,
        strategies: report.strategies.map((strategy) => ({
          id: strategy.id,
          claimRecallAtK: strategy.claimRecallAtK,
          contextPrecisionAtK: strategy.contextPrecisionAtK,
          buildMs: strategy.latency.buildMs,
          updateMs: strategy.latency.updateMs,
          meanQueryMs: strategy.latency.meanQueryMs,
          vectorBytes: strategy.storage.vectorBytes,
        })),
        lateChunking: report.lateChunking,
      },
      null,
      2,
    ),
  );
} finally {
  await adapter.dispose();
}
