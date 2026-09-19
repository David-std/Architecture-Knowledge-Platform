import { createHash } from "node:crypto";
import type { Postgres, PostgresPoolClient } from "./index.js";

export type ContextRevisionDimensionName =
  | "knowledgeGit"
  | "corpus"
  | "lexical"
  | "vector"
  | "graph"
  | "contextPack"
  | "retrievalConfiguration"
  | "code"
  | "runtime"
  | "temporal"
  | "community";

export type ContextRevisionDimension =
  | { status: "AVAILABLE"; revision: string }
  | { status: "UNAVAILABLE"; revision: null; reason: string };

export interface ContextProfileRevision {
  source: "DEFAULT" | "DURABLE_REVISION";
  revisionId: string | null;
  profileId: string;
  version: string;
  hash: string;
}

export interface ContextPolicyRevision {
  source: "KNOWLEDGE_PROFILE_POLICY";
  revision: string;
}

export interface ContextRevisionSet {
  schemaVersion: 1;
  spaceId: string;
  vaultId: string;
  dimensions: Record<ContextRevisionDimensionName, ContextRevisionDimension>;
  profile: ContextProfileRevision;
  policy: ContextPolicyRevision;
}

export interface PinnedContextRevisionSet {
  revisionSet: ContextRevisionSet;
  revisionSetHash: string;
  pinnedAt: Date;
}

export interface WorkspaceContextRevisionState {
  status: "CURRENT" | "CHANGED" | "LEGACY_UNPINNED";
  pinned: PinnedContextRevisionSet | null;
  current: {
    revisionSet: ContextRevisionSet;
    revisionSetHash: string;
  };
  changedDimensions: string[];
}

type RevisionQueryable = Pick<PostgresPoolClient, "query">;

type ContextRevisionRow = {
  current_revision: string | null;
  corpus_revision: string | null;
  lexical_revision: string | null;
  vector_revision: string | null;
  graph_revision: string | null;
  context_pack_revision: string | null;
  retrieval_configuration_version: string | null;
  active_profile_revision_id: string | null;
  profile_revision_id: string | null;
  profile_id: string | null;
  profile_version: string | null;
  profile_hash: string | null;
  canonical_profile: string | null;
  profile_status: string | null;
};

const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_VERSION = "0.3-compat";
const DEFAULT_PROFILE_HASH =
  "54ec44e0dafdb51e82898ac3c249ace10a8ecbdb22ea7b3301db6f81d0337ac1";
const DEFAULT_POLICY_REVISION =
  "3ab1d6ab2b3a7cee52cabb49a7087759052dee21adaa71a42843b6a4ef384fd1";

function contextError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
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

function available(
  revision: string | null | undefined,
): ContextRevisionDimension {
  const value = revision?.trim();
  return value
    ? { status: "AVAILABLE", revision: value }
    : {
        status: "UNAVAILABLE",
        revision: null,
        reason: "REVISION_NOT_AVAILABLE",
      };
}

function unsupported(): ContextRevisionDimension {
  return {
    status: "UNAVAILABLE",
    revision: null,
    reason: "REVISION_AUTHORITY_NOT_IMPLEMENTED",
  };
}

function parseProfile(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw contextError("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID", 409);
  }
  return parsed as Record<string, unknown>;
}

function contextPolicyRevisionFromProfile(
  profile: Record<string, unknown>,
): string {
  return sha256(
    stableJson({
      lifecycles: profile.lifecycles ?? {},
      evidencePolicies: profile.evidencePolicies ?? {},
      reviewPolicies: profile.reviewPolicies ?? {},
      retrievalPolicy: profile.retrievalPolicy ?? {},
      promotionPolicy: profile.promotionPolicy ?? {},
      freshnessPolicy: profile.freshnessPolicy ?? {},
      connectorPolicy: profile.connectorPolicy ?? null,
      modelRoleConstraints: profile.modelRoleConstraints ?? [],
    }),
  );
}

function profileIdentity(row: ContextRevisionRow): {
  identity: ContextProfileRevision;
  policyRevision: string;
} {
  if (!row.active_profile_revision_id) {
    return {
      identity: {
        source: "DEFAULT",
        revisionId: null,
        profileId: DEFAULT_PROFILE_ID,
        version: DEFAULT_PROFILE_VERSION,
        hash: DEFAULT_PROFILE_HASH,
      },
      policyRevision: DEFAULT_POLICY_REVISION,
    };
  }

  if (
    row.profile_revision_id !== row.active_profile_revision_id ||
    row.profile_status !== "ACTIVE" ||
    !row.profile_id ||
    !row.profile_version ||
    !row.profile_hash ||
    !row.canonical_profile
  ) {
    throw contextError("ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID", 409);
  }

  return {
    identity: {
      source: "DURABLE_REVISION",
      revisionId: row.profile_revision_id,
      profileId: row.profile_id,
      version: row.profile_version,
      hash: row.profile_hash,
    },
    policyRevision: contextPolicyRevisionFromProfile(
      parseProfile(row.canonical_profile),
    ),
  };
}

export function contextRevisionSetHash(
  revisionSet: ContextRevisionSet,
): string {
  return sha256(stableJson(revisionSet));
}

