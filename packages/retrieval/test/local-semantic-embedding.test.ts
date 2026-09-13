import { describe, expect, it } from "vitest";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  MULTILINGUAL_E5_SMALL_DIMENSIONS,
  LocalSemanticEmbeddingAdapter,
  resolveLocalSemanticCacheDir,
  type LocalSemanticPipelineFactory,
  type LocalSemanticPipelineResult,
} from "../src/local-semantic-embedding.js";

function unitVector(component: number, value = 1): number[] {
  return Array.from({ length: MULTILINGUAL_E5_SMALL_DIMENSIONS }, (_, index) =>
    index === component ? value : 0,
  );
}

function tensor(rows: number[][]): LocalSemanticPipelineResult {
  return {
    dims: [rows.length, MULTILINGUAL_E5_SMALL_DIMENSIONS],
    tolist: () => rows,
  };
}

describe("local multilingual semantic embedding adapter", () => {
  it("keeps cache paths operational and outside the semantic descriptor", () => {
    const previous = process.env.AKP_MODEL_CACHE_DIR;
    process.env.AKP_MODEL_CACHE_DIR = "C:/short/akp-model-cache";
    try {
      expect(resolveLocalSemanticCacheDir()).toBe("C:/short/akp-model-cache");
      expect(resolveLocalSemanticCacheDir("D:/explicit-cache")).toBe(
        "D:/explicit-cache",
      );
      expect(() => resolveLocalSemanticCacheDir("   ")).toThrow("non-empty");
      expect(
        JSON.stringify(LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR),
      ).not.toContain("short/akp-model-cache");
    } finally {
      if (previous === undefined) delete process.env.AKP_MODEL_CACHE_DIR;
      else process.env.AKP_MODEL_CACHE_DIR = previous;
    }
  });

  it("keeps model loading lazy, prefixes roles and preserves batched order", async () => {
    let factoryCalls = 0;
    const batches: string[][] = [];
    const extractionOptions: Array<{ pooling: string; normalize: boolean }> =
      [];

    const pipelineFactory: LocalSemanticPipelineFactory = async (options) => {
      factoryCalls += 1;
      expect(options.model).toBe("intfloat/multilingual-e5-small");
      expect(options.revision).toBe("614241f622f53c4eeff9890bdc4f31cfecc418b3");
      expect(options.subfolder).toBe("onnx");
      expect(options.modelFileName).toBe("model_O4");
      return async (texts, optionsForExtraction) => {
        batches.push([...texts]);
        extractionOptions.push({ ...optionsForExtraction });
        return tensor(texts.map((_, index) => unitVector(index)));
      };
    };

    const adapter = new LocalSemanticEmbeddingAdapter({
      maxBatchSize: 2,
      pipelineFactory,
    });

    expect(factoryCalls).toBe(0);

    const vectors = await adapter.embedQueries([
      "arquitectura hexagonal",
      "domain events",
      "bounded contexts",
    ]);

    expect(factoryCalls).toBe(1);
    expect(batches).toEqual([
      ["query: arquitectura hexagonal", "query: domain events"],
      ["query: bounded contexts"],
    ]);
    expect(extractionOptions).toEqual([
      { pooling: "mean", normalize: true },
      { pooling: "mean", normalize: true },
    ]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(unitVector(0));
    expect(vectors[1]).toEqual(unitVector(1));
    expect(vectors[2]).toEqual(unitVector(0));
  });

  it("uses the passage role by default and does not duplicate an E5 prefix", async () => {
    let received: readonly string[] = [];
    const adapter = new LocalSemanticEmbeddingAdapter({
      pipelineFactory: async () => async (texts) => {
        received = texts;
        return tensor(texts.map(() => unitVector(0, 3)));
      },
    });

    await adapter.embed(["passage: ya preparado", "contenido del vault"]);

    expect(received).toEqual([
      "passage: ya preparado",
      "passage: contenido del vault",
    ]);
  });

  it("exposes a pinned semantic descriptor compatible with EmbeddingPort", () => {
    expect(LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR).toMatchObject({
      provider: "local-transformers-js",
      model: "intfloat/multilingual-e5-small",
      modelRevision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
      dimensions: 384,
      normalization: "l2",
      inputStrategy: "e5-query-passage-prefix-v1",
      configurationVersion: "transformers-js-4.2.0-e5-onnx-o4-v1",
      runtime: {
        library: "@huggingface/transformers",
        libraryVersion: "4.2.0",
        backend: "onnxruntime-node",
        device: "cpu",
        dtype: "fp32",
        subfolder: "onnx",
        modelFileName: "model_O4",
        maxTokens: 512,
      },
    });
  });

  it("rejects output tensors whose shape does not match the generation", async () => {
    const adapter = new LocalSemanticEmbeddingAdapter({
      pipelineFactory: async () => async () => ({
        dims: [1, MULTILINGUAL_E5_SMALL_DIMENSIONS - 1],
        tolist: () => [unitVector(0).slice(0, -1)],
      }),
    });

    await expect(adapter.embedPassages(["invalid shape"])).rejects.toThrow(
      "do not match",
    );
  });

  it("rejects zero or non-finite vectors instead of persisting unusable embeddings", async () => {
    const zeroAdapter = new LocalSemanticEmbeddingAdapter({
      pipelineFactory: async () => async () =>
        tensor([
          Array.from({ length: MULTILINGUAL_E5_SMALL_DIMENSIONS }, () => 0),
        ]),
    });
    await expect(zeroAdapter.embedPassages(["zero vector"])).rejects.toThrow(
      "cannot be L2-normalized",
    );

    const nonFiniteAdapter = new LocalSemanticEmbeddingAdapter({
      pipelineFactory: async () => async () =>
        tensor([[Number.NaN, ...unitVector(0).slice(1)]]),
    });
    await expect(
      nonFiniteAdapter.embedPassages(["non-finite vector"]),
    ).rejects.toThrow("non-finite");
  });

  it("executes the real pinned model when explicitly opted in", async () => {
    if (process.env.AKP_RUN_REAL_SEMANTIC_TEST !== "1") return;

    const adapter = new LocalSemanticEmbeddingAdapter({
      cacheDir: process.env.AKP_MODEL_CACHE_DIR,
      localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
    });
    const [query, relevantPassage, unrelatedPassage] = await Promise.all([
      adapter.embedQueries(["¿Cómo se diseña una arquitectura hexagonal?"]),
      adapter.embedPassages([
        "Hexagonal architecture isolates domain rules behind ports and adapters.",
      ]),
      adapter.embedPassages([
        "The recipe uses tomatoes, basil, and olive oil to prepare pasta.",
      ]),
    ]);

    expect(query[0]).toHaveLength(MULTILINGUAL_E5_SMALL_DIMENSIONS);
    expect(relevantPassage[0]).toHaveLength(MULTILINGUAL_E5_SMALL_DIMENSIONS);
    expect(unrelatedPassage[0]).toHaveLength(MULTILINGUAL_E5_SMALL_DIMENSIONS);
    expect(Math.hypot(...(query[0] ?? []))).toBeCloseTo(1, 5);
    expect(Math.hypot(...(relevantPassage[0] ?? []))).toBeCloseTo(1, 5);
    expect(Math.hypot(...(unrelatedPassage[0] ?? []))).toBeCloseTo(1, 5);

    const cosine = (left: number[], right: number[]): number =>
      left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
    const relevantScore = cosine(query[0] ?? [], relevantPassage[0] ?? []);
    const unrelatedScore = cosine(query[0] ?? [], unrelatedPassage[0] ?? []);
    const margin = relevantScore - unrelatedScore;
    console.info(
      JSON.stringify({
        model: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.model,
        revision: LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.modelRevision,
        modelFileName:
          LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.runtime.modelFileName,
        relevantScore,
        unrelatedScore,
        margin,
      }),
    );
    expect(relevantScore).toBeGreaterThan(unrelatedScore + 0.05);
  }, 180_000);
});
