export interface PersonalizedPageRankNode {
  id: string;
  scopeId: string;
  graphDomain: string;
}

export interface PersonalizedPageRankEdge {
  fromNodeId: string;
  toNodeId: string;
  scopeId: string;
  relation: string;
  weight: number;
}

export interface PersonalizedPageRankSeed {
  nodeId: string;
  weight: number;
}

export interface PersonalizedPageRankPolicy {
  /** Probability of returning to the personalized seed distribution. */
  restartProbability: number;
  allowedGraphDomains: readonly string[];
  allowedRelations: readonly string[];
  maxNodes: number;
  maxIterations: number;
  minimumScore: number;
  perScopeCap: number;
  tolerance: number;
}

export interface PersonalizedPageRankCandidate {
  nodeId: string;
  scopeId: string;
  score: number;
  rank: number;
}

export interface PersonalizedPageRankResult {
  candidates: PersonalizedPageRankCandidate[];
  iterations: number;
  converged: boolean;
  nodeCount: number;
  edgeCount: number;
}

export const DEFAULT_PERSONALIZED_PAGE_RANK_POLICY: PersonalizedPageRankPolicy =
  Object.freeze({
    restartProbability: 0.15,
    allowedGraphDomains: ["EPISTEMIC"],
    allowedRelations: [],
    maxNodes: 2000,
    maxIterations: 50,
    minimumScore: 0.000001,
    perScopeCap: 100,
    tolerance: 0.00000001,
  });

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function positiveFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be finite and positive`);
  }
  return value;
}

function probability(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value >= 1
  ) {
    throw new Error(`${field} must be greater than 0 and less than 1`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function resolvePersonalizedPageRankPolicy(
  input: Partial<PersonalizedPageRankPolicy> = {},
): PersonalizedPageRankPolicy {
  const restartProbability = probability(
    input.restartProbability ??
      DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.restartProbability,
    "restartProbability",
  );
  const maxNodes = boundedInteger(
    input.maxNodes ?? DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.maxNodes,
    "maxNodes",
    1,
    10000,
  );
  const maxIterations = boundedInteger(
    input.maxIterations ?? DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.maxIterations,
    "maxIterations",
    1,
    500,
  );
  const perScopeCap = boundedInteger(
    input.perScopeCap ?? DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.perScopeCap,
    "perScopeCap",
    1,
    5000,
  );
  const minimumScore =
    input.minimumScore ?? DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.minimumScore;
  if (
    typeof minimumScore !== "number" ||
    !Number.isFinite(minimumScore) ||
    minimumScore < 0 ||
    minimumScore > 1
  ) {
    throw new Error("minimumScore must be finite and between 0 and 1");
  }
  const tolerance =
    input.tolerance ?? DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.tolerance;
  if (
    typeof tolerance !== "number" ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance >= 1
  ) {
    throw new Error("tolerance must be greater than 0 and less than 1");
  }

  const allowedGraphDomains = [
    ...new Set(
      (
        input.allowedGraphDomains ??
        DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.allowedGraphDomains
      ).map((value) => nonEmpty(value, "allowedGraphDomains entry")),
    ),
  ];
  if (allowedGraphDomains.length === 0) {
    throw new Error("allowedGraphDomains must contain at least one domain");
  }
  const allowedRelations = [
    ...new Set(
      (
        input.allowedRelations ??
        DEFAULT_PERSONALIZED_PAGE_RANK_POLICY.allowedRelations
      ).map((value) => nonEmpty(value, "allowedRelations entry")),
    ),
  ];

  return {
    restartProbability,
    allowedGraphDomains,
    allowedRelations,
    maxNodes,
    maxIterations,
    minimumScore,
    perScopeCap,
    tolerance,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic Personalized PageRank over an already-authorized graph.
 *
 * This function is deliberately ignorant of database authorization. Callers
 * must construct the node/edge envelope after authorization, lifecycle and
 * truth filtering. Cross-scope edges fail closed so a federated invocation
 * cannot accidentally create a bridge between independently authorized
 * projections.
 *
 * PPR scores are candidate-generation signals only. They are not evidence.
 */
export function personalizedPageRank(input: {
  nodes: readonly PersonalizedPageRankNode[];
  edges: readonly PersonalizedPageRankEdge[];
  seeds: readonly PersonalizedPageRankSeed[];
  policy?: Partial<PersonalizedPageRankPolicy>;
  shouldCancel?: () => boolean;
}): PersonalizedPageRankResult {
  const cancelled = (): boolean => input.shouldCancel?.() === true;
  if (cancelled()) throw new Error("PPR_CANCELLED");
  const policy = resolvePersonalizedPageRankPolicy(input.policy);
  const allowedDomains = new Set(policy.allowedGraphDomains);
  const allowedRelations = new Set(policy.allowedRelations);

  const nodes = new Map<string, PersonalizedPageRankNode>();
  for (const raw of input.nodes) {
    const node: PersonalizedPageRankNode = {
      id: nonEmpty(raw?.id, "node.id"),
      scopeId: nonEmpty(raw?.scopeId, "node.scopeId"),
      graphDomain: nonEmpty(raw?.graphDomain, "node.graphDomain"),
    };
    if (!allowedDomains.has(node.graphDomain)) continue;
    const existing = nodes.get(node.id);
    if (
      existing &&
      (existing.scopeId !== node.scopeId ||
        existing.graphDomain !== node.graphDomain)
    ) {
      throw new Error("PPR_NODE_IDENTITY_CONFLICT");
    }
    nodes.set(node.id, node);
  }

  if (nodes.size > policy.maxNodes) {
    throw new Error("PPR_MAX_NODES_EXCEEDED");
  }
  const nodeIds = [...nodes.keys()].sort(compareStrings);

  const edgeByKey = new Map<string, PersonalizedPageRankEdge>();
  for (const raw of input.edges) {
    const fromNodeId = nonEmpty(raw?.fromNodeId, "edge.fromNodeId");
    const toNodeId = nonEmpty(raw?.toNodeId, "edge.toNodeId");
    const scopeId = nonEmpty(raw?.scopeId, "edge.scopeId");
    const relation = nonEmpty(raw?.relation, "edge.relation");
    const weight = positiveFinite(raw?.weight, "edge.weight");
    if (allowedRelations.size > 0 && !allowedRelations.has(relation)) continue;
    const from = nodes.get(fromNodeId);
    const to = nodes.get(toNodeId);
    if (!from || !to) continue;
    if (
      from.scopeId !== scopeId ||
      to.scopeId !== scopeId ||
      from.scopeId !== to.scopeId
    ) {
      throw new Error("PPR_SCOPE_VIOLATION");
    }
    const key = `${scopeId}\u0000${fromNodeId}\u0000${toNodeId}\u0000${relation}`;
    const current = edgeByKey.get(key);
    if (!current || weight > current.weight) {
      edgeByKey.set(key, {
        fromNodeId,
        toNodeId,
        scopeId,
        relation,
        weight,
      });
    }
  }

  const outgoing = new Map<
    string,
    Array<{ toNodeId: string; weight: number }>
  >();
  for (const edge of [...edgeByKey.values()].sort(
    (left, right) =>
      compareStrings(left.scopeId, right.scopeId) ||
      compareStrings(left.fromNodeId, right.fromNodeId) ||
      compareStrings(left.toNodeId, right.toNodeId) ||
      compareStrings(left.relation, right.relation),
  )) {
    const edges = outgoing.get(edge.fromNodeId) ?? [];
    edges.push({ toNodeId: edge.toNodeId, weight: edge.weight });
    outgoing.set(edge.fromNodeId, edges);
  }
  for (const edges of outgoing.values()) {
    edges.sort(
      (left, right) =>
        compareStrings(left.toNodeId, right.toNodeId) ||
        right.weight - left.weight,
    );
  }
  const edgeCount = edgeByKey.size;

  const seedWeights = new Map<string, number>();
  for (const raw of input.seeds) {
    const nodeId = nonEmpty(raw?.nodeId, "seed.nodeId");
    if (!nodes.has(nodeId)) continue;
    const weight = positiveFinite(raw?.weight, "seed.weight");
    seedWeights.set(nodeId, (seedWeights.get(nodeId) ?? 0) + weight);
  }
  const totalSeedWeight = [...seedWeights.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  if (totalSeedWeight <= 0) {
    return {
      candidates: [],
      iterations: 0,
      converged: true,
      nodeCount: nodes.size,
      edgeCount,
    };
  }

  const personalization = new Map<string, number>();
  for (const nodeId of nodeIds) {
    personalization.set(
      nodeId,
      (seedWeights.get(nodeId) ?? 0) / totalSeedWeight,
    );
  }

  let scores = new Map(personalization);
  let iterations = 0;
  let converged = false;
  const propagationProbability = 1 - policy.restartProbability;

  for (let iteration = 1; iteration <= policy.maxIterations; iteration += 1) {
    if (cancelled()) throw new Error("PPR_CANCELLED");
    const next = new Map<string, number>();
    for (const nodeId of nodeIds) {
      next.set(
        nodeId,
        policy.restartProbability * (personalization.get(nodeId) ?? 0),
      );
    }

    let danglingMass = 0;
    for (const [nodeId, score] of scores) {
      const edges = outgoing.get(nodeId) ?? [];
      if (edges.length === 0) {
        danglingMass += score;
        continue;
      }
      const totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0);
      for (const edge of edges) {
        const contribution =
          propagationProbability * score * (edge.weight / totalWeight);
        next.set(edge.toNodeId, (next.get(edge.toNodeId) ?? 0) + contribution);
      }
    }

    if (danglingMass > 0) {
      for (const [nodeId, seedShare] of personalization) {
        if (seedShare <= 0) continue;
        next.set(
          nodeId,
          (next.get(nodeId) ?? 0) +
            propagationProbability * danglingMass * seedShare,
        );
      }
    }

    let delta = 0;
    for (const nodeId of nodeIds) {
      delta += Math.abs((next.get(nodeId) ?? 0) - (scores.get(nodeId) ?? 0));
    }
    scores = next;
    iterations = iteration;
    if (delta <= policy.tolerance) {
      converged = true;
      break;
    }
  }

  const byScope = new Map<string, Array<{ nodeId: string; score: number }>>();
  for (const [nodeId, score] of scores) {
    if (!Number.isFinite(score) || score < policy.minimumScore) continue;
    const node = nodes.get(nodeId);
    if (!node) continue;
    const candidates = byScope.get(node.scopeId) ?? [];
    candidates.push({ nodeId, score });
    byScope.set(node.scopeId, candidates);
  }

  const selected: Array<{ nodeId: string; scopeId: string; score: number }> =
    [];
  for (const [scopeId, candidates] of [...byScope.entries()].sort(
    ([left], [right]) => compareStrings(left, right),
  )) {
    candidates.sort(
      (left, right) =>
        right.score - left.score || compareStrings(left.nodeId, right.nodeId),
    );
    selected.push(
      ...candidates
        .slice(0, policy.perScopeCap)
        .map((candidate) => ({ ...candidate, scopeId })),
    );
  }
  selected.sort(
    (left, right) =>
      right.score - left.score ||
      compareStrings(left.scopeId, right.scopeId) ||
      compareStrings(left.nodeId, right.nodeId),
  );

  return {
    candidates: selected.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    })),
    iterations,
    converged,
    nodeCount: nodes.size,
    edgeCount,
  };
}