export async function resolveCurrentContextRevisionSet(
  queryable: RevisionQueryable,
  spaceId: string,
  vaultId: string,
): Promise<ContextRevisionSet> {
  const result = await queryable.query<ContextRevisionRow>(
    `
    select v.current_revision,
           i.corpus_revision,i.lexical_revision,i.vector_revision,
           i.graph_revision,i.context_pack_revision,
           i.retrieval_configuration_version,
           v.active_knowledge_profile_revision_id active_profile_revision_id,
           p.id profile_revision_id,p.profile_id,p.version profile_version,
           p.profile_hash,p.canonical_profile,p.status profile_status
      from vaults v
      left join vault_index_revisions i
        on i.space_id=v.space_id and i.vault_id=v.id
      left join knowledge_profile_revisions p
        on p.id=v.active_knowledge_profile_revision_id
       and p.space_id=v.space_id and p.vault_id=v.id
     where v.space_id=$1 and v.id=$2 and v.enabled
    `,
    [spaceId, vaultId],
  );
  const row = result.rows[0];
  if (!row) throw contextError("VAULT_CONTEXT_UNAVAILABLE", 409);
  const profile = profileIdentity(row);
  return {
    schemaVersion: 1,
    spaceId,
    vaultId,
    dimensions: {
      knowledgeGit: available(row.current_revision),
      corpus: available(row.corpus_revision),
      lexical: available(row.lexical_revision),
      vector: available(row.vector_revision),
      graph: available(row.graph_revision),
      contextPack: available(row.context_pack_revision),
      retrievalConfiguration: available(row.retrieval_configuration_version),
      code: unsupported(),
      runtime: unsupported(),
      temporal: unsupported(),
      community: unsupported(),
    },
    profile: profile.identity,
    policy: {
      source: "KNOWLEDGE_PROFILE_POLICY",
      revision: profile.policyRevision,
    },
  };
}

export async function pinWorkspaceContextRevisionSet(
  client: PostgresPoolClient,
  sessionId: string,
  spaceId: string,
  vaultId: string,
): Promise<PinnedContextRevisionSet> {
  const revisionSet = await resolveCurrentContextRevisionSet(
    client,
    spaceId,
    vaultId,
  );
  const revisionSetHash = contextRevisionSetHash(revisionSet);
  const inserted = await client.query<{ pinned_at: Date }>(
    `insert into workspace_context_revision_sets(
       session_id,space_id,vault_id,revision_set,revision_set_hash
     ) values($1,$2,$3,$4::jsonb,$5)
     returning pinned_at`,
    [sessionId, spaceId, vaultId, JSON.stringify(revisionSet), revisionSetHash],
  );
  const row = inserted.rows[0];
  if (!row) throw contextError("CONTEXT_REVISION_PIN_FAILED", 500);
  return { revisionSet, revisionSetHash, pinnedAt: row.pinned_at };
}

export async function loadPinnedWorkspaceContextRevisionSet(
  queryable: RevisionQueryable,
  sessionId: string,
): Promise<PinnedContextRevisionSet | null> {
  const result = await queryable.query<{
    revision_set: ContextRevisionSet;
    revision_set_hash: string;
    pinned_at: Date;
  }>(
    `select revision_set,revision_set_hash,pinned_at
       from workspace_context_revision_sets
      where session_id=$1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row
    ? {
        revisionSet: row.revision_set,
        revisionSetHash: row.revision_set_hash,
        pinnedAt: row.pinned_at,
      }
    : null;
}

function changedDimensions(
  pinned: ContextRevisionSet,
  current: ContextRevisionSet,
): string[] {
  const changed: string[] = [];
  const names = Object.keys(
    pinned.dimensions,
  ) as ContextRevisionDimensionName[];
  for (const name of names) {
    if (
      stableJson(pinned.dimensions[name]) !==
      stableJson(current.dimensions[name])
    ) {
      changed.push(name);
    }
  }
  if (stableJson(pinned.profile) !== stableJson(current.profile))
    changed.push("profile");
  if (stableJson(pinned.policy) !== stableJson(current.policy))
    changed.push("policy");
  return changed;
}

export async function workspaceContextRevisionState(
  queryable: RevisionQueryable,
  sessionId: string,
  spaceId: string,
  vaultId: string,
): Promise<WorkspaceContextRevisionState> {
  const pinned = await loadPinnedWorkspaceContextRevisionSet(
    queryable,
    sessionId,
  );
  const currentSet = await resolveCurrentContextRevisionSet(
    queryable,
    spaceId,
    vaultId,
  );
  const current = {
    revisionSet: currentSet,
    revisionSetHash: contextRevisionSetHash(currentSet),
  };
  if (!pinned) {
    return {
      status: "LEGACY_UNPINNED",
      pinned: null,
      current,
      changedDimensions: [],
    };
  }
  if (pinned.revisionSetHash === current.revisionSetHash) {
    return {
      status: "CURRENT",
      pinned,
      current,
      changedDimensions: [],
    };
  }
  return {
    status: "CHANGED",
    pinned,
    current,
    changedDimensions: changedDimensions(pinned.revisionSet, currentSet),
  };
}

export async function assertWorkspaceContextRevisionCurrent(
  queryable: RevisionQueryable,
  sessionId: string,
  spaceId: string,
  vaultId: string,
): Promise<void> {
  const state = await workspaceContextRevisionState(
    queryable,
    sessionId,
    spaceId,
    vaultId,
  );
  if (state.status === "CHANGED") {
    throw contextError("CONTEXT_REVISION_CHANGED", 409);
  }
}

export async function currentContextRevisionSet(
  db: Postgres,
  spaceId: string,
  vaultId: string,
): Promise<{ revisionSet: ContextRevisionSet; revisionSetHash: string }> {
  const revisionSet = await resolveCurrentContextRevisionSet(
    db.pool,
    spaceId,
    vaultId,
  );
  return { revisionSet, revisionSetHash: contextRevisionSetHash(revisionSet) };
}
