import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
import {
  CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE,
  ContextualCrossEncoderEvidenceVerifier,
  ReaderEvidenceVerifier,
  assessRetrievalAnswerabilityWithVerifier,
  evidenceReaderMessages,
  EVIDENCE_READER_PROMPT_VERSION,
  parseEvidenceReaderJudgment,
  type EvidenceReader,
  type EvidenceReaderInput,
  type QueryConditionedEvidenceVerifier,
} from "../src/index.js";
import {
  evaluateEvidenceAdmission,
  loadEvidenceAdmissionPack,
  type QuestionResult,
} from "../../../scripts/evidence-admission-pack.js";
import {
  recordedEvidenceScoreRuntime,
  type RecordedEvidenceScores,
} from "../../../scripts/evidence-admission-recordings.js";

import {
  SOURCE_SELECTION_PROTOCOLS,
  parseSourceSelection,
  sourceSelectionMessages,
  sourceSelectionMeasurement,
  type SourceSelectionProtocol,
  type SourceSelectionShard,
} from "./evidence-source-selection-contract.js";

const shardIndex = Number(process.env.AKP_SOURCE_SELECTION_SHARD_INDEX ?? "0");
const shardCount = Number(process.env.AKP_SOURCE_SELECTION_SHARD_COUNT ?? "1");
if (
  !Number.isSafeInteger(shardIndex) ||
  !Number.isSafeInteger(shardCount) ||
  shardIndex < 0 ||
  shardCount < 1 ||
  shardIndex >= shardCount
) {
  throw new Error("INVALID_SHARD");
}

const scorePath = path.resolve(
  repositoryRoot,
  process.env.AKP_SOURCE_SELECTION_SCORES ??
    "reports/ci/source-selection-scores.json",
);
const recorded = JSON.parse(
  await readFile(scorePath, "utf8"),
) as RecordedEvidenceScores;
const runtimeFactory = recordedEvidenceScoreRuntime(recorded);
const shortlist = new ContextualCrossEncoderEvidenceVerifier({
  minimumSupportScore: CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE,
  runtimeFactory,
  localFilesOnly: true,
  maxTokens: 512,
  batchSize: 8,
});

const { cases: allCases } = await loadEvidenceAdmissionPack(["development"]);
const cases = allCases.filter((_, index) => index % shardCount === shardIndex);

const endpoint = "http://127.0.0.1:18081/chat/completions";
const model =
  process.env.AKP_LOCAL_AGENT_MODEL ?? "onnx-community/Qwen2.5-0.5B-Instruct";
const modelRevision = process.env.AKP_LOCAL_AGENT_MODEL_REVISION ?? "";
const providerHealth = (await (
  await fetch("http://127.0.0.1:18081/health")
).json()) as {
  model?: unknown;
  revision?: unknown;
  dtype?: unknown;
};
if (
  providerHealth.model !== model ||
  providerHealth.revision !== modelRevision ||
  providerHealth.dtype !== (process.env.AKP_LOCAL_AGENT_DTYPE ?? "q4")
) {
  throw new Error("MODEL_PROVENANCE_MISMATCH");
}
const generation = {
  temperature: 0,
  maxTokens: 256,
  responseFormatRequested: "json_object",
  constrainedDecoding: false,
};
const deploymentFingerprint = createHash("sha256")
  .update(JSON.stringify({ providerHealth, generation }))
  .digest("hex");

const stats = {
  "quote-v4": {
    calls: 0,
    timeMs: 0,
    providerErrors: 0,
    parseErrors: 0,
    invalidSelections: 0,
  },
  "source-selection-v1": {
    calls: 0,
    timeMs: 0,
    providerErrors: 0,
    parseErrors: 0,
    invalidSelections: 0,
  },
};
type Protocol = SourceSelectionProtocol;

async function complete(
  protocol: Protocol,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<string> {
  const started = performance.now();
  stats[protocol].calls += 1;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 256,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error("EVIDENCE_READER_HTTP_" + String(response.status));
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error("EVIDENCE_READER_RESPONSE_INVALID");
    return content;
  } catch (error) {
    stats[protocol].providerErrors += 1;
    throw error;
  } finally {
    // Include body consumption and decoding, not just response headers.
    stats[protocol].timeMs += performance.now() - started;
  }
}

const quoteReader: EvidenceReader = {
  id: "pinned-local:" + model + ":quote-v4",
  judge: async (input: EvidenceReaderInput) => {
    try {
      return parseEvidenceReaderJudgment(
        await complete("quote-v4", evidenceReaderMessages(input)),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /^EVIDENCE_READER_REPLY_/u.test(error.message)
      ) {
        stats["quote-v4"].parseErrors += 1;
      }
      throw error;
    }
  },
};

