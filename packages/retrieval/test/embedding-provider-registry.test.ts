import { describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../src/embeddings.js";
import {
  EmbeddingProviderUnavailableError,
  QueryEmbeddingService,
  assertEmbeddingDescriptorCompatible,
  createConfiguredEmbeddingProvider,
  createEmbeddingProviderForGeneration,
  serializeEmbeddingRuntime,
  type ActiveEmbeddingGenerationDescriptor,
} from "../src/embedding-provider-registry.js";

const generation: ActiveEmbeddingGenerationDescriptor = {
  generationId: "generation-1",
  spaceId: "space-1",
  vaultId: "vault-1",
  corpusRevision: "corpus-1",
  provider: "test-semantic",
  model: "multilingual-test",
  modelRevision: "revision-1",
  dimensions: 3,
  normalization: "l2",
  inputStrategy: "e5-query-passage-prefix-v1",
  configurationVersion: "configuration-1",
  runtime: { backend: "test", version: 1 },
};

describe("embedding provider registry", () => {
  it("has no implicit production provider and protects the deterministic fixture", () => {
    expect(createConfiguredEmbeddingProvider({})).toBeNull();
    expect(() =>
      createConfiguredEmbeddingProvider({
        AKP_EMBEDDING_PROVIDER: "deterministic-test",
        NODE_ENV: "production",
      }),
    ).toThrow(EmbeddingProviderUnavailableError);
    expect(() =>
      createConfiguredEmbeddingProvider({
        AKP_EMBEDDING_PROVIDER: "deterministic-test",
        AKP_ALLOW_DETERMINISTIC_EMBEDDINGS: "true",
        NODE_ENV: "production",
      }),
    ).toThrow(EmbeddingProviderUnavailableError);
    expect(
      createConfiguredEmbeddingProvider({
        AKP_EMBEDDING_PROVIDER: "deterministic-test",
        NODE_ENV: "test",
      })?.descriptor.provider,
    ).toBe("local-deterministic");
    expect(() =>
      createEmbeddingProviderForGeneration(
        {
          ...generation,
          provider: "local-deterministic",
          model: "hash-projection",
          modelRevision: "sha256-v1",
          dimensions: 64,
          normalization: "l2",
          inputStrategy: "deterministic-token-hash-v1",
          configurationVersion: "deterministic-embedding-v1",
          runtime: "node:crypto/sha256",
        },
        {
          NODE_ENV: "production",
          AKP_ALLOW_DETERMINISTIC_EMBEDDINGS: "true",
        },
      ),
    ).toThrow(EmbeddingProviderUnavailableError);
  });

  it("compares runtime objects canonically and rejects incompatible generations", () => {
    expect(() =>
      assertEmbeddingDescriptorCompatible(generation, {
        ...generation,
        runtime: { version: 1, backend: "test" },
      }),
    ).not.toThrow();
    expect(() =>
      assertEmbeddingDescriptorCompatible(generation, {
        ...generation,
        modelRevision: "revision-2",
      }),
    ).toThrow(/modelRevision/);
  });

  it("redacts credential-shaped values from structured and string runtimes", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
    const serialized = serializeEmbeddingRuntime({
      backend: "http",
      authorization: "Bearer top-secret",
      endpoint: "https://user:password@example.test/v1",
      note: `token=opaque-token ${jwt}`,
    });
    const stringRuntime = serializeEmbeddingRuntime(
      "http authorization=opaque password=hunter2",
    );

    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("password@example");
    expect(serialized).not.toContain("opaque-token");
    expect(serialized).not.toContain(jwt);
    expect(stringRuntime).not.toContain("opaque");
    expect(stringRuntime).not.toContain("hunter2");
  });

  it("uses the query role and validates the active generation dimension", async () => {
    const calls: unknown[] = [];
    const provider: EmbeddingProvider = {
      descriptor: generation,
      embed: async (_texts, request) => {
        calls.push(request);
        return [[1, 0, 0]];
      },
    };
    const service = new QueryEmbeddingService(async () => provider);
    await expect(service.embedQuery("consulta", generation)).resolves.toEqual([
      1, 0, 0,
    ]);
    expect(calls).toEqual([{ role: "query" }]);

    const wrongDimension: EmbeddingProvider = {
      descriptor: generation,
      embed: async () => [[0.1, 0.2]],
    };
    await expect(
      new QueryEmbeddingService(async () => wrongDimension).embedQuery(
        "consulta",
        generation,
      ),
    ).rejects.toThrow("EMBEDDING_QUERY_DIMENSION_MISMATCH");

    const wrongNormalization: EmbeddingProvider = {
      descriptor: generation,
      embed: async () => [[3, 4, 0]],
    };
    await expect(
      new QueryEmbeddingService(async () => wrongNormalization).embedQuery(
        "consulta",
        generation,
      ),
    ).rejects.toThrow("EMBEDDING_QUERY_NORMALIZATION_MISMATCH");
  });
});
