import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PostgresAuthorizationPort,
  PostgresFederatedGraphStore,
  type Postgres,
} from "@akp/postgres";
import {
  CodeGraphQueryService,
  computeCodeCommitDelta,
  mergeCodeImpactPartitions,
  parseProjectCodeGraphRepository,
  partitionCodeImpact,
  type CodeGraphCandidateEdge,
  type CodeImpactOptions,
  type CodePathOptions,
  type CodeQueryContext,
  type CodeSymbolSelector,
} from "@akp/project-adapter";
import {
  actorOf,
  hasSpaceAccess,
  requirePermission,
  requirePrincipalAction,
} from "../auth.js";

const CODE_COMMIT = /^[a-f0-9]{40}$/i;

const CodeScope = z.object({
  spaceId: z.string().uuid(),
  vaultId: z.string().uuid().optional(),
  vaultIds: z.array(z.string().uuid()).max(100).default([]),
  federated: z.boolean().default(false),
  freshnessPolicy: z.enum(["FRESH_ONLY", "ALLOW_STALE"]).default("FRESH_ONLY"),
});

const CodeSymbolSelector = z
  .object({
    repository: z.string().trim().min(1).max(2048),
    commitSha: z.string().regex(CODE_COMMIT).optional(),
    path: z.string().trim().min(1).max(4096).optional(),
    qualifiedName: z.string().trim().min(1).max(2048).optional(),
    name: z.string().trim().min(1).max(1024).optional(),
    kind: z.string().trim().min(1).max(120).optional(),
    signature: z.string().trim().min(1).max(4096).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.path || value.qualifiedName || value.name || value.signature,
      ),
    {
      message:
        "At least one of path, qualifiedName, name, or signature is required.",
    },
  );

const CodePathOptionsSchema = z.object({
  relationTypes: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  maxHops: z.number().int().min(1).max(16).optional(),
  maxFanout: z.number().int().min(1).max(1000).optional(),
  maxCandidates: z.number().int().min(1).max(10000).optional(),
  timeBudgetMs: z.number().int().min(1).max(60000).optional(),
});

const CodeImpactOptionsSchema = CodePathOptionsSchema.extend({
  direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  includeTests: z.boolean().optional(),
  includeCatalogBridges: z.boolean().optional(),
  includeRulesDecisions: z.boolean().optional(),
  includeRuntimeObservations: z.boolean().optional(),
});

const ScopedSelector = CodeScope.extend({
  selector: CodeSymbolSelector,
});

const ScopedPath = CodeScope.extend({
  source: CodeSymbolSelector,
  target: CodeSymbolSelector,
  options: CodePathOptionsSchema.optional(),
});

const ScopedImpact = CodeScope.extend({
  selector: CodeSymbolSelector,
  options: CodeImpactOptionsSchema.optional(),
});

const ScopedChangeImpact = CodeScope.extend({
  repository: z.string().trim().min(1).max(2048),
  commitSha: z.string().regex(CODE_COMMIT),
  changedPaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(500),
  options: CodeImpactOptionsSchema.optional(),
});

const ScopedCommitDeltaImpact = CodeScope.extend({
  repository: z.string().trim().min(1).max(2048),
  baseSha: z.string().regex(CODE_COMMIT),
  headSha: z.string().regex(CODE_COMMIT),
  options: CodeImpactOptionsSchema.optional(),
});

const CandidateEdge = z.object({
  id: z.string().min(1).max(256),
  sourceId: z.string().min(1).max(256),
  targetId: z.string().min(1).max(256),
  relation: z.enum([
    "CONTAINS",
    "CALLS",
    "IMPORTS",
    "INHERITS",
    "IMPLEMENTS",
    "REFERENCES",
    "TESTS",
    "ROUTES_TO",
    "RATIONALE_REF",
  ]),
  derivation: z.enum(["INFERRED", "AMBIGUOUS"]),
  confidence: z.number().min(0).max(1).optional(),
});

type CodeScopeInput = z.infer<typeof CodeScope>;
type ParsedCodeSymbolSelector = z.infer<typeof CodeSymbolSelector>;

