import { createHash } from "node:crypto";
import type {
  CodeGraphArtifact,
  GraphProjectionArtifact,
  GraphProjectionEdgeInput,
  GraphProjectionNodeInput,
} from "@akp/contracts";

export interface CodeGraphProjectionInput {
  artifact: CodeGraphArtifact;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  authorizationPathPrefix?: string;
}

export interface CodeGraphProjectionPlan {
  projection: GraphProjectionArtifact;
  skippedCandidateEdgeIds: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function authorizationPath(
  prefix: string | undefined,
  nodePath: string,
): string {
  const relative = nodePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !relative ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("/../") ||
    relative.startsWith("/")
  ) {
    throw new Error("CODE_GRAPH_AUTHORIZATION_PATH_INVALID");
  }
  const normalizedPrefix = prefix
    ?.replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (
    prefix !== undefined &&
    (!normalizedPrefix ||
      normalizedPrefix === "." ||
      normalizedPrefix === ".." ||
      normalizedPrefix.startsWith("../") ||
      normalizedPrefix.includes("/../"))
  ) {
    throw new Error("CODE_GRAPH_AUTHORIZATION_PREFIX_INVALID");
  }
  return normalizedPrefix ? `${normalizedPrefix}/${relative}` : relative;
}

function locatorRef(input: {
  repository: string;
  commitSha: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
}): string {
  const line =
    input.lineStart === undefined
      ? ""
      : ":" +
        String(input.lineStart) +
        (input.lineEnd && input.lineEnd !== input.lineStart
          ? "-" + String(input.lineEnd)
          : "");
  const symbol = input.symbol ? "#" + input.symbol : "";
  return (
    input.repository + "@" + input.commitSha + ":" + input.path + line + symbol
  );
}

export function codeGraphProjectionRevision(
  artifact: Pick<CodeGraphArtifact, "commitSha" | "configurationHash">,
): string {
  return artifact.commitSha + ":" + artifact.configurationHash;
}

export function planCodeGraphProjection(
  input: CodeGraphProjectionInput,
): CodeGraphProjectionPlan {
  const revision = codeGraphProjectionRevision(input.artifact);
  const nodeById = new Map(input.artifact.nodes.map((node) => [node.id, node]));
  const nodes: GraphProjectionNodeInput[] = input.artifact.nodes.map(
    (node) => ({
      identity: {
        graphDomain: "CODE",
        scopeId: input.scopeId,
        kind: node.kind,
        canonicalKey: node.id,
        revision,
      },
      vaultId: input.vaultId,
      authorizationPath: authorizationPath(
        input.authorizationPathPrefix,
        node.path,
      ),
      payload: {
        codeNodeId: node.id,
        repository: input.artifact.repository,
        commitSha: input.artifact.commitSha,
        kind: node.kind,
        name: node.name,
        ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
        ...(node.signature ? { signature: node.signature } : {}),
        ...(node.language ? { language: node.language } : {}),
        path: node.path,
        ...(node.lineStart !== undefined ? { lineStart: node.lineStart } : {}),
        ...(node.lineEnd !== undefined ? { lineEnd: node.lineEnd } : {}),
        ...(node.contentHash ? { contentHash: node.contentHash } : {}),
        provider: input.artifact.provider,
        providerVersion: input.artifact.providerVersion,
      },
    }),
  );

  const skippedCandidateEdgeIds: string[] = [];
  const edges: GraphProjectionEdgeInput[] = [];
  for (const edge of input.artifact.edges) {
    if (
      edge.derivation !== "EXTRACTED" &&
      edge.derivation !== "STATICALLY_RESOLVED"
    ) {
      skippedCandidateEdgeIds.push(edge.id);
      continue;
    }
    const from = nodeById.get(edge.sourceId);
    const to = nodeById.get(edge.targetId);
    if (!from || !to) {
      throw new Error("CODE_GRAPH_PROJECTION_DANGLING_EDGE");
    }
    const sourceLocator = edge.locator
      ? locatorRef({
          repository: edge.locator.repository,
          commitSha: edge.locator.commitSha,
          path: edge.locator.path,
          ...(edge.locator.lineStart !== undefined
            ? { lineStart: edge.locator.lineStart }
            : {}),
          ...(edge.locator.lineEnd !== undefined
            ? { lineEnd: edge.locator.lineEnd }
            : {}),
          ...(edge.locator.symbol ? { symbol: edge.locator.symbol } : {}),
        })
      : locatorRef({
          repository: input.artifact.repository,
          commitSha: input.artifact.commitSha,
          path: from.path,
          ...(from.lineStart !== undefined
            ? { lineStart: from.lineStart }
            : {}),
          ...(from.lineEnd !== undefined ? { lineEnd: from.lineEnd } : {}),
          ...(from.qualifiedName ? { symbol: from.qualifiedName } : {}),
        });
    edges.push({
      from: {
        graphDomain: "CODE",
        scopeId: input.scopeId,
        kind: from.kind,
        canonicalKey: from.id,
        revision,
      },
      relation: edge.relation.toLowerCase(),
      to: {
        graphDomain: "CODE",
        scopeId: input.scopeId,
        kind: to.kind,
        canonicalKey: to.id,
        revision,
      },
      authorizationPath: authorizationPath(
        input.authorizationPathPrefix,
        from.path,
      ),
      provenance: {
        derivation:
          edge.derivation === "EXTRACTED"
            ? "DETERMINISTIC_EXTRACTED"
            : "STATICALLY_RESOLVED",
        sourceIds: [
          "code:" + input.artifact.repository + "@" + input.artifact.commitSha,
        ],
        evidenceIds: [],
        locatorRefs: [sourceLocator],
        revision,
        recordedAt: input.artifact.generatedAt,
      },
    });
  }

  const sourceHash = sha256(
    stableJson({
      schemaVersion: input.artifact.schemaVersion,
      repository: input.artifact.repository,
      commitSha: input.artifact.commitSha,
      provider: input.artifact.provider,
      providerVersion: input.artifact.providerVersion,
      configurationHash: input.artifact.configurationHash,
      nodes: input.artifact.nodes,
      edges: input.artifact.edges,
      warnings: input.artifact.warnings,
    }),
  );

  return {
    projection: {
      graphDomain: "CODE",
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      scopeId: input.scopeId,
      revision,
      sourceRevision: input.artifact.commitSha,
      sourceHash,
      provider: input.artifact.provider,
      providerVersion: input.artifact.providerVersion,
      configurationVersion: input.artifact.configurationHash,
      nodes,
      edges,
    },
    skippedCandidateEdgeIds,
  };
}
