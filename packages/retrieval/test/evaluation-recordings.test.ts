import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CROSS_ENCODER_RECORDING_CONFIGURATION,
  evidenceScoreInputHash,
  recordedEvidenceReader,
  recordedEvidenceScoreRuntime,
  type RecordedEvidenceScores,
  type ReaderRecordingProvenance,
} from "../../../scripts/evidence-admission-recordings.js";

const directories: string[] = [];

async function cachePath() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "akp-evaluation-recordings-"),
  );
  directories.push(directory);
  return path.join(directory, "judgments.json");
}

afterAll(async () => {
  for (const directory of directories)
    await rm(directory, { recursive: true, force: true });
});

const options = {
  model: "fixture-model",
  revision: "fixture-revision",
  localFilesOnly: true,
  maxTokens: 512,
  batchSize: 8,
};

function scores(): RecordedEvidenceScores {
  return {
    schemaVersion: 2,
    verifier: "contextual-cross-encoder:fixture-model@fixture-revision",
    configuration: CROSS_ENCODER_RECORDING_CONFIGURATION,
    rows: [
      {
        questionId: "same-id",
        unitId: "same-id",
        contextual: 0.8,
        plain: 0.2,
        contextualInputHash: evidenceScoreInputHash(
          "Question",
          "First passage",
        ),
        plainInputHash: evidenceScoreInputHash("Question", "First passage"),
      },
    ],
  };
}

const provenance: ReaderRecordingProvenance = {
  modelRevision: "digest-one",
  deploymentFingerprint: "server-context-configuration",
  promptVersion: "fixture-v1",
  temperature: 0,
  maxOutputTokens: 256,
  jsonResponseFormat: true,
};

describe("recorded relevance provenance", () => {
  it("does not replay an old score for a changed query or passage with the same IDs", async () => {
    const runtime = await recordedEvidenceScoreRuntime(scores())(options);
    expect(
      await runtime.score([{ query: "Question", passage: "First passage" }]),
    ).toEqual([0.8]);
    await expect(
      runtime.score([{ query: "Question", passage: "Different passage" }]),
    ).rejects.toThrow("INPUT_MISSING");
    await expect(
      runtime.score([
        { query: "Different question", passage: "First passage" },
      ]),
    ).rejects.toThrow("INPUT_MISSING");
  });

  it("uses input hashes even when fixture IDs repeat", async () => {
    const recording = scores();
    recording.rows.push({
      ...recording.rows[0]!,
      contextual: 0.1,
      contextualInputHash: evidenceScoreInputHash(
        "Question",
        "Different passage",
      ),
    });
    const runtime = await recordedEvidenceScoreRuntime(recording)(options);
    expect(
      await runtime.score([
        { query: "Question", passage: "Different passage" },
      ]),
    ).toEqual([0.1]);
  });

  it("requires matching model revision and inference configuration", async () => {
    const factory = recordedEvidenceScoreRuntime(scores());
    await expect(
      factory({ ...options, revision: "different-revision" }),
    ).rejects.toThrow("CONFIGURATION_MISMATCH");
    await expect(factory({ ...options, maxTokens: 256 })).rejects.toThrow(
      "CONFIGURATION_MISMATCH",
    );
  });

  it("rejects legacy and inconsistent score records", () => {
    expect(() =>
      recordedEvidenceScoreRuntime({
        ...scores(),
        schemaVersion: 1,
      } as unknown as RecordedEvidenceScores),
    ).toThrow("PROVENANCE_REQUIRED");
    const recording = scores();
    recording.rows.push({ ...recording.rows[0]!, contextual: 0.3 });
    expect(() => recordedEvidenceScoreRuntime(recording)).toThrow(
      "CONFLICTING_INPUT",
    );
  });
});

