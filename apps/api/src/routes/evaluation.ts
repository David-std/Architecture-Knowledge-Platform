import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { resolveAuthorizedVaultScope, type Postgres } from "@akp/postgres";
import { z } from "zod";
import {
  loadEvaluationPack,
  RETRIEVAL_BENCHMARK_MATRIX,
  REQUIRED_GENERIC_SLICES,
  scoreRetrieval,
  type GoldCase,
} from "@akp/evaluation";
import {
  actorOf,
  audit,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";
import { queryKnowledge } from "./search.js";
import type { RetrievalExecutionOptions } from "./search.js";

interface EvaluatedCase {
  slice: string;
  expectNoAnswer: boolean;
  noAnswerCorrect: boolean;
  metrics: { recallAt10: number };
}

function intersectionSize(
  left: readonly string[],
  right: readonly string[],
): number {
  const rightSet = new Set(right);
  return new Set(left.filter((value) => rightSet.has(value))).size;
}

const EvaluationTarget = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid(),
  evalPack: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/)
    .default("generic"),
});

async function validateEvaluationTarget(
  db: Postgres,
  target: z.infer<typeof EvaluationTarget>,
): Promise<boolean> {
  const result = await db.pool.query(
    `select eval_pack from vaults
      where id=$1 and space_id=$2 and enabled=true`,
    [target.vaultId, target.spaceId],
  );
  if (result.rows.length !== 1) return false;
  const registered = (result.rows[0]?.eval_pack ?? {}) as Record<
    string,
    unknown
  >;
  return (
    target.evalPack === "generic" ||
    String(registered.name ?? "") === target.evalPack
  );
}

function averageSlice(results: EvaluatedCase[], slice: string): number {
  const matching = results.filter((result) => result.slice === slice);
  return matching.length === 0
    ? 0
    : matching.reduce((sum, result) => sum + result.metrics.recallAt10, 0) /
        matching.length;
}

