import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  GraphImpactResult,
  GraphNodeRef,
  GraphPathResult,
  GraphQueryPort,
} from "@akp/contracts";
import {
  CodeGraphQueryService,
  mergeCodeImpactPartitions,
  partitionCodeImpact,
} from "../src/index.js";

function node(input: {
  id?: string;
  name: string;
  path: string;
  repository?: string;
  commitSha?: string;
}): GraphNodeRef {
  return {
    id: input.id ?? randomUUID(),
    spaceId: "00000000-0000-0000-0000-000000000003",
    vaultId: "00000000-0000-0000-0000-000000000004",
    authorizationPath: input.path,
    identity: {
      graphDomain: "CODE",
      scopeId: "repo:fixture",
      kind: "FUNCTION",
      canonicalKey: randomUUID(),
      revision: "code-r1",
    },
    payload: {
      repository: input.repository ?? "fixture",
      commitSha: input.commitSha ?? "1".repeat(40),
      kind: "FUNCTION",
      name: input.name,
      qualifiedName: input.name,
      path: input.path,
    },
    projection: {
      id: randomUUID(),
      revision: "code-r1",
      lifecycle: "ACTIVE",
      freshness: "FRESH",
    },
  };
}

class FakeGraph implements GraphQueryPort {
  readonly calls: Array<{ method: string; input: unknown }> = [];
  lookup: GraphNodeRef[] = [];
  pathsResult: GraphPathResult[] = [];
  impactResult: GraphImpactResult | null = null;

  async findNodes(input: Parameters<GraphQueryPort["findNodes"]>[0]) {
    this.calls.push({ method: "findNodes", input });
    return this.lookup;
  }

  async neighbors(input: Parameters<GraphQueryPort["neighbors"]>[0]) {
    this.calls.push({ method: "neighbors", input });
    return this.pathsResult;
  }

  async paths(input: Parameters<GraphQueryPort["paths"]>[0]) {
    this.calls.push({ method: "paths", input });
    return this.pathsResult;
  }

  async impact(input: Parameters<GraphQueryPort["impact"]>[0]) {
    this.calls.push({ method: "impact", input });
    if (!this.impactResult) {
      const seed = this.lookup[0];
      if (!seed) throw new Error("fixture seed missing");
      return { seed, affected: [], revisionSet: { CODE: "code-r1" } };
    }
    return this.impactResult;
  }

  async revisionState(
    ..._args: Parameters<GraphQueryPort["revisionState"]>
  ): ReturnType<GraphQueryPort["revisionState"]> {
    throw new Error("not used");
  }
}

const context = {
  authorization: {
    spaceId: "00000000-0000-0000-0000-000000000003",
    vaults: [
      {
        vaultId: "00000000-0000-0000-0000-000000000004",
        pathPrefix: null,
      },
    ],
  },
} as const;

