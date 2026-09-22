import { createHash } from "node:crypto";
import {
  createModelRoleRouteCandidates,
  modelRoleProviderFailureCode,
  routeModelRoleCandidates,
  type ModelRoleDescriptor,
  type ModelRoleRouteCandidate,
  type ModelTextGenerationResult,
} from "@akp/compiler";
import {
  ModelResidency,
  mostRestrictiveModelResidency,
  type ModelResidency as ModelResidencyValue,
} from "@akp/contracts";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
} from "@akp/contracts/knowledge-profile";
import { OpenTelemetryBridge } from "@akp/observability";
import {
  getActiveKnowledgeProfileRevision,
  type Postgres,
} from "@akp/postgres";
import {
  DEFAULT_COMMUNITY_RANDOM_SEED,
  DEFAULT_COMMUNITY_RESOLUTION,
  detectLeidenCommunities,
  type CommunityGraphEdge,
  type CommunityGraphNode,
  type CommunityPartition,
} from "@akp/retrieval";

const DERIVED_INDEX_LIFECYCLE = "DERIVED_INDEX";
const DETERMINISTIC_SUMMARY_VERSION = "akp-derived-community-summary-v1";
const COMMUNITY_SUMMARY_ROLE = "COMMUNITY_SUMMARY";
const MAX_MODEL_SUMMARY_MEMBERS = 12;
const MAX_MODEL_MEMBER_EXCERPT = 600;
const MAX_COMMUNITY_SUMMARY_CHARS = 4_000;
const communitySummaryTelemetry = new OpenTelemetryBridge();

interface CommunityDocumentRow {
  id: string;
  title: string;
  external_id: string;
  path: string;
  type: string;
  body_cache: string;
}

interface CommunityRelationRow {
  id: string;
  from_document_id: string;
  to_document_id: string;
  relation_type: string;
  weight: number | string | null;
  provenance: string;
}

interface CommunitySummaryBoundary {
  effectiveResidency: ModelResidencyValue;
  spaceResidency: ModelResidencyValue;
  sourceResidencies: ModelResidencyValue[];
  profileResidency: ModelResidencyValue;
  structuredOutputRequired: boolean;
}

interface CommunitySummaryMetadata {
  mode: "DETERMINISTIC" | "MODEL";
  configurationHash: string;
  requiredResidency: ModelResidencyValue;
  structuredOutputRequired: boolean;
  descriptor?: ModelRoleDescriptor;
}

interface CommunitySummaryBuild {
  metadata: CommunitySummaryMetadata;
  summaries: Map<string, string>;
  degraded: boolean;
}

class CommunitySummaryBuildError extends Error {
  readonly code: string;
  readonly metadata: CommunitySummaryMetadata;

  constructor(
    code: string,
    metadata: CommunitySummaryMetadata,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "CommunitySummaryBuildError";
    this.code = code;
    this.metadata = metadata;
  }
}

export interface RebuildCommunityIndexOptions {
  spaceId: string;
  vaultId: string;
  graphRevision: string;
  scopeId?: string;
  resolution?: number;
  randomSeed?: number;
  /**
   * Optional injection seam for tests/specialized runtimes. Undefined reads
   * configured COMMUNITY_SUMMARY role policies; [] explicitly selects the
   * deterministic summary baseline.
   */
  summaryCandidates?: ModelRoleRouteCandidate[];
}

