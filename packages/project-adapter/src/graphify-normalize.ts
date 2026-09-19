import { createHash } from "node:crypto";
import path from "node:path";
import { CodeGraphArtifact as CodeGraphArtifactSchema } from "@akp/contracts";
import type {
  CodeGraphArtifact,
  CodeGraphEdge,
  CodeGraphEdgeDerivation,
  CodeGraphNode,
  CodeGraphNodeKind,
  CodeGraphRelation,
  CodeGraphWarning,
  CodeLocator,
  CodeSnapshot,
} from "@akp/contracts";

export interface GraphifyPayload {
  directed?: unknown;
  multigraph?: unknown;
  nodes?: unknown;
  edges?: unknown;
  links?: unknown;
}

interface GraphifyNode {
  id?: unknown;
  label?: unknown;
  name?: unknown;
  source_file?: unknown;
  sourceFile?: unknown;
  source_location?: unknown;
  sourceLocation?: unknown;
  file_type?: unknown;
  node_type?: unknown;
  kind?: unknown;
  type?: unknown;
  category?: unknown;
  language?: unknown;
  qualified_name?: unknown;
  qualifiedName?: unknown;
  symbol?: unknown;
  signature?: unknown;
  community?: unknown;
}

interface GraphifyEdge {
  id?: unknown;
  source?: unknown;
  target?: unknown;
  src?: unknown;
  dst?: unknown;
  from?: unknown;
  to?: unknown;
  relation?: unknown;
  type?: unknown;
  kind?: unknown;
  label?: unknown;
  confidence?: unknown;
  confidence_score?: unknown;
  score?: unknown;
  weight?: unknown;
  source_file?: unknown;
  source_location?: unknown;
}

function graphifyError(code: string): Error {
  const value = new Error(code) as Error & { code?: string };
  value.code = code;
  return value;
}

function sha256(value: string | Buffer): string {
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

function cleanString(
  value: unknown,
  maximum: number,
  fallback?: string,
): string {
  if (typeof value !== "string") {
    if (fallback !== undefined) return fallback;
    throw graphifyError("GRAPHIFY_STRING_REQUIRED");
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    if (fallback !== undefined) return fallback;
    throw graphifyError("GRAPHIFY_STRING_REQUIRED");
  }
  return normalized.slice(0, maximum);
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw graphifyError("CODE_GRAPH_PATH_ESCAPE");
  }
  return normalized.replace(/^\.\//, "");
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function providerPath(raw: unknown, repositoryRoot: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw graphifyError("GRAPHIFY_NODE_SOURCE_FILE_REQUIRED");
  }
  const candidate = raw.trim();
  if (path.isAbsolute(candidate)) {
    const resolved = path.resolve(candidate);
    if (!pathInside(repositoryRoot, resolved)) {
      throw graphifyError("GRAPHIFY_SOURCE_PATH_ESCAPE");
    }
    return normalizeRelativePath(path.relative(repositoryRoot, resolved));
  }
  return normalizeRelativePath(candidate);
}

function providerEndpointId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  throw graphifyError("GRAPHIFY_EDGE_ENDPOINT_INVALID");
}

function sourceLines(value: unknown): {
  lineStart?: number;
  lineEnd?: number;
} {
  if (typeof value !== "string") return {};
  const match = /(?:^|\b)L?(\d+)(?:\s*[-:]\s*L?(\d+))?\b/i.exec(value);
  if (!match?.[1]) return {};
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end)) {
    return {};
  }
  return { lineStart: start, lineEnd: Math.max(start, end) };
}

function extensionLanguage(relativePath: string): string | undefined {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return {
    ".ts": "TypeScript",
    ".tsx": "TypeScriptReact",
    ".js": "JavaScript",
    ".jsx": "JavaScriptReact",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".cs": "CSharp",
    ".go": "Go",
    ".rs": "Rust",
    ".c": "C",
    ".h": "C",
    ".cc": "Cpp",
    ".cpp": "Cpp",
    ".cxx": "Cpp",
    ".hpp": "Cpp",
    ".rb": "Ruby",
    ".php": "PHP",
    ".swift": "Swift",
    ".scala": "Scala",
    ".vue": "Vue",
    ".svelte": "Svelte",
  }[extension];
}

