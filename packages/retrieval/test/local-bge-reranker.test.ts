import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR,
  LocalBgeCrossEncoderReranker,
  type LocalBgeCrossEncoderRuntimeFactory,
} from "../src/local-bge-reranker.js";

describe("local multilingual BGE cross-encoder reranker", () => {
  it("keeps model loading lazy, pinned and reusable", async () => {
    const calls: Array<[string, string]> = [];
    const dispose = vi.fn();
    const runtimeFactory = vi.fn<LocalBgeCrossEncoderRuntimeFactory>(
      async (options) => {
        expect(options).toMatchObject({
          model: "onnx-community/bge-reranker-v2-m3-ONNX",
          revision: "6f5ff65298512715a1e669753bc754d2bc8f367b",
          localFilesOnly: true,
        });
        return {
          scoreLogit: async (query, passage) => {
            calls.push([query, passage]);
            return passage.includes("relevant") ? 2 : 0;
          },
          dispose,
        };
      },
    );

    const reranker = new LocalBgeCrossEncoderReranker({
      localFilesOnly: true,
      runtimeFactory,
    });
    expect(runtimeFactory).not.toHaveBeenCalled();

    const scores = await reranker.scoreMany("  retry policy  ", [
      "relevant atomic passage",
      "unrelated passage",
    ]);

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      ["retry policy", "relevant atomic passage"],
      ["retry policy", "unrelated passage"],
    ]);
    expect(scores[0]).toBeCloseTo(0.880797, 5);
    expect(scores[1]).toBe(0.5);

    await reranker.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("exposes the pinned relevance-only descriptor", () => {
    expect(LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR).toEqual({
      model: "onnx-community/bge-reranker-v2-m3-ONNX",
      revision: "6f5ff65298512715a1e669753bc754d2bc8f367b",
      runtime: "@huggingface/transformers",
      task: "query-passage-cross-encoder-reranking",
      device: "cpu",
      dtype: "int8",
      subfolder: "onnx",
      modelFileName: "model",
      maxTokens: 512,
    });
  });

  it("fails closed on empty inputs and invalid model scores", async () => {
    const invalid = new LocalBgeCrossEncoderReranker({
      runtimeFactory: async () => ({
        scoreLogit: async () => Number.NaN,
      }),
    });

    await expect(invalid.score("", "passage")).rejects.toThrow("non-empty");
    await expect(invalid.score("query", " ")).rejects.toThrow("non-empty");
    await expect(invalid.score("query", "passage")).rejects.toThrow(
      "LOCAL_BGE_RERANKER_LOGIT_INVALID",
    );
  });
});
