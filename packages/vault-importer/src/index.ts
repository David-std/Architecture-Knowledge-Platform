import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fg from "fast-glob";
import matter from "gray-matter";
import type { Postgres } from "@akp/postgres";
import {
  DeterministicEmbeddingAdapter,
  parseKnowledgeUnits,
  toPgVector,
} from "@akp/retrieval";

export const DEFAULT_SPACE_ID = "00000000-0000-0000-0000-000000000003";

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

const RAW_PREFIXES = ["Resources/transfer-packs/", "00-system/governance/"];
const SOURCE_COLLECTION_PREFIX = "Resources/source-collection/";
const TRANSFER_PACK_PREFIX = "Resources/transfer-packs/";
const CURATED_RECOVERY_TYPES = new Set([
  "source-collection-guide",
  "source-collection-index",
  "source-recovery-map",
]);
const ROOT_ROUTER_DOCUMENTS = new Set([
  "README.md",
  "AGENTS.md",
  "PROJECT_STATE.md",
  "RESEARCH_LOG.md",
  "TRACEABILITY.md",
  "VALIDATION_REPORT.md",
  "CHANGELOG.md",
]);

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
): boolean {
  if (!relativePath.startsWith(SOURCE_COLLECTION_PREFIX)) return false;
  const status = String(frontmatter.status ?? "").toLowerCase();
  const type = String(frontmatter.type ?? "").toLowerCase();
  const id = String(frontmatter.id ?? "").trim();
  return (
    status === "curated" && id.length > 0 && CURATED_RECOVERY_TYPES.has(type)
  );
}

