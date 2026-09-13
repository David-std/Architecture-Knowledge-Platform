import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fg from "fast-glob";
import matter from "gray-matter";
import type { Postgres } from "@akp/postgres";
import {
  configurationHashForEmbeddingDescriptor,
  createConfiguredEmbeddingProvider,
  parseKnowledgeUnits,
  serializeEmbeddingRuntime,
  toPgVector,
} from "@akp/retrieval";

export type ImportSeverity = "error" | "warning";

export interface ImportIssue {
  severity: ImportSeverity;
  code: string;
  path?: string;
  message: string;
}

export interface VaultDocument {
  relativePath: string;
  absolutePath: string;
  externalId: string;
  title: string;
  type: string;
  lifecycle: string;
  trustTier: string;
  layer: string;
  aliases: string[];
  body: string;
  frontmatter: Record<string, unknown>;
  links: string[];
  contentHash: string;
  tokenEstimate: number;
  operational: boolean;
}

export interface VaultInspection {
  canonicalPath: string;
  name: string;
  revision: string;
  documents: VaultDocument[];
  issues: ImportIssue[];
  relations: Array<{ from: string; to: string; type: string; target: string }>;
  metrics: {
    markdownFiles: number;
    operationalDocuments: number;
    rawDocuments: number;
    archivalDocuments: number;
    curatedRecoveryDocuments: number;
    acquisitionBacklogsQuarantined: number;
    stableIds: number;
    links: number;
    resolvedLinks: number;
    unresolvedLinks: number;
    operationalComponents: number;
    sourceNotes: number;
    evidenceNotes: number;
    claimsWithEvidence: number;
  };
}

export interface ImportResult extends VaultInspection {
  runId: string;
  vaultId: string;
  status: "COMPLETED" | "COMPLETED_WITH_WARNINGS";
  reportPath?: string;
}

/**
 * A vault import profile carries local curation conventions without making
 * them platform behaviour.  In particular, names of folders used by one
 * knowledge vault must never decide whether a different vault's content is
 * operational, archival or agent-facing.
 *
 * The default profile is deliberately empty and generic.  Consumers that
 * need a legacy curation policy can pass a JSON-compatible profile explicitly
 * when they import or register that vault.
 */
export interface VaultImportProfile {
  rawPrefixes?: string[];
  sourceCollectionPrefix?: string;
  transferPackPrefix?: string;
  curatedRecoveryTypes?: string[];
  rootRouterDocuments?: string[];
  layerMap?: Record<string, string>;
  quarantineAcquisitionBacklogs?: boolean;
}

const DEFAULT_IMPORT_PROFILE: Required<VaultImportProfile> = {
  rawPrefixes: [],
  sourceCollectionPrefix: "",
  transferPackPrefix: "",
  curatedRecoveryTypes: [],
  rootRouterDocuments: ["README.md", "AGENTS.md"],
  layerMap: {},
  quarantineAcquisitionBacklogs: false,
};

function normalizeProfile(
  profile: VaultImportProfile | undefined,
): Required<VaultImportProfile> {
  const normalizedPrefix = (value: string): string =>
    normalizePath(value).replace(/^\/+|\/+$/g, "");
  return {
    rawPrefixes: (profile?.rawPrefixes ?? DEFAULT_IMPORT_PROFILE.rawPrefixes)
      .map(normalizedPrefix)
      .filter(Boolean)
      .map((prefix) => `${prefix}/`),
    sourceCollectionPrefix: profile?.sourceCollectionPrefix
      ? `${normalizedPrefix(profile.sourceCollectionPrefix)}/`
      : "",
    transferPackPrefix: profile?.transferPackPrefix
      ? `${normalizedPrefix(profile.transferPackPrefix)}/`
      : "",
    curatedRecoveryTypes: profile?.curatedRecoveryTypes ?? [],
    rootRouterDocuments:
      profile?.rootRouterDocuments ??
      DEFAULT_IMPORT_PROFILE.rootRouterDocuments,
    layerMap: profile?.layerMap ?? DEFAULT_IMPORT_PROFILE.layerMap,
    quarantineAcquisitionBacklogs:
      profile?.quarantineAcquisitionBacklogs ??
      DEFAULT_IMPORT_PROFILE.quarantineAcquisitionBacklogs,
  };
}

const sha256 = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function slugTitle(relativePath: string): string {
  return path
    .basename(relativePath, path.extname(relativePath))
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function parseWikiLinks(body: string): string[] {
  const targets: string[] = [];
  const regex = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of body.matchAll(regex)) {
    const target = match[1]?.trim();
    if (target) targets.push(normalizePath(target.replace(/\.md$/i, "")));
  }
  return [...new Set(targets)];
}

function isCuratedRecoveryDocument(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  profile: Required<VaultImportProfile>,
): boolean {
  if (
    !profile.sourceCollectionPrefix ||
    !relativePath.startsWith(profile.sourceCollectionPrefix)
  )
    return false;
  const status = String(frontmatter.status ?? "").toLowerCase();
  const type = String(frontmatter.type ?? "").toLowerCase();
  const id = String(frontmatter.id ?? "").trim();
  return (
    status === "curated" &&
    id.length > 0 &&
    profile.curatedRecoveryTypes.includes(type)
  );
}