function normalizedCodeSelector(
  value: ParsedCodeSymbolSelector,
): CodeSymbolSelector {
  return {
    repository: value.repository,
    ...(value.commitSha ? { commitSha: value.commitSha } : {}),
    ...(value.path ? { path: value.path } : {}),
    ...(value.qualifiedName ? { qualifiedName: value.qualifiedName } : {}),
    ...(value.name ? { name: value.name } : {}),
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.signature ? { signature: value.signature } : {}),
  };
}

function codeQueryStatus(code: string): number {
  if (
    code === "CODE_SYMBOL_NOT_FOUND" ||
    code === "CODE_PROJECT_NOT_FOUND_OR_UNAUTHORIZED" ||
    code === "GRAPH_NODE_NOT_FOUND_OR_UNAUTHORIZED" ||
    code === "VAULT_SCOPE_NOT_FOUND"
  ) {
    return 404;
  }
  if (
    code === "CODE_SYMBOL_AMBIGUOUS" ||
    code === "GRAPH_PROJECTION_REVISION_CONFLICT" ||
    code === "GRAPH_PROJECTION_BASE_REVISION_CHANGED" ||
    code === "CODE_GRAPH_NOT_READY" ||
    code === "CODE_GRAPH_SOURCE_REVISION_STALE"
  ) {
    return 409;
  }
  if (
    code === "VAULT_ACCESS_DENIED" ||
    code === "SPACE_ACCESS_DENIED" ||
    code === "PRINCIPAL_VAULT_SCOPE_DENIED"
  ) {
    return 403;
  }
  if (code === "GRAPH_QUERY_TIME_BUDGET_EXCEEDED") return 408;
  if (
    code.startsWith("CODE_") ||
    code.startsWith("GRAPH_") ||
    code === "INVALID_VAULT_SCOPE"
  ) {
    return 400;
  }
  return 500;
}

function sendCodeQueryError(reply: FastifyReply, error: unknown) {
  const code =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "CODE_QUERY_FAILED";
  return reply.code(codeQueryStatus(code)).send({ code });
}

async function authorizedCodeContext(
  db: Postgres,
  request: FastifyRequest,
  scopeInput: CodeScopeInput,
): Promise<CodeQueryContext> {
  const actor = actorOf(request);
  if (!actor) {
    throw new Error("AUTH_REQUIRED");
  }
  if (!hasSpaceAccess(actor, scopeInput.spaceId, "knowledge:read")) {
    throw new Error("SPACE_ACCESS_DENIED");
  }

  const principalVaultId =
    actor.principalKind === "AGENT_PROCESS" ? actor.principalVaultId : null;
  const requestedVaults = [
    ...(scopeInput.vaultId ? [scopeInput.vaultId] : []),
    ...scopeInput.vaultIds,
  ];
  if (
    principalVaultId &&
    (scopeInput.federated ||
      requestedVaults.some((vaultId) => vaultId !== principalVaultId))
  ) {
    throw new Error("PRINCIPAL_VAULT_SCOPE_DENIED");
  }

  const resolved = await new PostgresAuthorizationPort(db).resolveVaultScope({
    userId: actor.id,
    spaceId: scopeInput.spaceId,
    permission: "knowledge:read",
    ...(principalVaultId
      ? { vaultId: principalVaultId }
      : scopeInput.vaultId
        ? { vaultId: scopeInput.vaultId }
        : {}),
    vaultIds: principalVaultId ? [principalVaultId] : scopeInput.vaultIds,
    federated: principalVaultId ? false : scopeInput.federated,
  });

  const vaults = resolved.vaultIds.map((vaultId) => {
    const access = resolved.accessByVault[vaultId];
    if (!access) throw new Error("VAULT_ACCESS_DENIED");
    return {
      vaultId,
      pathPrefix: access.pathPrefix,
    };
  });
  if (vaults.length === 0) throw new Error("VAULT_SCOPE_NOT_FOUND");

  return {
    authorization: {
      spaceId: scopeInput.spaceId,
      vaults,
      allowSpaceScoped: false,
    },
    freshnessPolicy: scopeInput.freshnessPolicy,
  };
}

