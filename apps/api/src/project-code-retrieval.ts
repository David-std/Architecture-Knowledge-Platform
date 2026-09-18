import type { GraphNodeRef, GraphPathResult } from "@akp/contracts";
import {
  PostgresFederatedGraphStore,
  pathMatchesVaultPrefix,
  type Postgres,
} from "@akp/postgres";
import { projectCodeGraphIdentity } from "@akp/project-adapter";

export interface CodeChannelCandidate {
  id: string;
  documentRevision: string;
  reason: string;
  citations: string[];
}

export interface ProjectCodeRetrieval {
  projectId: string;
  available: boolean;
  candidates: CodeChannelCandidate[];
  revision: string | null;
  sourceRevision: string | null;
  warnings: string[];
}

export interface ProjectCodeGraphScope {
  vaultId: string;
  pathPrefix: string | null;
}

interface ProjectCodeRow {
  id: string;
  vault_id: string;
  slug: string;
  metadata: Record<string, unknown>;
  document_id: string;
  document_revision: string;
  document_path: string;
}

interface SnapshotSymbol {
  name: string;
  path: string;
}

interface SnapshotFile {
  path: string;
}

function unavailable(
  projectId: string,
  warning: string,
  sourceRevision: string | null = null,
  revision: string | null = null,
): ProjectCodeRetrieval {
  return {
    projectId,
    available: false,
    candidates: [],
    revision,
    sourceRevision,
    warnings: [warning],
  };
}

function currentCommit(metadata: Record<string, unknown>): string | null {
  const value = metadata.commit;
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function snapshotRecord(
  metadata: Record<string, unknown>,
): Record<string, unknown> | null {
  return metadata.snapshot &&
    typeof metadata.snapshot === "object" &&
    !Array.isArray(metadata.snapshot)
    ? (metadata.snapshot as Record<string, unknown>)
    : null;
}

function snapshotSymbols(metadata: Record<string, unknown>): SnapshotSymbol[] {
  const snapshot = snapshotRecord(metadata);
  if (!snapshot || !Array.isArray(snapshot.symbols)) return [];
  return snapshot.symbols.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const symbol = value as Record<string, unknown>;
    const locator =
      symbol.locator &&
      typeof symbol.locator === "object" &&
      !Array.isArray(symbol.locator)
        ? (symbol.locator as Record<string, unknown>)
        : null;
    if (
      typeof symbol.name !== "string" ||
      !symbol.name.trim() ||
      !locator ||
      typeof locator.path !== "string" ||
      !locator.path.trim()
    ) {
      return [];
    }
    return [{ name: symbol.name, path: locator.path.replaceAll("\\", "/") }];
  });
}

function snapshotFiles(metadata: Record<string, unknown>): SnapshotFile[] {
  const snapshot = snapshotRecord(metadata);
  if (!snapshot || !Array.isArray(snapshot.files)) return [];
  return snapshot.files.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const file = value as Record<string, unknown>;
    return typeof file.path === "string" && file.path.trim()
      ? [{ path: file.path.replaceAll("\\", "/") }]
      : [];
  });
}

