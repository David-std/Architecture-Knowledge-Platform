import type {
  GraphAuthorizationScope,
  GraphImpactResult,
  GraphNodeRef,
  GraphPathResult,
  GraphQueryPort,
} from "@akp/contracts";
import type { CodeGraphCandidateEdge } from "./code-graph-projection.js";

export interface CodeSymbolSelector {
  repository: string;
  commitSha?: string;
  path?: string;
  qualifiedName?: string;
  name?: string;
  kind?: string;
  signature?: string;
}

export interface CodeQueryContext {
  authorization: GraphAuthorizationScope;
  freshnessPolicy?: "FRESH_ONLY" | "ALLOW_STALE";
}

export interface CodePathOptions {
  relationTypes?: readonly string[];
  maxHops?: number;
  maxFanout?: number;
  maxCandidates?: number;
  timeBudgetMs?: number;
}

export interface CodeImpactOptions extends CodePathOptions {
  direction?: "outgoing" | "incoming" | "both";
  includeTests?: boolean;
  includeCatalogBridges?: boolean;
  includeRulesDecisions?: boolean;
  includeRuntimeObservations?: boolean;
}

export interface CodeChangeImpactResult {
  changedNodes: GraphNodeRef[];
  impacts: GraphImpactResult[];
  unmatchedPaths: string[];
}

export type CodeUncertainImpact =
  | { kind: "GRAPH_PATH"; path: GraphPathResult }
  | { kind: "CANDIDATE_EDGE"; candidate: CodeGraphCandidateEdge };

export interface CodeImpactPartitions {
  directStaticDependents: GraphPathResult[];
  transitiveStaticDependents: GraphPathResult[];
  tests: GraphPathResult[];
  runtimeObservations: GraphPathResult[];
  catalogImpacts: GraphPathResult[];
  linkedRulesDecisions: GraphPathResult[];
  uncertainAmbiguousImpacts: CodeUncertainImpact[];
  otherContext: GraphPathResult[];
}

export interface CodeImpactReport {
  impact: GraphImpactResult;
  partitions: CodeImpactPartitions;
}

function pathKey(value: GraphPathResult): string {
  return [
    value.seed.id,
    value.target.id,
    ...value.steps.map(
      (step) =>
        step.from.id +
        ":" +
        step.relation +
        ":" +
        step.direction +
        ":" +
        step.to.id,
    ),
  ].join("|");
}

function uniquePaths(values: readonly GraphPathResult[]): GraphPathResult[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = pathKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uncertainPath(value: GraphPathResult): boolean {
  return value.steps.some(
    (step) =>
      step.assertion.lifecycle !== "ACTIVE" ||
      step.provenance.derivation === "MODEL_INFERRED",
  );
}

export function partitionCodeImpact(
  impact: GraphImpactResult,
  candidates: readonly CodeGraphCandidateEdge[] = [],
): CodeImpactPartitions {
  const partitions: CodeImpactPartitions = {
    directStaticDependents: [],
    transitiveStaticDependents: [],
    tests: [],
    runtimeObservations: [],
    catalogImpacts: [],
    linkedRulesDecisions: [],
    uncertainAmbiguousImpacts: candidates.map((candidate) => ({
      kind: "CANDIDATE_EDGE" as const,
      candidate,
    })),
    otherContext: [],
  };

  for (const affected of impact.affected) {
    if (uncertainPath(affected)) {
      partitions.uncertainAmbiguousImpacts.push({
        kind: "GRAPH_PATH",
        path: affected,
      });
      continue;
    }
    const domain = affected.target.identity.graphDomain;
    const targetKind =
      typeof affected.target.payload.kind === "string"
        ? affected.target.payload.kind.toUpperCase()
        : affected.target.identity.kind.toUpperCase();
    const hasTestRelation = affected.steps.some(
      (step) => step.relation.toLowerCase() === "tests",
    );
    if (domain === "RUNTIME") {
      partitions.runtimeObservations.push(affected);
    } else if (domain === "SOFTWARE_CATALOG") {
      partitions.catalogImpacts.push(affected);
    } else if (domain === "EPISTEMIC") {
      partitions.linkedRulesDecisions.push(affected);
    } else if (
      domain === "CODE" &&
      (targetKind === "TEST" || hasTestRelation)
    ) {
      partitions.tests.push(affected);
    } else if (domain === "CODE" && affected.steps.length === 1) {
      partitions.directStaticDependents.push(affected);
    } else if (domain === "CODE" && affected.steps.length > 1) {
      partitions.transitiveStaticDependents.push(affected);
    } else {
      partitions.otherContext.push(affected);
    }
  }
  return partitions;
}

export function mergeCodeImpactPartitions(
  values: readonly CodeImpactPartitions[],
): CodeImpactPartitions {
  const paths = (
    key: keyof Omit<CodeImpactPartitions, "uncertainAmbiguousImpacts">,
  ) => uniquePaths(values.flatMap((value) => value[key]));
  const uncertain = values
    .flatMap((value) => value.uncertainAmbiguousImpacts)
    .filter((entry, position, all) => {
      const key =
        entry.kind === "CANDIDATE_EDGE"
          ? "candidate:" + entry.candidate.id
          : "path:" + pathKey(entry.path);
      return (
        all.findIndex((candidate) => {
          const candidateKey =
            candidate.kind === "CANDIDATE_EDGE"
              ? "candidate:" + candidate.candidate.id
              : "path:" + pathKey(candidate.path);
          return candidateKey === key;
        }) === position
      );
    });

  return {
    directStaticDependents: paths("directStaticDependents"),
    transitiveStaticDependents: paths("transitiveStaticDependents"),
    tests: paths("tests"),
    runtimeObservations: paths("runtimeObservations"),
    catalogImpacts: paths("catalogImpacts"),
    linkedRulesDecisions: paths("linkedRulesDecisions"),
    uncertainAmbiguousImpacts: uncertain,
    otherContext: paths("otherContext"),
  };
}

function codeQueryError(code: string): Error {
  const value = new Error(code) as Error & { code?: string };
  value.code = code;
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw codeQueryError(code);
  }
  return candidate;
}

