import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import { scoreRetrieval } from "@akp/evaluation";
import {
  actorOf,
  audit,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";
import { queryKnowledge } from "./search.js";
import type { RetrievalExecutionOptions } from "./search.js";

interface GoldCase {
  id: string;
  category: string;
  query: string;
  gold_documents: string[];
  must_not_include?: string[];
  critical?: boolean;
}

export async function runEvaluation(
  db: Postgres,
  configuration: {
    name?: string;
    channels?: RetrievalExecutionOptions["channels"];
    allowVectorForBenchmark?: boolean;
    deterministicRerank?: boolean;
  } = {},
  spaceId = "00000000-0000-0000-0000-000000000003",
): Promise<Record<string, unknown>> {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const lines = (await readFile(path.join(root, "evals/gold.jsonl"), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean);
  const checkedInCases = lines.map((line) => JSON.parse(line) as GoldCase);
  const persisted = await db.pool.query(
    "select id,category,query,expected,critical from eval_cases where active=true and (space_id is null or space_id=$1) order by id",
    [spaceId],
  );
  const persistedCases = persisted.rows.map((row) => {
    const expected = (row.expected ?? {}) as Record<string, unknown>;
    return {
      id: String(row.id),
      category: String(row.category),
      query: String(row.query),
      gold_documents: Array.isArray(expected.gold_documents)
        ? expected.gold_documents.map(String)
        : [],
      must_not_include: Array.isArray(expected.must_not_include)
        ? expected.must_not_include.map(String)
        : [],
      critical: Boolean(row.critical),
    } satisfies GoldCase;
  });
  const byId = new Map<string, GoldCase>();
  for (const testCase of [...checkedInCases, ...persistedCases])
    byId.set(testCase.id, testCase);
  const cases = [...byId.values()];
  const results = [];
  for (const testCase of cases) {
    const started = performance.now();
    const hits = await queryKnowledge(
      db,
      {
        query: testCase.query,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 10,
        spaceId,
      },
      {
        ...(configuration.channels ? { channels: configuration.channels } : {}),
        ...(configuration.allowVectorForBenchmark === undefined
          ? {}
          : { allowVectorForBenchmark: configuration.allowVectorForBenchmark }),
        ...(configuration.deterministicRerank
          ? { deterministicRerank: true }
          : {}),
      },
    );
    const latencyMs = performance.now() - started;
    const rows =
      hits.length === 0
        ? { rows: [] }
        : await db.pool.query(
            "select id,external_id,path from knowledge_documents where id=any($1::uuid[])",
            [hits.map((hit) => hit.documentId)],
          );
    const identityById = new Map(
      rows.rows.map((row) => {
        const stem = path.posix.basename(String(row.path), ".md");
        const externalId = String(row.external_id);
        const preferred = testCase.gold_documents.includes(stem)
          ? stem
          : externalId;
        return [String(row.id), preferred];
      }),
    );
    const ranked = hits.map(
      (hit) => identityById.get(hit.documentId) ?? hit.documentId,
    );
    const metrics = scoreRetrieval(
      {
        caseId: testCase.id,
        rankedDocumentIds: ranked,
        goldDocumentIds: testCase.gold_documents,
      },
      10,
    );
    const forbidden = (testCase.must_not_include ?? []).filter((id) =>
      ranked.includes(id),
    );
    results.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      ranked,
      metrics,
      forbidden,
      passed: metrics.hit && forbidden.length === 0,
      critical: Boolean(testCase.critical),
      latencyMs,
      citationPrecision:
        hits.length === 0
          ? 1
          : hits.filter((hit) => hit.citations.length > 0).length / hits.length,
      unsupportedAnswer:
        hits.length > 0 && hits.every((hit) => hit.citations.length === 0),
    });
  }
  const metrics = {
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    criticalFailures: results.filter(
      (result) => result.critical && !result.passed,
    ).length,
    meanRecallAt10:
      results.reduce((sum, result) => sum + result.metrics.recallAtK, 0) /
      Math.max(results.length, 1),
    meanReciprocalRank:
      results.reduce((sum, result) => sum + result.metrics.reciprocalRank, 0) /
      Math.max(results.length, 1),
    meanNdcgAt10:
      results.reduce((sum, result) => sum + result.metrics.ndcgAtK, 0) /
      Math.max(results.length, 1),
    meanCitationPrecision:
      results.reduce((sum, result) => sum + result.citationPrecision, 0) /
      Math.max(results.length, 1),
    unsupportedAnswerRate:
      results.filter((result) => result.unsupportedAnswer).length /
      Math.max(results.length, 1),
    meanLatencyMs:
      results.reduce((sum, result) => sum + result.latencyMs, 0) /
      Math.max(results.length, 1),
  };
  const revision = await db.pool.query(
    "select current_revision from vaults where space_id=$1 order by last_imported_at desc nulls last limit 1",
    [spaceId],
  );
  const runId = randomUUID();
  await db.pool.query(
    `
    insert into eval_runs(id,space_id,corpus_revision,retrieval_config,metrics,status)
    values($1,$2,$3,$4::jsonb,$5::jsonb,$6)
    `,
    [
      runId,
      spaceId,
      String(revision.rows[0]?.current_revision ?? "unknown"),
      JSON.stringify({
        name: configuration.name ?? "default",
        channels: configuration.channels ?? [
          "context-pack",
          "exact",
          "lexical",
          "graph",
        ],
        vectorBenchmarkOnly: Boolean(configuration.allowVectorForBenchmark),
        deterministicRerank: Boolean(configuration.deterministicRerank),
        k: 10,
      }),
      JSON.stringify({ ...metrics, results }),
      metrics.criticalFailures === 0 ? "PASSED" : "FAILED",
    ],
  );
  return {
    runId,
    configurationName: configuration.name ?? "default",
    status: metrics.criticalFailures === 0 ? "PASSED" : "FAILED",
    ...metrics,
    results,
  };
}