export interface RebuildCommunityIndexResult {
  revisionId: string;
  communityRevision: string;
  graphRevision: string;
  communities: number;
  memberships: number;
  quality: number;
  reused: boolean;
  summaryMode: "DETERMINISTIC" | "MODEL";
  summaryProvider?: ModelRoleDescriptor;
  degraded: boolean;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summaryConfigurationHash(input: {
  mode: "DETERMINISTIC" | "MODEL";
  boundary: CommunitySummaryBoundary;
  descriptor?: ModelRoleDescriptor;
  configuredCandidates?: readonly ModelRoleDescriptor[];
}): string {
  return stableHash({
    mode: input.mode,
    version:
      input.mode === "DETERMINISTIC"
        ? DETERMINISTIC_SUMMARY_VERSION
        : "model-role-runtime-v1",
    requiredResidency: input.boundary.effectiveResidency,
    structuredOutputRequired: input.boundary.structuredOutputRequired,
    descriptor: input.descriptor
      ? {
          role: input.descriptor.role,
          provider: input.descriptor.provider,
          model: input.descriptor.model,
          endpointRef: input.descriptor.endpointRef,
          policyDataResidency: input.descriptor.policyDataResidency,
          dataResidency: input.descriptor.dataResidency,
          configurationHash: input.descriptor.configurationHash,
        }
      : null,
    configuredCandidates:
      input.configuredCandidates?.map((candidate) => ({
        role: candidate.role,
        provider: candidate.provider,
        model: candidate.model,
        endpointRef: candidate.endpointRef,
        policyDataResidency: candidate.policyDataResidency,
        dataResidency: candidate.dataResidency,
        configurationHash: candidate.configurationHash,
      })) ?? [],
  });
}

function communityRevisionFor(input: {
  graphRevision: string;
  scopeId: string;
  resolution: number;
  randomSeed: number;
  summaryConfigurationHash: string;
  nodes: readonly CommunityGraphNode[];
  edges: readonly CommunityGraphEdge[];
}): string {
  const canonical = {
    graphRevision: input.graphRevision,
    scopeId: input.scopeId,
    algorithm: "LEIDEN",
    algorithmVersion: "ngraph.leiden@0.3.0",
    objective: "CPM",
    resolution: input.resolution,
    randomSeed: input.randomSeed,
    summaryConfigurationHash: input.summaryConfigurationHash,
    nodes: [...input.nodes].map((node) => node.id).sort(),
    edges: [...input.edges]
      .map((edge) => ({
        key: edge.id,
        from: edge.from,
        to: edge.to,
        weight: edge.weight ?? 1,
      }))
      .sort((left, right) =>
        [left.from, left.to, left.key, String(left.weight)]
          .join("\0")
          .localeCompare(
            [right.from, right.to, right.key, String(right.weight)].join("\0"),
          ),
      ),
  };
  return `community:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

function derivedSummary(
  titles: readonly string[],
  totalMembers: number,
): string {
  const sample = titles
    .map((title) => title.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (sample.length === 0) {
    return `Derived community containing ${totalMembers} knowledge item(s).`;
  }
  const suffix = totalMembers > sample.length ? "; …" : "";
  return `Derived community containing ${totalMembers} knowledge item(s): ${sample.join("; ")}${suffix}`;
}

function numericWeight(value: number | string | null): number {
  const parsed = Number(value ?? 1);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

function safeFailureCode(error: unknown): string {
  if (error instanceof CommunitySummaryBuildError) return error.code;
  const provider = modelRoleProviderFailureCode(error);
  if (provider) return provider;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,120}$/.test(error.message)) {
    return error.message;
  }
  return "COMMUNITY_BUILD_FAILED";
}

function summaryHierarchy(
  partition: CommunityPartition,
  metadata: CommunitySummaryMetadata,
): Record<string, unknown> {
  return {
    ...partition.hierarchy,
    summaryGeneration: {
      mode: metadata.mode,
      role: COMMUNITY_SUMMARY_ROLE,
      requiredResidency: metadata.requiredResidency,
      structuredOutputRequired: metadata.structuredOutputRequired,
      configurationHash: metadata.configurationHash,
      ...(metadata.descriptor
        ? {
            provider: metadata.descriptor.provider,
            model: metadata.descriptor.model,
            endpointRef: metadata.descriptor.endpointRef,
            dataResidency: metadata.descriptor.dataResidency,
          }
        : { version: DETERMINISTIC_SUMMARY_VERSION }),
    },
  };
}

async function loadCommunitySummaryBoundary(
  db: Postgres,
  options: RebuildCommunityIndexOptions,
  documentIds: readonly string[],
): Promise<CommunitySummaryBoundary> {
  const space = await db.pool.query<{ model_residency: string }>(
    "select model_residency from spaces where id=$1",
    [options.spaceId],
  );
  const spaceRow = space.rows[0];
  if (!spaceRow) throw new Error("COMMUNITY_SPACE_NOT_FOUND");
  const spaceResidency = ModelResidency.parse(spaceRow.model_residency);

  const sourceResult =
    documentIds.length === 0
      ? { rows: [] as Array<{ model_residency: string }> }
      : await db.pool.query<{ model_residency: string }>(
          `
          select distinct s.model_residency
            from document_evidence de
            join evidence e on e.id=de.evidence_id
            join sources s on s.id=e.source_id
           where de.document_id=any($1::uuid[])
             and e.space_id=$2 and e.vault_id=$3
             and s.space_id=$2 and s.vault_id=$3
          `,
          [documentIds, options.spaceId, options.vaultId],
        );
  const sourceResidencies = sourceResult.rows.map((row) =>
    ModelResidency.parse(row.model_residency),
  );

  const activeProfile = await getActiveKnowledgeProfileRevision(
    db,
    options.spaceId,
    options.vaultId,
  );
  const profile = activeProfile
    ? KnowledgeProfileV1.parse(activeProfile.profile)
    : DEFAULT_KNOWLEDGE_PROFILE_V1;
  const profileConstraint = profile.modelRoleConstraints.find(
    (constraint) => constraint.role === COMMUNITY_SUMMARY_ROLE,
  );
  const profileResidency = profileConstraint?.residency ?? "EXTERNAL_ALLOWED";

  return {
    spaceResidency,
    sourceResidencies,
    profileResidency,
    structuredOutputRequired:
      profileConstraint?.structuredOutputRequired ?? false,
    effectiveResidency: mostRestrictiveModelResidency(
      spaceResidency,
      ...sourceResidencies,
      profileResidency,
    ),
  };
}

function communityModelInput(
  communityKey: string,
  memberDocuments: readonly CommunityDocumentRow[],
  totalMembers: number,
  structuredOutputRequired: boolean,
): { system: string; user: string; responseFormat: "text" | "json_object" } {
  const members = memberDocuments
    .slice(0, MAX_MODEL_SUMMARY_MEMBERS)
    .map((document) => ({
      title: document.title.trim().slice(0, 500),
      type: document.type.trim().slice(0, 120),
      excerpt: document.body_cache
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_MODEL_MEMBER_EXCERPT),
    }));
  const system = [
    "You create concise AKP community orientation summaries.",
    "The summary is a DERIVED_INDEX navigation aid, never evidence or citation authority.",
    "Use only the supplied member metadata/excerpts; do not invent facts, consensus, approvals, or causal claims.",
    "Describe the common theme and notable distinctions in at most 3 short sentences.",
    structuredOutputRequired
      ? 'Return one JSON object only: {"summary":"..."}'
      : "Return plain summary text only.",
  ].join(" ");
  return {
    system,
    user: JSON.stringify({
      communityKey,
      totalMembers,
      sampledMembers: members.length,
      members,
    }),
    responseFormat: structuredOutputRequired ? "json_object" : "text",
  };
}

function summaryTextFromGeneration(
  result: ModelTextGenerationResult,
  structuredOutputRequired: boolean,
): string {
  let summary = result.text.trim();
  if (structuredOutputRequired) {
    try {
      const parsed = JSON.parse(summary) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).summary !== "string"
      ) {
        throw new Error("COMMUNITY_SUMMARY_RESPONSE_INVALID");
      }
      summary = String((parsed as Record<string, unknown>).summary).trim();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "COMMUNITY_SUMMARY_RESPONSE_INVALID"
      ) {
        throw error;
      }
      throw new Error("COMMUNITY_SUMMARY_RESPONSE_INVALID");
    }
  }
  if (!summary || summary.length > MAX_COMMUNITY_SUMMARY_CHARS) {
    throw new Error("COMMUNITY_SUMMARY_RESPONSE_INVALID");
  }
  return summary;
}

function recordModelUsage(
  descriptor: ModelRoleDescriptor,
  result: ModelTextGenerationResult,
  fallbackUsed: boolean,
): void {
  const attributes = {
    role: COMMUNITY_SUMMARY_ROLE,
    provider: descriptor.provider,
    model: descriptor.model,
    status: "success",
    fallback_used: String(fallbackUsed),
  };
  if (result.usage?.inputTokens !== undefined) {
    communitySummaryTelemetry.counter(
      "model_provider_input_tokens_total",
      result.usage.inputTokens,
      attributes,
    );
  }
  if (result.usage?.outputTokens !== undefined) {
    communitySummaryTelemetry.counter(
      "model_provider_output_tokens_total",
      result.usage.outputTokens,
      attributes,
    );
  }
  if (result.usage?.totalTokens !== undefined) {
    communitySummaryTelemetry.counter(
      "model_provider_tokens_total",
      result.usage.totalTokens,
      attributes,
    );
  }
}

async function buildCommunitySummaries(
  partition: CommunityPartition,
  documentById: ReadonlyMap<string, CommunityDocumentRow>,
  boundary: CommunitySummaryBoundary,
  candidates: readonly ModelRoleRouteCandidate[],
): Promise<CommunitySummaryBuild> {
  if (candidates.length === 0) {
    const metadata: CommunitySummaryMetadata = {
      mode: "DETERMINISTIC",
      requiredResidency: boundary.effectiveResidency,
      structuredOutputRequired: false,
      configurationHash: summaryConfigurationHash({
        mode: "DETERMINISTIC",
        boundary: { ...boundary, structuredOutputRequired: false },
      }),
    };
    return {
      metadata,
      degraded: false,
      summaries: new Map(
        partition.communities.map((community) => {
          const memberDocuments = community.memberNodeIds
            .map((id) => documentById.get(id))
            .filter((document): document is CommunityDocumentRow =>
              Boolean(document),
            );
          return [
            community.communityKey,
            derivedSummary(
              memberDocuments.map((document) => document.title),
              community.memberNodeIds.length,
            ),
          ];
        }),
      ),
    };
  }

  const decision = routeModelRoleCandidates(candidates, {
    dataResidency: boundary.effectiveResidency,
    structuredOutputRequired: boundary.structuredOutputRequired,
  });
  communitySummaryTelemetry.counter("model_route_decisions_total", 1, {
    role: COMMUNITY_SUMMARY_ROLE,
    residency: boundary.effectiveResidency,
    outcome: decision.selected ? "selected" : "no_candidate",
  });
  for (const rejection of decision.rejected) {
    communitySummaryTelemetry.counter("model_route_rejections_total", 1, {
      role: COMMUNITY_SUMMARY_ROLE,
      reason: rejection.reason,
    });
  }

  if (!decision.selected) {
    const metadata: CommunitySummaryMetadata = {
      mode: "MODEL",
      requiredResidency: boundary.effectiveResidency,
      structuredOutputRequired: boundary.structuredOutputRequired,
      configurationHash: summaryConfigurationHash({
        mode: "MODEL",
        boundary,
        configuredCandidates: candidates.map(
          (candidate) => candidate.descriptor,
        ),
      }),
    };
    throw new CommunitySummaryBuildError(
      "COMMUNITY_SUMMARY_ROUTE_UNAVAILABLE",
      metadata,
    );
  }

  let lastError: unknown;
  for (const [index, candidate] of decision.eligible.entries()) {
    const structuredOutputRequired =
      boundary.structuredOutputRequired ||
      candidate.policy.structuredOutputRequired === true;
    const metadata: CommunitySummaryMetadata = {
      mode: "MODEL",
      descriptor: candidate.descriptor,
      requiredResidency: boundary.effectiveResidency,
      structuredOutputRequired,
      configurationHash: summaryConfigurationHash({
        mode: "MODEL",
        boundary: { ...boundary, structuredOutputRequired },
        descriptor: candidate.descriptor,
      }),
    };
    let generator;
    try {
      generator = candidate.createTextGenerator();
    } catch (error) {
      lastError = error;
      const hasFallback = index + 1 < decision.eligible.length;
      if (candidate.policy.degradationSafe !== true || !hasFallback) {
        throw new CommunitySummaryBuildError(
          safeFailureCode(error),
          metadata,
          error,
        );
      }
      communitySummaryTelemetry.counter("model_failovers_total", 1, {
        role: COMMUNITY_SUMMARY_ROLE,
        residency: boundary.effectiveResidency,
      });
      continue;
    }

    const summaries = new Map<string, string>();
    let failed = false;
    for (const community of partition.communities) {
      const memberDocuments = community.memberNodeIds
        .map((id) => documentById.get(id))
        .filter((document): document is CommunityDocumentRow =>
          Boolean(document),
        );
      const startedAt = performance.now();
      try {
        const result = await generator.generate(
          communityModelInput(
            community.communityKey,
            memberDocuments,
            community.memberNodeIds.length,
            structuredOutputRequired,
          ),
        );
        summaries.set(
          community.communityKey,
          summaryTextFromGeneration(result, structuredOutputRequired),
        );
        const attributes = {
          role: COMMUNITY_SUMMARY_ROLE,
          provider: candidate.descriptor.provider,
          model: candidate.descriptor.model,
          status: "success",
          fallback_used: String(index > 0),
        };
        communitySummaryTelemetry.counter(
          "model_provider_attempts_total",
          1,
          attributes,
        );
        communitySummaryTelemetry.histogram(
          "model_provider_attempt_latency_ms",
          Math.max(0, performance.now() - startedAt),
          attributes,
        );
        recordModelUsage(candidate.descriptor, result, index > 0);
      } catch (error) {
        failed = true;
        lastError = error;
        const attributes = {
          role: COMMUNITY_SUMMARY_ROLE,
          provider: candidate.descriptor.provider,
          model: candidate.descriptor.model,
          status: "failure",
          fallback_used: String(index > 0),
        };
        communitySummaryTelemetry.counter(
          "model_provider_attempts_total",
          1,
          attributes,
        );
        communitySummaryTelemetry.histogram(
          "model_provider_attempt_latency_ms",
          Math.max(0, performance.now() - startedAt),
          attributes,
        );
        break;
      }
    }

    if (!failed) {
      return { metadata, summaries, degraded: index > 0 };
    }
    const hasFallback = index + 1 < decision.eligible.length;
    if (candidate.policy.degradationSafe !== true || !hasFallback) {
      throw new CommunitySummaryBuildError(
        safeFailureCode(lastError),
        metadata,
        lastError,
      );
    }
    communitySummaryTelemetry.counter("model_failovers_total", 1, {
      role: COMMUNITY_SUMMARY_ROLE,
      residency: boundary.effectiveResidency,
    });
  }

  const selected = decision.selected;
  const metadata: CommunitySummaryMetadata = {
    mode: "MODEL",
    descriptor: selected.descriptor,
    requiredResidency: boundary.effectiveResidency,
    structuredOutputRequired:
      boundary.structuredOutputRequired ||
      selected.policy.structuredOutputRequired === true,
    configurationHash: summaryConfigurationHash({
      mode: "MODEL",
      boundary,
      descriptor: selected.descriptor,
    }),
  };
  throw new CommunitySummaryBuildError(
    safeFailureCode(lastError),
    metadata,
    lastError,
  );
}

async function activeRevision(
  db: Postgres,
  options: RebuildCommunityIndexOptions,
  scopeId: string,
  communityRevision: string,
): Promise<{ id: string; status: string; stale: boolean } | null> {
  const existing = await db.pool.query<{
    id: string;
    status: string;
    stale: boolean;
  }>(
    `
    select id,status,stale
      from community_index_revisions
     where space_id=$1 and vault_id=$2 and scope_id=$3
       and community_revision=$4
    `,
    [options.spaceId, options.vaultId, scopeId, communityRevision],
  );
  return existing.rows[0] ?? null;
}

async function recordCommunityBuildFailure(
  db: Postgres,
  options: RebuildCommunityIndexOptions,
  scopeId: string,
  communityRevision: string,
  partition: CommunityPartition,
  metadata: CommunitySummaryMetadata,
  error: unknown,
): Promise<void> {
  await db.pool.query(
    `
    insert into community_index_revisions(
      space_id,vault_id,scope_id,community_revision,graph_revision,
      algorithm,algorithm_version,objective,resolution,random_seed,quality,
      hierarchy,lifecycle,status,stale,activated_at,error
    ) values(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
      'DERIVED_INDEX','FAILED',true,null,$13::jsonb
    )
    on conflict(space_id,vault_id,scope_id,community_revision) do update set
      graph_revision=excluded.graph_revision,
      algorithm=excluded.algorithm,
      algorithm_version=excluded.algorithm_version,
      objective=excluded.objective,
      resolution=excluded.resolution,
      random_seed=excluded.random_seed,
      quality=excluded.quality,
      hierarchy=excluded.hierarchy,
      lifecycle='DERIVED_INDEX',
      status='FAILED',
      stale=true,
      activated_at=null,
      error=excluded.error,
      updated_at=now()
    where community_index_revisions.status<>'ACTIVE'
       or community_index_revisions.stale=true
    `,
    [
      options.spaceId,
      options.vaultId,
      scopeId,
      communityRevision,
      options.graphRevision,
      partition.algorithm,
      partition.algorithmVersion,
      partition.objective,
      partition.resolution,
      partition.randomSeed,
      partition.quality,
      JSON.stringify(summaryHierarchy(partition, metadata)),
      JSON.stringify({ code: safeFailureCode(error) }),
    ],
  );
}

/**
 * Rebuild the vault-scoped community index from the current typed document
 * relation graph. Summaries are navigation aids only and remain DERIVED_INDEX
 * and non-citable. A configured COMMUNITY_SUMMARY model is optional; without
 * one AKP uses a deterministic local summary so the product works without API
 * keys or a model service.
 */
export async function rebuildCommunityIndex(
  db: Postgres,
  options: RebuildCommunityIndexOptions,
): Promise<RebuildCommunityIndexResult> {
  const scopeId = options.scopeId?.trim() || `vault:${options.vaultId}`;
  const resolution = options.resolution ?? DEFAULT_COMMUNITY_RESOLUTION;
  const randomSeed = options.randomSeed ?? DEFAULT_COMMUNITY_RANDOM_SEED;

  const documents = await db.pool.query<CommunityDocumentRow>(
    `
    select id,title,external_id,path,type,body_cache
      from knowledge_documents
     where space_id=$1 and vault_id=$2
       and lifecycle not in (
         'ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID'
       )
     order by id
    `,
    [options.spaceId, options.vaultId],
  );
  const documentIds = new Set(documents.rows.map((document) => document.id));

  const relations = await db.pool.query<CommunityRelationRow>(
    `
    select r.id,r.from_document_id,r.to_document_id,r.relation_type,r.weight,
           r.provenance
      from knowledge_relations r
      join knowledge_documents source on source.id=r.from_document_id
      join knowledge_documents target on target.id=r.to_document_id
     where r.space_id=$1
       and source.vault_id=$2 and target.vault_id=$2
       and source.lifecycle not in (
         'ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID'
       )
       and target.lifecycle not in (
         'ARCHIVED','DELETED_TOMBSTONE','SUPERSEDED','INVALID'
       )
     order by r.from_document_id,r.to_document_id,r.relation_type,r.id
    `,
    [options.spaceId, options.vaultId],
  );

  const nodes: CommunityGraphNode[] = documents.rows.map((document) => ({
    id: document.id,
  }));
  const edges: CommunityGraphEdge[] = relations.rows
    .filter(
      (relation) =>
        documentIds.has(relation.from_document_id) &&
        documentIds.has(relation.to_document_id),
    )
    .map((relation) => ({
      id: [
        relation.from_document_id,
        relation.relation_type,
        relation.to_document_id,
        relation.provenance,
      ].join(":"),
      from: relation.from_document_id,
      to: relation.to_document_id,
      weight: numericWeight(relation.weight),
    }));

  const partition = detectLeidenCommunities(nodes, edges, {
    resolution,
    randomSeed,
  });
  const documentById = new Map(
    documents.rows.map((document) => [document.id, document] as const),
  );
  const summaryCandidates =
    options.summaryCandidates ??
    createModelRoleRouteCandidates(COMMUNITY_SUMMARY_ROLE, process.env);
  const boundary: CommunitySummaryBoundary =
    summaryCandidates.length === 0
      ? {
          effectiveResidency: "EXTERNAL_ALLOWED",
          spaceResidency: "EXTERNAL_ALLOWED",
          sourceResidencies: [],
          profileResidency: "EXTERNAL_ALLOWED",
          structuredOutputRequired: false,
        }
      : await loadCommunitySummaryBoundary(db, options, [...documentIds]);

  let summaryBuild: CommunitySummaryBuild;
  try {
    summaryBuild = await buildCommunitySummaries(
      partition,
      documentById,
      boundary,
      summaryCandidates,
    );
  } catch (error) {
    const metadata =
      error instanceof CommunitySummaryBuildError
        ? error.metadata
        : {
            mode: "DETERMINISTIC" as const,
            requiredResidency: boundary.effectiveResidency,
            structuredOutputRequired: false,
            configurationHash: summaryConfigurationHash({
              mode: "DETERMINISTIC",
              boundary: { ...boundary, structuredOutputRequired: false },
            }),
          };
    const failedRevision = communityRevisionFor({
      graphRevision: options.graphRevision,
      scopeId,
      resolution,
      randomSeed,
      summaryConfigurationHash: metadata.configurationHash,
      nodes,
      edges,
    });
    await recordCommunityBuildFailure(
      db,
      options,
      scopeId,
      failedRevision,
      partition,
      metadata,
      error,
    );
    throw error;
  }

  const communityRevision = communityRevisionFor({
    graphRevision: options.graphRevision,
    scopeId,
    resolution,
    randomSeed,
    summaryConfigurationHash: summaryBuild.metadata.configurationHash,
    nodes,
    edges,
  });
  const current = await activeRevision(db, options, scopeId, communityRevision);
  if (current?.status === "ACTIVE" && current.stale === false) {
    return {
      revisionId: current.id,
      communityRevision,
      graphRevision: options.graphRevision,
      communities: partition.communities.length,
      memberships: partition.memberships.length,
      quality: partition.quality,
      reused: true,
      summaryMode: summaryBuild.metadata.mode,
      ...(summaryBuild.metadata.descriptor
        ? { summaryProvider: summaryBuild.metadata.descriptor }
        : {}),
      degraded: summaryBuild.degraded,
    };
  }

  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `
      insert into community_index_revisions(
        space_id,vault_id,scope_id,community_revision,graph_revision,
        algorithm,algorithm_version,objective,resolution,random_seed,quality,
        hierarchy,lifecycle,status,stale,activated_at,error
      ) values(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,
        'DERIVED_INDEX','BUILT',true,null,null
      )
      on conflict(space_id,vault_id,scope_id,community_revision) do update set
        graph_revision=excluded.graph_revision,
        algorithm=excluded.algorithm,
        algorithm_version=excluded.algorithm_version,
        objective=excluded.objective,
        resolution=excluded.resolution,
        random_seed=excluded.random_seed,
        quality=excluded.quality,
        hierarchy=excluded.hierarchy,
        lifecycle='DERIVED_INDEX',
        status='BUILT',
        stale=true,
        activated_at=null,
        error=null,
        updated_at=now()
      returning id
      `,
      [
        options.spaceId,
        options.vaultId,
        scopeId,
        communityRevision,
        options.graphRevision,
        partition.algorithm,
        partition.algorithmVersion,
        partition.objective,
        partition.resolution,
        partition.randomSeed,
        partition.quality,
        JSON.stringify(summaryHierarchy(partition, summaryBuild.metadata)),
      ],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("COMMUNITY_REVISION_WRITE_FAILED");

    await client.query(
      "delete from community_index_memberships where revision_id=$1",
      [revisionId],
    );
    await client.query(
      "delete from community_index_communities where revision_id=$1",
      [revisionId],
    );

    for (const community of partition.communities) {
      const summary = summaryBuild.summaries.get(community.communityKey);
      if (!summary) throw new Error("COMMUNITY_SUMMARY_MISSING");
      const supportSet = {
        documentIds: community.memberNodeIds,
        relationKeys: community.supportEdgeIds,
      };
      await client.query(
        `
        insert into community_index_communities(
          revision_id,community_key,ordinal,member_count,summary,
          summary_lifecycle,citable,support_set,hierarchy
        ) values($1,$2,$3,$4,$5,'DERIVED_INDEX',false,$6::jsonb,$7::jsonb)
        `,
        [
          revisionId,
          community.communityKey,
          community.ordinal,
          community.memberNodeIds.length,
          summary,
          JSON.stringify(supportSet),
          JSON.stringify(community.hierarchy),
        ],
      );
    }

    for (const membership of partition.memberships) {
      const community = partition.communities.find(
        (candidate) => candidate.communityKey === membership.communityKey,
      );
      await client.query(
        `
        insert into community_index_memberships(
          revision_id,document_id,community_key,hierarchy
        ) values($1,$2,$3,$4::jsonb)
        `,
        [
          revisionId,
          membership.nodeId,
          membership.communityKey,
          JSON.stringify({
            ...(community?.hierarchy ?? {}),
            rawCommunity: membership.rawCommunity,
          }),
        ],
      );
    }

    await client.query(
      `
      update community_index_revisions
         set status='STALE',stale=true,updated_at=now()
       where space_id=$1 and vault_id=$2 and scope_id=$3
         and id<>$4 and status='ACTIVE' and stale=false
      `,
      [options.spaceId, options.vaultId, scopeId, revisionId],
    );
    await client.query(
      `
      update community_index_revisions
         set status='ACTIVE',stale=false,activated_at=now(),error=null,
             updated_at=now()
       where id=$1
      `,
      [revisionId],
    );

    await client.query("commit");
    return {
      revisionId,
      communityRevision,
      graphRevision: options.graphRevision,
      communities: partition.communities.length,
      memberships: partition.memberships.length,
      quality: partition.quality,
      reused: false,
      summaryMode: summaryBuild.metadata.mode,
      ...(summaryBuild.metadata.descriptor
        ? { summaryProvider: summaryBuild.metadata.descriptor }
        : {}),
      degraded: summaryBuild.degraded,
    };
  } catch (error) {
    await client.query("rollback");
    await recordCommunityBuildFailure(
      db,
      options,
      scopeId,
      communityRevision,
      partition,
      summaryBuild.metadata,
      error,
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const communitySummaryLifecycle = DERIVED_INDEX_LIFECYCLE;