function configuredProjectRoots(): string[] {
  const configured = process.env.AKP_PROJECT_ROOTS?.trim();
  if (!configured) throw new Error("CODE_PROJECT_ROOTS_NOT_CONFIGURED");
  const roots = configured.split(path.delimiter).map((root) => root.trim());
  if (roots.length === 0 || roots.some((root) => root.length === 0)) {
    throw new Error("CODE_PROJECT_ROOTS_NOT_CONFIGURED");
  }
  return roots.map((root) => path.resolve(root));
}

async function authorizedProjectRoot(rootPath: string): Promise<string> {
  const canonical = await realpath(path.resolve(rootPath)).catch(() => null);
  const info = canonical ? await stat(canonical).catch(() => null) : null;
  if (!canonical || !info?.isDirectory()) {
    throw new Error("CODE_PROJECT_ROOT_NOT_FOUND");
  }
  const allowed = (
    await Promise.all(
      configuredProjectRoots().map(async (root) => {
        const resolved = await realpath(root).catch(() => null);
        const rootInfo = resolved
          ? await stat(resolved).catch(() => null)
          : null;
        return resolved && rootInfo?.isDirectory() ? resolved : null;
      }),
    )
  ).filter((root): root is string => Boolean(root));
  if (
    !allowed.some((root) => {
      const relative = path.relative(root, canonical);
      return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    })
  ) {
    throw new Error("CODE_PROJECT_ROOT_NOT_ALLOWED");
  }
  return canonical;
}

async function projectMetadataRow(
  db: Postgres,
  context: CodeQueryContext,
  repository: string,
): Promise<{
  rootPath: string;
  metadata: Record<string, unknown>;
  vaultId: string;
  slug: string;
}> {
  const parsed = parseProjectCodeGraphRepository(repository);
  if (!parsed) throw new Error("CODE_PROJECT_REPOSITORY_REQUIRED");
  if (
    !context.authorization.vaults.some(
      (scope) => scope.vaultId === parsed.vaultId,
    )
  ) {
    throw new Error("CODE_PROJECT_NOT_FOUND_OR_UNAUTHORIZED");
  }
  const result = await db.pool.query<{
    root_path: string;
    metadata: Record<string, unknown>;
  }>(
    `select root_path,metadata
       from projects
      where space_id=$1 and vault_id=$2 and slug=$3
      limit 1`,
    [context.authorization.spaceId, parsed.vaultId, parsed.slug],
  );
  const row = result.rows[0];
  if (!row) throw new Error("CODE_PROJECT_NOT_FOUND_OR_UNAUTHORIZED");
  return {
    rootPath: row.root_path,
    metadata: row.metadata,
    vaultId: parsed.vaultId,
    slug: parsed.slug,
  };
}

async function projectRuntimeRow(
  db: Postgres,
  context: CodeQueryContext,
  repository: string,
): Promise<{
  rootPath: string;
  metadata: Record<string, unknown>;
  vaultId: string;
  slug: string;
}> {
  const project = await projectMetadataRow(db, context, repository);
  return {
    ...project,
    rootPath: await authorizedProjectRoot(project.rootPath),
  };
}

function candidateEdgesFromMetadata(
  metadata: Record<string, unknown>,
  seedNodeIds?: ReadonlySet<string>,
): CodeGraphCandidateEdge[] {
  const codeGraph =
    metadata.codeGraph &&
    typeof metadata.codeGraph === "object" &&
    !Array.isArray(metadata.codeGraph)
      ? (metadata.codeGraph as Record<string, unknown>)
      : null;
  const raw = Array.isArray(codeGraph?.candidateEdges)
    ? codeGraph.candidateEdges
    : [];
  return raw
    .slice(0, 128)
    .flatMap((candidate) => {
      const parsed = CandidateEdge.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    })
    .filter(
      (candidate) =>
        !seedNodeIds ||
        seedNodeIds.has(candidate.sourceId) ||
        seedNodeIds.has(candidate.targetId),
    );
}