function isOperational(
  relativePath: string,
  frontmatter: Record<string, unknown>,
): boolean {
  if (relativePath.startsWith(SOURCE_COLLECTION_PREFIX)) {
    return isCuratedRecoveryDocument(relativePath, frontmatter);
  }
  return !RAW_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function deriveLayer(
  relativePath: string,
  frontmatter: Record<string, unknown>,
): string {
  if (typeof frontmatter.layer === "string") return frontmatter.layer;
  if (isCuratedRecoveryDocument(relativePath, frontmatter)) return "source";
  const first = relativePath.split("/")[0] ?? "root";
  const mapping: Record<string, string> = {
    "00-system": "system",
    "10-sources": "source",
    "20-claims": "claim",
    "30-concepts": "concept",
    "40-architecture": "architecture",
    "50-domain-design": "domain-design",
    "60-requirements": "requirements",
    "70-documentation": "documentation",
    "80-workflows": "workflow",
    "85-implementation-profiles": "profile",
    "90-agent-layer": "agent",
    examples: "example",
    Projects: "project",
    Resources: "resource",
  };
  return mapping[first] ?? "root";
}

function isAcquisitionBacklog(
  raw: string,
  frontmatter: Record<string, unknown>,
): boolean {
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
): Promise<VaultInspection> {
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
    const transferArtifact = relativePath.startsWith(TRANSFER_PACK_PREFIX);
    const acquisitionBacklog = isAcquisitionBacklog(raw, frontmatter);
    const operational =
      isOperational(relativePath, frontmatter) && !acquisitionBacklog;
    const archival = transferArtifact || acquisitionBacklog;
    const requiresStableMetadata =
      operational && !ROOT_ROUTER_DOCUMENTS.has(relativePath);
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
      layer: deriveLayer(relativePath, frontmatter),
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
  const revision =
    gitRevision(canonicalPath) ?? `snapshot:${sha256(snapshotMaterial)}`;

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
          CURATED_RECOVERY_TYPES.has(document.type.toLowerCase()),
      ).length,
      acquisitionBacklogsQuarantined: issues.filter(
        (issue) => issue.code === "ACQUISITION_BACKLOG_QUARANTINED",
      ).length,
      stableIds: documents.filter(
        (document) =>
          document.operational &&
          !ROOT_ROUTER_DOCUMENTS.has(document.relativePath) &&
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

export async function importVaultReadOnly(
  db: Postgres,
  vaultPath: string,
  options: { spaceId?: string; reportPath?: string } = {},
): Promise<ImportResult> {
  const inspection = await inspectVault(vaultPath);
  const spaceId = options.spaceId ?? DEFAULT_SPACE_ID;
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const vaultResult = await client.query<{ id: string }>(
      `
      insert into vaults(space_id, canonical_path, name, read_only, current_revision)
      values ($1, $2, $3, true, $4)
      on conflict (space_id, canonical_path)
      do update set name = excluded.name, read_only = true, current_revision = excluded.current_revision
      returning id
      `,
      [spaceId, inspection.canonicalPath, inspection.name, inspection.revision],
    );
    const vaultId = vaultResult.rows[0]?.id;
    if (!vaultId) throw new Error("Could not create or resolve vault record.");

    const runResult = await client.query<{ id: string }>(
      `
      insert into vault_import_runs(vault_id, revision, source_path, read_only, status, report_path)
      values ($1, $2, $3, true, 'RUNNING', $4)
      returning id
      `,
      [
        vaultId,
        inspection.revision,
        inspection.canonicalPath,
        options.reportPath ?? null,
      ],
    );
    const runId = runResult.rows[0]?.id;
    if (!runId) throw new Error("Could not create import run.");
    const managed = await client.query<{ current_revision: string }>(
      `
      select current_revision from knowledge_documents
       where space_id=$1 and path like 'managed/%'
       order by updated_at desc limit 1
      `,
      [spaceId],
    );
    const projectionRevision = managed.rows[0]?.current_revision
      ? `composite:${inspection.revision}+managed:${managed.rows[0].current_revision}`
      : inspection.revision;

    await client.query(
      `
      delete from knowledge_relations r
       where r.space_id=$1
         and r.provenance='markdown'
         and exists (
           select 1 from knowledge_documents d
            where d.id=r.from_document_id and d.vault_id=$2
         )
      `,
      [spaceId, vaultId],
    );
    const embeddingAdapter = new DeterministicEmbeddingAdapter();
    const embeddingGeneration = await client.query<{ id: string }>(
      `
      insert into embedding_generations(
        space_id,provider,model,model_revision,dimensions,normalization,
        configuration_version,corpus_revision,status,activated_at
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $9='ACTIVE' then now() else null end)
      on conflict(
        space_id,provider,model,model_revision,configuration_version,corpus_revision
      ) do update set status=excluded.status,activated_at=excluded.activated_at
      returning id
      `,
      [
        spaceId,
        embeddingAdapter.descriptor.provider,
        embeddingAdapter.descriptor.model,
        embeddingAdapter.descriptor.modelRevision,
        embeddingAdapter.descriptor.dimensions,
        embeddingAdapter.descriptor.normalization,
        embeddingAdapter.descriptor.configurationVersion,
        projectionRevision,
        process.env.AKP_VECTOR_ENABLED === "true" ? "ACTIVE" : "READY",
      ],
    );
    const generationId = embeddingGeneration.rows[0]?.id;
    if (!generationId)
      throw new Error("Could not create embedding generation.");
    const importedIds: string[] = [];
    const databaseIdByExternalId = new Map<string, string>();
    for (const document of inspection.documents) {
      const row = await client.query<{ id: string }>(
        `
        insert into knowledge_documents(
          space_id, vault_id, path, external_id, title, type, lifecycle, trust_tier,
          current_revision, body_cache, frontmatter, aliases, layer, content_hash,
          token_estimate, raw_links, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,now())
        on conflict (space_id, path)
        do update set
          vault_id = excluded.vault_id,
          external_id = excluded.external_id,
          title = excluded.title,
          type = excluded.type,
          lifecycle = excluded.lifecycle,
          trust_tier = excluded.trust_tier,
          current_revision = excluded.current_revision,
          body_cache = excluded.body_cache,
          frontmatter = excluded.frontmatter,
          aliases = excluded.aliases,
          layer = excluded.layer,
          content_hash = excluded.content_hash,
          token_estimate = excluded.token_estimate,
          raw_links = excluded.raw_links,
          updated_at = now()
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
      if (!databaseId)
        throw new Error(
          `Document upsert returned no id for ${document.relativePath}`,
        );
      importedIds.push(databaseId);
      databaseIdByExternalId.set(document.externalId, databaseId);
      await client.query(
        `
        insert into knowledge_versions(document_id, git_commit, content_hash, body, frontmatter)
        values ($1,$2,$3,$4,$5::jsonb)
        on conflict (document_id, git_commit) do nothing
        `,
        [
          databaseId,
          inspection.revision,
          document.contentHash,
          document.body,
          JSON.stringify(document.frontmatter),
        ],
      );
      await client.query("delete from knowledge_units where document_id=$1", [
        databaseId,
      ]);
      const units = parseKnowledgeUnits(document.title, document.body);
      const embeddings = await embeddingAdapter.embed(
        units.map((unit) => unit.body),
      );
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        const embedding = embeddings[index];
        if (!unit || !embedding) continue;
        const insertedUnit = await client.query<{ id: string }>(
          `
          insert into knowledge_units(
            document_id,space_id,unit_key,unit_type,heading_path,body,content_hash,
            corpus_revision,lifecycle,trust_tier,source_ids,token_estimate
          )
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          returning id
          `,
          [
            databaseId,
            spaceId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            projectionRevision,
            document.lifecycle,
            document.trustTier,
            [],
            unit.tokenEstimate,
          ],
        );
        await client.query(
          `
          insert into unit_embeddings(unit_id,generation_id,content_hash,embedding)
          values($1,$2,$3,$4::vector)
          `,
          [
            insertedUnit.rows[0]?.id,
            generationId,
            unit.contentHash,
            toPgVector(embedding),
          ],
        );
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
       where vault_id=$1 and not (id=any($2::uuid[]))
      `,
      [vaultId, importedIds],
    );

    for (const relation of inspection.relations) {
      const from = databaseIdByExternalId.get(relation.from);
      const to = databaseIdByExternalId.get(relation.to);
      if (!from || !to) continue;
      await client.query(
        `
        insert into knowledge_relations(
          space_id, from_document_id, to_document_id, relation_type, provenance, metadata
        )
        values ($1,$2,$3,$4,'markdown',$5::jsonb)
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
        insert into vault_import_issues(run_id, severity, code, path, message)
        values ($1,$2,$3,$4,$5)
        `,
        [runId, issue.severity, issue.code, issue.path ?? null, issue.message],
      );
    }

    const status = inspection.issues.some(
      (issue) => issue.severity === "warning",
    )
      ? "COMPLETED_WITH_WARNINGS"
      : "COMPLETED";
    await client.query(
      `
      update vault_import_runs
         set status = $2, metrics = $3::jsonb, completed_at = now()
       where id = $1
      `,
      [runId, status, JSON.stringify(inspection.metrics)],
    );
    await client.query(
      `update vaults set last_imported_at = now(), current_revision = $2 where id = $1`,
      [vaultId, inspection.revision],
    );
    await client.query(
      `
      insert into index_revisions(
        space_id,corpus_revision,lexical_revision,vector_revision,graph_revision,
        context_pack_revision,status,warnings
      )
      values($1,$2,$2,$3,$2,$2,$4,$5::jsonb)
      on conflict(space_id) do update set
        corpus_revision=excluded.corpus_revision,
        lexical_revision=excluded.lexical_revision,
        vector_revision=excluded.vector_revision,
        graph_revision=excluded.graph_revision,
        context_pack_revision=excluded.context_pack_revision,
        status=excluded.status,
        warnings=excluded.warnings,
        updated_at=now()
      `,
      [
        spaceId,
        projectionRevision,
        process.env.AKP_VECTOR_ENABLED === "true" ? projectionRevision : null,
        process.env.AKP_VECTOR_ENABLED === "true" ? "CONSISTENT" : "DEGRADED",
        JSON.stringify(
          process.env.AKP_VECTOR_ENABLED === "true"
            ? []
            : ["VECTOR_DISABLED_PENDING_BENCHMARK"],
        ),
      ],
    );
    await client.query("commit");
    return {
      ...inspection,
      runId,
      vaultId,
      status,
      ...(options.reportPath ? { reportPath: options.reportPath } : {}),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
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