export async function runEvaluation(
  db: Postgres,
  configuration: {
    name?: string;
    channels?: RetrievalExecutionOptions["channels"];
    allowVectorForBenchmark?: boolean;
    deterministicRerank?: boolean;
  },
  spaceId: string,
  packName: string,
  vaultId: string,
): Promise<Record<string, unknown>> {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const checkedInCases = await loadEvaluationPack(root, packName);
  const persisted = await db.pool.query(
    `select id,category,query,expected,critical from eval_cases
      where active=true and (space_id is null or space_id=$1)
        and ($2::uuid is null or vault_id is null or vault_id=$2)
      order by id`,
    [spaceId, vaultId],
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
      expect_no_answer: Boolean(expected.expect_no_answer),
      ...(Array.isArray(expected.gold_evidence)
        ? { gold_evidence: expected.gold_evidence.map(String) }
        : {}),
      ...(Array.isArray(expected.gold_citations)
        ? { gold_citations: expected.gold_citations.map(String) }
        : {}),
      ...(typeof expected.slice === "string" ? { slice: expected.slice } : {}),
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
        vaultId,
        vaultIds: [vaultId],
        federated: false,
      },
      {
        vaultIds: [vaultId],
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
    const metricsAt5 = scoreRetrieval(
      {
        caseId: testCase.id,
        rankedDocumentIds: ranked,
        goldDocumentIds: testCase.gold_documents,
      },
      5,
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
    const expectNoAnswer = Boolean(testCase.expect_no_answer);
    const noAnswerCorrect = expectNoAnswer
      ? hits.length === 0
      : hits.length > 0;
    const relevantHitIndices = ranked
      .map((id, index) => (testCase.gold_documents.includes(id) ? index : -1))
      .filter((index) => index >= 0);
    const citedHitIndices = hits
      .map((hit, index) => (hit.citations.length > 0 ? index : -1))
      .filter((index) => index >= 0);
    const citedRelevantIndices = citedHitIndices.filter((index) =>
      relevantHitIndices.includes(index),
    );
    const retrievedEvidenceIds = citedRelevantIndices.map(
      (index) => ranked[index]!,
    );
    const evidenceLabelled = testCase.gold_evidence !== undefined;
    const evidenceRecall = evidenceLabelled
      ? testCase.gold_evidence!.length === 0
        ? 1
        : intersectionSize(retrievedEvidenceIds, testCase.gold_evidence!) /
          testCase.gold_evidence!.length
      : testCase.gold_documents.length === 0
        ? expectNoAnswer
          ? 1
          : 0
        : citedRelevantIndices.length / testCase.gold_documents.length;
    const retrievedCitationIds = hits.flatMap((hit) => hit.citations);
    const citationLabelled = testCase.gold_citations !== undefined;
    const citationPrecision = citationLabelled
      ? retrievedCitationIds.length === 0
        ? testCase.gold_citations!.length === 0
          ? 1
          : 0
        : intersectionSize(retrievedCitationIds, testCase.gold_citations!) /
          retrievedCitationIds.length
      : citedHitIndices.length === 0
        ? expectNoAnswer
          ? 1
          : 0
        : citedRelevantIndices.length / citedHitIndices.length;
    const unsupportedAnswer =
      !expectNoAnswer && hits.length > 0 && citedRelevantIndices.length === 0;
    const estimatedTokens = hits.reduce(
      (sum, hit) => sum + Math.ceil(hit.excerpt.length / 4),
      0,
    );
    results.push({
      id: testCase.id,
      category: testCase.category,
      query: testCase.query,
      ranked,
      metrics: {
        recallAt5: metricsAt5.recallAtK,
        recallAt10: metrics.recallAtK,
        precisionAt10: metrics.precisionAtK,
        reciprocalRank: metrics.reciprocalRank,
        ndcgAt10: metrics.ndcgAtK,
      },
      forbidden,
      passed:
        (expectNoAnswer ? noAnswerCorrect : metrics.hit) &&
        forbidden.length === 0 &&
        !unsupportedAnswer,
      critical: Boolean(testCase.critical),
      slice: testCase.slice ?? testCase.category,
      expectNoAnswer,
      noAnswerCorrect,
      latencyMs,
      estimatedTokens,
      evidenceRecall,
      evidenceLabelled,
      citationPrecision,
      citationLabelled,
      unsupportedAnswer,
    });
  }
  const metrics = {
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    criticalFailures: results.filter(
      (result) => result.critical && !result.passed,
    ).length,
    meanRecallAt10:
      results.reduce((sum, result) => sum + result.metrics.recallAt10, 0) /
      Math.max(results.length, 1),
    meanRecallAt5:
      results.reduce((sum, result) => sum + result.metrics.recallAt5, 0) /
      Math.max(results.length, 1),
    meanReciprocalRank:
      results.reduce((sum, result) => sum + result.metrics.reciprocalRank, 0) /
      Math.max(results.length, 1),
    meanNdcgAt10:
      results.reduce((sum, result) => sum + result.metrics.ndcgAt10, 0) /
      Math.max(results.length, 1),
    meanEvidenceRecall:
      results.reduce((sum, result) => sum + result.evidenceRecall, 0) /
      Math.max(results.length, 1),
    evidenceRecallCoverage:
      results.filter((result) => result.evidenceLabelled).length /
      Math.max(results.length, 1),
    meanCitationPrecision:
      results.reduce((sum, result) => sum + result.citationPrecision, 0) /
      Math.max(results.length, 1),
    citationPrecisionCoverage:
      results.filter((result) => result.citationLabelled).length /
      Math.max(results.length, 1),
    unsupportedAnswerRate:
      results.filter((result) => result.unsupportedAnswer).length /
      Math.max(results.length, 1),
    unsupportedClaimRate:
      results.filter((result) => result.unsupportedAnswer).length /
      Math.max(results.length, 1),
    meanLatencyMs:
      results.reduce((sum, result) => sum + result.latencyMs, 0) /
      Math.max(results.length, 1),
    meanEstimatedTokens:
      results.reduce((sum, result) => sum + result.estimatedTokens, 0) /
      Math.max(results.length, 1),
    meanTokenCost:
      results.reduce((sum, result) => sum + result.estimatedTokens, 0) /
      Math.max(results.length, 1),
    noAnswerAccuracy: (() => {
      const cases = results.filter((result) => result.expectNoAnswer);
      return cases.length === 0
        ? 1
        : cases.filter((result) => result.noAnswerCorrect).length /
            cases.length;
    })(),
    noAnswerCases: results.filter((result) => result.expectNoAnswer).length,
    exactIdentifierRecall: averageSlice(results, "exact-identifiers"),
    crossLanguageRecall: averageSlice(results, "cross-language"),
  };
  const revision = await db.pool.query(
    `select current_revision from vaults where space_id=$1
      and ($2::uuid is null or id=$2)
      order by last_imported_at desc nulls last limit 1`,
    [spaceId, vaultId],
  );
  const runId = randomUUID();
  await db.pool.query(
    `
    insert into eval_runs(id,space_id,vault_id,eval_pack,corpus_revision,retrieval_config,metrics,status)
    values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
    `,
    [
      runId,
      spaceId,
      vaultId,
      packName,
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
    evalPack: packName,
    vaultId,
    configurationName: configuration.name ?? "default",
    status: metrics.criticalFailures === 0 ? "PASSED" : "FAILED",
    ...metrics,
    results,
  };
}

export async function runRetrievalBenchmark(
  db: Postgres,
  spaceId: string,
  packName: string,
  vaultId: string,
): Promise<Record<string, unknown>> {
  // Keep the API benchmark in lockstep with the package-level matrix.  A
  // spread creates mutable channel arrays for the execution adapter while the
  // canonical matrix remains immutable and testable offline.
  const configurations: Array<{
    name: string;
    channels: NonNullable<RetrievalExecutionOptions["channels"]>;
    allowVectorForBenchmark?: boolean;
    deterministicRerank?: boolean;
  }> = RETRIEVAL_BENCHMARK_MATRIX.map((configuration) => ({
    name: configuration.name,
    channels: [...configuration.channels] as NonNullable<
      RetrievalExecutionOptions["channels"]
    >,
    ...(configuration.allowVectorForBenchmark === undefined
      ? {}
      : { allowVectorForBenchmark: configuration.allowVectorForBenchmark }),
    ...(configuration.deterministicRerank === undefined
      ? {}
      : { deterministicRerank: configuration.deterministicRerank }),
  }));
  const runs = [];
  for (const configuration of configurations) {
    runs.push(
      await runEvaluation(db, configuration, spaceId, packName, vaultId),
    );
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
        Number(right.meanNdcgAt10) - Number(left.meanNdcgAt10) ||
        Number(right.meanRecallAt10) - Number(left.meanRecallAt10) ||
        Number(right.meanCitationPrecision) -
          Number(left.meanCitationPrecision) ||
        Number(left.meanLatencyMs) - Number(right.meanLatencyMs),
    );
  const nonVector = ranked.filter(
    (run) =>
      !String(run.configurationName).includes("vector") &&
      !String(run.configurationName).includes("full-hybrid"),
  );
  const vectorCandidates = ranked.filter(
    (run) =>
      String(run.configurationName).includes("vector") ||
      String(run.configurationName).includes("full-hybrid"),
  );
  const baseline = nonVector[0];
  const bestVector = vectorCandidates[0];
  const vectorEligible = Boolean(
    baseline &&
    bestVector &&
    Number(bestVector.meanReciprocalRank) >=
      Number(baseline.meanReciprocalRank) + 0.02 &&
    Number(bestVector.meanRecallAt10) >= Number(baseline.meanRecallAt10) &&
    Number(bestVector.meanCitationPrecision) >=
      Number(baseline.meanCitationPrecision) &&
    Number(bestVector.exactIdentifierRecall) >=
      Number(baseline.exactIdentifierRecall) &&
    Number(bestVector.meanLatencyMs) <=
      Math.max(Number(baseline.meanLatencyMs) * 2, 25),
  );
  const winner = vectorEligible ? bestVector : (baseline ?? ranked[0]);
  const datasetSlices = [
    ...new Set(
      runs.flatMap((run) =>
        Array.isArray(run.results)
          ? run.results.map((result) => String(result.slice ?? ""))
          : [],
      ),
    ),
  ].sort();
  return {
    status: "COMPLETED",
    datasetCases: Number(runs[0]?.cases ?? 0),
    evalPack: packName,
    vaultId,
    matrixSize: RETRIEVAL_BENCHMARK_MATRIX.length,
    benchmarkMatrix: RETRIEVAL_BENCHMARK_MATRIX.map((configuration) => ({
      name: configuration.name,
      channels: [...configuration.channels],
      vectorBenchmarkOnly: Boolean(configuration.allowVectorForBenchmark),
      rerank: Boolean(configuration.deterministicRerank),
    })),
    datasetSlices,
    requiredGenericSlices:
      packName === "generic" ? [...REQUIRED_GENERIC_SLICES] : [],
    metricDefinitions: {
      evidenceRecall:
        "gold_evidence labels when present; otherwise cited relevant-document provenance proxy",
      citationPrecision:
        "gold_citations labels when present; otherwise cited relevant-hit precision proxy",
      unsupportedClaimRate:
        "returned non-no-answer result with no cited relevant hit",
      tokenCost: "estimated excerpt tokens (characters / 4)",
    },
    runs,
    selectedDefault: String(winner?.configurationName ?? "exact+lexical"),
    vectorActivatedByDefault: vectorEligible,
    decision: {
      eligibility:
        "Critical failures and unsupported-answer rate must both be zero.",
      vectorRule:
        "Vector requires >=0.02 MRR gain, no Recall@10/citation/exact-ID regression, and <=2x baseline latency.",
      baseline: baseline?.configurationName ?? null,
      bestVector: bestVector?.configurationName ?? null,
      vectorEligible,
    },
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
      const query = z
        .object({ vaultId: z.string().uuid().optional() })
        .safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ code: "INVALID_EVAL_QUERY" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const authorizedVaultIds: string[] = [];
      for (const spaceId of spaces) {
        try {
          const scope = await resolveAuthorizedVaultScope(db, {
            userId: actor.id,
            spaceId,
            permission: "knowledge:read",
            ...(query.data.vaultId ? { vaultId: query.data.vaultId } : {}),
            ...(query.data.vaultId ? { vaultIds: [query.data.vaultId] } : {}),
            federated: !query.data.vaultId,
          });
          authorizedVaultIds.push(...scope.vaultIds);
        } catch {
          // A user can belong to a space without being authorized for each
          // private vault in it; inaccessible vaults remain indistinguishable.
        }
      }
      if (authorizedVaultIds.length === 0) return { runs: [] };
      const result = await db.pool.query(
        `select id,space_id,vault_id,eval_pack,corpus_revision,metrics,status,created_at
           from eval_runs
          where space_id=any($1::uuid[])
            and vault_id=any($2::uuid[])
          order by created_at desc limit 50`,
        [spaces, [...new Set(authorizedVaultIds)]],
      );
      return { runs: result.rows };
    },
  );
  app.post(
    "/v1/evals/run",
    { preHandler: requirePermission("eval:run") },
    async (request, reply) => {
      const parsed = EvaluationTarget.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_EVAL_TARGET",
          issues: parsed.error.issues,
        });
      }
      const spaces = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "eval:run",
      );
      if (!spaces.includes(parsed.data.spaceId)) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      try {
        await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: parsed.data.spaceId,
          permission: "eval:run",
          vaultId: parsed.data.vaultId,
          vaultIds: [parsed.data.vaultId],
          federated: false,
        });
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      if (!(await validateEvaluationTarget(db, parsed.data))) {
        return reply.code(404).send({ code: "EVAL_TARGET_NOT_FOUND" });
      }
      const result = await runEvaluation(
        db,
        {},
        parsed.data.spaceId,
        parsed.data.evalPack,
        parsed.data.vaultId,
      );
      await audit(
        db,
        request,
        "eval.run",
        "eval_run",
        String(result.runId),
        {},
        parsed.data.spaceId,
      );
      return result;
    },
  );
  app.post(
    "/v1/evals/benchmark",
    { preHandler: requirePermission("eval:run") },
    async (request, reply) => {
      const parsed = EvaluationTarget.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_EVAL_TARGET",
          issues: parsed.error.issues,
        });
      }
      const spaces = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "eval:run",
      );
      if (!spaces.includes(parsed.data.spaceId)) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      try {
        await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: parsed.data.spaceId,
          permission: "eval:run",
          vaultId: parsed.data.vaultId,
          vaultIds: [parsed.data.vaultId],
          federated: false,
        });
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      if (!(await validateEvaluationTarget(db, parsed.data))) {
        return reply.code(404).send({ code: "EVAL_TARGET_NOT_FOUND" });
      }
      const result = await runRetrievalBenchmark(
        db,
        parsed.data.spaceId,
        parsed.data.evalPack,
        parsed.data.vaultId,
      );
      await audit(
        db,
        request,
        "eval.benchmark",
        "retrieval_benchmark",
        undefined,
        {},
        parsed.data.spaceId,
      );
      return result;
    },
  );
}