function ambiguousRenameMapping(
  metadata: Record<string, unknown>,
  baseSha: string,
  headSha: string,
): Array<Record<string, unknown>> {
  const codeGraph =
    metadata.codeGraph &&
    typeof metadata.codeGraph === "object" &&
    !Array.isArray(metadata.codeGraph)
      ? (metadata.codeGraph as Record<string, unknown>)
      : null;
  const reconciliation =
    codeGraph?.reconciliation &&
    typeof codeGraph.reconciliation === "object" &&
    !Array.isArray(codeGraph.reconciliation)
      ? (codeGraph.reconciliation as Record<string, unknown>)
      : null;
  const candidates = Array.isArray(reconciliation?.candidates)
    ? reconciliation.candidates
    : [];
  const output: Array<Record<string, unknown>> = [];
  for (const candidate of candidates.slice(0, 128)) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const value = candidate as Record<string, unknown>;
    const from =
      value.from && typeof value.from === "object" && !Array.isArray(value.from)
        ? (value.from as Record<string, unknown>)
        : null;
    const to =
      value.to && typeof value.to === "object" && !Array.isArray(value.to)
        ? (value.to as Record<string, unknown>)
        : null;
    if (
      value.state !== "AMBIGUOUS" ||
      typeof value.relationship !== "string" ||
      !from ||
      !to ||
      String(from.commitSha ?? "").toLowerCase() !== baseSha.toLowerCase() ||
      String(to.commitSha ?? "").toLowerCase() !== headSha.toLowerCase()
    ) {
      continue;
    }
    output.push({
      relationship: value.relationship.slice(0, 80),
      state: "AMBIGUOUS",
      ...(typeof value.confidence === "number"
        ? { confidence: value.confidence }
        : {}),
      basis: Array.isArray(value.basis)
        ? value.basis
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, 16)
        : [],
      from: {
        nodeId: String(from.nodeId ?? "").slice(0, 256),
        path: String(from.path ?? "").slice(0, 4096),
        name: String(from.name ?? "").slice(0, 1024),
      },
      to: {
        nodeId: String(to.nodeId ?? "").slice(0, 256),
        path: String(to.path ?? "").slice(0, 4096),
        name: String(to.name ?? "").slice(0, 1024),
      },
    });
  }
  return output;
}

async function projectFencedCommit(
  db: Postgres,
  graph: PostgresFederatedGraphStore,
  context: CodeQueryContext,
  repository: string,
  requestedCommit?: string,
): Promise<string | undefined> {
  const parsed = parseProjectCodeGraphRepository(repository);
  if (!parsed) return requestedCommit;
  if (
    !context.authorization.vaults.some(
      (scope) => scope.vaultId === parsed.vaultId,
    )
  ) {
    throw new Error("CODE_PROJECT_NOT_FOUND_OR_UNAUTHORIZED");
  }

  const result = await db.pool.query<{ metadata: Record<string, unknown> }>(
    `select metadata
       from projects
      where space_id=$1 and vault_id=$2 and slug=$3
      limit 1`,
    [context.authorization.spaceId, parsed.vaultId, parsed.slug],
  );
  const metadata = result.rows[0]?.metadata;
  const projectCommit =
    metadata &&
    typeof metadata.commit === "string" &&
    CODE_COMMIT.test(metadata.commit)
      ? metadata.commit.toLowerCase()
      : null;
  if (!projectCommit) {
    throw new Error("CODE_GRAPH_NOT_READY");
  }

  const state = await graph.revisionState(
    "CODE",
    context.authorization.spaceId,
    parsed.scopeId,
  );
  const active = state.active;
  if (!active) {
    throw new Error("CODE_GRAPH_NOT_READY");
  }

  const requested = requestedCommit?.toLowerCase();
  const currentFresh =
    active.sourceRevision.toLowerCase() === projectCommit &&
    active.freshness === "FRESH";
  if ((context.freshnessPolicy ?? "FRESH_ONLY") === "FRESH_ONLY") {
    if (
      !currentFresh ||
      (requested !== undefined && requested !== projectCommit)
    ) {
      throw new Error("CODE_GRAPH_SOURCE_REVISION_STALE");
    }
    return projectCommit;
  }

  if (currentFresh) {
    if (requested !== undefined && requested !== projectCommit) {
      throw new Error("CODE_GRAPH_SOURCE_REVISION_STALE");
    }
    return projectCommit;
  }
  if (active.freshness !== "STALE") {
    throw new Error("CODE_GRAPH_SOURCE_REVISION_STALE");
  }
  const activeCommit = active.sourceRevision.toLowerCase();
  if (requested !== undefined && requested !== activeCommit) {
    throw new Error("CODE_GRAPH_SOURCE_REVISION_STALE");
  }
  return activeCommit;
}