describe("recorded reader provenance", () => {
  it("reuses identical inputs but re-reads when source, revision or generation options change", async () => {
    const file = await cachePath();
    let calls = 0;
    const base = {
      id: "reader-alias",
      judge: async (input: { body: string }) => {
        calls++;
        return { answers: true, quote: input.body };
      },
    };
    const first = await recordedEvidenceReader(base, file, provenance);
    const input = { query: "Question", scope: "Scope", body: "First fact." };
    await first.reader.judge(input);
    await first.reader.judge(input);
    expect(calls).toBe(1);
    expect(first.stats).toMatchObject({ cacheHits: 1, freshModelCalls: 1 });
    await first.reader.judge({ ...input, body: "Changed fact." });
    const changedRevision = await recordedEvidenceReader(base, file, {
      ...provenance,
      modelRevision: "digest-two",
    });
    await changedRevision.reader.judge(input);
    const changedOptions = await recordedEvidenceReader(base, file, {
      ...provenance,
      maxOutputTokens: 512,
    });
    await changedOptions.reader.judge(input);
    expect(calls).toBe(4);
    const replay = await recordedEvidenceReader(base, file, provenance);
    await replay.reader.judge(input);
    expect(calls).toBe(4);
    expect(replay.stats).toMatchObject({
      cacheHits: 1,
      freshModelCalls: 0,
      freshModelTimeMs: 0,
    });
  });

  it("coalesces concurrent identical requests without losing cache records", async () => {
    const file = await cachePath();
    let calls = 0;
    const base = {
      id: "reader",
      judge: async (input: { body: string }) => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { answers: true, quote: input.body };
      },
    };
    const recorded = await recordedEvidenceReader(base, file, provenance);
    const input = { query: "Question", scope: "Scope", body: "Fact." };
    await Promise.all([
      recorded.reader.judge(input),
      recorded.reader.judge(input),
      recorded.reader.judge({ ...input, body: "Another fact." }),
    ]);
    expect(calls).toBe(2);
    expect(recorded.stats.coalescedRequests).toBe(1);
    const replay = await recordedEvidenceReader(base, file, provenance);
    await replay.reader.judge(input);
    await replay.reader.judge({ ...input, body: "Another fact." });
    expect(replay.stats.cacheHits).toBe(2);
    expect(calls).toBe(2);
  });

  it("does not cache model errors as negative judgments", async () => {
    const file = await cachePath();
    let calls = 0;
    const base = {
      id: "reader",
      judge: async () => {
        calls++;
        if (calls === 1) throw new Error("MODEL_ERROR");
        return { answers: false, quote: "" };
      },
    };
    const recorded = await recordedEvidenceReader(base, file, provenance);
    const input = { query: "Question", scope: "Scope", body: "Fact." };
    await expect(recorded.reader.judge(input)).rejects.toThrow("MODEL_ERROR");
    await recorded.reader.judge(input);
    expect(recorded.stats).toMatchObject({
      modelErrors: 1,
      freshModelCalls: 2,
      cacheHits: 0,
    });
  });

  it("fails closed on unpinned or legacy caches instead of silently re-labeling them", async () => {
    const file = await cachePath();
    const base = {
      id: "reader",
      judge: async () => ({ answers: false, quote: "" }),
    };
    await expect(
      recordedEvidenceReader(base, file, { ...provenance, modelRevision: "" }),
    ).rejects.toThrow("PINNED_CONFIGURATION");
    await writeFile(
      file,
      JSON.stringify({ oldHash: { answers: true, quote: "Stale" } }),
    );
    await expect(
      recordedEvidenceReader(base, file, provenance),
    ).rejects.toThrow("INPUT_PROVENANCE_REQUIRED");
  });
});

it("rejects corrupted reader records before admission can hide a cache error as abstention", async () => {
  const file = await cachePath();
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 2,
      entries: { badKey: { judgment: { answers: true, quote: "Stale" } } },
    }),
  );
  const base = {
    id: "reader",
    judge: async () => ({ answers: false, quote: "" }),
  };
  await expect(recordedEvidenceReader(base, file, provenance)).rejects.toThrow(
    "ENTRY_INVALID",
  );
});
