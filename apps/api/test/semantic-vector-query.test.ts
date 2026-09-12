import { describe, expect, it } from "vitest";
import {
  QueryEmbeddingService,
  type ActiveEmbeddingGenerationDescriptor,
  type EmbeddingProvider,
} from "@akp/retrieval";
import {
  channelsConsistentWithIndex,
  effectiveRetrievalChannels,
  queryKnowledge,
} from "../src/routes/search.js";

const spaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const vaultId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const documentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const unitId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const generationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const descriptor: ActiveEmbeddingGenerationDescriptor = {
  generationId,
  spaceId,
  vaultId,
  corpusRevision: "corpus-1",
  provider: "semantic-test",
  model: "model-1",
  modelRevision: "revision-1",
  dimensions: 3,
  normalization: "l2",
  inputStrategy: "e5-query-passage-prefix-v1",
  configurationVersion: "configuration-1",
  runtime: "test",
};

function normalizedVector(values: readonly [number, number, number]): number[] {
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

const queryFixtureVector = normalizedVector([0.2, 0.3, 0.4]);
const staleFixtureVector = normalizedVector([0.1, 0.2, 0.3]);

const request = {
  query: "¿Cómo cancelar una matrícula?",
  spaceId,
  vaultId,
  vaultIds: [] as string[],
  federated: false,
  types: [] as string[],
  minimumTrust: "MACHINE_SUPPORTED" as const,
  mode: "SOURCE_BACKED" as const,
  limit: 5,
};

describe("semantic vector query", () => {
  it("uses the active generation provider and its exact dimension", async () => {
    const previous = process.env.AKP_VECTOR_ENABLED;
    process.env.AKP_VECTOR_ENABLED = "true";
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const db = {
      pool: {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          if (sql.includes("from vault_index_revisions")) {
            return {
              rows: [
                {
                  vault_id: vaultId,
                  corpus_revision: "corpus-1",
                  lexical_revision: "corpus-1",
                  vector_revision: "corpus-1",
                  graph_revision: "corpus-1",
                  context_pack_revision: "corpus-1",
                  status: "CONSISTENT",
                  warnings: [],
                },
              ],
            };
          }
          if (sql.includes("from embedding_generations g")) {
            return {
              rows: [
                {
                  id: generationId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  corpus_revision: "corpus-1",
                  provider: descriptor.provider,
                  model: descriptor.model,
                  model_revision: descriptor.modelRevision,
                  dimensions: descriptor.dimensions,
                  normalization: descriptor.normalization,
                  input_strategy: descriptor.inputStrategy,
                  configuration_version: descriptor.configurationVersion,
                  runtime: descriptor.runtime,
                },
              ],
            };
          }
          if (sql.includes("e.generation_id=$1")) {
            return {
              rows: [
                {
                  id: documentId,
                  unit_id: unitId,
                  unit_type: "PARAGRAPH",
                  score: 0.91,
                },
              ],
            };
          }
          if (sql.includes("left join knowledge_relations")) {
            return {
              rows: [
                {
                  id: documentId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  path: "knowledge/enrollment-cancellation.md",
                  title: "Enrollment cancellation",
                  type: "concept",
                  layer: "concept",
                  trust_tier: "HUMAN_REVIEWED",
                  lifecycle: "ACTIVE",
                  current_revision: "revision-1",
                  body_cache: "Cancellation rules",
                  refresh_status: "CURRENT",
                  citations: [],
                  evidence_locators: [],
                },
              ],
            };
          }
          if (sql.includes("select u.id, u.document_id")) {
            return {
              rows: [
                {
                  id: unitId,
                  document_id: documentId,
                  unit_type: "PARAGRAPH",
                  body: "A learner may cancel an enrollment before the deadline.",
                  parent_unit_id: null,
                  parent_unit_type: null,
                  parent_body: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      },
    } as never;
    const embedCalls: unknown[] = [];
    const provider: EmbeddingProvider = {
      descriptor,
      embed: async (_texts, options) => {
        embedCalls.push(options);
        return [queryFixtureVector];
      },
    };
    try {
      const hits = await queryKnowledge(db, request, {
        vaultIds: [vaultId],
        channels: ["vector"],
        queryEmbeddingService: new QueryEmbeddingService(async () => provider),
      });
      expect(hits[0]).toMatchObject({
        documentId,
        unitId,
        reasons: ["vector"],
      });
      expect(embedCalls).toEqual([{ role: "query" }]);
      const vectorCall = calls.find((call) =>
        call.sql.includes("e.generation_id=$1"),
      );
      expect(vectorCall?.sql).toContain("vector(3)");
      expect(vectorCall?.sql).toContain(
        "not (layer = 'resource' or type = 'raw-resource')",
      );
      expect(vectorCall?.values?.[0]).toBe(generationId);
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }
  });

  it("degrades only vector when the active provider is unavailable", async () => {
    const previous = process.env.AKP_VECTOR_ENABLED;
    process.env.AKP_VECTOR_ENABLED = "true";
    const calls: string[] = [];
    const db = {
      pool: {
        query: async (sql: string) => {
          calls.push(sql);
          if (sql.includes("plainto_tsquery")) {
            return {
              rows: [
                {
                  id: documentId,
                  unit_id: unitId,
                  unit_type: "PARAGRAPH",
                  score: 0.72,
                },
              ],
            };
          }
          if (
            sql.includes("from vault_index_revisions") &&
            !sql.includes("join vault_index_revisions")
          ) {
            return {
              rows: [
                {
                  vault_id: vaultId,
                  corpus_revision: "corpus-1",
                  lexical_revision: "corpus-1",
                  vector_revision: "corpus-1",
                  graph_revision: "corpus-1",
                },
              ],
            };
          }
          if (sql.includes("from embedding_generations g")) {
            return {
              rows: [
                {
                  id: generationId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  corpus_revision: "corpus-1",
                  provider: descriptor.provider,
                  model: descriptor.model,
                  model_revision: descriptor.modelRevision,
                  dimensions: descriptor.dimensions,
                  normalization: descriptor.normalization,
                  input_strategy: descriptor.inputStrategy,
                  configuration_version: descriptor.configurationVersion,
                  runtime: descriptor.runtime,
                },
              ],
            };
          }
          if (sql.includes("left join knowledge_relations")) {
            return {
              rows: [
                {
                  id: documentId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  path: "knowledge/enrollment-cancellation.md",
                  title: "Enrollment cancellation",
                  type: "concept",
                  layer: "concept",
                  trust_tier: "HUMAN_REVIEWED",
                  lifecycle: "ACTIVE",
                  current_revision: "revision-1",
                  body_cache: "Cancellation rules",
                  refresh_status: "CURRENT",
                  citations: [],
                  evidence_locators: [],
                },
              ],
            };
          }
          if (sql.includes("select u.id, u.document_id")) {
            return {
              rows: [
                {
                  id: unitId,
                  document_id: documentId,
                  unit_type: "PARAGRAPH",
                  body: "A learner may cancel an enrollment before the deadline.",
                  parent_unit_id: null,
                  parent_unit_type: null,
                  parent_body: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      },
    } as never;
    const warnings: string[] = [];
    try {
      const hits = await queryKnowledge(db, request, {
        vaultIds: [vaultId],
        channels: ["vector", "exact", "lexical", "graph"],
        warningSink: warnings,
        queryEmbeddingService: new QueryEmbeddingService(async () => {
          throw new Error("provider offline and secret detail");
        }),
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        documentId,
        reasons: ["lexical"],
      });
      expect(calls.some((sql) => sql.includes("plainto_tsquery"))).toBe(true);
      expect(warnings).toEqual([`VECTOR_PROVIDER_UNAVAILABLE:${vaultId}`]);
      expect(warnings.join(" ")).not.toContain("secret detail");
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }
  });

  it("keeps federated vector when one vault succeeds and removes it when none do", () => {
    const channelState = channelsConsistentWithIndex(
      ["vector", "lexical"],
      {
        corpus_revision: "corpus-new",
        lexical_revision: "corpus-new",
        vector_revision: "corpus-old",
      },
      true,
    );

    const partial = effectiveRetrievalChannels(
      channelState,
      ["VECTOR_GENERATION_UNAVAILABLE:vault-b"],
      new Set(["vector"]),
    );
    expect(partial.channels).toEqual(["vector", "lexical"]);
    expect(partial.warnings).toContain("VECTOR_GENERATION_UNAVAILABLE:vault-b");

    const none = effectiveRetrievalChannels(
      channelState,
      [
        "VECTOR_GENERATION_UNAVAILABLE:vault-a",
        "VECTOR_GENERATION_UNAVAILABLE:vault-b",
      ],
      new Set(),
    );
    expect(none.channels).toEqual(["lexical"]);
  });

  it("does not report graph as searched when traversal could not execute", () => {
    const channelState = channelsConsistentWithIndex(
      ["exact", "lexical", "graph"],
      {
        corpus_revision: "corpus-1",
        lexical_revision: "corpus-1",
        graph_revision: "corpus-1",
      },
      false,
    );

    const effective = effectiveRetrievalChannels(
      channelState,
      [],
      new Set(["exact", "lexical"]),
    );

    expect(effective.channels).toEqual(["exact", "lexical"]);
  });

  it("continues lexical retrieval when the pgvector query fails", async () => {
    const previous = process.env.AKP_VECTOR_ENABLED;
    process.env.AKP_VECTOR_ENABLED = "true";
    const calls: string[] = [];
    const db = {
      pool: {
        query: async (sql: string) => {
          calls.push(sql);
          if (sql.includes("plainto_tsquery")) {
            return {
              rows: [
                {
                  id: documentId,
                  unit_id: unitId,
                  unit_type: "PARAGRAPH",
                  score: 0.72,
                },
              ],
            };
          }
          if (
            sql.includes("from vault_index_revisions") &&
            !sql.includes("join vault_index_revisions")
          ) {
            return {
              rows: [
                {
                  vault_id: vaultId,
                  corpus_revision: "corpus-1",
                  lexical_revision: "corpus-1",
                  vector_revision: "corpus-1",
                },
              ],
            };
          }
          if (sql.includes("from embedding_generations g")) {
            return {
              rows: [
                {
                  id: generationId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  corpus_revision: "corpus-1",
                  provider: descriptor.provider,
                  model: descriptor.model,
                  model_revision: descriptor.modelRevision,
                  dimensions: descriptor.dimensions,
                  normalization: descriptor.normalization,
                  input_strategy: descriptor.inputStrategy,
                  configuration_version: descriptor.configurationVersion,
                  runtime: descriptor.runtime,
                },
              ],
            };
          }
          if (sql.includes("e.generation_id=$1")) {
            throw new Error("pgvector operator unavailable");
          }
          if (sql.includes("left join knowledge_relations")) {
            return {
              rows: [
                {
                  id: documentId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  path: "knowledge/enrollment-cancellation.md",
                  title: "Enrollment cancellation",
                  type: "concept",
                  layer: "concept",
                  trust_tier: "HUMAN_REVIEWED",
                  lifecycle: "ACTIVE",
                  current_revision: "revision-1",
                  body_cache: "Cancellation rules",
                  refresh_status: "CURRENT",
                  citations: [],
                  evidence_locators: [],
                },
              ],
            };
          }
          if (sql.includes("select u.id, u.document_id")) {
            return {
              rows: [
                {
                  id: unitId,
                  document_id: documentId,
                  unit_type: "PARAGRAPH",
                  body: "A learner may cancel an enrollment before the deadline.",
                  parent_unit_id: null,
                  parent_unit_type: null,
                  parent_body: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      },
    } as never;
    const warnings: string[] = [];
    const availableChannels = new Set<
      "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
    >();
    const provider: EmbeddingProvider = {
      descriptor,
      embed: async () => [queryFixtureVector],
    };
    try {
      const hits = await queryKnowledge(db, request, {
        vaultIds: [vaultId],
        channels: ["vector", "lexical"],
        warningSink: warnings,
        availableChannelSink: availableChannels,
        queryEmbeddingService: new QueryEmbeddingService(async () => provider),
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        documentId,
        reasons: ["lexical"],
      });
      expect(availableChannels.has("vector")).toBe(false);
      expect(warnings).toContain(`VECTOR_QUERY_UNAVAILABLE:${vaultId}`);
      expect(calls.some((sql) => sql.includes("plainto_tsquery"))).toBe(true);
      const effective = effectiveRetrievalChannels(
        channelsConsistentWithIndex(
          ["vector", "lexical"],
          {
            corpus_revision: "corpus-1",
            lexical_revision: "corpus-1",
            vector_revision: "corpus-1",
          },
          true,
        ),
        warnings,
        availableChannels,
      );
      expect(effective.channels).toEqual(["lexical"]);
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }
  });

  it("uses the previous ACTIVE generation while vector revision is stale", async () => {
    const previous = process.env.AKP_VECTOR_ENABLED;
    process.env.AKP_VECTOR_ENABLED = "true";
    const previousGenerationId = "99999999-9999-4999-8999-999999999999";
    const previousDescriptor: ActiveEmbeddingGenerationDescriptor = {
      ...descriptor,
      generationId: previousGenerationId,
      corpusRevision: "corpus-old",
    };
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const db = {
      pool: {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          if (sql.includes("select vault_id,corpus_revision")) {
            return {
              rows: [
                {
                  vault_id: vaultId,
                  corpus_revision: "corpus-new",
                  lexical_revision: "corpus-new",
                  vector_revision: "corpus-old",
                  graph_revision: "corpus-new",
                  context_pack_revision: "corpus-new",
                  status: "DEGRADED",
                  warnings: ["VECTOR_REBUILD_IN_PROGRESS"],
                },
              ],
            };
          }
          if (sql.includes("from embedding_generations g")) {
            return {
              rows: [
                {
                  id: previousGenerationId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  corpus_revision: "corpus-old",
                  provider: previousDescriptor.provider,
                  model: previousDescriptor.model,
                  model_revision: previousDescriptor.modelRevision,
                  dimensions: previousDescriptor.dimensions,
                  normalization: previousDescriptor.normalization,
                  input_strategy: previousDescriptor.inputStrategy,
                  configuration_version:
                    previousDescriptor.configurationVersion,
                  runtime: previousDescriptor.runtime,
                  status: "ACTIVE",
                },
              ],
            };
          }
          if (sql.includes("e.generation_id=$1")) return { rows: [] };
          return { rows: [] };
        },
      },
    } as never;
    const availableChannels = new Set<"vector">();
    const warnings: string[] = [];
    const provider: EmbeddingProvider = {
      descriptor: previousDescriptor,
      embed: async () => [staleFixtureVector],
    };
    try {
      await queryKnowledge(
        db,
        { ...request, mode: "RAW_ONLY" },
        {
          vaultIds: [vaultId],
          channels: ["vector"],
          warningSink: warnings,
          availableChannelSink: availableChannels,
          queryEmbeddingService: new QueryEmbeddingService(
            async (generation) => {
              expect(generation.generationId).toBe(previousGenerationId);
              expect(generation.corpusRevision).toBe("corpus-old");
              return provider;
            },
          ),
        },
      );
      const vectorCall = calls.find((call) =>
        call.sql.includes("e.generation_id=$1"),
      );
      expect(vectorCall?.values?.[0]).toBe(previousGenerationId);
      expect(vectorCall?.sql).toContain(
        "(layer = 'resource' or type = 'raw-resource')",
      );
      expect(availableChannels.has("vector")).toBe(true);
      expect(warnings).toContain("INDEX_REVISION_STALE:vector");
      const staleState = channelsConsistentWithIndex(
        ["vector"],
        {
          corpus_revision: "corpus-new",
          vector_revision: "corpus-old",
        },
        true,
      );
      expect(staleState.channels).toContain("vector");
      expect(staleState.warnings).toEqual(["INDEX_REVISION_STALE:vector"]);
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }
  });

  it("executes available vaults in a partial federated vector rebuild", async () => {
    const previous = process.env.AKP_VECTOR_ENABLED;
    process.env.AKP_VECTOR_ENABLED = "true";
    const secondVaultId = "11111111-1111-4111-8111-111111111111";
    const firstGenerationId = "22222222-2222-4222-8222-222222222222";
    const firstDescriptor: ActiveEmbeddingGenerationDescriptor = {
      ...descriptor,
      generationId: firstGenerationId,
      vaultId,
      corpusRevision: "corpus-a",
    };
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const db = {
      pool: {
        query: async (sql: string, values?: unknown[]) => {
          calls.push({ sql, values });
          if (sql.includes("select vault_id,corpus_revision")) {
            return {
              rows: [
                {
                  vault_id: vaultId,
                  corpus_revision: "corpus-a",
                  lexical_revision: "corpus-a",
                  vector_revision: "corpus-a",
                },
                {
                  vault_id: secondVaultId,
                  corpus_revision: "corpus-b",
                  lexical_revision: "corpus-b",
                  vector_revision: null,
                },
              ],
            };
          }
          if (sql.includes("from embedding_generations g")) {
            return {
              rows: [
                {
                  id: firstGenerationId,
                  space_id: spaceId,
                  vault_id: vaultId,
                  corpus_revision: "corpus-a",
                  provider: firstDescriptor.provider,
                  model: firstDescriptor.model,
                  model_revision: firstDescriptor.modelRevision,
                  dimensions: firstDescriptor.dimensions,
                  normalization: firstDescriptor.normalization,
                  input_strategy: firstDescriptor.inputStrategy,
                  configuration_version: firstDescriptor.configurationVersion,
                  runtime: firstDescriptor.runtime,
                },
              ],
            };
          }
          if (sql.includes("e.generation_id=$1")) return { rows: [] };
          return { rows: [] };
        },
      },
    } as never;
    const warnings: string[] = [];
    const availableChannels = new Set<
      "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
    >();
    const provider: EmbeddingProvider = {
      descriptor: firstDescriptor,
      embed: async () => [queryFixtureVector],
    };
    try {
      await queryKnowledge(
        db,
        {
          ...request,
          federated: true,
        },
        {
          vaultIds: [vaultId, secondVaultId],
          channels: ["vector"],
          warningSink: warnings,
          availableChannelSink: availableChannels,
          queryEmbeddingService: new QueryEmbeddingService(
            async () => provider,
          ),
        },
      );
      expect(availableChannels.has("vector")).toBe(true);
      expect(warnings).toContain(
        `VECTOR_GENERATION_UNAVAILABLE:${secondVaultId}`,
      );
      expect(warnings).toContain("INDEX_REVISION_STALE:vector");
      const vectorCall = calls.find((call) =>
        call.sql.includes("e.generation_id=$1"),
      );
      expect(vectorCall?.values?.[0]).toBe(firstGenerationId);
      expect(vectorCall?.values?.[3]).toBe(vaultId);
      const effective = effectiveRetrievalChannels(
        channelsConsistentWithIndex(
          ["vector"],
          {
            corpus_revision: "federated:corpus",
            vector_revision: "federated-vector:corpus",
          },
          true,
        ),
        warnings,
        availableChannels,
      );
      expect(effective.channels).toContain("vector");
    } finally {
      if (previous === undefined) delete process.env.AKP_VECTOR_ENABLED;
      else process.env.AKP_VECTOR_ENABLED = previous;
    }
  });
});
