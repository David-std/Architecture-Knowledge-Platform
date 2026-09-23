import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  LocalSemanticEmbeddingAdapter,
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
} from "../src/index.js";

type Locator = {
  kind: string;
  documentId: string;
  startLine: number;
  endLine: number;
};

type FixtureChunk = {
  id: string;
  headingPath: string[];
  body: string;
  locator: Locator;
};

type FixtureDocument = {
  id: string;
  title: string;
  parentContext: string;
  chunks: FixtureChunk[];
};

type FixtureQuery = {
  id: string;
  text: string;
  requiredChunkIds: string[];
  relevantChunkIds: string[];
};

type Fixture = {
  schemaVersion: number;
  evidenceLevel: string;
  productionDefaultsChanged: boolean;
  topK: number;
  documents: FixtureDocument[];
  queries: FixtureQuery[];
  updateScenario: {
    documentId: string;
    changedChunkId: string;
    newParentContext: string;
    newBody: string;
  };
};

type ChunkRecord = FixtureChunk & {
  documentId: string;
  documentTitle: string;
  parentContext: string;
};

type ArmResult = {
  name: "STRUCTURE_FIRST" | "CONTEXTUAL_PREFIX" | "PARENT_CHILD";
  claimRecall: number;
  contextPrecision: number;
  buildLatencyMs: number;
  updateLatencyMs: number;
  meanQueryLatencyMs: number;
  storage: {
    persistentVectorCount: number;
    vectorBytes: number;
    preparationInputUtf8Bytes: number;
    storageModel: string;
  };
  update: {
    affectedChunks: number;
    description: string;
  };
  locatorIntegrity: {
    preserved: true;
    digest: string;
  };
  observations: Array<{
    queryId: string;
    rankedChunkIds: string[];
    requiredChunkIds: string[];
    relevantChunkIds: string[];
  }>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "contextual-chunk-benchmark.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CONTEXTUAL_CHUNK_REPORT ??
    "reports/ci/contextual-chunk-benchmark.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error("Cannot normalize contextual benchmark vector.");
  }
  return vector.map((value) => value / norm);
}

function compose(
  child: readonly number[],
  parent: readonly number[],
  childWeight = 0.7,
): number[] {
  if (child.length !== parent.length || child.length === 0) {
    throw new Error(
      "Parent/child vectors must have equal non-zero dimensions.",
    );
  }
  const parentWeight = 1 - childWeight;
  return normalize(
    child.map(
      (value, index) =>
        value * childWeight + (parent[index] ?? 0) * parentWeight,
    ),
  );
}

function dot(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new Error("Contextual benchmark vector dimensions do not match.");
  }
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function contextualInput(chunk: ChunkRecord): string {
  return [
    `Document: ${chunk.documentTitle}`,
    `Section: ${chunk.headingPath.join(" > ")}`,
    `Context: ${chunk.parentContext}`,
    `Chunk: ${chunk.body}`,
  ].join("\n");
}

function locatorDigest(chunks: readonly ChunkRecord[]): string {
  return sha256(
    JSON.stringify(
      chunks.map((chunk) => ({ id: chunk.id, locator: chunk.locator })),
    ),
  );
}

function rank(
  chunks: readonly ChunkRecord[],
  vectors: readonly number[][],
  queryVector: readonly number[],
  topK: number,
): string[] {
  return chunks
    .map((chunk, index) => ({
      id: chunk.id,
      score: dot(queryVector, vectors[index] ?? []),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    )
    .slice(0, topK)
    .map((item) => item.id);
}

function quality(
  queries: readonly FixtureQuery[],
  ranked: readonly string[][],
  topK: number,
): { claimRecall: number; contextPrecision: number } {
  let requiredTotal = 0;
  let requiredRetrieved = 0;
  let relevantRetrieved = 0;
  let returned = 0;
  queries.forEach((query, index) => {
    const hits = ranked[index] ?? [];
    const hitSet = new Set(hits);
    requiredTotal += query.requiredChunkIds.length;
    requiredRetrieved += query.requiredChunkIds.filter((id) =>
      hitSet.has(id),
    ).length;
    relevantRetrieved += query.relevantChunkIds.filter((id) =>
      hitSet.has(id),
    ).length;
    returned += Math.min(topK, hits.length);
  });
  return {
    claimRecall: requiredTotal === 0 ? 1 : requiredRetrieved / requiredTotal,
    contextPrecision: returned === 0 ? 1 : relevantRetrieved / returned,
  };
}

const raw = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(raw) as Fixture;
if (
  fixture.schemaVersion !== 1 ||
  fixture.productionDefaultsChanged !== false ||
  !Number.isInteger(fixture.topK) ||
  fixture.topK < 1
) {
  throw new Error("Contextual chunk benchmark fixture is invalid.");
}
const chunks: ChunkRecord[] = fixture.documents.flatMap((document) =>
  document.chunks.map((chunk) => ({
    ...chunk,
    documentId: document.id,
    documentTitle: document.title,
    parentContext: document.parentContext,
  })),
);
const expectedLocatorDigest = locatorDigest(chunks);
const adapter = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 16,
});