function nodeKind(
  value: GraphifyNode,
  relativePath: string,
): CodeGraphNodeKind {
  const raw = [value.node_type, value.kind, value.type, value.category]
    .find((candidate) => typeof candidate === "string")
    ?.toString()
    .toLowerCase();
  if (raw) {
    if (/repository|repo/.test(raw)) return "REPOSITORY";
    if (/module|package|namespace/.test(raw)) return "MODULE";
    if (/file/.test(raw)) return "FILE";
    if (/class/.test(raw)) return "CLASS";
    if (/interface|protocol|trait/.test(raw)) return "INTERFACE";
    if (/method|constructor/.test(raw)) return "METHOD";
    if (/function|func|procedure/.test(raw)) return "FUNCTION";
    if (/test|spec/.test(raw)) return "TEST";
    if (/route|endpoint|handler/.test(raw)) return "ROUTE";
    if (/config|configuration/.test(raw)) return "CONFIG";
    if (/adr|decision|rationale/.test(raw)) return "ADR_REF";
  }
  if (
    /(^|\/)(__tests__|tests?|specs?)(\/|$)|(?:\.test|\.spec)\.[^.]+$/i.test(
      relativePath,
    )
  ) {
    return "TEST";
  }
  return "OTHER";
}

function relation(value: unknown): {
  canonical: CodeGraphRelation;
  providerRelation: string;
} {
  const providerRelation = cleanString(value, 160, "references").toLowerCase();
  if (/^(contains|member_of|defines|declares)$/.test(providerRelation)) {
    return { canonical: "CONTAINS", providerRelation };
  }
  if (/^(calls|call|invokes|invocation)$/.test(providerRelation)) {
    return { canonical: "CALLS", providerRelation };
  }
  if (
    /^(imports|import|uses_module|depends_on_module)$/.test(providerRelation)
  ) {
    return { canonical: "IMPORTS", providerRelation };
  }
  if (/^(inherits|extends|subclasses)$/.test(providerRelation)) {
    return { canonical: "INHERITS", providerRelation };
  }
  if (/^(implements|implementation_of)$/.test(providerRelation)) {
    return { canonical: "IMPLEMENTS", providerRelation };
  }
  if (/^(tests|tested_by|covers)$/.test(providerRelation)) {
    return { canonical: "TESTS", providerRelation };
  }
  if (/^(routes_to|route_to|dispatches_to)$/.test(providerRelation)) {
    return { canonical: "ROUTES_TO", providerRelation };
  }
  if (/^(rationale_for|adr_ref|decision_ref)$/.test(providerRelation)) {
    return { canonical: "RATIONALE_REF", providerRelation };
  }
  return { canonical: "REFERENCES", providerRelation };
}

function derivation(value: unknown): CodeGraphEdgeDerivation {
  if (typeof value !== "string") return "AMBIGUOUS";
  switch (value.trim().toUpperCase()) {
    case "EXTRACTED":
      return "EXTRACTED";
    case "STATICALLY_RESOLVED":
      return "STATICALLY_RESOLVED";
    case "INFERRED":
      return "INFERRED";
    case "AMBIGUOUS":
      return "AMBIGUOUS";
    default:
      return "AMBIGUOUS";
  }
}

function numericConfidence(value: GraphifyEdge): number | undefined {
  const candidate = [value.confidence_score, value.score, value.weight].find(
    (entry) => typeof entry === "number",
  );
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, candidate));
}

function canonicalNodeId(input: {
  repository: string;
  commitSha: string;
  path: string;
  kind: CodeGraphNodeKind;
  qualifiedName: string;
  signature?: string;
  lineStart?: number;
}): string {
  const digest = sha256(
    [
      input.repository,
      input.commitSha,
      input.path,
      input.kind,
      input.qualifiedName,
      input.signature ?? "",
      String(input.lineStart ?? 0),
    ].join("\0"),
  );
  return "CODE-" + digest.slice(0, 32).toUpperCase();
}

