import { describe, expect, it } from "vitest";
import { assertEmbeddingDescriptorCompatible } from "../src/embedding-provider-registry.js";
import {
  OpenAICompatibleEmbeddingAdapter,
  type OpenAICompatibleFetch,
} from "../src/openai-compatible-embedding.js";

const noNetworkFetch: OpenAICompatibleFetch = async () =>
  new Response(
    JSON.stringify({
      model: "embedding-test-v1",
      data: [{ index: 0, embedding: [1, 0, 0] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function openAIAdapter(baseUrl: string, apiKey: string) {
  return new OpenAICompatibleEmbeddingAdapter({
    baseUrl,
    model: "embedding-test-v1",
    modelRevision: "revision-1",
    dimensions: 3,
    normalization: "l2",
    inputStrategy: "none",
    configurationVersion: "test-v1",
    apiKey,
    fetchImpl: noNetworkFetch,
  });
}

describe("embedding provider configuration identity", () => {
  it("makes OpenAI-compatible identity endpoint-sensitive but independent of apiKey", () => {
    const endpointA = openAIAdapter(
      "https://embeddings-a.example/v1",
      "sk-test-key-a",
    );
    const endpointB = openAIAdapter(
      "https://embeddings-b.example/v1",
      "sk-test-key-a",
    );
    const endpointAWithAnotherKey = openAIAdapter(
      "https://embeddings-a.example/v1",
      "sk-test-key-b",
    );

    const hashA = endpointA.descriptor.configurationHash;
    const hashB = endpointB.descriptor.configurationHash;
    const hashAWithAnotherKey =
      endpointAWithAnotherKey.descriptor.configurationHash;

    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).not.toBe(hashB);
    expect(hashA).toBe(hashAWithAnotherKey);
    expect(hashA).not.toContain("sk-test-key-a");
    expect(hashA).not.toContain("sk-test-key-b");

    // The public descriptor remains the same apart from its identity hash:
    // endpoint routing is represented by the non-secret hash, not credentials.
    const { configurationHash: _hashA, ...descriptorA } = endpointA.descriptor;
    const { configurationHash: _hashB, ...descriptorB } = endpointB.descriptor;
    expect(descriptorA).toEqual(descriptorB);
  });

  it("rejects an active descriptor when endpoint/configuration identity differs, while accepting key rotation", () => {
    const expectedProvider = openAIAdapter(
      "https://embeddings-a.example/v1",
      "sk-test-key-a",
    );
    const differentEndpoint = openAIAdapter(
      "https://embeddings-b.example/v1",
      "sk-test-key-a",
    );
    const rotatedKey = openAIAdapter(
      "https://embeddings-a.example/v1",
      "sk-test-key-rotated",
    );

    expect(() =>
      assertEmbeddingDescriptorCompatible(
        expectedProvider.descriptor,
        differentEndpoint.descriptor,
      ),
    ).toThrow(/configurationHash/);
    expect(() =>
      assertEmbeddingDescriptorCompatible(
        expectedProvider.descriptor,
        rotatedKey.descriptor,
      ),
    ).not.toThrow();
  });

  it("never exposes provider secrets in descriptors, hashes, or upstream errors", async () => {
    const secret = "sk-super-secret-that-must-not-be-persisted";
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "https://embeddings.example/v1",
      model: "embedding-test-v1",
      dimensions: 3,
      apiKey: secret,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_api_key",
              message: `upstream echoed ${secret}`,
            },
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              "x-request-id": `request-${secret}`,
            },
          },
        ),
    });

    expect(JSON.stringify(adapter.descriptor)).not.toContain(secret);
    expect(adapter.descriptor.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.descriptor.configurationHash).not.toContain(secret);

    let error: unknown;
    try {
      await adapter.embed(["texto"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