function bounds(options: CodePathOptions = {}) {
  return {
    maxHops: boundedInteger(options.maxHops, 4, 1, 16, "CODE_MAX_HOPS_INVALID"),
    maxFanout: boundedInteger(
      options.maxFanout,
      200,
      1,
      1000,
      "CODE_MAX_FANOUT_INVALID",
    ),
    maxCandidates: boundedInteger(
      options.maxCandidates,
      2000,
      1,
      10000,
      "CODE_MAX_CANDIDATES_INVALID",
    ),
    timeBudgetMs: boundedInteger(
      options.timeBudgetMs,
      2000,
      1,
      60000,
      "CODE_TIME_BUDGET_INVALID",
    ),
  };
}

function codeRelations(options: CodeImpactOptions = {}): string[] {
  const relations = new Set(
    options.relationTypes ?? [
      "calls",
      "imports",
      "references",
      "inherits",
      "implements",
      "routes_to",
      "contains",
    ],
  );
  if (options.includeTests) relations.add("tests");
  if (options.includeCatalogBridges) {
    relations.add("implemented_by");
    relations.add("depends_on");
  }
  if (options.includeRulesDecisions) {
    relations.add("rationale_ref");
    relations.add("governed_by");
    relations.add("applies_to");
  }
  if (options.includeRuntimeObservations) {
    relations.add("runtime_observation");
  }
  return [...relations].sort();
}

function impactDomains(options: CodeImpactOptions = {}) {
  const domains = new Set([
    "CODE" as const,
    ...(options.includeCatalogBridges ? (["SOFTWARE_CATALOG"] as const) : []),
    ...(options.includeRulesDecisions ? (["EPISTEMIC"] as const) : []),
    ...(options.includeRuntimeObservations ? (["RUNTIME"] as const) : []),
  ]);
  return [...domains];
}

function payloadFilter(selector: CodeSymbolSelector) {
  const filter: Record<string, string> = {
    repository: selector.repository,
  };
  if (selector.commitSha) filter.commitSha = selector.commitSha;
  if (selector.path) filter.path = selector.path;
  if (selector.qualifiedName) filter.qualifiedName = selector.qualifiedName;
  if (selector.name) filter.name = selector.name;
  if (selector.signature) filter.signature = selector.signature;
  return filter;
}

function validateSelector(selector: CodeSymbolSelector): void {
  if (!selector.repository.trim()) {
    throw codeQueryError("CODE_REPOSITORY_REQUIRED");
  }
  if (
    !selector.path &&
    !selector.qualifiedName &&
    !selector.name &&
    !selector.signature
  ) {
    throw codeQueryError("CODE_SYMBOL_SELECTOR_REQUIRED");
  }
  if (selector.commitSha && !/^[a-f0-9]{40}$/i.test(selector.commitSha)) {
    throw codeQueryError("CODE_COMMIT_INVALID");
  }
}

export class CodeGraphQueryService {
  constructor(private readonly graph: GraphQueryPort) {}

  async symbol(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
  ): Promise<GraphNodeRef[]> {
    validateSelector(selector);
    return this.graph.findNodes({
      authorization: context.authorization,
      domains: ["CODE"],
      ...(selector.kind ? { kinds: [selector.kind] } : {}),
      payloadContains: payloadFilter(selector),
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      limit: 100,
    });
  }