/** Exact selected body text still passes all ReaderEvidenceVerifier guards. */
const selectionReader: EvidenceReader = {
  id: "pinned-local:" + model + ":source-selection-v1",
  judge: async (input: EvidenceReaderInput) => {
    try {
      return parseSourceSelection(
        await complete("source-selection-v1", sourceSelectionMessages(input)),
        input.body,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "EVIDENCE_READER_SELECTION_INVALID"
      )
        stats["source-selection-v1"].invalidSelections += 1;
      else if (
        error instanceof Error &&
        /^EVIDENCE_READER_REPLY_/u.test(error.message)
      )
        stats["source-selection-v1"].parseErrors += 1;
      throw error;
    }
  },
};

// Preflight every exact contextual input before fail-closed product handling can
// turn a stale/missing recording into apparent reader recall loss.
for (const entry of cases) {
  await shortlist.scoreBatch(
    entry.hits.map((hit) => ({
      query: entry.question.query,
      candidateKey: hit.documentId,
      title: hit.title,
      ...(hit.headingPath ? { headingPath: hit.headingPath } : {}),
      passage: hit.excerpt.trim(),
      unitType: hit.unitType ?? null,
      parentUnitType: null,
      documentType: hit.type,
    })),
  );
}

async function runCase(
  entry: (typeof cases)[number],
  verifier: QueryConditionedEvidenceVerifier,
) {
  const traces: unknown[] = [];
  const rows = await evaluateEvidenceAdmission([entry], async (hits, query) => {
    const assessment = await assessRetrievalAnswerabilityWithVerifier(
      hits,
      query,
      verifier,
      { mode: "ENFORCE", maxCandidates: 64, maxConcurrency: 1 },
    );
    traces.push({
      query,
      candidates: assessment.candidateSignals.map((signal) => ({
        key: signal.candidateKey,
        supportReason: signal.passageSupport.reason,
        verification: signal.queryConditionedEvidence ?? null,
      })),
    });
    return assessment.supportedCandidateKeys;
  });
  return { rows, traces };
}

const quoteVerifier = new ReaderEvidenceVerifier({
  reader: quoteReader,
  shortlist,
  shortlistSize: 4,
  concurrency: 1,
});
const selectionVerifier = new ReaderEvidenceVerifier({
  reader: selectionReader,
  shortlist,
  shortlistSize: 4,
  concurrency: 1,
});

const verifiers = {
  "quote-v4": quoteVerifier,
  "source-selection-v1": selectionVerifier,
};
const arms = Object.fromEntries(
  SOURCE_SELECTION_PROTOCOLS.map((protocol) => [
    protocol,
    {
      rows: [] as QuestionResult[],
      traces: [] as unknown[],
      stats: stats[protocol],
    },
  ]),
) as SourceSelectionShard["arms"];
const measurement = await sourceSelectionMeasurement(allCases, {
  generation,
  model,
  modelRevision,
  quotePrompt: EVIDENCE_READER_PROMPT_VERSION,
  selectionPrompt: "source-selection-v1",
  shortlistSize: 4,
  shortlistFloor: 0.001,
  maxCandidates: 64,
  maxConcurrency: 1,
  pairing: "alternating-question-order",
});
const report: SourceSelectionShard = {
  schemaVersion: 2,
  benchmark: "EVIDENCE_SOURCE_SELECTION_AB",
  split: "development",
  shardIndex,
  shardCount,
  model: {
    model,
    revision: modelRevision,
    providerHealth,
    deploymentFingerprint,
    generation,
  },
  measurement,
  cases: cases.length,
  arms,
};
try {
  for (const [index, entry] of cases.entries()) {
    // Interleave matched questions and alternate first arm to reduce order bias.
    const order =
      (index + shardIndex) % 2 === 0
        ? SOURCE_SELECTION_PROTOCOLS
        : [...SOURCE_SELECTION_PROTOCOLS].reverse();
    for (const protocol of order) {
      const result = await runCase(entry, verifiers[protocol]);
      arms[protocol].rows.push(...result.rows);
      arms[protocol].traces.push(...result.traces);
    }
  }
} finally {
  const output = path.join(
    repositoryRoot,
    "reports/ci/source-selection-shard-" + String(shardIndex) + ".json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report));
  await shortlist.dispose();
}
if (
  SOURCE_SELECTION_PROTOCOLS.some(
    (protocol) => stats[protocol].providerErrors > 0,
  )
)
  throw new Error("PROVIDER_INFRASTRUCTURE_ERROR");
console.log(
  JSON.stringify(
    {
      shardIndex,
      cases: cases.length,
      quote: stats["quote-v4"],
      selection: stats["source-selection-v1"],
      measurement,
    },
    null,
    2,
  ),
);