export async function runRetrievalBenchmark(
  db: Postgres,
  spaceId = "00000000-0000-0000-0000-000000000003",
): Promise<Record<string, unknown>> {
  const configurations: Array<{
    name: string;
    channels: NonNullable<RetrievalExecutionOptions["channels"]>;
    allowVectorForBenchmark?: boolean;
    deterministicRerank?: boolean;
  }> = [
    { name: "context-pack-only", channels: ["context-pack"] },
    { name: "exact+lexical", channels: ["exact", "lexical"] },
    {
      name: "vector-only",
      channels: ["vector"],
      allowVectorForBenchmark: true,
    },
    {
      name: "lexical-seeded-graph",
      channels: ["graph"],
    },
    {
      name: "lexical+vector",
      channels: ["lexical", "vector"],
      allowVectorForBenchmark: true,
    },
    { name: "lexical+graph", channels: ["lexical", "graph"] },
    {
      name: "vector+graph",
      channels: ["vector", "graph"],
      allowVectorForBenchmark: true,
    },
    {
      name: "context-pack+lexical+graph",
      channels: ["context-pack", "lexical", "graph"],
    },
    {
      name: "exact+lexical+graph",
      channels: ["exact", "lexical", "graph"],
    },
    {
      name: "full-hybrid-rrf",
      channels: ["context-pack", "exact", "lexical", "vector", "graph"],
      allowVectorForBenchmark: true,
    },
    {
      name: "full-hybrid+deterministic-lexical-rerank",
      channels: ["context-pack", "exact", "lexical", "vector", "graph"],
      allowVectorForBenchmark: true,
      deterministicRerank: true,
    },
  ];
  const runs = [];
  for (const configuration of configurations) {
    runs.push(await runEvaluation(db, configuration, spaceId));
  }
  const ranked = [...runs]
    .filter(
      (run) =>
        Number(run.criticalFailures) === 0 &&
        Number(run.unsupportedAnswerRate) === 0,
    )
    .sort(
      (left, right) =>
        Number(right.meanReciprocalRank) - Number(left.meanReciprocalRank) ||
        Number(right.meanRecallAt10) - Number(left.meanRecallAt10),
    );
  const winner = ranked[0];
  return {
    status: "COMPLETED",
    datasetCases: Number(runs[0]?.cases ?? 0),
    runs,
    selectedDefault: String(winner?.configurationName ?? "exact+lexical"),
    vectorActivatedByDefault: false,
    decision:
      "Only configurations with zero critical failures and zero unsupported-answer rate are eligible. Vector remains benchmark-only because this smoke dataset is too small to justify a default semantic channel.",
    bestEligibleRunId: String(winner?.runId ?? ""),
  };
}

export function registerEvaluationRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/evals",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const spaces = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "knowledge:read",
      );
      if (!spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        "select id,space_id,corpus_revision,metrics,status,created_at from eval_runs where space_id=any($1::uuid[]) order by created_at desc limit 50",
        [spaces],
      );
      return { runs: result.rows };
    },
  );
  app.post(
    "/v1/evals/run",
    { preHandler: requirePermission("eval:run") },
    async (request, reply) => {
      const spaceId = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "eval:run",
      )[0];
      if (!spaceId) return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      const result = await runEvaluation(db, {}, spaceId);
      await audit(
        db,
        request,
        "eval.run",
        "eval_run",
        String(result.runId),
        {},
        spaceId,
      );
      return result;
    },
  );
  app.post(
    "/v1/evals/benchmark",
    { preHandler: requirePermission("eval:run") },
    async (request, reply) => {
      const spaceId = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "eval:run",
      )[0];
      if (!spaceId) return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      const result = await runRetrievalBenchmark(db, spaceId);
      await audit(
        db,
        request,
        "eval.benchmark",
        "retrieval_benchmark",
        undefined,
        {},
        spaceId,
      );
      return result;
    },
  );
}