  async callers(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
  ): Promise<GraphPathResult[]> {
    const node = await this.uniqueSymbol(context, selector);
    return this.graph.neighbors({
      authorization: context.authorization,
      domains: ["CODE"],
      relationAllowlist: ["calls"],
      direction: "incoming",
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      bounds: bounds({ maxHops: 1 }),
      seed: { nodeId: node.id },
    });
  }

  async callees(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
  ): Promise<GraphPathResult[]> {
    const node = await this.uniqueSymbol(context, selector);
    return this.graph.neighbors({
      authorization: context.authorization,
      domains: ["CODE"],
      relationAllowlist: ["calls"],
      direction: "outgoing",
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      bounds: bounds({ maxHops: 1 }),
      seed: { nodeId: node.id },
    });
  }

  async dependencies(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
  ): Promise<GraphPathResult[]> {
    const node = await this.uniqueSymbol(context, selector);
    return this.graph.neighbors({
      authorization: context.authorization,
      domains: ["CODE"],
      relationAllowlist: ["imports", "references", "inherits", "implements"],
      direction: "outgoing",
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      bounds: bounds({ maxHops: 1 }),
      seed: { nodeId: node.id },
    });
  }

  async path(
    context: CodeQueryContext,
    source: CodeSymbolSelector,
    target: CodeSymbolSelector,
    options: CodePathOptions = {},
  ): Promise<GraphPathResult[]> {
    const [from, to] = await Promise.all([
      this.uniqueSymbol(context, source),
      this.uniqueSymbol(context, target),
    ]);
    return this.graph.paths({
      authorization: context.authorization,
      domains: ["CODE"],
      relationAllowlist: [
        ...(options.relationTypes ?? [
          "calls",
          "imports",
          "references",
          "inherits",
          "implements",
          "routes_to",
          "contains",
          "tests",
        ]),
      ],
      direction: "outgoing",
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      bounds: bounds(options),
      seed: { nodeId: from.id },
      target: { nodeId: to.id },
    });
  }

  async impact(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
    options: CodeImpactOptions = {},
  ): Promise<GraphImpactResult> {
    const node = await this.uniqueSymbol(context, selector);
    return this.graph.impact({
      authorization: context.authorization,
      domains: impactDomains(options),
      relationAllowlist: codeRelations(options),
      direction: options.direction ?? "both",
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      bounds: bounds(options),
      seed: { nodeId: node.id },
    });
  }

  async tests(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
  ): Promise<GraphPathResult[]> {
    const node = await this.uniqueSymbol(context, selector);
    return this.graph.paths({
      authorization: context.authorization,
      domains: ["CODE"],
      relationAllowlist: ["tests"],
      direction: "both",
      freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
      bounds: bounds({ maxHops: 2, maxCandidates: 500 }),
      seed: { nodeId: node.id },
    });
  }

  async explain(
    context: CodeQueryContext,
    source: CodeSymbolSelector,
    target: CodeSymbolSelector,
    options: CodePathOptions = {},
  ): Promise<GraphPathResult[]> {
    return this.path(context, source, target, options);
  }

  async changeImpact(
    context: CodeQueryContext,
    input: {
      repository: string;
      commitSha: string;
      changedPaths: readonly string[];
      options?: CodeImpactOptions;
    },
  ): Promise<CodeChangeImpactResult> {
    if (!/^[a-f0-9]{40}$/i.test(input.commitSha)) {
      throw codeQueryError("CODE_COMMIT_INVALID");
    }
    const changedNodes = new Map<string, GraphNodeRef>();
    const unmatchedPaths: string[] = [];
    for (const changedPath of [...new Set(input.changedPaths)].sort()) {
      const nodes = await this.symbol(context, {
        repository: input.repository,
        commitSha: input.commitSha,
        path: changedPath,
      });
      if (nodes.length === 0) {
        unmatchedPaths.push(changedPath);
        continue;
      }
      for (const node of nodes) changedNodes.set(node.id, node);
    }

    const impacts: GraphImpactResult[] = [];
    for (const node of [...changedNodes.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      impacts.push(
        await this.graph.impact({
          authorization: context.authorization,
          domains: impactDomains(input.options),
          relationAllowlist: codeRelations(input.options),
          direction: input.options?.direction ?? "both",
          freshnessPolicy: context.freshnessPolicy ?? "FRESH_ONLY",
          bounds: bounds(input.options),
          seed: { nodeId: node.id },
        }),
      );
    }
    return {
      changedNodes: [...changedNodes.values()],
      impacts,
      unmatchedPaths,
    };
  }

  private async uniqueSymbol(
    context: CodeQueryContext,
    selector: CodeSymbolSelector,
  ): Promise<GraphNodeRef> {
    const matches = await this.symbol(context, selector);
    if (matches.length === 0) throw codeQueryError("CODE_SYMBOL_NOT_FOUND");
    if (matches.length > 1) throw codeQueryError("CODE_SYMBOL_AMBIGUOUS");
    return matches[0]!;
  }
}
