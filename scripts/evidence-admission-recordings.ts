import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CrossEncoderRuntimeFactory,
  EvidenceReader,
  EvidenceReaderInput,
  EvidenceReaderJudgment,
} from "../packages/retrieval/src/index.js";

export const CROSS_ENCODER_RECORDING_CONFIGURATION = {
  maxTokens: 512,
  batchSize: 8,
  dtype: "int8",
  device: "cpu",
} as const;

/** Fingerprint the exact model inputs, not benchmark question or document IDs. */
export function evidenceScoreInputHash(query: string, passage: string): string {
  return createHash("sha256")
    .update(JSON.stringify([query, passage]))
    .digest("hex");
}

export interface RecordedEvidenceScores {
  schemaVersion: 2;
  verifier: string;
  configuration: typeof CROSS_ENCODER_RECORDING_CONFIGURATION;
  rows: Array<{
    questionId: string;
    unitId: string;
    contextual: number;
    plain: number;
    contextualInputHash: string;
    plainInputHash: string;
    split?: string;
  }>;
}

export function recordedEvidenceScoreRuntime(
  recorded: RecordedEvidenceScores,
): CrossEncoderRuntimeFactory {
  if (recorded.schemaVersion !== 2 || !Array.isArray(recorded.rows))
    throw new Error("RECORDED_SCORES_INPUT_PROVENANCE_REQUIRED");
  const scores = new Map<string, number>();
  for (const row of recorded.rows) {
    if (
      !/^[a-f0-9]{64}$/u.test(row.contextualInputHash) ||
      !Number.isFinite(row.contextual) ||
      row.contextual < 0 ||
      row.contextual > 1
    )
      throw new Error("RECORDED_SCORES_INVALID");
    const prior = scores.get(row.contextualInputHash);
    if (prior !== undefined && prior !== row.contextual)
      throw new Error("RECORDED_SCORES_CONFLICTING_INPUT");
    scores.set(row.contextualInputHash, row.contextual);
  }
  return async (options) => {
    if (
      recorded.verifier !==
        `contextual-cross-encoder:${options.model}@${options.revision}` ||
      recorded.configuration?.maxTokens !== options.maxTokens ||
      recorded.configuration?.batchSize !== options.batchSize ||
      recorded.configuration?.dtype !== "int8" ||
      recorded.configuration?.device !== "cpu"
    )
      throw new Error("RECORDED_SCORES_CONFIGURATION_MISMATCH");
    return {
      score: async (pairs) =>
        pairs.map((pair) => {
          const score = scores.get(
            evidenceScoreInputHash(pair.query, pair.passage),
          );
          if (score === undefined)
            throw new Error("RECORDED_SCORE_INPUT_MISSING");
          return score;
        }),
    };
  };
}

export interface ReaderRecordingProvenance {
  modelRevision: string;
  /** A recorded fingerprint of server revision/configuration, not credentials. */
  deploymentFingerprint: string;
  promptVersion: string;
  temperature: number;
  maxOutputTokens: number;
  jsonResponseFormat: boolean;
}

export interface ReaderRecordingStats {
  cacheHits: number;
  coalescedRequests: number;
  freshModelCalls: number;
  freshModelTimeMs: number;
  modelErrors: number;
}

interface ReaderCache {
  schemaVersion: 2;
  entries: Record<
    string,
    {
      provenanceHash: string;
      inputHash: string;
      judgment: EvidenceReaderJudgment;
      inferenceMs: number;
    }
  >;
}

/**
 * Single-process content/provenance-bound cache. Never treat cache lookup time
 * as inference latency. Legacy caches lack this evidence and must be regenerated.
 */
export async function recordedEvidenceReader(
  reader: EvidenceReader,
  cachePath: string,
  provenance: ReaderRecordingProvenance,
): Promise<{
  reader: EvidenceReader;
  stats: ReaderRecordingStats;
  provenanceHash: string;
}> {
  if (
    !provenance.modelRevision?.trim() ||
    !provenance.deploymentFingerprint?.trim()
  )
    throw new Error("READER_RECORDING_PINNED_CONFIGURATION_REQUIRED");
  const provenanceHash = createHash("sha256")
    .update(JSON.stringify([reader.id, provenance]))
    .digest("hex");
  const resolved = path.resolve(cachePath);
  let cache: ReaderCache = { schemaVersion: 2, entries: {} };
  try {
    cache = JSON.parse(await readFile(resolved, "utf8")) as ReaderCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    cache.schemaVersion !== 2 ||
    !cache.entries ||
    typeof cache.entries !== "object" ||
    Array.isArray(cache.entries)
  )
    throw new Error("READER_RECORDING_INPUT_PROVENANCE_REQUIRED");
  await mkdir(path.dirname(resolved), { recursive: true });
  const stats: ReaderRecordingStats = {
    cacheHits: 0,
    coalescedRequests: 0,
    freshModelCalls: 0,
    freshModelTimeMs: 0,
    modelErrors: 0,
  };
  const inFlight = new Map<string, Promise<EvidenceReaderJudgment>>();
  let writes = Promise.resolve();
  const wrapped: EvidenceReader = {
    id: reader.id,
    judge: async (input: EvidenceReaderInput) => {
      const inputHash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex");
      const key = createHash("sha256")
        .update(JSON.stringify([provenanceHash, inputHash]))
        .digest("hex");
      const cached = cache.entries[key];
      if (cached) {
        if (
          cached.provenanceHash !== provenanceHash ||
          cached.inputHash !== inputHash ||
          typeof cached.judgment?.answers !== "boolean" ||
          typeof cached.judgment?.quote !== "string" ||
          !Number.isFinite(cached.inferenceMs) ||
          cached.inferenceMs < 0
        )
          throw new Error("READER_RECORDING_ENTRY_INVALID");
        stats.cacheHits++;
        return cached.judgment;
      }
      const pending = inFlight.get(key);
      if (pending) {
        stats.coalescedRequests++;
        return pending;
      }
      const reading = (async () => {
        const started = performance.now();
        stats.freshModelCalls++;
        let judgment: EvidenceReaderJudgment;
        try {
          judgment = await reader.judge(input);
        } catch (error) {
          stats.modelErrors++;
          throw error;
        } finally {
          stats.freshModelTimeMs += performance.now() - started;
        }
        if (
          typeof judgment?.answers !== "boolean" ||
          typeof judgment?.quote !== "string"
        )
          throw new Error("READER_RECORDING_JUDGMENT_INVALID");
        cache.entries[key] = {
          provenanceHash,
          inputHash,
          judgment,
          inferenceMs: performance.now() - started,
        };
        writes = writes.then(async () => {
          const temporary = `${resolved}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(cache), "utf8");
          await rename(temporary, resolved);
        });
        await writes;
        return judgment;
      })();
      inFlight.set(key, reading);
      try {
        return await reading;
      } finally {
        inFlight.delete(key);
      }
    },
    dispose: () => reader.dispose?.(),
  };
  return { reader: wrapped, stats, provenanceHash };
}