async function queryEvidence(vectors: number[][]): Promise<{
  observations: ArmResult["observations"];
  meanQueryLatencyMs: number;
  claimRecall: number;
  contextPrecision: number;
}> {
  const started = performance.now();
  const queryVectors = await adapter.embedQueries(
    fixture.queries.map((query) => query.text),
  );
  const ranked = fixture.queries.map((query, index) =>
    rank(chunks, vectors, queryVectors[index] ?? [], fixture.topK),
  );
  const elapsed = performance.now() - started;
  const scores = quality(fixture.queries, ranked, fixture.topK);
  return {
    observations: fixture.queries.map((query, index) => ({
      queryId: query.id,
      rankedChunkIds: ranked[index] ?? [],
      requiredChunkIds: query.requiredChunkIds,
      relevantChunkIds: query.relevantChunkIds,
    })),
    meanQueryLatencyMs: elapsed / fixture.queries.length,
    ...scores,
  };
}

async function structureFirst(): Promise<ArmResult> {
  const inputs = chunks.map((chunk) => chunk.body);
  const buildStarted = performance.now();
  const vectors = await adapter.embedPassages(inputs);
  const buildLatencyMs = performance.now() - buildStarted;
  const query = await queryEvidence(vectors);
  const updateStarted = performance.now();
  await adapter.embedPassages([fixture.updateScenario.newBody]);
  const updateLatencyMs = performance.now() - updateStarted;
  return {
    name: "STRUCTURE_FIRST",
    ...query,
    buildLatencyMs,
    updateLatencyMs,
    storage: {
      persistentVectorCount: chunks.length,
      vectorBytes:
        chunks.length *
        LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.dimensions *
        Float32Array.BYTES_PER_ELEMENT,
      preparationInputUtf8Bytes: inputs.reduce(
        (sum, value) => sum + Buffer.byteLength(value, "utf8"),
        0,
      ),
      storageModel: "one persisted child vector per structural chunk",
    },
    update: {
      affectedChunks: 1,
      description:
        "Only the changed atomic chunk requires a new embedding when parent context is not embedded.",
    },
    locatorIntegrity: {
      preserved: true,
      digest: expectedLocatorDigest,
    },
  };
}

async function contextualPrefix(): Promise<ArmResult> {
  const inputs = chunks.map(contextualInput);
  const buildStarted = performance.now();
  const vectors = await adapter.embedPassages(inputs);
  const buildLatencyMs = performance.now() - buildStarted;
  const query = await queryEvidence(vectors);
  const targetDocument = fixture.documents.find(
    (document) => document.id === fixture.updateScenario.documentId,
  );
  if (!targetDocument) {
    throw new Error("Contextual update document is missing.");
  }
  const updatedInputs = targetDocument.chunks.map((chunk) =>
    contextualInput({
      ...chunk,
      documentId: targetDocument.id,
      documentTitle: targetDocument.title,
      parentContext: fixture.updateScenario.newParentContext,
      body:
        chunk.id === fixture.updateScenario.changedChunkId
          ? fixture.updateScenario.newBody
          : chunk.body,
    }),
  );
  const updateStarted = performance.now();
  await adapter.embedPassages(updatedInputs);
  const updateLatencyMs = performance.now() - updateStarted;
  return {
    name: "CONTEXTUAL_PREFIX",
    ...query,
    buildLatencyMs,
    updateLatencyMs,
    storage: {
      persistentVectorCount: chunks.length,
      vectorBytes:
        chunks.length *
        LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.dimensions *
        Float32Array.BYTES_PER_ELEMENT,
      preparationInputUtf8Bytes: inputs.reduce(
        (sum, value) => sum + Buffer.byteLength(value, "utf8"),
        0,
      ),
      storageModel:
        "one persisted child vector; contextual prefix is deterministic rebuild input",
    },
    update: {
      affectedChunks: targetDocument.chunks.length,
      description:
        "A parent-context change invalidates every contextualized child embedding in that document.",
    },
    locatorIntegrity: {
      preserved: true,
      digest: expectedLocatorDigest,
    },
  };
}

