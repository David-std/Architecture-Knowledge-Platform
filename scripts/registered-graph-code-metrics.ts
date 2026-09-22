import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type {
  GraphDomain,
  GraphNodeIdentity,
  GraphProjectionArtifact,
  GraphProjectionEdgeInput,
  GraphProjectionNodeInput,
  GraphProvenanceEnvelope,
} from "../packages/contracts/src/index.js";
import { Postgres, PostgresFederatedGraphStore } from "../packages/postgres/src/index.js";
import { CodeGraphQueryService } from "../packages/project-adapter/src/index.js";
import {
  detectLeidenCommunities,
  personalizedPageRank,
} from "../packages/retrieval/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const outputPath = path.resolve(
  process.env.AKP_REGISTERED_GRAPH_CODE_METRICS_REPORT ??
    "reports/ci/registered-graph-code-metrics.json",
);

type RateMetric = {
  measured: true;
  value: number;
  numerator: number;
  denominator: number;
  sampleCount: number;
  unit: "ratio";
  scope: "REGISTERED_FIXTURE";
  evidence: string;
  limitation: string;
};

type DurationMetric = {
  measured: true;
  value: number;
  sampleCount: 1;
  unit: "ms";
  scope: "REGISTERED_FIXTURE";
  evidence: string;
  limitation: string;
};

function rate(
  numerator: number,
  denominator: number,
  evidence: string,
  limitation: string,
): RateMetric {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    throw new Error("REGISTERED_METRIC_DENOMINATOR_INVALID");
  }
  return {
    measured: true,
    value: numerator / denominator,
    numerator,
    denominator,
    sampleCount: denominator,
    unit: "ratio",
    scope: "REGISTERED_FIXTURE",
    evidence,
    limitation,
  };
}

function duration(
  value: number,
  evidence: string,
  limitation: string,
): DurationMetric {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("REGISTERED_DURATION_INVALID");
  }
  return {
    measured: true,
    value,
    sampleCount: 1,
    unit: "ms",
    scope: "REGISTERED_FIXTURE",
    evidence,
    limitation,
  };
}

function intersectionCount(
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): number {
  let count = 0;
  for (const value of actual) if (expected.has(value)) count += 1;
  return count;
}

function identity(
  graphDomain: GraphDomain,
  scopeId: string,
  kind: string,
  canonicalKey: string,
  revision: string,
): GraphNodeIdentity {
  return { graphDomain, scopeId, kind, canonicalKey, revision };
}

function node(
  identityValue: GraphNodeIdentity,
  vaultId: string | null,
  authorizationPath: string | null,
  payload: Record<string, unknown> = {},
): GraphProjectionNodeInput {
  return {
    identity: identityValue,
    vaultId,
    authorizationPath,
    payload,
  };
}

function provenance(revision: string): GraphProvenanceEnvelope {
  return {
    derivation: "STATICALLY_RESOLVED",
    sourceIds: [`registered-source:${revision}`],
    evidenceIds: [`registered-evidence:${revision}`],
    locatorRefs: [],
    revision,
    recordedAt: "2026-09-21T00:00:00.000Z",
  };
}

function edge(
  from: GraphNodeIdentity,
  relation: string,
  to: GraphNodeIdentity,
  revision: string,
  authorizationPath: string | null,
): GraphProjectionEdgeInput {
  return {
    from,
    relation,
    to,
    authorizationPath,
    provenance: provenance(revision),
  };
}

function artifact(input: {
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  revision: string;
  nodes: readonly GraphProjectionNodeInput[];
  edges: readonly GraphProjectionEdgeInput[];
}): GraphProjectionArtifact {
  return {
    graphDomain: input.graphDomain,
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    scopeId: input.scopeId,
    revision: input.revision,
    sourceRevision: `registered-source:${input.revision}`,
    sourceHash: null,
    provider: "registered-domain-metrics",
    providerVersion: "1",
    configurationVersion: "registered-domain-metrics-v1",
    nodes: input.nodes,
    edges: input.edges,
  };
}

const db = new Postgres(databaseUrl);
const store = new PostgresFederatedGraphStore(db);
const code = new CodeGraphQueryService(store);
const organizationId = randomUUID();
const spaceId = randomUUID();
const vaultId = randomUUID();
const codeScope = "code:registered-domain-metrics";
const epistemicScope = "epistemic:registered-domain-metrics";
const codeRevision = "registered-code-r1";
const nextCodeRevision = "registered-code-r2";
const decisionRevision = "registered-decision-r1";
const repository = "fixture/registered";
const commitSha = "1111111111111111111111111111111111111111";
const nextCommitSha = "2222222222222222222222222222222222222222";