describe("CodeGraphQueryService", () => {
  it("keeps same-name symbols ambiguous until a stronger selector is supplied", async () => {
    const graph = new FakeGraph();
    graph.lookup = [
      node({ name: "parse", path: "src/a.ts" }),
      node({ name: "parse", path: "src/b.ts" }),
    ];
    const service = new CodeGraphQueryService(graph);

    await expect(
      service.callers(context, { repository: "fixture", name: "parse" }),
    ).rejects.toThrow("CODE_SYMBOL_AMBIGUOUS");
    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0]).toMatchObject({
      method: "findNodes",
      input: {
        domains: ["CODE"],
        payloadContains: {
          repository: "fixture",
          name: "parse",
        },
        freshnessPolicy: "FRESH_ONLY",
      },
    });
  });

  it("maps callers and callees to incoming and outgoing call traversals", async () => {
    const graph = new FakeGraph();
    graph.lookup = [node({ name: "parse", path: "src/a.ts" })];
    const service = new CodeGraphQueryService(graph);

    await service.callers(context, {
      repository: "fixture",
      qualifiedName: "parse",
    });
    await service.callees(context, {
      repository: "fixture",
      qualifiedName: "parse",
    });

    const traversals = graph.calls.filter(
      (call) => call.method === "neighbors",
    );
    expect(traversals).toHaveLength(2);
    expect(traversals[0]?.input).toMatchObject({
      domains: ["CODE"],
      relationAllowlist: ["calls"],
      direction: "incoming",
      bounds: { maxHops: 1 },
    });
    expect(traversals[1]?.input).toMatchObject({
      domains: ["CODE"],
      relationAllowlist: ["calls"],
      direction: "outgoing",
      bounds: { maxHops: 1 },
    });
  });

  it("parameterizes blast radius without presenting static traversal as runtime proof", async () => {
    const graph = new FakeGraph();
    graph.lookup = [node({ name: "charge", path: "src/charge.ts" })];
    const service = new CodeGraphQueryService(graph);

    await service.impact(
      context,
      { repository: "fixture", qualifiedName: "charge" },
      {
        maxHops: 3,
        direction: "both",
        includeTests: true,
        includeCatalogBridges: true,
        includeRulesDecisions: true,
        includeRuntimeObservations: true,
      },
    );

    const impact = graph.calls.find((call) => call.method === "impact");
    expect(impact?.input).toMatchObject({
      domains: ["CODE", "SOFTWARE_CATALOG", "EPISTEMIC", "RUNTIME"],
      direction: "both",
      bounds: { maxHops: 3 },
    });
    const relations = (impact?.input as { relationAllowlist: string[] })
      .relationAllowlist;
    expect(relations).toEqual(
      expect.arrayContaining([
        "calls",
        "imports",
        "tests",
        "implemented_by",
        "governed_by",
        "runtime_observation",
      ]),
    );
  });
  it("partitions impact by evidence channel instead of flattening one score", () => {
    const seed = node({ name: "charge", path: "src/charge.ts" });
    const intermediate = node({ name: "middle", path: "src/middle.ts" });
    const direct = node({ name: "caller", path: "src/caller.ts" });
    const transitive = node({ name: "top", path: "src/top.ts" });
    const testNode = {
      ...node({ name: "charge test", path: "test/charge.test.ts" }),
      payload: {
        repository: "fixture",
        commitSha: "1".repeat(40),
        kind: "TEST",
        name: "charge test",
        path: "test/charge.test.ts",
      },
    } satisfies GraphNodeRef;
    const runtimeNode = {
      ...node({ name: "trace", path: "runtime/trace" }),
      identity: {
        ...seed.identity,
        graphDomain: "RUNTIME" as const,
        kind: "trace",
        canonicalKey: "trace-1",
      },
      payload: { kind: "trace" },
    } satisfies GraphNodeRef;
    const catalogNode = {
      ...node({ name: "payments", path: "catalog/payments" }),
      identity: {
        ...seed.identity,
        graphDomain: "SOFTWARE_CATALOG" as const,
        kind: "service",
        canonicalKey: "payments",
      },
      payload: { kind: "service" },
    } satisfies GraphNodeRef;
    const ruleNode = {
      ...node({ name: "ADR-17", path: "knowledge/adr-17" }),
      identity: {
        ...seed.identity,
        graphDomain: "EPISTEMIC" as const,
        kind: "decision",
        canonicalKey: "ADR-17",
      },
      payload: { kind: "decision" },
    } satisfies GraphNodeRef;

    const step = (
      from: GraphNodeRef,
      to: GraphNodeRef,
      relation: string,
      derivation:
        | "STATICALLY_RESOLVED"
        | "MODEL_INFERRED" = "STATICALLY_RESOLVED",
    ) => ({
      from,
      relation,
      direction: "incoming" as const,
      to,
      assertion: {
        id: randomUUID(),
        spaceId: seed.spaceId,
        ownerGraphDomain: from.identity.graphDomain,
        fromNodeId: from.id,
        toNodeId: to.id,
        relation,
        authorizationPath: from.authorizationPath,
        lifecycle: "ACTIVE" as const,
        provenance: {
          derivation,
          sourceIds: ["fixture"],
          evidenceIds: [],
          locatorRefs: [],
          revision: "r1",
          recordedAt: "2026-09-20T00:00:00.000Z",
        },
      },
      provenance: {
        derivation,
        sourceIds: ["fixture"],
        evidenceIds: [],
        locatorRefs: [],
        revision: "r1",
        recordedAt: "2026-09-20T00:00:00.000Z",
      },
    });
    const path = (
      target: GraphNodeRef,
      steps: GraphPathResult["steps"],
    ): GraphPathResult => ({
      seed,
      target,
      steps,
      revisionSet: { CODE: "code-r1" },
    });
    const impact: GraphImpactResult = {
      seed,
      affected: [
        path(direct, [step(seed, direct, "calls")]),
        path(transitive, [
          step(seed, intermediate, "calls"),
          step(intermediate, transitive, "calls"),
        ]),
        path(testNode, [step(testNode, seed, "tests")]),
        path(runtimeNode, [step(seed, runtimeNode, "runtime_observation")]),
        path(catalogNode, [step(seed, catalogNode, "implemented_by")]),
        path(ruleNode, [step(seed, ruleNode, "governed_by")]),
        path(intermediate, [
          step(seed, intermediate, "references", "MODEL_INFERRED"),
        ]),
      ],
      revisionSet: { CODE: "code-r1" },
    };

    const partitions = partitionCodeImpact(impact, [
      {
        id: "candidate-1",
        sourceId: "function:charge",
        targetId: "function:other",
        relation: "CALLS",
        derivation: "AMBIGUOUS",
        confidence: 0.5,
      },
    ]);
    expect(partitions.directStaticDependents).toHaveLength(1);
    expect(partitions.transitiveStaticDependents).toHaveLength(1);
    expect(partitions.tests).toHaveLength(1);
    expect(partitions.runtimeObservations).toHaveLength(1);
    expect(partitions.catalogImpacts).toHaveLength(1);
    expect(partitions.linkedRulesDecisions).toHaveLength(1);
    expect(partitions.uncertainAmbiguousImpacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "CANDIDATE_EDGE" }),
        expect.objectContaining({ kind: "GRAPH_PATH" }),
      ]),
    );
    expect(
      mergeCodeImpactPartitions([partitions, partitions]).directStaticDependents,
    ).toHaveLength(1);
  });

});