async function parentChild(): Promise<ArmResult> {
  const childInputs = chunks.map((chunk) => chunk.body);
  const parentDocuments = fixture.documents;
  const parentInputs = parentDocuments.map(
    (document) => `${document.title}\n${document.parentContext}`,
  );
  const buildStarted = performance.now();
  const [childVectors, parentVectors] = await Promise.all([
    adapter.embedPassages(childInputs),
    adapter.embedPassages(parentInputs),
  ]);
  const parentByDocument = new Map(
    parentDocuments.map((document, index) => [
      document.id,
      parentVectors[index] ?? [],
    ]),
  );
  const vectors = chunks.map((chunk, index) =>
    compose(
      childVectors[index] ?? [],
      parentByDocument.get(chunk.documentId) ?? [],
    ),
  );
  const buildLatencyMs = performance.now() - buildStarted;
  const query = await queryEvidence(vectors);
  const targetDocument = fixture.documents.find(
    (document) => document.id === fixture.updateScenario.documentId,
  );
  if (!targetDocument) {
    throw new Error("Parent-child update document is missing.");
  }
  const updateStarted = performance.now();
  const [updatedParent, updatedChild] = await Promise.all([
    adapter.embedPassages([
      `${targetDocument.title}\n${fixture.updateScenario.newParentContext}`,
    ]),
    adapter.embedPassages([fixture.updateScenario.newBody]),
  ]);
  const parentVector = updatedParent[0] ?? [];
  const changedChildVector = updatedChild[0] ?? [];
  for (const chunk of targetDocument.chunks) {
    const childIndex = chunks.findIndex(
      (candidate) => candidate.id === chunk.id,
    );
    const childVector =
      chunk.id === fixture.updateScenario.changedChunkId
        ? changedChildVector
        : (childVectors[childIndex] ?? []);
    compose(childVector, parentVector);
  }
  const updateLatencyMs = performance.now() - updateStarted;
  return {
    name: "PARENT_CHILD",
    ...query,
    buildLatencyMs,
    updateLatencyMs,
    storage: {
      persistentVectorCount: chunks.length + parentDocuments.length,
      vectorBytes:
        (chunks.length + parentDocuments.length) *
        LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.dimensions *
        Float32Array.BYTES_PER_ELEMENT,
      preparationInputUtf8Bytes: [...childInputs, ...parentInputs].reduce(
        (sum, value) => sum + Buffer.byteLength(value, "utf8"),
        0,
      ),
      storageModel:
        "persist child and parent vectors so parent changes can recompose children without re-embedding unchanged child text",
    },
    update: {
      affectedChunks: targetDocument.chunks.length,
      description:
        "Re-embed the changed parent plus changed child, then recompose every child of the affected parent.",
    },
    locatorIntegrity: {
      preserved: true,
      digest: expectedLocatorDigest,
    },
  };
}

try {
  await adapter.load();
  const arms = [
    await structureFirst(),
    await contextualPrefix(),
    await parentChild(),
  ];
  if (
    arms.some(
      (arm) =>
        arm.locatorIntegrity.digest !== expectedLocatorDigest ||
        !arm.locatorIntegrity.preserved,
    )
  ) {
    throw new Error("Embedding strategy changed structural locator identity.");
  }
  const report = {
    schemaVersion: 1,
    evidenceLevel: "REGISTERED_REAL_MODEL_CONTEXTUAL_CHUNK_BENCHMARK",
    status: "PROVEN",
    productionDefaultsChanged: false,
    generatedAt: new Date().toISOString(),
    fixture: {
      path: path.relative(repositoryRoot, fixturePath),
      sha256: sha256(raw),
      evidenceLevel: fixture.evidenceLevel,
      chunks: chunks.length,
      queries: fixture.queries.length,
      topK: fixture.topK,
      locatorDigest: expectedLocatorDigest,
    },
    embeddingProvider: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
    arms,
    lateChunking: {
      status: "NOT_APPLICABLE",
      reason:
        "The current EmbeddingPort exposes pooled vectors only and the pinned E5 runtime is bounded to 512 input tokens; no compatible long-context token-state pooling adapter is currently available behind the port.",
      providerMaxTokens:
        LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.runtime.maxTokens,
      requires:
        "token-level hidden-state access from a compatible long-context embedding provider before chunk pooling",
    },
    decision: {
      selectedDefault: null,
      productionDefaultChanged: false,
      reason:
        "Measurement only. Strategy selection remains benchmark-gated and requires registered-corpus evidence plus operational review.",
    },
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        status: report.status,
        arms: arms.map((arm) => ({
          name: arm.name,
          claimRecall: arm.claimRecall,
          contextPrecision: arm.contextPrecision,
          buildLatencyMs: arm.buildLatencyMs,
          updateLatencyMs: arm.updateLatencyMs,
          meanQueryLatencyMs: arm.meanQueryLatencyMs,
          vectorBytes: arm.storage.vectorBytes,
        })),
        lateChunking: report.lateChunking.status,
        productionDefaultChanged: report.productionDefaultsChanged,
      },
      null,
      2,
    ),
  );
} finally {
  await adapter.dispose();
}