const decision = identity(
  "EPISTEMIC",
  epistemicScope,
  "decision",
  "decision:auth-boundary",
  decisionRevision,
);
const service = identity(
  "CODE",
  codeScope,
  "function",
  "code:service",
  codeRevision,
);
const auth = identity("CODE", codeScope, "function", "code:auth", codeRevision);
const repositoryNode = identity(
  "CODE",
  codeScope,
  "function",
  "code:repository",
  codeRevision,
);
const testNode = identity("CODE", codeScope, "test", "code:test", codeRevision);
const hidden = identity(
  "CODE",
  codeScope,
  "function",
  "code:hidden",
  codeRevision,
);

const authorization = {
  spaceId,
  vaults: [{ vaultId, pathPrefix: "allowed" }],
  allowSpaceScoped: false,
} as const;
const graphBounds = {
  maxHops: 4,
  maxFanout: 50,
  maxCandidates: 100,
  timeBudgetMs: 5000,
} as const;

try {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'REGISTERED domain metrics')`,
    [organizationId, `registered-metrics-${organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'REGISTERED metrics space','PRIVATE',$4)`,
    [
      spaceId,
      organizationId,
      `registered-metrics-${spaceId.slice(0, 8)}`,
      `/tmp/registered-metrics-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,'REGISTERED metrics vault',true,$4,$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/registered-metrics-vault-${vaultId}`,
      commitSha,
      `registered-metrics-${vaultId.slice(0, 8)}`,
    ],
  );

  await store.build(
    artifact({
      graphDomain: "EPISTEMIC",
      spaceId,
      vaultId,
      scopeId: epistemicScope,
      revision: decisionRevision,
      nodes: [
        node(decision, vaultId, "allowed/decisions/auth-boundary.md", {
          title: "Authentication boundary",
          status: "active",
        }),
      ],
      edges: [],
    }),
  );

  const codeArtifact = (revision: string, commit: string) => {
    const serviceIdentity = identity(
      "CODE",
      codeScope,
      "function",
      "code:service",
      revision,
    );
    const authIdentity = identity(
      "CODE",
      codeScope,
      "function",
      "code:auth",
      revision,
    );
    const repositoryIdentity = identity(
      "CODE",
      codeScope,
      "function",
      "code:repository",
      revision,
    );
    const testIdentity = identity(
      "CODE",
      codeScope,
      "test",
      "code:test",
      revision,
    );
    const hiddenIdentity = identity(
      "CODE",
      codeScope,
      "function",
      "code:hidden",
      revision,
    );
    return artifact({
      graphDomain: "CODE",
      spaceId,
      vaultId,
      scopeId: codeScope,
      revision,
      nodes: [
        node(serviceIdentity, vaultId, "allowed/src/service.ts", {
          repository,
          commitSha: commit,
          path: "src/service.ts",
          qualifiedName: "Service.handle",
          name: "handle",
          kind: "FUNCTION",
        }),
        node(authIdentity, vaultId, "allowed/src/auth.ts", {
          repository,
          commitSha: commit,
          path: "src/auth.ts",
          qualifiedName: "Auth.validate",
          name: "validate",
          kind: "FUNCTION",
        }),
        node(repositoryIdentity, vaultId, "allowed/src/repository.ts", {
          repository,
          commitSha: commit,
          path: "src/repository.ts",
          qualifiedName: "Repository.save",
          name: "save",
          kind: "FUNCTION",
        }),
        node(testIdentity, vaultId, "allowed/test/service.test.ts", {
          repository,
          commitSha: commit,
          path: "test/service.test.ts",
          qualifiedName: "ServiceTest.validates",
          name: "validates",
          kind: "TEST",
        }),
        node(hiddenIdentity, vaultId, "private/src/hidden.ts", {
          repository,
          commitSha: commit,
          path: "private/src/hidden.ts",
          qualifiedName: "Hidden.secret",
          name: "secret",
          kind: "FUNCTION",
        }),
      ],
      edges: [
        edge(
          serviceIdentity,
          "calls",
          authIdentity,
          revision,
          "allowed/src/service.ts",
        ),
        edge(
          authIdentity,
          "calls",
          repositoryIdentity,
          revision,
          "allowed/src/auth.ts",
        ),
        edge(
          authIdentity,
          "calls",
          hiddenIdentity,
          revision,
          "private/src/hidden.ts",
        ),
        edge(
          serviceIdentity,
          "imports",
          repositoryIdentity,
          revision,
          "allowed/src/service.ts",
        ),
        edge(
          testIdentity,
          "tests",
          serviceIdentity,
          revision,
          "allowed/test/service.test.ts",
        ),
        edge(
          serviceIdentity,
          "governed_by",
          decision,
          revision,
          "allowed/src/service.ts",
        ),
      ],
    });
  };

  const buildStartedAt = performance.now();
  await store.build(codeArtifact(codeRevision, commitSha));
  const codeProjectionBuildMs = performance.now() - buildStartedAt;

  const callsImpact = await store.impact({
    authorization,
    domains: ["CODE"],
    relationAllowlist: ["calls"],
    direction: "outgoing",
    freshnessPolicy: "FRESH_ONLY",
    bounds: graphBounds,
    seed: { identity: service },
  });
  const callTargets = new Set(
    callsImpact.affected.map((entry) => entry.target.identity.canonicalKey),
  );
  const expectedCallTargets = new Set(["code:auth", "code:repository"]);
  const relevantCallTargets = intersectionCount(
    callTargets,
    expectedCallTargets,
  );
  const typedPathPrecision = rate(
    relevantCallTargets,
    Math.max(1, callTargets.size),
    "PostgresFederatedGraphStore.impact over typed calls relations",
    "Precision is measured on one registered synthetic graph fixture, not a production corpus.",
  );
  const multiHopRecall = rate(
    relevantCallTargets,
    expectedCallTargets.size,
    "PostgresFederatedGraphStore.impact over a two-hop expected path set",
    "Recall is bounded to the registered fixture's two expected reachable targets.",
  );
  const unauthorizedPathCount = callsImpact.affected.filter(
    (entry) =>
      entry.target.authorizationPath === null ||
      !entry.target.authorizationPath.startsWith("allowed/"),
  ).length;
  const unauthorizedPathRate = rate(
    unauthorizedPathCount,
    Math.max(1, callsImpact.affected.length),
    "Authorized graph traversal with a private hidden neighbor present in the persisted graph",
    "Rate is measured only across paths returned by the registered fixture.",
  );
  const explainablePaths = callsImpact.affected.filter((entry) =>
    entry.steps.every(
      (step) =>
        step.assertion.id.length > 0 &&
        step.provenance.revision.length > 0 &&
        step.provenance.sourceIds.length > 0,
    ),
  ).length;
  const pathExplainability = rate(
    explainablePaths,
    Math.max(1, callsImpact.affected.length),
    "Returned GraphPathResult assertions and provenance envelopes",
    "This checks machine-readable provenance completeness, not human explanation quality.",
  );

  const bridgeImpact = await store.impact({
    authorization,
    domains: ["CODE", "EPISTEMIC"],
    relationAllowlist: ["governed_by"],
    direction: "outgoing",
    freshnessPolicy: "FRESH_ONLY",
    bounds: graphBounds,
    seed: { identity: service },
  });
  const bridgeTargets = new Set(
    bridgeImpact.affected.map((entry) => entry.target.identity.canonicalKey),
  );
  const expectedBridgeTargets = new Set(["decision:auth-boundary"]);
  const bridgeAccuracy = rate(
    intersectionCount(bridgeTargets, expectedBridgeTargets),
    Math.max(1, Math.max(bridgeTargets.size, expectedBridgeTargets.size)),
    "Cross-domain CODE -> EPISTEMIC governed_by traversal",
    "Bridge accuracy covers one explicit registered cross-domain relation.",
  );

  const ppr = personalizedPageRank({
    nodes: [
      { id: "seed", scopeId: "registered", graphDomain: "EPISTEMIC" },
      { id: "strong", scopeId: "registered", graphDomain: "EPISTEMIC" },
      { id: "weak", scopeId: "registered", graphDomain: "EPISTEMIC" },
    ],
    edges: [
      {
        fromNodeId: "seed",
        toNodeId: "strong",
        scopeId: "registered",
        relation: "supports",
        weight: 4,
      },
      {
        fromNodeId: "seed",
        toNodeId: "weak",
        scopeId: "registered",
        relation: "supports",
        weight: 1,
      },
      {
        fromNodeId: "strong",
        toNodeId: "seed",
        scopeId: "registered",
        relation: "supports",
        weight: 1,
      },
    ],
    seeds: [{ nodeId: "seed", weight: 1 }],
    policy: {
      allowedGraphDomains: ["EPISTEMIC"],
      allowedRelations: ["supports"],
      maxIterations: 250,
      tolerance: 1e-12,
    },
  });
  const pprTargets = new Set(
    ppr.candidates
      .map((entry) => entry.nodeId)
      .filter((nodeId) => nodeId !== "seed"),
  );
  const pprExpected = new Set(["strong", "weak"]);
  const pprAssociativeRecall = rate(
    intersectionCount(pprTargets, pprExpected),
    pprExpected.size,
    "personalizedPageRank over the registered weighted associative fixture",
    "This measures candidate recall on a small deterministic authorized graph.",
  );

  const communityNodes = ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({
    id,
  }));
  const community = detectLeidenCommunities(
    communityNodes,
    [
      { id: "a12", from: "a1", to: "a2", weight: 3 },
      { id: "a23", from: "a2", to: "a3", weight: 3 },
      { id: "a31", from: "a3", to: "a1", weight: 3 },
      { id: "b12", from: "b1", to: "b2", weight: 3 },
      { id: "b23", from: "b2", to: "b3", weight: 3 },
      { id: "b31", from: "b3", to: "b1", weight: 3 },
    ],
    { resolution: 0.5, randomSeed: 42 },
  );
  const coveredCommunityNodes = new Set(
    community.memberships.map((entry) => entry.nodeId),
  );
  const globalCommunityCoverage = rate(
    coveredCommunityNodes.size,
    communityNodes.length,
    "detectLeidenCommunities deterministic registered fixture",
    "Coverage measures membership coverage, not semantic quality of community labels.",
  );

  const symbolSelectors = [
    { qualifiedName: "Service.handle", expected: "code:service" },
    { qualifiedName: "Auth.validate", expected: "code:auth" },
    { qualifiedName: "Repository.save", expected: "code:repository" },
  ];
  let symbolCorrect = 0;
  for (const sample of symbolSelectors) {
    const result = await code.symbol(
      { authorization, freshnessPolicy: "FRESH_ONLY" },
      { repository, commitSha, qualifiedName: sample.qualifiedName },
    );
    if (
      result.length === 1 &&
      result[0]?.identity.canonicalKey === sample.expected
    ) {
      symbolCorrect += 1;
    }
  }
  const symbolResolution = rate(
    symbolCorrect,
    symbolSelectors.length,
    "CodeGraphQueryService.symbol against three registered exact symbol selectors",
    "The fixture covers exact qualified-name resolution, not fuzzy reconciliation.",
  );

  const [callers, callees] = await Promise.all([
    code.callers(
      { authorization, freshnessPolicy: "FRESH_ONLY" },
      { repository, commitSha, qualifiedName: "Auth.validate" },
    ),
    code.callees(
      { authorization, freshnessPolicy: "FRESH_ONLY" },
      { repository, commitSha, qualifiedName: "Service.handle" },
    ),
  ]);
  const callerCorrect =
    callers.length === 1 &&
    callers[0]?.target.identity.canonicalKey === "code:service";
  const calleeCorrect =
    callees.length === 1 &&
    callees[0]?.target.identity.canonicalKey === "code:auth";
  const callersCalleesCorrectness = rate(
    Number(callerCorrect) + Number(calleeCorrect),
    2,
    "CodeGraphQueryService callers/callees over persisted calls edges",
    "Two directional call assertions are measured in the registered fixture.",
  );

  const dependencies = await code.dependencies(
    { authorization, freshnessPolicy: "FRESH_ONLY" },
    { repository, commitSha, qualifiedName: "Service.handle" },
  );
  const dependencyTargets = new Set(
    dependencies.map((entry) => entry.target.identity.canonicalKey),
  );
  const dependencyExpected = new Set(["code:repository"]);
  const dependencyPathPrecision = rate(
    intersectionCount(dependencyTargets, dependencyExpected),
    Math.max(1, dependencyTargets.size),
    "CodeGraphQueryService.dependencies over persisted imports edges",
    "Precision covers one registered dependency edge.",
  );

  const blast = await code.impact(
    { authorization, freshnessPolicy: "FRESH_ONLY" },
    { repository, commitSha, qualifiedName: "Auth.validate" },
    { direction: "incoming", relationTypes: ["calls"], maxHops: 2 },
  );
  const blastTargets = new Set(
    blast.affected.map((entry) => entry.target.identity.canonicalKey),
  );
  const blastExpected = new Set(["code:service"]);
  const blastRadiusRecall = rate(
    intersectionCount(blastTargets, blastExpected),
    blastExpected.size,
    "CodeGraphQueryService.impact incoming calls",
    "Blast-radius recall is measured on one known dependent in the fixture.",
  );

  const changed = await code.changeImpact(
    { authorization, freshnessPolicy: "FRESH_ONLY" },
    {
      repository,
      commitSha,
      changedPaths: ["src/auth.ts"],
      options: {
        direction: "incoming",
        relationTypes: ["calls"],
        maxHops: 2,
      },
    },
  );
  const changedTargets = new Set(
    changed.impacts.flatMap((impact) =>
      impact.affected.map((entry) => entry.target.identity.canonicalKey),
    ),
  );
  const changeImpactRecall = rate(
    intersectionCount(changedTargets, blastExpected),
    blastExpected.size,
    "CodeGraphQueryService.changeImpact from an exact changed path",
    "The fixture has one changed source path and one expected dependent.",
  );

  const tests = await code.tests(
    { authorization, freshnessPolicy: "FRESH_ONLY" },
    { repository, commitSha, qualifiedName: "Service.handle" },
  );
  const testTargets = new Set(
    tests.map((entry) => entry.target.identity.canonicalKey),
  );
  const testExpected = new Set(["code:test"]);
  const testLinkageAccuracy = rate(
    intersectionCount(testTargets, testExpected),
    Math.max(1, Math.max(testTargets.size, testExpected.size)),
    "CodeGraphQueryService.tests over a persisted tests relation",
    "Accuracy covers one explicit registered test linkage.",
  );

  const governed = await code.impact(
    { authorization, freshnessPolicy: "FRESH_ONLY" },
    { repository, commitSha, qualifiedName: "Service.handle" },
    {
      direction: "outgoing",
      relationTypes: [],
      includeRulesDecisions: true,
      maxHops: 1,
    },
  );
  const governedTargets = new Set(
    governed.affected.map((entry) => entry.target.identity.canonicalKey),
  );
  const ruleDecisionBridgePrecision = rate(
    intersectionCount(governedTargets, expectedBridgeTargets),
    Math.max(1, governedTargets.size),
    "CodeGraphQueryService rule/decision bridge traversal",
    "Precision covers one CODE -> EPISTEMIC governed_by bridge.",
  );

  await store.markStale(
    "CODE",
    spaceId,
    codeScope,
    "REGISTERED stale detection fixture",
  );
  const staleSymbols = await code.symbol(
    { authorization, freshnessPolicy: "FRESH_ONLY" },
    { repository, commitSha, qualifiedName: "Service.handle" },
  );
  const staleRejected = staleSymbols.length === 0;
  const staleDetection = rate(
    staleRejected ? 1 : 0,
    1,
    "FRESH_ONLY code query after marking the active CODE projection stale",
    "This measures stale projection rejection for one registered code scope.",
  );

  let staleEdgeRejected = false;
  try {
    await store.paths({
      authorization,
      domains: ["CODE"],
      relationAllowlist: ["calls"],
      direction: "outgoing",
      freshnessPolicy: "FRESH_ONLY",
      bounds: graphBounds,
      seed: { identity: service },
    });
  } catch (error) {
    staleEdgeRejected =
      error instanceof Error &&
      error.message === "GRAPH_NODE_NOT_FOUND_OR_UNAUTHORIZED";
  }
  const staleEdgeSuppression = rate(
    staleEdgeRejected ? 1 : 0,
    1,
    "FRESH_ONLY graph traversal after active projection is marked STALE",
    "This proves stale projection-edge suppression, not per-edge expiry scoring.",
  );

  const updateStartedAt = performance.now();
  await store.update({
    baseRevision: codeRevision,
    next: codeArtifact(nextCodeRevision, nextCommitSha),
  });
  const incrementalUpdateMs = performance.now() - updateStartedAt;

  const graph = {
    typedPathPrecision,
    multiHopRecall,
    pprAssociativeRecall,
    globalCommunityCoverage,
    bridgeAccuracy,
    staleEdgeSuppression,
    unauthorizedPathRate,
    pathExplainability,
    observedCommunityCount: community.communities.length,
  };
  const codeMetrics = {
    symbolResolution,
    callersCalleesCorrectness,
    dependencyPathPrecision,
    blastRadiusRecall,
    changeImpactRecall,
    testLinkageAccuracy,
    ruleDecisionBridgePrecision,
    buildTimeMs: duration(
      codeProjectionBuildMs,
      "PostgresFederatedGraphStore.build for the registered CODE projection",
      "This is projection persistence/build time; real Graphify extraction timing is separate evidence.",
    ),
    incrementalUpdateTimeMs: duration(
      incrementalUpdateMs,
      "PostgresFederatedGraphStore.update for the registered CODE projection",
      "This is projection replacement time; real Graphify incremental extraction timing is separate evidence.",
    ),
    staleDetection,
  };

  const requiredRatios = [
    graph.typedPathPrecision,
    graph.multiHopRecall,
    graph.pprAssociativeRecall,
    graph.globalCommunityCoverage,
    graph.bridgeAccuracy,
    graph.staleEdgeSuppression,
    graph.pathExplainability,
    codeMetrics.symbolResolution,
    codeMetrics.callersCalleesCorrectness,
    codeMetrics.dependencyPathPrecision,
    codeMetrics.blastRadiusRecall,
    codeMetrics.changeImpactRecall,
    codeMetrics.testLinkageAccuracy,
    codeMetrics.ruleDecisionBridgePrecision,
    codeMetrics.staleDetection,
  ];
  const status =
    requiredRatios.every((metric) => metric.value === 1) &&
    graph.unauthorizedPathRate.value === 0
      ? "PROVEN"
      : "FAILED";

  const report = {
    schemaVersion: 1,
    benchmark: "AKP_REGISTERED_GRAPH_CODE_METRICS",
    commit: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    evidenceLevel: "REGISTERED_SYNTHETIC_RUNTIME_FIXTURE",
    claimPolicy: {
      externalParityClaimAllowed: false,
      fixtureRatesAreProductionRates: false,
      scenarioPassRateRelabelledAsPrecisionRecall: false,
      zeroLeakageClaimScope: "REGISTERED_FIXTURE_ONLY",
    },
    status,
    fixture: {
      repository,
      spaceId,
      vaultId,
      authorizedPathPrefix: "allowed",
      hiddenUnauthorizedNodePresent: true,
    },
    graph,
    code: codeMetrics,
    deferredToNextREGISTEREDSlice: {
      temporalTruthMetrics: true,
      workspaceTeamMetrics: true,
    },
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        status,
        outputPath,
        graph: Object.fromEntries(
          Object.entries(graph).map(([key, value]) => [
            key,
            typeof value === "number" ? value : value.value,
          ]),
        ),
        code: Object.fromEntries(
          Object.entries(codeMetrics).map(([key, value]) => [key, value.value]),
        ),
      },
      null,
      2,
    ),
  );
  if (status !== "PROVEN") process.exitCode = 1;
} finally {
  await db.pool
    .query("delete from event_outbox where space_id=$1", [spaceId])
    .catch(() => undefined);
  await db.pool
    .query(
      "delete from federated_graph_projection_revisions where space_id=$1",
      [spaceId],
    )
    .catch(() => undefined);
  await db.pool
    .query("delete from federated_graph_edges where space_id=$1", [spaceId])
    .catch(() => undefined);
  await db.pool
    .query(
      "delete from federated_graph_relationship_assertions where space_id=$1",
      [spaceId],
    )
    .catch(() => undefined);
  await db.pool
    .query("delete from federated_graph_nodes where space_id=$1", [spaceId])
    .catch(() => undefined);
  await db.pool
    .query("delete from vaults where id=$1", [vaultId])
    .catch(() => undefined);
  await db.pool
    .query("delete from spaces where id=$1", [spaceId])
    .catch(() => undefined);
  await db.pool
    .query("delete from organizations where id=$1", [organizationId])
    .catch(() => undefined);
  await db.close();
}
