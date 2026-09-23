import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_GRAPH_NODE_LOOKUP_LIMIT,
  PostgresFederatedGraphStore,
  type Postgres,
} from "@akp/postgres";
import {
  CodeGraphLifecycleCoordinator,
  GraphifyCodeGraphAdapter,
  createCodeSnapshot,
  defaultCodeGraphOptions,
  projectCodeGraphIdentity,
  reconcileCodeGraphCandidates,
} from "@akp/project-adapter";
import type { EventHandlers } from "./event-worker.js";

interface ProjectRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  slug: string;
  root_path: string;
  metadata: Record<string, unknown>;
}

function configuredProjectRoots(): string[] {
  const configured = process.env.AKP_PROJECT_ROOTS;
  if (!configured?.trim()) throw new Error("PROJECT_ROOTS_NOT_CONFIGURED");
  const roots = configured.split(path.delimiter).map((root) => root.trim());
  if (roots.length === 0 || roots.some((root) => root.length === 0)) {
    throw new Error("PROJECT_ROOTS_NOT_CONFIGURED");
  }
  return roots.map((root) => path.resolve(root));
}

async function authorizedProjectRoot(rootPath: string): Promise<string> {
  const canonical = await realpath(path.resolve(rootPath)).catch(() => null);
  const info = canonical ? await stat(canonical).catch(() => null) : null;
  if (!canonical || !info?.isDirectory()) {
    throw new Error("PROJECT_ROOT_NOT_FOUND");
  }
  const allowedRoots = (
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
    !allowedRoots.some((root) => {
      const relative = path.relative(root, canonical);
      return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    })
  ) {
    throw new Error("PROJECT_ROOT_NOT_ALLOWED");
  }
  return canonical;
}

function graphifyConfiguration() {
  const executable = process.env.AKP_GRAPHIFY_EXECUTABLE?.trim();
  if (!executable) throw new Error("GRAPHIFY_EXECUTABLE_REQUIRED");
  const rawArgs = process.env.AKP_GRAPHIFY_EXECUTABLE_ARGS?.trim();
  if (!rawArgs) return { executable };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    throw new Error("GRAPHIFY_EXECUTABLE_ARGS_INVALID");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 32 ||
    parsed.some(
      (value) =>
        typeof value !== "string" || value.length === 0 || value.length > 4096,
    )
  ) {
    throw new Error("GRAPHIFY_EXECUTABLE_ARGS_INVALID");
  }
  return { executable, executableArgs: parsed as string[] };
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(value)
    ? value
    : "CODE_GRAPH_REFRESH_FAILED";
}

function currentCommit(row: ProjectRow): string | null {
  const value = row.metadata?.commit;
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
    ? value
    : null;
}

async function updateCodeGraphStatus(
  db: Postgres,
  projectId: string,
  sourceRevision: string,
  status: Record<string, unknown>,
): Promise<void> {
  await db.pool.query(
    `update projects
        set metadata=jsonb_set(metadata,'{codeGraph}',$2::jsonb,true)
      where id=$1 and metadata->>'commit'=$3`,
    [projectId, JSON.stringify(status), sourceRevision],
  );
}

async function projectStillCurrent(
  db: Postgres,
  projectId: string,
  sourceRevision: string,
): Promise<boolean> {
  const result = await db.pool.query<{ current: boolean }>(
    `select coalesce(metadata->>'commit','')=$2 current
       from projects
      where id=$1`,
    [projectId, sourceRevision],
  );
  return result.rows[0]?.current === true;
}