async function projectFencedSelector(
  db: Postgres,
  graph: PostgresFederatedGraphStore,
  context: CodeQueryContext,
  selector: CodeSymbolSelector,
): Promise<CodeSymbolSelector> {
  const commitSha = await projectFencedCommit(
    db,
    graph,
    context,
    selector.repository,
    selector.commitSha,
  );
  return {
    ...selector,
    ...(commitSha ? { commitSha } : {}),
  };
}

export function registerCodeGraphRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  const graph = new PostgresFederatedGraphStore(db);
  const service = new CodeGraphQueryService(graph);
  const guards = [
    requirePermission("knowledge:read"),
    requirePrincipalAction("knowledge:read"),
  ];

  app.post(
    "/v1/code/symbol",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedSelector.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_SYMBOL_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        return {
          symbols: await service.symbol(
            context,
            await projectFencedSelector(
              db,
              graph,
              context,
              normalizedCodeSelector(parsed.data.selector),
            ),
          ),
        };
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );

  app.post(
    "/v1/code/callers",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedSelector.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_CALLERS_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        return {
          paths: await service.callers(
            context,
            await projectFencedSelector(
              db,
              graph,
              context,
              normalizedCodeSelector(parsed.data.selector),
            ),
          ),
        };
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );

  app.post(
    "/v1/code/callees",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedSelector.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_CALLEES_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        return {
          paths: await service.callees(
            context,
            await projectFencedSelector(
              db,
              graph,
              context,
              normalizedCodeSelector(parsed.data.selector),
            ),
          ),
        };
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );

  app.post("/v1/code/path", { preHandler: guards }, async (request, reply) => {
    const parsed = ScopedPath.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_CODE_PATH_QUERY",
        issues: parsed.error.issues,
      });
    }
    try {
      const context = await authorizedCodeContext(db, request, parsed.data);
      return {
        paths: await service.path(
          context,
          await projectFencedSelector(
            db,
            graph,
            context,
            normalizedCodeSelector(parsed.data.source),
          ),
          await projectFencedSelector(
            db,
            graph,
            context,
            normalizedCodeSelector(parsed.data.target),
          ),
          (parsed.data.options ?? {}) as CodePathOptions,
        ),
      };
    } catch (error) {
      return sendCodeQueryError(reply, error);
    }
  });

  app.post(
    "/v1/code/impact",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedImpact.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_IMPACT_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        const selector = await projectFencedSelector(
          db,
          graph,
          context,
          normalizedCodeSelector(parsed.data.selector),
        );
        const impact = await service.impact(
          context,
          selector,
          (parsed.data.options ?? {}) as CodeImpactOptions,
        );
        let candidates: CodeGraphCandidateEdge[] = [];
        if (parseProjectCodeGraphRepository(selector.repository)) {
          const project = await projectMetadataRow(
            db,
            context,
            selector.repository,
          );
          const seedNodeId =
            typeof impact.seed.payload.codeNodeId === "string"
              ? impact.seed.payload.codeNodeId
              : null;
          candidates = candidateEdgesFromMetadata(
            project.metadata,
            seedNodeId ? new Set([seedNodeId]) : undefined,
          );
        }
        return {
          impact,
          partitions: partitionCodeImpact(impact, candidates),
        };
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );

  app.post(
    "/v1/code/change-impact",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedChangeImpact.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_CHANGE_IMPACT_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        const commitSha = await projectFencedCommit(
          db,
          graph,
          context,
          parsed.data.repository,
          parsed.data.commitSha,
        );
        return await service.changeImpact(context, {
          repository: parsed.data.repository,
          commitSha: commitSha ?? parsed.data.commitSha,
          changedPaths: parsed.data.changedPaths,
          ...(parsed.data.options
            ? { options: parsed.data.options as CodeImpactOptions }
            : {}),
        });
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );

  app.post(
    "/v1/code/commit-delta-impact",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedCommitDeltaImpact.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_COMMIT_DELTA_IMPACT_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        const project = await projectRuntimeRow(
          db,
          context,
          parsed.data.repository,
        );
        const headSha = await projectFencedCommit(
          db,
          graph,
          context,
          parsed.data.repository,
          parsed.data.headSha,
        );
        if (!headSha) throw new Error("CODE_GRAPH_NOT_READY");
        const delta = computeCodeCommitDelta({
          repositoryPath: project.rootPath,
          baseSha: parsed.data.baseSha,
          headSha,
        });
        const changedPaths = [
          ...new Set([
            ...delta.changeSet.added,
            ...delta.changeSet.modified,
            ...delta.changeSet.renamed.map((entry) => entry.to),
          ]),
        ].sort();
        const options: CodeImpactOptions = {
          ...((parsed.data.options ?? {}) as CodeImpactOptions),
          includeTests: parsed.data.options?.includeTests ?? true,
          includeCatalogBridges:
            parsed.data.options?.includeCatalogBridges ?? true,
          includeRulesDecisions:
            parsed.data.options?.includeRulesDecisions ?? true,
          includeRuntimeObservations:
            parsed.data.options?.includeRuntimeObservations ?? true,
        };
        const changeImpact =
          changedPaths.length === 0
            ? { changedNodes: [], impacts: [], unmatchedPaths: [] }
            : await service.changeImpact(context, {
                repository: parsed.data.repository,
                commitSha: headSha,
                changedPaths,
                options,
              });
        const seedNodeIds = new Set(
          changeImpact.changedNodes
            .map((node) => node.payload.codeNodeId)
            .filter((value): value is string => typeof value === "string"),
        );
        const candidates = candidateEdgesFromMetadata(
          project.metadata,
          seedNodeIds.size > 0 ? seedNodeIds : undefined,
        );
        const partitions = mergeCodeImpactPartitions(
          changeImpact.impacts.map((impact, index) =>
            partitionCodeImpact(impact, index === 0 ? candidates : []),
          ),
        );
        return {
          baseSha: delta.baseSha,
          headSha: delta.headSha,
          changeSet: delta.changeSet,
          changedSymbols: delta.changedSymbols,
          removedSymbols: delta.removedSymbols,
          addedSymbols: delta.addedSymbols,
          ambiguousRenameMapping: ambiguousRenameMapping(
            project.metadata,
            delta.baseSha,
            delta.headSha,
          ),
          unmatchedPaths: changeImpact.unmatchedPaths,
          directStaticDependents: partitions.directStaticDependents,
          transitiveStaticDependents: partitions.transitiveStaticDependents,
          impactedTests: partitions.tests,
          runtimeObservations: partitions.runtimeObservations,
          impactedServicesCatalog: partitions.catalogImpacts,
          relevantRulesDecisions: partitions.linkedRulesDecisions,
          uncertainAmbiguousImpacts: partitions.uncertainAmbiguousImpacts,
          otherContext: partitions.otherContext,
          warnings: delta.warnings,
        };
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );

  app.post("/v1/code/tests", { preHandler: guards }, async (request, reply) => {
    const parsed = ScopedSelector.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_CODE_TESTS_QUERY",
        issues: parsed.error.issues,
      });
    }
    try {
      const context = await authorizedCodeContext(db, request, parsed.data);
      return {
        paths: await service.tests(
          context,
          await projectFencedSelector(
            db,
            graph,
            context,
            normalizedCodeSelector(parsed.data.selector),
          ),
        ),
      };
    } catch (error) {
      return sendCodeQueryError(reply, error);
    }
  });

  app.post(
    "/v1/code/explain",
    { preHandler: guards },
    async (request, reply) => {
      const parsed = ScopedPath.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CODE_EXPLAIN_QUERY",
          issues: parsed.error.issues,
        });
      }
      try {
        const context = await authorizedCodeContext(db, request, parsed.data);
        return {
          paths: await service.explain(
            context,
            await projectFencedSelector(
              db,
              graph,
              context,
              normalizedCodeSelector(parsed.data.source),
            ),
            await projectFencedSelector(
              db,
              graph,
              context,
              normalizedCodeSelector(parsed.data.target),
            ),
            (parsed.data.options ?? {}) as CodePathOptions,
          ),
        };
      } catch (error) {
        return sendCodeQueryError(reply, error);
      }
    },
  );
}