function queryIdentifiers(query: string): Set<string> {
  return new Set(
    (query.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
      .filter((value) => value.length >= 2)
      .map((value) => value.toLowerCase()),
  );
}

function nodeLabel(node: Pick<GraphNodeRef, "payload">): string {
  for (const key of ["qualifiedName", "name", "path"]) {
    const value = node.payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "code-node";
}

function codeCitation(
  node: Pick<GraphNodeRef, "payload">,
  repository: string,
  commitSha: string,
): string | null {
  const nodePath = node.payload.path;
  if (typeof nodePath !== "string" || !nodePath.trim()) return null;
  const lineStart =
    typeof node.payload.lineStart === "number"
      ? Math.trunc(node.payload.lineStart)
      : null;
  const lineEnd =
    typeof node.payload.lineEnd === "number"
      ? Math.trunc(node.payload.lineEnd)
      : lineStart;
  const symbol =
    typeof node.payload.qualifiedName === "string"
      ? node.payload.qualifiedName
      : typeof node.payload.name === "string"
        ? node.payload.name
        : null;
  const lines =
    lineStart && lineStart > 0
      ? `:${lineStart}${lineEnd && lineEnd !== lineStart ? `-${lineEnd}` : ""}`
      : "";
  return `code:${repository}@${commitSha}:${nodePath}${lines}${symbol ? `#${symbol}` : ""}`;
}

function renderCodePath(path: GraphPathResult): string | null {
  const step = path.steps[0];
  if (!step) return null;
  const relation = `${step.relation}[${step.provenance.derivation}]`;
  return step.direction === "outgoing"
    ? `${nodeLabel(step.from)} --${relation}--> ${nodeLabel(step.to)}`
    : `${nodeLabel(step.from)} <--${relation}-- ${nodeLabel(step.to)}`;
}

export async function resolveProjectCodeRetrieval(
  db: Postgres,
  input: {
    spaceId: string;
    vaultIds: readonly string[];
    projectId?: string;
    query: string;
    graphScopes: readonly ProjectCodeGraphScope[];
    pathAuthorizer: (path: string, vaultId?: string) => boolean;
  },
): Promise<ProjectCodeRetrieval | null> {
  if (!input.projectId) return null;

  const result = await db.pool.query<ProjectCodeRow>(
    `
    select p.id,p.vault_id,p.slug,p.metadata,
           d.id document_id,d.current_revision document_revision,d.path document_path
      from projects p
      join knowledge_documents d
        on d.space_id=p.space_id
       and d.vault_id=p.vault_id
       and d.path=('projects/' || p.slug || '/snapshot.md')
     where p.id=$1 and p.space_id=$2 and p.vault_id=any($3::uuid[])
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
     limit 1
    `,
    [input.projectId, input.spaceId, [...input.vaultIds]],
  );
  const project = result.rows[0];
  if (
    !project ||
    !input.pathAuthorizer(project.document_path, project.vault_id)
  ) {
    throw new Error("PROJECT_CODE_NOT_FOUND_OR_UNAUTHORIZED");
  }

  const sourceRevision = currentCommit(project.metadata);
  if (!sourceRevision) {
    return unavailable(input.projectId, "CODE_GRAPH_NOT_READY");
  }
  const identity = projectCodeGraphIdentity(project.vault_id, project.slug);
  const graphScope = input.graphScopes.find(
    (scope) =>
      scope.vaultId === project.vault_id &&
      pathMatchesVaultPrefix(project.document_path, scope.pathPrefix),
  );
  if (!graphScope) {
    throw new Error("PROJECT_CODE_NOT_FOUND_OR_UNAUTHORIZED");
  }

  const graph = new PostgresFederatedGraphStore(db);
  const state = await graph.revisionState(
    "CODE",
    input.spaceId,
    identity.scopeId,
  );
  const active = state.active;
  if (!active) {
    return unavailable(input.projectId, "CODE_GRAPH_NOT_READY", sourceRevision);
  }
  if (
    active.freshness !== "FRESH" ||
    active.sourceRevision.toLowerCase() !== sourceRevision
  ) {
    return unavailable(
      input.projectId,
      "CODE_GRAPH_SOURCE_REVISION_STALE",
      sourceRevision,
      active.revision,
    );
  }

  const identifiers = queryIdentifiers(input.query);
  const selectors: Array<{ path: string; name?: string }> = [
    ...snapshotSymbols(project.metadata)
      .filter((symbol) => identifiers.has(symbol.name.toLowerCase()))
      .map((symbol) => ({ name: symbol.name, path: symbol.path })),
    ...snapshotFiles(project.metadata)
      .filter((file) =>
        input.query.toLowerCase().includes(file.path.toLowerCase()),
      )
      .map((file) => ({ path: file.path })),
  ]
    .filter(
      (selector, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.path === selector.path &&
            candidate.name === selector.name,
        ) === index,
    )
    .slice(0, 12);

  if (selectors.length === 0) {
    return {
      projectId: input.projectId,
      available: true,
      candidates: [],
      revision: active.revision,
      sourceRevision,
      warnings: [],
    };
  }

  const matchedNodes = new Map<string, GraphNodeRef>();
  for (const selector of selectors) {
    const nodes = await graph.findNodes({
      authorization: {
        spaceId: input.spaceId,
        vaults: [graphScope],
        allowSpaceScoped: false,
      },
      domains: ["CODE"],
      payloadContains: {
        repository: identity.repository,
        commitSha: sourceRevision,
        path: selector.path,
        ...(selector.name ? { name: selector.name } : {}),
      },
      freshnessPolicy: "FRESH_ONLY",
      limit: 25,
    });
    for (const node of nodes) matchedNodes.set(node.id, node);
  }

  const reasons: string[] = [];
  const citations = new Set<string>();
  for (const node of [...matchedNodes.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 8)) {
    const citation = codeCitation(node, identity.repository, sourceRevision);
    if (citation) citations.add(citation);
    const paths = await graph.neighbors({
      authorization: {
        spaceId: input.spaceId,
        vaults: [graphScope],
        allowSpaceScoped: false,
      },
      domains: ["CODE"],
      relationAllowlist: [
        "calls",
        "imports",
        "references",
        "inherits",
        "implements",
        "routes_to",
        "contains",
        "tests",
      ],
      direction: "both",
      freshnessPolicy: "FRESH_ONLY",
      bounds: {
        maxHops: 1,
        maxFanout: 20,
        maxCandidates: 50,
        timeBudgetMs: 1000,
      },
      seed: { nodeId: node.id },
    });
    if (paths.length === 0) {
      reasons.push(`code:symbol ${nodeLabel(node)} @ ${sourceRevision}`);
      continue;
    }
    for (const path of paths.slice(0, 4)) {
      const rendered = renderCodePath(path);
      if (rendered) reasons.push(`code:path ${rendered} @ ${sourceRevision}`);
      for (const step of path.steps) {
        const fromCitation = codeCitation(
          step.from,
          identity.repository,
          sourceRevision,
        );
        const toCitation = codeCitation(
          step.to,
          identity.repository,
          sourceRevision,
        );
        if (fromCitation) citations.add(fromCitation);
        if (toCitation) citations.add(toCitation);
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)].sort().slice(0, 8);
  return {
    projectId: input.projectId,
    available: true,
    candidates:
      uniqueReasons.length === 0
        ? []
        : [
            {
              id: project.document_id,
              documentRevision: project.document_revision,
              reason: uniqueReasons.join(" | "),
              citations: [...citations].sort(),
            },
          ],
    revision: active.revision,
    sourceRevision,
    warnings: [],
  };
}
