import { describe, expect, it } from "vitest";
import {
  configurationHashForEmbeddingDescriptor,
  type EmbeddingDescriptor,
} from "@akp/retrieval";
import {
  DeterministicEmbeddingAdapter,
  type EmbeddingProvider,
} from "@akp/retrieval";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
} from "@akp/retrieval";
import {
  configurationHashForDescriptor,
  type EmbeddingGenerationDescriptor,
} from "../src/embedding-generation.js";

function asGenerationDescriptor(
  descriptor: EmbeddingDescriptor,
): EmbeddingGenerationDescriptor {
  return descriptor;
}

function providerAndManagerHashes(provider: EmbeddingProvider): {
  provider: string;
  manager: string;
} {
  const descriptor = provider.descriptor;
  return {
    provider: configurationHashForEmbeddingDescriptor(descriptor),
    manager: configurationHashForDescriptor(asGenerationDescriptor(descriptor)),
  };
}

describe("embedding provider/generation configuration identity", () => {
  it("uses the same canonical hash for the deterministic provider and generation manager", () => {
    const provider = new DeterministicEmbeddingAdapter();
    const hashes = providerAndManagerHashes(provider);

    expect(hashes.provider).toBe(hashes.manager);
    expect(hashes.provider).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the same canonical hash for the pinned local provider and generation manager", () => {
    // Construction is intentionally enough to inspect the local provider's
    // pinned descriptor; model loading remains lazy and needs no network here.
    const provider = new LocalSemanticEmbeddingAdapter({
      pipelineFactory: async () => async () => {
        throw new Error("pipeline is not used by this identity test");
      },
    });
    expect(provider.descriptor).toEqual(LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR);
    const hashes = providerAndManagerHashes(provider);

    expect(hashes.provider).toBe(hashes.manager);
    expect(hashes.provider).toMatch(/^[a-f0-9]{64}$/);
  });
});