function canonicalEdgeId(input: {
  sourceId: string;
  targetId: string;
  relation: CodeGraphRelation;
  providerRelation: string;
  derivation: CodeGraphEdgeDerivation;
  locator?: CodeLocator;
}): string {
  const digest = sha256(
    stableJson({
      sourceId: input.sourceId,
      targetId: input.targetId,
      relation: input.relation,
      providerRelation: input.providerRelation,
      derivation: input.derivation,
      locator: input.locator ?? null,
    }),
  );
  return "CODE-EDGE-" + digest.slice(0, 32).toUpperCase();
}

export function parseGraphifyPayload(value: unknown): GraphifyPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw graphifyError("GRAPHIFY_OUTPUT_INVALID");
  }
  const payload = value as GraphifyPayload;
  if (!Array.isArray(payload.nodes)) {
    throw graphifyError("GRAPHIFY_OUTPUT_NODES_INVALID");
  }
  if (!Array.isArray(payload.edges) && !Array.isArray(payload.links)) {
    throw graphifyError("GRAPHIFY_OUTPUT_EDGES_INVALID");
  }
  return payload;
}

export function normalizeGraphifyArtifact(input: {
  raw: GraphifyPayload;
  snapshot: CodeSnapshot;
  repositoryRoot: string;
  providerVersion: string;
  configurationHash: string;
  outputHash: string;
  warnings: CodeGraphWarning[];
  executionMode: "FULL" | "INCREMENTAL" | "FULL_FALLBACK";
  previousCommitSha?: string;
}): CodeGraphArtifact {
  const rawNodes = input.raw.nodes as GraphifyNode[];
  const rawEdges = (
    Array.isArray(input.raw.edges) ? input.raw.edges : input.raw.links
  ) as GraphifyEdge[];
  const snapshotFiles = new Map(
    input.snapshot.files.map((file) => [file.path.replaceAll("\\", "/"), file]),
  );
  const providerToCanonical = new Map<string, string>();
  const canonicalIds = new Set<string>();
  const nodes: CodeGraphNode[] = [];

  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode !== "object") {
      throw graphifyError("GRAPHIFY_NODE_INVALID");
    }
    const providerId = cleanString(rawNode.id, 4096);
    if (providerToCanonical.has(providerId)) {
      throw graphifyError("GRAPHIFY_NODE_ID_DUPLICATE");
    }
    const relativePath = providerPath(
      rawNode.source_file ?? rawNode.sourceFile,
      input.repositoryRoot,
    );
    const file = snapshotFiles.get(relativePath);
    if (!file) throw graphifyError("GRAPHIFY_NODE_OUTSIDE_SNAPSHOT");
    const lines = sourceLines(
      rawNode.source_location ?? rawNode.sourceLocation,
    );
    const name = cleanString(rawNode.label ?? rawNode.name ?? rawNode.id, 1024);
    const kind = nodeKind(rawNode, relativePath);
    const qualifiedName = cleanString(
      rawNode.qualified_name ??
        rawNode.qualifiedName ??
        rawNode.symbol ??
        rawNode.label ??
        rawNode.name ??
        rawNode.id,
      2048,
    );
    const signature =
      typeof rawNode.signature === "string" && rawNode.signature.trim()
        ? cleanString(rawNode.signature, 4096)
        : undefined;
    const id = canonicalNodeId({
      repository: input.snapshot.repository,
      commitSha: input.snapshot.commitSha,
      path: relativePath,
      kind,
      qualifiedName,
      ...(signature ? { signature } : {}),
      ...lines,
    });
    if (canonicalIds.has(id)) {
      throw graphifyError("CODE_GRAPH_CANONICAL_ID_COLLISION");
    }
    canonicalIds.add(id);
    providerToCanonical.set(providerId, id);

    const language =
      typeof rawNode.language === "string" && rawNode.language.trim()
        ? cleanString(rawNode.language, 120)
        : extensionLanguage(relativePath);
    nodes.push({
      id,
      kind,
      name,
      qualifiedName,
      ...(signature ? { signature } : {}),
      ...(language ? { language } : {}),
      path: relativePath,
      ...lines,
      contentHash: file.contentHash,
      extensions: {
        graphify: {
          id: providerId,
          fileType:
            typeof rawNode.file_type === "string" ? rawNode.file_type : null,
          nodeType:
            typeof rawNode.node_type === "string" ? rawNode.node_type : null,
          community:
            typeof rawNode.community === "string" ||
            typeof rawNode.community === "number"
              ? rawNode.community
              : null,
        },
      },
    });
  }

  const edges: CodeGraphEdge[] = [];
  for (const rawEdge of rawEdges) {
    if (!rawEdge || typeof rawEdge !== "object") {
      throw graphifyError("GRAPHIFY_EDGE_INVALID");
    }
    const sourceProviderId = providerEndpointId(
      rawEdge.source ?? rawEdge.src ?? rawEdge.from,
    );
    const targetProviderId = providerEndpointId(
      rawEdge.target ?? rawEdge.dst ?? rawEdge.to,
    );
    const sourceId = providerToCanonical.get(sourceProviderId);
    const targetId = providerToCanonical.get(targetProviderId);
    if (!sourceId || !targetId) {
      throw graphifyError("GRAPHIFY_EDGE_ENDPOINT_UNKNOWN");
    }
    const mappedRelation = relation(
      rawEdge.relation ?? rawEdge.type ?? rawEdge.kind ?? rawEdge.label,
    );
    const mappedDerivation = derivation(rawEdge.confidence);
    const edgeLines = sourceLines(rawEdge.source_location);
    let locator: CodeLocator | undefined;
    if (typeof rawEdge.source_file === "string" && rawEdge.source_file.trim()) {
      const relativePath = providerPath(
        rawEdge.source_file,
        input.repositoryRoot,
      );
      const file = snapshotFiles.get(relativePath);
      if (!file) throw graphifyError("GRAPHIFY_EDGE_OUTSIDE_SNAPSHOT");
      locator = {
        repository: input.snapshot.repository,
        commitSha: input.snapshot.commitSha,
        path: relativePath,
        ...edgeLines,
        contentHash: file.contentHash,
      };
    }
    const confidence = numericConfidence(rawEdge);
    const id = canonicalEdgeId({
      sourceId,
      targetId,
      relation: mappedRelation.canonical,
      providerRelation: mappedRelation.providerRelation,
      derivation: mappedDerivation,
      ...(locator ? { locator } : {}),
    });
    edges.push({
      id,
      sourceId,
      targetId,
      relation: mappedRelation.canonical,
      derivation: mappedDerivation,
      ...(mappedDerivation === "INFERRED" || mappedDerivation === "AMBIGUOUS"
        ? confidence === undefined
          ? {}
          : { confidence }
        : {}),
      ...(locator ? { locator } : {}),
      extensions: {
        graphify: {
          id:
            typeof rawEdge.id === "string" || typeof rawEdge.id === "number"
              ? String(rawEdge.id)
              : null,
          relation: mappedRelation.providerRelation,
          confidence:
            typeof rawEdge.confidence === "string" ? rawEdge.confidence : null,
          confidenceScore: confidence ?? null,
        },
      },
    });
  }

  const languages = [
    ...new Set(
      nodes
        .map((node) => node.language)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();

  return CodeGraphArtifactSchema.parse({
    schemaVersion: 1,
    repository: input.snapshot.repository,
    commitSha: input.snapshot.commitSha,
    provider: "graphify",
    providerVersion: input.providerVersion,
    configurationHash: input.configurationHash,
    generatedAt: new Date().toISOString(),
    languages,
    nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
    warnings: input.warnings,
    extensions: {
      snapshotTreeHash: input.snapshot.treeHash,
      graphify: {
        directed:
          typeof input.raw.directed === "boolean" ? input.raw.directed : null,
        multigraph:
          typeof input.raw.multigraph === "boolean"
            ? input.raw.multigraph
            : null,
        outputSha256: input.outputHash,
        executionMode: input.executionMode,
        ...(input.previousCommitSha
          ? { previousCommitSha: input.previousCommitSha }
          : {}),
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
    },
  });
}

export function sha256GraphifyOutput(value: Buffer): string {
  return sha256(value);
}