export function createCodeGraphRefreshHandlers(
  db: Postgres,
): Pick<EventHandlers, "CodeGraphRefreshRequested"> {
  let graphify: GraphifyCodeGraphAdapter | undefined;
  const extraction = (): GraphifyCodeGraphAdapter => {
    graphify ??= new GraphifyCodeGraphAdapter({
      ...graphifyConfiguration(),
      incremental: true,
    });
    return graphify;
  };
  return {
    CodeGraphRefreshRequested: async (event) => {
      if (process.env.AKP_CODE_GRAPH_ENABLED !== "true") {
        throw new Error("CODE_GRAPH_WORKER_DISABLED");
      }
      const projectId = String(event.payload.projectId ?? event.resourceId);
      const sourceRevision = String(event.payload.commit ?? "");
      if (
        !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(projectId) ||
        !/^[a-f0-9]{40}$/i.test(sourceRevision)
      ) {
        throw new Error("CODE_GRAPH_REFRESH_EVENT_INVALID");
      }

      const result = await db.pool.query<ProjectRow>(
        `select id,space_id,vault_id,slug,root_path,metadata
           from projects
          where id=$1
          limit 1`,
        [projectId],
      );
      const project = result.rows[0];
      if (!project || !project.vault_id) {
        throw new Error("CODE_GRAPH_PROJECT_NOT_FOUND");
      }
      if (
        String(event.spaceId ?? "") !== project.space_id ||
        String(event.vaultId ?? "") !== project.vault_id
      ) {
        throw new Error("CODE_GRAPH_REFRESH_SCOPE_MISMATCH");
      }
      if (currentCommit(project) !== sourceRevision) {
        return;
      }

      const identity = projectCodeGraphIdentity(project.vault_id, project.slug);
      if (
        event.payload.repository !== identity.repository ||
        event.payload.scopeId !== identity.scopeId ||
        event.payload.authorizationPathPrefix !==
          identity.authorizationPathPrefix
      ) {
        throw new Error("CODE_GRAPH_REFRESH_IDENTITY_MISMATCH");
      }

      const store = new PostgresFederatedGraphStore(db);
      try {
        const previousState = await store.revisionState(
          "CODE",
          project.space_id,
          identity.scopeId,
        );
        const previousNodes =
          previousState.active &&
          /^[a-f0-9]{40}$/i.test(previousState.active.sourceRevision)
            ? await store.findNodes({
                authorization: {
                  spaceId: project.space_id,
                  vaults: [{ vaultId: project.vault_id, pathPrefix: null }],
                  allowSpaceScoped: false,
                },
                domains: ["CODE"],
                payloadContains: {
                  repository: identity.repository,
                  commitSha: previousState.active.sourceRevision,
                },
                freshnessPolicy: "ALLOW_STALE",
                limit: MAX_GRAPH_NODE_LOOKUP_LIMIT,
              })
            : [];
        const repositoryPath = await authorizedProjectRoot(project.root_path);
        const snapshot = await createCodeSnapshot({
          repositoryPath,
          commit: sourceRevision,
        });
        const coordinator = new CodeGraphLifecycleCoordinator(
          extraction(),
          store,
        );
        const refreshed = await coordinator.refresh({
          snapshot: { ...snapshot, repository: identity.repository },
          options: defaultCodeGraphOptions(),
          spaceId: project.space_id,
          vaultId: project.vault_id,
          scopeId: identity.scopeId,
          authorizationPathPrefix: identity.authorizationPathPrefix,
        });

        if (!(await projectStillCurrent(db, projectId, sourceRevision))) {
          await store.markStale(
            "CODE",
            project.space_id,
            identity.scopeId,
            "project advanced while code graph refresh was running",
          );
          throw new Error("CODE_GRAPH_SOURCE_REVISION_CHANGED");
        }

        const reconciliationCandidates = reconcileCodeGraphCandidates(
          previousNodes,
          refreshed.artifact,
        );
        const graphifyExtension = refreshed.artifact.extensions?.graphify;
        const providerExecution =
          graphifyExtension &&
          typeof graphifyExtension === "object" &&
          !Array.isArray(graphifyExtension)
            ? (graphifyExtension as Record<string, unknown>)
            : null;
        await updateCodeGraphStatus(db, projectId, sourceRevision, {
          ...identity,
          status: "ACTIVE",
          sourceRevision,
          revision: refreshed.active.revision,
          freshness: refreshed.active.freshness,
          provider: refreshed.artifact.provider,
          providerVersion: refreshed.artifact.providerVersion,
          ...(typeof providerExecution?.executionMode === "string"
            ? { providerExecutionMode: providerExecution.executionMode }
            : {}),
          ...(typeof providerExecution?.previousCommitSha === "string"
            ? { providerPreviousCommitSha: providerExecution.previousCommitSha }
            : {}),
          nodeCount: refreshed.artifact.nodes.length,
          edgeCount: refreshed.artifact.edges.length,
          warningCount: refreshed.artifact.warnings.length,
          warnings: refreshed.artifact.warnings.slice(0, 32).map((warning) => ({
            code: warning.code,
            ...(warning.path ? { path: warning.path } : {}),
          })),
          warningsTruncated: refreshed.artifact.warnings.length > 32,
          skippedCandidateEdgeCount:
            refreshed.plan.skippedCandidateEdgeIds.length,
          candidateEdgeCount: refreshed.plan.candidateEdges.length,
          candidateEdges: refreshed.plan.candidateEdges.slice(0, 128),
          candidateEdgesTruncated: refreshed.plan.candidateEdges.length > 128,
          degradedDuringRefresh: refreshed.degradedDuringRefresh,
          reconciliation: {
            candidateCount: reconciliationCandidates.length,
            ambiguousCount: reconciliationCandidates.filter(
              (candidate) => candidate.state === "AMBIGUOUS",
            ).length,
            candidates: reconciliationCandidates,
          },
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        const state = await store
          .revisionState("CODE", project.space_id, identity.scopeId)
          .catch(() => null);
        await updateCodeGraphStatus(db, projectId, sourceRevision, {
          ...identity,
          status: state?.active ? "DEGRADED" : "FAILED",
          sourceRevision,
          errorCode: safeErrorCode(error),
          ...(state?.active
            ? {
                activeRevision: state.active.revision,
                activeSourceRevision: state.active.sourceRevision,
                activeFreshness: state.active.freshness,
              }
            : {}),
          failedAt: new Date().toISOString(),
        });
        throw error;
      }
    },
  };
}