function isOperational(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  profile: Required<VaultImportProfile>,
): boolean {
  if (
    profile.sourceCollectionPrefix &&
    relativePath.startsWith(profile.sourceCollectionPrefix)
  ) {
    return isCuratedRecoveryDocument(relativePath, frontmatter, profile);
  }
  return !profile.rawPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

function deriveLayer(
  relativePath: string,
  frontmatter: Record<string, unknown>,
  profile: Required<VaultImportProfile>,
): string {
  if (typeof frontmatter.layer === "string") return frontmatter.layer;
  if (isCuratedRecoveryDocument(relativePath, frontmatter, profile))
    return "source";
  const first = relativePath.split("/")[0] ?? "root";
  return profile.layerMap[first] ?? "content";
}

function isAcquisitionBacklog(
  raw: string,
  frontmatter: Record<string, unknown>,
  profile: Required<VaultImportProfile>,
): boolean {
  if (!profile.quarantineAcquisitionBacklogs) return false;
  const status = String(frontmatter.status ?? "").toLowerCase();
  const type = String(frontmatter.type ?? "").toLowerCase();
  if (
    status.includes("ready-for-acquisition") ||
    status.includes("pending-acquisition") ||
    type.includes("acquisition-manifest")
  ) {
    return true;
  }
  const signals = [
    /\|\s*[☐□]\s*\|\s*P\d/i,
    /\b(?:PAGO|GRATIS-(?:PDF|WEB)|PAGO-ARCHIVO)\b/i,
    /\b(?:comprar una copia|descargar primero|pendiente de (?:pago|compra|descarga))\b/i,
  ];
  return signals.filter((pattern) => pattern.test(raw)).length >= 2;
}

function normalizeLifecycle(
  frontmatter: Record<string, unknown>,
  options: { archival: boolean },
): string {
  if (options.archival) return "ARCHIVED";
  const value = String(
    frontmatter.lifecycle ?? frontmatter.status ?? "",
  ).toLowerCase();
  if (value.includes("draft")) return "DRAFT";
  if (value.includes("disputed") || value.includes("conflict"))
    return "DISPUTED";
  if (value.includes("superseded")) return "SUPERSEDED";
  if (value.includes("archive") || value.includes("deprecated"))
    return "ARCHIVED";
  return "ACTIVE";
}

function normalizeTrust(
  frontmatter: Record<string, unknown>,
  operational: boolean,
): string {
  if (!operational) return "UNVERIFIED";
  const value = String(
    frontmatter.trust_tier ??
      frontmatter.verification_status ??
      frontmatter.status ??
      "",
  ).toLowerCase();
  if (value.includes("attested")) return "ATTESTED";
  if (
    value.includes("verified") ||
    value.includes("reviewed") ||
    value.includes("approved") ||
    value.includes("active") ||
    value.includes("curated")
  ) {
    return "HUMAN_REVIEWED";
  }
  if (value.includes("machine") || value.includes("extracted"))
    return "MACHINE_SUPPORTED";
  return "MACHINE_SUPPORTED";
}

function gitRevision(root: string): string | null {
  const inside = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--is-inside-work-tree"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return null;
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (head.status !== 0) return null;
  const dirty = spawnSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return `${head.stdout.trim()}${dirty.stdout.trim() ? ":dirty" : ""}`;
}

function resolveLink(
  fromPath: string,
  target: string,
  byStem: Map<string, string[]>,
  byPath: Map<string, string>,
): string | null {
  const normalized = normalizePath(target).replace(/^\/+/, "");
  const direct = byPath.get(normalized.toLowerCase());
  if (direct) return direct;

  const fromDirectory = path.posix.dirname(fromPath);
  const relativeTarget = path.posix
    .normalize(path.posix.join(fromDirectory, normalized))
    .replace(/^\.\//, "");
  const nearby = byPath.get(relativeTarget.toLowerCase());
  if (nearby) return nearby;

  const candidates =
    byStem.get(path.posix.basename(normalized).toLowerCase()) ?? [];
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function componentCount(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
): number {
  if (nodes.length === 0) return 0;
  const adjacency = new Map(nodes.map((node) => [node, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const visited = new Set<string>();
  let components = 0;
  for (const node of nodes) {
    if (visited.has(node)) continue;
    components += 1;
    const queue = [node];
    visited.add(node);
    while (queue.length) {
      const current = queue.shift();
      if (!current) continue;
      for (const adjacent of adjacency.get(current) ?? []) {
        if (!visited.has(adjacent)) {
          visited.add(adjacent);
          queue.push(adjacent);
        }
      }
    }
  }
  return components;
}

export async function inspectVault(
  vaultPath: string,
  options: { profile?: VaultImportProfile } = {},
): Promise<VaultInspection> {
  const profile = normalizeProfile(options.profile);
  const canonicalPath = await realpath(path.resolve(vaultPath));
  const rootStats = await stat(canonicalPath);
  if (!rootStats.isDirectory())
    throw new Error(`Vault path is not a directory: ${canonicalPath}`);

  const relativePaths = (
    await fg("**/*.md", {
      cwd: canonicalPath,
      onlyFiles: true,
      dot: false,
      ignore: [".git/**", "node_modules/**", ".obsidian/plugins/**"],
    })
  )
    .map(normalizePath)
    .sort();

  const issues: ImportIssue[] = [];
  const documents: VaultDocument[] = [];
  const seenIds = new Map<string, string>();

  for (const relativePath of relativePaths) {
    if (process.env.AKP_IMPORT_DEBUG === "1") {
      console.error(
        `[vault-import] parse ${documents.length + 1}/${relativePaths.length} ${relativePath}`,
      );
    }
    const absolutePath = path.join(canonicalPath, ...relativePath.split("/"));
    const raw = await readFile(absolutePath, "utf8");
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (error) {
      issues.push({
        severity: "error",
        code: "INVALID_FRONTMATTER",
        path: relativePath,
        message: String(error),
      });
      parsed = matter("");
      parsed.content = raw;
      parsed.data = {};
    }
    const frontmatter = parsed.data as Record<string, unknown>;
    const transferArtifact =
      Boolean(profile.transferPackPrefix) &&
      relativePath.startsWith(profile.transferPackPrefix);
    const acquisitionBacklog = isAcquisitionBacklog(raw, frontmatter, profile);
    const operational =
      isOperational(relativePath, frontmatter, profile) && !acquisitionBacklog;
    const archival = transferArtifact || acquisitionBacklog;
    const requiresStableMetadata =
      operational && !profile.rootRouterDocuments.includes(relativePath);
    const declaredId =
      typeof frontmatter.id === "string" ? frontmatter.id.trim() : "";
    const externalId =
      operational && declaredId
        ? declaredId
        : `RAW-${sha256(relativePath).slice(0, 16).toUpperCase()}`;
    if (requiresStableMetadata && !declaredId) {
      issues.push({
        severity: "error",
        code: "MISSING_STABLE_ID",
        path: relativePath,
        message: "Operational Markdown must declare a stable frontmatter id.",
      });
    }
    if (operational) {
      const existing = seenIds.get(externalId);
      if (existing) {
        issues.push({
          severity: "error",
          code: "DUPLICATE_STABLE_ID",
          path: relativePath,
          message: `Stable id ${externalId} is already used by ${existing}.`,
        });
      } else {
        seenIds.set(externalId, relativePath);
      }
    }

    const type = transferArtifact
      ? "raw-transfer-artifact"
      : acquisitionBacklog
        ? "source-acquisition-backlog"
        : typeof frontmatter.type === "string"
          ? frontmatter.type
          : operational
            ? "note"
            : "raw-resource";
    if (requiresStableMetadata && typeof frontmatter.type !== "string") {
      issues.push({
        severity: "warning",
        code: "MISSING_TYPE",
        path: relativePath,
        message: "Operational Markdown has no explicit type; imported as note.",
      });
    }

    const body = parsed.content.trim();
    if (acquisitionBacklog) {
      issues.push({
        severity: "warning",
        code: "ACQUISITION_BACKLOG_QUARANTINED",
        path: relativePath,
        message:
          "Acquisition/download checklist retained as archived provenance; it is not agent-facing knowledge. Curate durable facts into source/evidence notes before use.",
      });
    }
    documents.push({
      relativePath,
      absolutePath,
      externalId,
      title:
        (typeof frontmatter.title === "string" && frontmatter.title.trim()) ||
        slugTitle(relativePath),
      type,
      lifecycle: normalizeLifecycle(frontmatter, { archival }),
      trustTier: normalizeTrust(frontmatter, operational),
      layer: deriveLayer(relativePath, frontmatter, profile),
      aliases: asStrings(frontmatter.aliases),
      body,
      frontmatter,
      links: parseWikiLinks(body),
      contentHash: sha256(raw),
      tokenEstimate: Math.ceil(raw.length / 4),
      operational,
    });
  }

  const byPath = new Map<string, string>();
  const byStem = new Map<string, string[]>();
  for (const document of documents) {
    const withoutExtension = document.relativePath.replace(/\.md$/i, "");
    byPath.set(withoutExtension.toLowerCase(), document.externalId);
    const stem = path.posix.basename(withoutExtension).toLowerCase();
    byStem.set(stem, [...(byStem.get(stem) ?? []), document.externalId]);
    byPath.set(document.externalId.toLowerCase(), document.externalId);
    for (const alias of document.aliases)
      byPath.set(alias.toLowerCase(), document.externalId);
  }

  const relations: VaultInspection["relations"] = [];
  let unresolvedLinks = 0;
  if (process.env.AKP_IMPORT_DEBUG === "1") {
    console.error(
      `[vault-import] resolve links for ${documents.length} documents`,
    );
  }
  for (const document of documents) {
    for (const target of document.links) {
      const resolved = resolveLink(
        document.relativePath,
        target,
        byStem,
        byPath,
      );
      if (!resolved) {
        unresolvedLinks += 1;
        issues.push({
          severity: "warning",
          code: "UNRESOLVED_LINK",
          path: document.relativePath,
          message: `Could not resolve wikilink [[${target}]].`,
        });
        continue;
      }
      relations.push({
        from: document.externalId,
        to: resolved,
        type: "related_to",
        target,
      });
    }
    const typedRelationFields: Array<{
      field: string;
      relationType: string;
      warnWhenUnresolved: boolean;
    }> = [
      { field: "supports", relationType: "supports", warnWhenUnresolved: true },
      {
        field: "contradicts",
        relationType: "contradicts",
        warnWhenUnresolved: true,
      },
      { field: "requires", relationType: "requires", warnWhenUnresolved: true },
      {
        field: "implements",
        relationType: "implements",
        warnWhenUnresolved: true,
      },
      {
        field: "example_of",
        relationType: "example_of",
        warnWhenUnresolved: true,
      },
      {
        field: "counterexample_of",
        relationType: "counterexample_of",
        warnWhenUnresolved: true,
      },
      {
        field: "validated_by",
        relationType: "validated_by",
        warnWhenUnresolved: true,
      },
      { field: "produces", relationType: "produces", warnWhenUnresolved: true },
      {
        field: "consumed_by",
        relationType: "consumed_by",
        warnWhenUnresolved: true,
      },
      {
        field: "supersedes",
        relationType: "supersedes",
        warnWhenUnresolved: true,
      },
      {
        field: "derives_from",
        relationType: "derives_from",
        warnWhenUnresolved: true,
      },
      {
        field: "derived_from",
        relationType: "derives_from",
        warnWhenUnresolved: true,
      },
      {
        field: "source",
        relationType: "derives_from",
        warnWhenUnresolved: false,
      },
      {
        field: "sources",
        relationType: "derives_from",
        warnWhenUnresolved: true,
      },
      {
        field: "evidence",
        relationType: "derives_from",
        warnWhenUnresolved: true,
      },
      { field: "claim", relationType: "requires", warnWhenUnresolved: true },
      { field: "claims", relationType: "requires", warnWhenUnresolved: true },
      { field: "rule", relationType: "requires", warnWhenUnresolved: true },
      { field: "rules", relationType: "requires", warnWhenUnresolved: true },
      {
        field: "context_pack",
        relationType: "requires",
        warnWhenUnresolved: true,
      },
    ];
    for (const {
      field,
      relationType,
      warnWhenUnresolved,
    } of typedRelationFields) {
      for (const rawTarget of asStrings(document.frontmatter[field])) {
        const target = rawTarget
          .replace(/^!?\[\[/, "")
          .replace(/\]\]$/, "")
          .split(/[|#]/)[0]
          ?.trim();
        if (!target) continue;
        const resolved = resolveLink(
          document.relativePath,
          target,
          byStem,
          byPath,
        );
        if (!resolved) {
          const looksLikeKnowledgeReference =
            rawTarget.includes("[[") ||
            rawTarget.includes("/") ||
            /^(?:SRC|CLM|CON|PAT|RUL|WF|REQ|QAS|BC|ADR|C4|ARC|API|EVT|TST|FIT|EVD|PRO|SKL|EVAL|AKS)-/i.test(
              target,
            );
          if (warnWhenUnresolved && looksLikeKnowledgeReference) {
            issues.push({
              severity: "warning",
              code: "UNRESOLVED_TYPED_RELATION",
              path: document.relativePath,
              message: `Could not resolve ${field} target ${rawTarget}.`,
            });
          }
          continue;
        }
        if (
          !relations.some(
            (relation) =>
              relation.from === document.externalId &&
              relation.to === resolved &&
              relation.type === relationType,
          )
        ) {
          relations.push({
            from: document.externalId,
            to: resolved,
            type: relationType,
            target,
          });
        }
      }
    }
  }

  const operationalIds = new Set(
    documents
      .filter((document) => document.operational)
      .map((document) => document.externalId),
  );
  const operationalEdges = relations.filter(
    (relation) =>
      operationalIds.has(relation.from) && operationalIds.has(relation.to),
  );
  const sourceNotes = documents.filter(
    (document) => document.layer === "source",
  ).length;
  const evidenceNotes = documents.filter((document) =>
    document.type.includes("evidence"),
  ).length;
  const claimsWithEvidence = documents.filter(
    (document) =>
      document.layer === "claim" &&
      (document.links.some((link) => link.toLowerCase().includes("evidence")) ||
        Object.keys(document.frontmatter).some((key) =>
          key.toLowerCase().includes("evidence"),
        )),
  ).length;

  const snapshotMaterial = documents
    .map((document) => `${document.relativePath}\0${document.contentHash}`)
    .join("\n");
  const repositoryRevision = gitRevision(canonicalPath);
  const snapshotHash = sha256(snapshotMaterial);
  // `HEAD:dirty` alone is not a snapshot identity: two successive imports of
  // different uncommitted worktree contents would otherwise overwrite one
  // corpus revision and its units. Include the material hash while dirty so
  // historical snapshots stay addressable and identical retries remain
  // idempotent.
  const revision = repositoryRevision
    ? repositoryRevision.endsWith(":dirty")
      ? `${repositoryRevision}:${snapshotHash}`
      : repositoryRevision
    : `snapshot:${snapshotHash}`;

  return {
    canonicalPath,
    name: path.basename(canonicalPath),
    revision,
    documents,
    issues,
    relations,
    metrics: {
      markdownFiles: documents.length,
      operationalDocuments: operationalIds.size,
      rawDocuments: documents.length - operationalIds.size,
      archivalDocuments: documents.filter(
        (document) => document.lifecycle === "ARCHIVED",
      ).length,
      curatedRecoveryDocuments: documents.filter(
        (document) =>
          document.operational &&
          profile.curatedRecoveryTypes.includes(document.type.toLowerCase()),
      ).length,
      acquisitionBacklogsQuarantined: issues.filter(
        (issue) => issue.code === "ACQUISITION_BACKLOG_QUARANTINED",
      ).length,
      stableIds: documents.filter(
        (document) =>
          document.operational &&
          !profile.rootRouterDocuments.includes(document.relativePath) &&
          !document.externalId.startsWith("RAW-"),
      ).length,
      links: documents.reduce(
        (sum, document) => sum + document.links.length,
        0,
      ),
      resolvedLinks: relations.length,
      unresolvedLinks,
      operationalComponents: componentCount(
        [...operationalIds],
        operationalEdges,
      ),
      sourceNotes,
      evidenceNotes,
      claimsWithEvidence,
    },
  };
}

type ConfiguredEmbeddingProvider = NonNullable<
  ReturnType<typeof createConfiguredEmbeddingProvider>
>;

interface ImportEmbeddingPlan {
  generationId: string | null;
  needsBuild: boolean;
  activate: boolean;
}

interface ImportEmbeddingBuildOptions {
  spaceId: string;
  vaultId: string;
  corpusRevision: string;
}

function safeEmbeddingFailureReason(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Embedding provider failed.";
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(api[_ -]?key|authorization|credential|password|passwd|secret|token)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[REDACTED]@")
    .slice(0, 500);
}

/**
 * Build vectors only after the canonical import has committed.  The target
 * generation is kept BUILDING while provider calls run, so a timeout or a
 * process restart leaves a resumable partial generation instead of rolling
 * back documents or deleting the previous generation's FK targets.
 */
async function buildImportedEmbeddingGeneration(
  db: Postgres,
  provider: ConfiguredEmbeddingProvider,
  generationId: string,
  options: ImportEmbeddingBuildOptions,
): Promise<void> {
  const dimensions = provider.descriptor.dimensions;
  const units = await db.pool.query<{
    id: string;
    content_hash: string;
    body: string;
  }>(
    `
    select u.id,u.content_hash,u.body
      from knowledge_units u
      join knowledge_documents d on d.id=u.document_id
     where u.space_id=$1 and u.vault_id=$2 and u.corpus_revision=$3
       and u.embedding_eligible=true
       and u.lifecycle in ('ACTIVE','DISPUTED')
       and d.space_id=$1 and d.vault_id=$2
       and d.lifecycle in ('ACTIVE','DISPUTED')
       and d.refresh_status not in ('STALE_BLOCKED','INVALID')
     order by u.document_id,u.structural_order,u.id
    `,
    [options.spaceId, options.vaultId, options.corpusRevision],
  );

  // A retry must repair stale rows as well as missing rows.  Ineligible or
  // content-mismatched rows belong to an older snapshot and must not make a
  // generation appear complete.
  await db.pool.query(
    `
    delete from unit_embeddings e
     where e.generation_id=$1
       and exists (
         select 1 from embedding_generations g
          where g.id=e.generation_id and g.space_id=$2 and g.vault_id=$3
            and g.corpus_revision=$4
       )
       and not exists (
         select 1
           from knowledge_units u
           join knowledge_documents d on d.id=u.document_id
          where u.id=e.unit_id
            and u.space_id=$2 and u.vault_id=$3
            and u.corpus_revision=$4
            and u.embedding_eligible=true
            and u.lifecycle in ('ACTIVE','DISPUTED')
            and d.space_id=$2 and d.vault_id=$3
            and d.lifecycle in ('ACTIVE','DISPUTED')
            and d.refresh_status not in ('STALE_BLOCKED','INVALID')
            and u.content_hash=e.content_hash
            and e.embedding_dimensions=$5
       )
    `,
    [
      generationId,
      options.spaceId,
      options.vaultId,
      options.corpusRevision,
      dimensions,
    ],
  );

  const written = await db.pool.query<{
    unit_id: string;
    content_hash: string;
  }>(
    `select e.unit_id,e.content_hash
       from unit_embeddings e
       join embedding_generations g on g.id=e.generation_id
      where e.generation_id=$1 and g.space_id=$2 and g.vault_id=$3
        and g.corpus_revision=$4`,
    [generationId, options.spaceId, options.vaultId, options.corpusRevision],
  );
  const writtenHashes = new Map(
    written.rows.map((row) => [String(row.unit_id), row.content_hash]),
  );
  const missing = units.rows.filter(
    (unit) => writtenHashes.get(unit.id) !== unit.content_hash,
  );

  const batchSize = 64;
  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    const vectors = await provider.embed(
      batch.map((unit) => unit.body),
      "passage",
    );
    if (vectors.length !== batch.length) {
      throw new Error("EMBEDDING_PROVIDER_RESULT_COUNT_MISMATCH");
    }
    for (const [index, unit] of batch.entries()) {
      const vector = vectors[index];
      if (
        !vector ||
        vector.length !== dimensions ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("EMBEDDING_DIMENSION_MISMATCH");
      }
      if (provider.descriptor.normalization.toLowerCase() === "l2") {
        const norm = Math.hypot(...vector);
        if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
          throw new Error("EMBEDDING_NORMALIZATION_MISMATCH");
        }
      }
      await db.pool.query(
        `
        insert into unit_embeddings(
          unit_id,generation_id,content_hash,embedding,embedding_dimensions
        ) values($1,$2,$3,$4::vector,$5)
        on conflict(unit_id,generation_id) do update set
          content_hash=excluded.content_hash,
          embedding=excluded.embedding,
          embedding_dimensions=excluded.embedding_dimensions
        `,
        [
          unit.id,
          generationId,
          unit.content_hash,
          toPgVector(vector),
          dimensions,
        ],
      );
    }
  }

  const counts = await db.pool.query<{
    expected: number;
    matching: number;
    stored: number;
  }>(
    `
    select
      (select count(*)::int
         from knowledge_units u
         join knowledge_documents d on d.id=u.document_id
        where u.space_id=$1 and u.vault_id=$2 and u.corpus_revision=$3
          and u.embedding_eligible=true
          and u.lifecycle in ('ACTIVE','DISPUTED')
          and d.space_id=$1 and d.vault_id=$2
          and d.lifecycle in ('ACTIVE','DISPUTED')
          and d.refresh_status not in ('STALE_BLOCKED','INVALID')) expected,
      (select count(*)::int
         from unit_embeddings e
         join knowledge_units u
           on u.id=e.unit_id and u.space_id=$1 and u.vault_id=$2
          and u.corpus_revision=$3 and u.content_hash=e.content_hash
         join knowledge_documents d
           on d.id=u.document_id and d.space_id=$1 and d.vault_id=$2
          and d.lifecycle in ('ACTIVE','DISPUTED')
          and d.refresh_status not in ('STALE_BLOCKED','INVALID')
        where e.generation_id=$4
          and u.embedding_eligible=true
          and u.lifecycle in ('ACTIVE','DISPUTED')
          and e.embedding_dimensions=$5) matching,
      (select count(*)::int
         from unit_embeddings e
         join embedding_generations g on g.id=e.generation_id
        where e.generation_id=$4 and g.space_id=$1 and g.vault_id=$2
          and g.corpus_revision=$3) stored
    `,
    [
      options.spaceId,
      options.vaultId,
      options.corpusRevision,
      generationId,
      dimensions,
    ],
  );
  const count = counts.rows[0];
  if (
    !count ||
    Number(count.expected) !== Number(count.matching) ||
    Number(count.expected) !== Number(count.stored)
  ) {
    throw new Error("Embedding generation is incomplete.");
  }

  const ready = await db.pool.query(
    `update embedding_generations
        set status='READY'
      where id=$1 and space_id=$2 and vault_id=$3 and corpus_revision=$4
        and status='BUILDING'
    returning id`,
    [generationId, options.spaceId, options.vaultId, options.corpusRevision],
  );
  if (ready.rowCount !== 1) {
    const current = await db.pool.query<{ status: string }>(
      `select status
         from embedding_generations
        where id=$1 and space_id=$2 and vault_id=$3 and corpus_revision=$4`,
      [generationId, options.spaceId, options.vaultId, options.corpusRevision],
    );
    if (!["READY", "ACTIVE"].includes(current.rows[0]?.status ?? "")) {
      throw new Error("INVALID_EMBEDDING_GENERATION_TRANSITION");
    }
  }
}

/**
 * Activate only while the structural marker still selects this import. The
 * marker lock, generation switch and vector publication share one transaction
 * so a slow R1 import cannot retire an already-current R2 generation.
 */
async function activateImportedGenerationIfCurrent(
  db: Postgres,
  generationId: string,
  options: ImportEmbeddingBuildOptions,
): Promise<boolean> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const marker = await client.query<{ corpus_revision: string }>(
      `select corpus_revision
         from vault_index_revisions
        where space_id=$1 and vault_id=$2
        for update`,
      [options.spaceId, options.vaultId],
    );
    if (marker.rows[0]?.corpus_revision !== options.corpusRevision) {
      await client.query("rollback");
      return false;
    }
    const activated = await client.query(
      `select * from akp_activate_embedding_generation($1)`,
      [generationId],
    );
    if (activated.rowCount !== 1) {
      throw new Error("EMBEDDING_GENERATION_NOT_FOUND");
    }
    const published = await client.query(
      `update vault_index_revisions
          set vector_revision=$3,
              status=case
                when lexical_revision=$3 and graph_revision=$3
                  and context_pack_revision=$3 then 'CONSISTENT'
                else 'DEGRADED'
              end,
              warnings=(
                select coalesce(jsonb_agg(value),'[]'::jsonb)
                  from jsonb_array_elements_text(warnings) value
                 where value not in (
                   'VECTOR_BUILD_PENDING','VECTOR_BUILD_FAILED',
                   'VECTOR_PROVIDER_NOT_CONFIGURED',
                   'VECTOR_PROVIDER_CONFIGURATION_INVALID',
                   'VECTOR_DISABLED','VECTOR_DISABLED_PENDING_BENCHMARK',
                   'VECTOR_PROVIDER_UNAVAILABLE'
                 )
              ),
              updated_at=now()
        where space_id=$1 and vault_id=$2 and corpus_revision=$3`,
      [options.spaceId, options.vaultId, options.corpusRevision],
    );
    if (published.rowCount !== 1) {
      throw new Error("INDEX_REVISION_MARKER_NOT_CURRENT");
    }
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface FinalizeImportOptions {
  runId: string;
  spaceId: string;
  vaultId: string;
  projectionRevision: string;
  preservedVectorRevision: string | null;
  generationId: string | null;
  vectorReady: boolean;
  warning: string | null;
  failureReason: string | null;
  inspection: VaultInspection;
}

async function finalizeImportedProjection(
  db: Postgres,
  options: FinalizeImportOptions,
): Promise<ImportResult["status"]> {
  const client = await db.pool.connect();
  const warnings = options.warning ? [options.warning] : [];
  const status: ImportResult["status"] =
    options.inspection.issues.some((issue) => issue.severity === "warning") ||
    options.warning !== null
      ? "COMPLETED_WITH_WARNINGS"
      : "COMPLETED";
  try {
    await client.query("begin");
    if (options.generationId && options.failureReason) {
      await client.query(
        `update embedding_generations
            set status='FAILED',failure_reason=$2
          where id=$1 and space_id=$3 and vault_id=$4
            and status in ('REQUESTED','BUILDING')`,
        [
          options.generationId,
          options.failureReason,
          options.spaceId,
          options.vaultId,
        ],
      );
    }

    // A structural refresh must not hide a still-valid active generation.
    // Keep advertising that generation while a replacement is unavailable;
    // this is the rollback/query anchor when the provider is down.
    const vectorRevision = options.vectorReady
      ? options.projectionRevision
      : options.preservedVectorRevision;
    const indexStatus = options.vectorReady ? "CONSISTENT" : "DEGRADED";
    const warningJson = JSON.stringify(warnings);
    await client.query(
      `
      insert into index_revisions(
        space_id,corpus_revision,lexical_revision,vector_revision,graph_revision,
        context_pack_revision,status,warnings
      ) values($1,$2,$2,$3,$2,$2,$4,$5::jsonb)
      on conflict(space_id) do update set
        corpus_revision=excluded.corpus_revision,
        lexical_revision=excluded.lexical_revision,
        vector_revision=excluded.vector_revision,
        graph_revision=excluded.graph_revision,
        context_pack_revision=excluded.context_pack_revision,
        status=excluded.status,warnings=excluded.warnings,updated_at=now()
      where index_revisions.corpus_revision=excluded.corpus_revision
      `,
      [
        options.spaceId,
        options.projectionRevision,
        vectorRevision,
        indexStatus,
        warningJson,
      ],
    );
    await client.query(
      `
      insert into vault_index_revisions(
        space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
        graph_revision,context_pack_revision,status,warnings
      ) values($1,$2,$3,$3,$4,$3,$3,$5,$6::jsonb)
      on conflict(space_id,vault_id) do update set
        corpus_revision=excluded.corpus_revision,
        lexical_revision=excluded.lexical_revision,
        vector_revision=excluded.vector_revision,
        graph_revision=excluded.graph_revision,
        context_pack_revision=excluded.context_pack_revision,
        status=excluded.status,warnings=excluded.warnings,updated_at=now()
      where vault_index_revisions.corpus_revision=excluded.corpus_revision
      `,
      [
        options.spaceId,
        options.vaultId,
        options.projectionRevision,
        vectorRevision,
        indexStatus,
        warningJson,
      ],
    );
    if (options.warning === "VECTOR_BUILD_FAILED") {
      await client.query(
        `insert into vault_import_issues(
           run_id,severity,code,path,message
         ) values($1,'warning',$2,null,$3)`,
        [
          options.runId,
          options.warning,
          "Embedding provider failed; the structural import completed and vector retrieval is degraded.",
        ],
      );
    }
    await client.query(
      `update vault_import_runs
          set status=$2,metrics=$3::jsonb,completed_at=now()
        where id=$1`,
      [options.runId, status, JSON.stringify(options.inspection.metrics)],
    );
    await client.query("commit");
    return status;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Import a read-only vault without coupling canonical persistence to optional
 * semantic inference.  Historical unit snapshots remain addressable by their
 * corpus revision until an explicit retention policy removes them.
 */
export async function importVaultReadOnly(
  db: Postgres,
  vaultPath: string,
  options: {
    spaceId: string;
    vaultKey?: string;
    evalPack?: string;
    reportPath?: string;
    profile?: VaultImportProfile;
  },
): Promise<ImportResult> {
  let embeddingAdapter: ReturnType<typeof createConfiguredEmbeddingProvider> =
    null;
  let embeddingConfigurationWarning: string | null = null;
  try {
    embeddingAdapter = createConfiguredEmbeddingProvider();
  } catch {
    embeddingConfigurationWarning = "VECTOR_PROVIDER_CONFIGURATION_INVALID";
  }

  const profile = normalizeProfile(options.profile);
  const inspection = await inspectVault(vaultPath, { profile });
  const spaceId = options.spaceId;
  const baseKey = inspection.name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const vaultKey =
    options.vaultKey ??
    `${baseKey || "vault"}-${sha256(inspection.canonicalPath).slice(0, 8)}`;
  const evalPack = options.evalPack ?? "generic";
  const vectorEnabled = process.env.AKP_VECTOR_ENABLED === "true";

  let vaultId = "";
  let runId = "";
  let projectionRevision = "";
  let preservedVectorRevision: string | null = null;
  let generationPlan: ImportEmbeddingPlan = {
    generationId: null,
    needsBuild: false,
    activate: false,
  };

  const client = await db.pool.connect();
  try {
    await client.query("begin");

    const insertedVault = await client.query<{
      id: string;
      space_id: string;
      canonical_path: string;
    }>(
      `
      insert into vaults(
        space_id,canonical_path,name,read_only,current_revision,vault_key,
        local_path,eval_pack,schema_profile
      )
      values ($1,$2,$3,true,$4,$5,$2,$6::jsonb,$7::jsonb)
      on conflict (vault_key) do nothing
      returning id,space_id,canonical_path
      `,
      [
        spaceId,
        inspection.canonicalPath,
        inspection.name,
        inspection.revision,
        vaultKey,
        JSON.stringify({
          name: evalPack,
          version: "1",
          enabled: true,
          criticalCases: [],
        }),
        JSON.stringify({ importProfile: profile }),
      ],
    );
    let vault = insertedVault.rows[0];
    if (!vault) {
      const existingVault = await client.query<{
        id: string;
        space_id: string;
        canonical_path: string;
      }>(
        `select id,space_id,canonical_path from vaults where vault_key=$1 for update`,
        [vaultKey],
      );
      vault = existingVault.rows[0];
    }
    if (!vault) throw new Error("VAULT_KEY_RESOLUTION_FAILED");
    if (vault.space_id !== spaceId) {
      throw new Error("VAULT_KEY_SCOPE_CONFLICT");
    }
    if (vault.canonical_path !== inspection.canonicalPath) {
      throw new Error("VAULT_KEY_CANONICAL_PATH_CONFLICT");
    }

    const updatedVault = await client.query<{ id: string }>(
      `
      update vaults
         set name=$2,read_only=true,current_revision=$3,local_path=$4,
             eval_pack=$5::jsonb,
             schema_profile=coalesce(schema_profile,'{}'::jsonb)||$6::jsonb
       where id=$1 and space_id=$7
      returning id
      `,
      [
        vault.id,
        inspection.name,
        inspection.revision,
        inspection.canonicalPath,
        JSON.stringify({
          name: evalPack,
          version: "1",
          enabled: true,
          criticalCases: [],
        }),
        JSON.stringify({ importProfile: profile }),
        spaceId,
      ],
    );
    vaultId = updatedVault.rows[0]?.id ?? "";
    if (!vaultId) throw new Error("VAULT_SCOPE_MISMATCH");

    const runResult = await client.query<{ id: string }>(
      `
      insert into vault_import_runs(
        vault_id,revision,source_path,read_only,status,report_path
      ) values($1,$2,$3,true,'RUNNING',$4)
      returning id
      `,
      [
        vaultId,
        inspection.revision,
        inspection.canonicalPath,
        options.reportPath ?? null,
      ],
    );
    runId = runResult.rows[0]?.id ?? "";
    if (!runId) throw new Error("IMPORT_RUN_CREATE_FAILED");
    projectionRevision = `vault:${vaultId}:${inspection.revision}`;

    const activeGeneration = await client.query<{ corpus_revision: string }>(
      `select corpus_revision
         from embedding_generations
        where space_id=$1 and vault_id=$2 and status='ACTIVE'
        order by activated_at desc nulls last,created_at desc
        limit 1`,
      [spaceId, vaultId],
    );
    preservedVectorRevision = activeGeneration.rows[0]?.corpus_revision ?? null;

    await client.query(
      `
      delete from knowledge_relations r
       where r.space_id=$1
         and r.provenance='markdown'
         and exists (
           select 1 from knowledge_documents d
            where d.id=r.from_document_id
              and d.space_id=$1 and d.vault_id=$2
         )
      `,
      [spaceId, vaultId],
    );

    const importedIds: string[] = [];
    const databaseIdByExternalId = new Map<string, string>();
    for (const document of inspection.documents) {
      const row = await client.query<{ id: string }>(
        `
        insert into knowledge_documents(
          space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
          current_revision,body_cache,frontmatter,aliases,layer,content_hash,
          token_estimate,raw_links,updated_at
        )
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,now())
        on conflict (vault_id,path) where vault_id is not null
        do update set
          space_id=excluded.space_id,
          vault_id=excluded.vault_id,
          external_id=excluded.external_id,
          title=excluded.title,
          type=excluded.type,
          lifecycle=excluded.lifecycle,
          trust_tier=excluded.trust_tier,
          current_revision=excluded.current_revision,
          body_cache=excluded.body_cache,
          frontmatter=excluded.frontmatter,
          aliases=excluded.aliases,
          layer=excluded.layer,
          content_hash=excluded.content_hash,
          token_estimate=excluded.token_estimate,
          raw_links=excluded.raw_links,
          refresh_status='CURRENT',
          invalidated_by=null,
          stale_reason=null,
          updated_at=now()
        returning id
        `,
        [
          spaceId,
          vaultId,
          document.relativePath,
          document.externalId,
          document.title,
          document.type,
          document.lifecycle,
          document.trustTier,
          inspection.revision,
          document.body,
          JSON.stringify(document.frontmatter),
          document.aliases,
          document.layer,
          document.contentHash,
          document.tokenEstimate,
          JSON.stringify(document.links),
        ],
      );
      const databaseId = row.rows[0]?.id;
      if (!databaseId) {
        throw new Error(
          `Document upsert returned no id for ${document.relativePath}`,
        );
      }
      importedIds.push(databaseId);
      databaseIdByExternalId.set(document.externalId, databaseId);

      await client.query(
        `
        insert into knowledge_versions(
          document_id,git_commit,content_hash,body,frontmatter
        ) values($1,$2,$3,$4,$5::jsonb)
        on conflict(document_id,git_commit) do nothing
        `,
        [
          databaseId,
          inspection.revision,
          document.contentHash,
          document.body,
          JSON.stringify(document.frontmatter),
        ],
      );

      const units = parseKnowledgeUnits(document.title, document.body);
      const unitIdByKey = new Map<string, string>();
      for (const unit of units) {
        const insertedUnit = await client.query<{ id: string }>(
          `
          insert into knowledge_units(
            document_id,space_id,vault_id,unit_key,unit_type,heading_path,body,
            content_hash,corpus_revision,document_revision,lifecycle,trust_tier,
            source_ids,token_estimate,parent_unit_id,permissions,locator,
            structural_order,container_only,embedding_eligible
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   $16::jsonb,$17::jsonb,$18,$19,$20)
          on conflict(document_id,unit_key,corpus_revision)
          do update set
            space_id=excluded.space_id,
            vault_id=excluded.vault_id,
            unit_type=excluded.unit_type,
            heading_path=excluded.heading_path,
            body=excluded.body,
            content_hash=excluded.content_hash,
            document_revision=excluded.document_revision,
            lifecycle=excluded.lifecycle,
            trust_tier=excluded.trust_tier,
            source_ids=excluded.source_ids,
            token_estimate=excluded.token_estimate,
            parent_unit_id=excluded.parent_unit_id,
            permissions=excluded.permissions,
            locator=excluded.locator,
            structural_order=excluded.structural_order,
            container_only=excluded.container_only,
            embedding_eligible=excluded.embedding_eligible,
            updated_at=now()
          returning id
          `,
          [
            databaseId,
            spaceId,
            vaultId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            projectionRevision,
            inspection.revision,
            document.lifecycle,
            document.trustTier,
            [],
            unit.tokenEstimate,
            unit.parentUnitKey
              ? (unitIdByKey.get(unit.parentUnitKey) ?? null)
              : null,
            JSON.stringify(document.frontmatter.permissions ?? {}),
            JSON.stringify({ ...unit.locator, path: document.relativePath }),
            unit.structuralOrder,
            unit.containerOnly,
            unit.embeddingEligible,
          ],
        );
        const insertedUnitId = insertedUnit.rows[0]?.id;
        if (!insertedUnitId) {
          throw new Error(`Could not insert knowledge unit ${unit.unitKey}.`);
        }
        unitIdByKey.set(unit.unitKey, insertedUnitId);
      }
    }

    await client.query(
      `
      update knowledge_documents
         set lifecycle='DELETED_TOMBSTONE',
             refresh_status='INVALID',
             stale_reason='Removed from imported vault revision',
             body_cache='',
             updated_at=now()
       where space_id=$1 and vault_id=$2 and not (id=any($3::uuid[]))
      `,
      [spaceId, vaultId, importedIds],
    );
    await client.query(
      `
      update knowledge_units u
         set lifecycle=d.lifecycle,updated_at=now()
        from knowledge_documents d
       where u.document_id=d.id and u.space_id=$1 and u.vault_id=$2
         and d.space_id=$1 and d.vault_id=$2
         and d.lifecycle='DELETED_TOMBSTONE'
      `,
      [spaceId, vaultId],
    );

    for (const relation of inspection.relations) {
      const from = databaseIdByExternalId.get(relation.from);
      const to = databaseIdByExternalId.get(relation.to);
      if (!from || !to) continue;
      await client.query(
        `
        insert into knowledge_relations(
          space_id,from_document_id,to_document_id,relation_type,provenance,metadata
        ) values($1,$2,$3,$4,'markdown',$5::jsonb)
        on conflict do nothing
        `,
        [
          spaceId,
          from,
          to,
          relation.type,
          JSON.stringify({ target: relation.target, vaultId }),
        ],
      );
    }

    for (const issue of inspection.issues) {
      await client.query(
        `
        insert into vault_import_issues(run_id,severity,code,path,message)
        values($1,$2,$3,$4,$5)
        `,
        [runId, issue.severity, issue.code, issue.path ?? null, issue.message],
      );
    }

    if (embeddingAdapter) {
      const runtime = serializeEmbeddingRuntime(
        embeddingAdapter.descriptor.runtime,
      );
      const configurationHash = configurationHashForEmbeddingDescriptor(
        embeddingAdapter.descriptor,
      );
      const insertedGeneration = await client.query<{
        id: string;
        status: string;
      }>(
        `
        insert into embedding_generations(
          space_id,vault_id,provider,model,model_revision,dimensions,
          normalization,input_strategy,configuration_version,runtime,
          configuration_hash,corpus_revision,status
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'REQUESTED')
        on conflict do nothing
        returning id,status
        `,
        [
          spaceId,
          vaultId,
          embeddingAdapter.descriptor.provider,
          embeddingAdapter.descriptor.model,
          embeddingAdapter.descriptor.modelRevision,
          embeddingAdapter.descriptor.dimensions,
          embeddingAdapter.descriptor.normalization,
          embeddingAdapter.descriptor.inputStrategy,
          embeddingAdapter.descriptor.configurationVersion,
          runtime,
          configurationHash,
          projectionRevision,
        ],
      );
      let generation = insertedGeneration.rows[0];
      if (!generation) {
        generation = (
          await client.query<{ id: string; status: string }>(
            `
            select id,status from embedding_generations
             where space_id=$1 and vault_id=$2 and provider=$3 and model=$4
               and model_revision=$5 and dimensions=$6 and normalization=$7
               and input_strategy=$8 and configuration_version=$9
               and runtime=$10 and configuration_hash=$11
               and corpus_revision=$12
             for update
            `,
            [
              spaceId,
              vaultId,
              embeddingAdapter.descriptor.provider,
              embeddingAdapter.descriptor.model,
              embeddingAdapter.descriptor.modelRevision,
              embeddingAdapter.descriptor.dimensions,
              embeddingAdapter.descriptor.normalization,
              embeddingAdapter.descriptor.inputStrategy,
              embeddingAdapter.descriptor.configurationVersion,
              runtime,
              configurationHash,
              projectionRevision,
            ],
          )
        ).rows[0];
      }
      if (!generation) throw new Error("EMBEDDING_GENERATION_NOT_FOUND");

      generationPlan = {
        generationId: generation.id,
        needsBuild: false,
        activate: false,
      };
      const completeness = await client.query<{
        expected: number;
        matching: number;
        stored: number;
      }>(
        `
        select
          (select count(*)::int
             from knowledge_units u
             join knowledge_documents d on d.id=u.document_id
            where u.space_id=$1 and u.vault_id=$2 and u.corpus_revision=$3
              and u.embedding_eligible=true
              and u.lifecycle in ('ACTIVE','DISPUTED')
              and d.space_id=$1 and d.vault_id=$2
              and d.lifecycle in ('ACTIVE','DISPUTED')
              and d.refresh_status not in ('STALE_BLOCKED','INVALID')) expected,
          (select count(*)::int
             from unit_embeddings e
             join knowledge_units u
               on u.id=e.unit_id and u.space_id=$1 and u.vault_id=$2
              and u.corpus_revision=$3 and u.content_hash=e.content_hash
             join knowledge_documents d
               on d.id=u.document_id and d.space_id=$1 and d.vault_id=$2
              and d.lifecycle in ('ACTIVE','DISPUTED')
              and d.refresh_status not in ('STALE_BLOCKED','INVALID')
            where e.generation_id=$4 and u.embedding_eligible=true
              and u.lifecycle in ('ACTIVE','DISPUTED')
              and e.embedding_dimensions=$5) matching,
          (select count(*)::int from unit_embeddings where generation_id=$4) stored
        `,
        [
          spaceId,
          vaultId,
          projectionRevision,
          generation.id,
          embeddingAdapter.descriptor.dimensions,
        ],
      );
      const count = completeness.rows[0];
      const complete =
        count !== undefined &&
        Number(count.expected) === Number(count.matching) &&
        Number(count.expected) === Number(count.stored);
      if (
        !complete ||
        !["ACTIVE", "READY", "RETIRED"].includes(generation.status)
      ) {
        if (generation.status === "ACTIVE" || generation.status === "READY") {
          await client.query(
            `update embedding_generations
                set status='STALE'
              where id=$1 and space_id=$2 and vault_id=$3
                and corpus_revision=$4`,
            [generation.id, spaceId, vaultId, projectionRevision],
          );
          generation.status = "STALE";
        }
        if (generation.status !== "BUILDING") {
          await client.query(
            `update embedding_generations
                set status='BUILDING',failure_reason=null
              where id=$1 and space_id=$2 and vault_id=$3
                and corpus_revision=$4
                and status in ('REQUESTED','FAILED','STALE','RETIRED')`,
            [generation.id, spaceId, vaultId, projectionRevision],
          );
        }
        generationPlan.needsBuild = true;
      } else {
        generationPlan.activate = generation.status !== "ACTIVE";
      }
    }

    await client.query(
      `update vaults
          set last_imported_at=now(),current_revision=$2
        where id=$1 and space_id=$3`,
      [vaultId, inspection.revision, spaceId],
    );

    const initialWarning = embeddingConfigurationWarning
      ? embeddingConfigurationWarning
      : !embeddingAdapter
        ? vectorEnabled
          ? "VECTOR_PROVIDER_NOT_CONFIGURED"
          : "VECTOR_DISABLED_PENDING_BENCHMARK"
        : !vectorEnabled
          ? "VECTOR_DISABLED_PENDING_BENCHMARK"
          : generationPlan.needsBuild
            ? "VECTOR_BUILD_PENDING"
            : null;
    const initialWarnings = initialWarning ? [initialWarning] : [];
    const initialWarningJson = JSON.stringify(initialWarnings);
    await client.query(
      `
      insert into index_revisions(
        space_id,corpus_revision,lexical_revision,vector_revision,graph_revision,
        context_pack_revision,status,warnings
      ) values($1,$2,$2,$3,$2,$2,'DEGRADED',$4::jsonb)
      on conflict(space_id) do update set
        corpus_revision=excluded.corpus_revision,
        lexical_revision=excluded.lexical_revision,
        vector_revision=excluded.vector_revision,
        graph_revision=excluded.graph_revision,
        context_pack_revision=excluded.context_pack_revision,
        status=excluded.status,warnings=excluded.warnings,updated_at=now()
      `,
      [
        spaceId,
        projectionRevision,
        preservedVectorRevision,
        initialWarningJson,
      ],
    );
    await client.query(
      `
      insert into vault_index_revisions(
        space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
        graph_revision,context_pack_revision,status,warnings
      ) values($1,$2,$3,$3,$4,$3,$3,'DEGRADED',$5::jsonb)
      on conflict(space_id,vault_id) do update set
        corpus_revision=excluded.corpus_revision,
        lexical_revision=excluded.lexical_revision,
        vector_revision=excluded.vector_revision,
        graph_revision=excluded.graph_revision,
        context_pack_revision=excluded.context_pack_revision,
        status=excluded.status,warnings=excluded.warnings,updated_at=now()
      `,
      [
        spaceId,
        vaultId,
        projectionRevision,
        preservedVectorRevision,
        initialWarningJson,
      ],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  let vectorReady = false;
  let semanticWarning = embeddingConfigurationWarning;
  let failureReason: string | null = null;
  if (embeddingAdapter && generationPlan.generationId) {
    if (generationPlan.needsBuild) {
      try {
        await buildImportedEmbeddingGeneration(
          db,
          embeddingAdapter,
          generationPlan.generationId,
          {
            spaceId,
            vaultId,
            corpusRevision: projectionRevision,
          },
        );
      } catch (error) {
        semanticWarning = "VECTOR_BUILD_FAILED";
        failureReason = safeEmbeddingFailureReason(error);
      }
    }
    if (!semanticWarning && vectorEnabled) {
      try {
        let current = true;
        if (generationPlan.needsBuild || generationPlan.activate) {
          current = await activateImportedGenerationIfCurrent(
            db,
            generationPlan.generationId,
            {
              spaceId,
              vaultId,
              corpusRevision: projectionRevision,
            },
          );
        }
        if (current) {
          const active = await db.pool.query<{ status: string }>(
            `select status
               from embedding_generations
              where id=$1 and space_id=$2 and vault_id=$3
                and corpus_revision=$4`,
            [generationPlan.generationId, spaceId, vaultId, projectionRevision],
          );
          if (active.rows[0]?.status !== "ACTIVE") {
            throw new Error("EMBEDDING_GENERATION_NOT_ACTIVE");
          }
          vectorReady = true;
        }
      } catch (error) {
        semanticWarning = "VECTOR_BUILD_FAILED";
        failureReason = safeEmbeddingFailureReason(error);
      }
    } else if (!vectorEnabled && !semanticWarning) {
      semanticWarning = "VECTOR_DISABLED_PENDING_BENCHMARK";
    }
  } else if (!semanticWarning) {
    semanticWarning = vectorEnabled
      ? "VECTOR_PROVIDER_NOT_CONFIGURED"
      : "VECTOR_DISABLED_PENDING_BENCHMARK";
  }

  const status = await finalizeImportedProjection(db, {
    runId,
    spaceId,
    vaultId,
    projectionRevision,
    preservedVectorRevision,
    generationId: generationPlan.generationId,
    vectorReady,
    warning: semanticWarning,
    failureReason,
    inspection,
  });
  return {
    ...inspection,
    runId,
    vaultId,
    status,
    ...(options.reportPath ? { reportPath: options.reportPath } : {}),
  };
}

export async function latestImportStatus(
  db: Postgres,
  vaultPath?: string,
): Promise<Record<string, unknown> | null> {
  const result = await db.pool.query(
    `
    select r.id, r.status, r.revision, r.read_only, r.metrics, r.started_at,
           r.completed_at, r.report_path, v.canonical_path, v.name
      from vault_import_runs r
      join vaults v on v.id = r.vault_id
     where ($1::text is null or v.canonical_path = $1)
     order by r.started_at desc
     limit 1
    `,
    [vaultPath ? await realpath(path.resolve(vaultPath)) : null],
  );
  return result.rows[0] ?? null;
}

export function renderImportReport(result: ImportResult): string {
  const warnings = result.issues.filter(
    (issue) => issue.severity === "warning",
  );
  const errors = result.issues.filter((issue) => issue.severity === "error");
  const issueLines = result.issues
    .slice(0, 200)
    .map(
      (issue) =>
        `- **${issue.severity.toUpperCase()} ${issue.code}**${issue.path ? ` \`${issue.path}\`` : ""}: ${issue.message}`,
    );
  return `# Vault read-only import report

- Run: \`${result.runId}\`
- Vault: \`${result.canonicalPath}\`
- Revision: \`${result.revision}\`
- Mode: **read-only**
- Status: **${result.status}**
- Markdown files: ${result.metrics.markdownFiles}
- Operational documents: ${result.metrics.operationalDocuments}
- Raw documents: ${result.metrics.rawDocuments}
- Archived provenance documents: ${result.metrics.archivalDocuments}
- Curated recovery documents: ${result.metrics.curatedRecoveryDocuments}
- Acquisition backlogs quarantined: ${result.metrics.acquisitionBacklogsQuarantined}
- Stable operational IDs: ${result.metrics.stableIds}
- Wikilinks: ${result.metrics.links}
- Resolved links: ${result.metrics.resolvedLinks}
- Unresolved links: ${result.metrics.unresolvedLinks}
- Operational graph components: ${result.metrics.operationalComponents}
- Source notes: ${result.metrics.sourceNotes}
- Evidence notes: ${result.metrics.evidenceNotes}
- Claims with evidence metadata/link: ${result.metrics.claimsWithEvidence}
- Errors: ${errors.length}
- Warnings: ${warnings.length}

## Integrity statement

The importer opened Markdown files for reading and wrote only to the platform database and this external report. It did not write into the vault.

## Issues

${issueLines.length ? issueLines.join("\n") : "No issues detected."}
${result.issues.length > 200 ? `\n\n${result.issues.length - 200} additional issues are retained in the database.` : ""}
`;
}
