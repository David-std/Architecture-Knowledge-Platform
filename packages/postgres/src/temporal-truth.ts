import { createHash, randomUUID } from "node:crypto";
export type TruthSupportEvaluation = "SUPPORTED" | "DISPUTED" | "UNSUPPORTED";

export interface SourceEpisode {
  id: string;
  spaceId: string;
  vaultId: string;
  sourceId: string;
  sourceArtifactId: string;
  sourceHash: string;
  observedAt: string | null;
  ingestedAt: string;
  locatorRefs: string[];
}

export interface TruthSupportSet {
  schemaVersion: 1;
  id: string;
  spaceId: string;
  vaultId: string;
  state: "SUPPORTED" | "DISPUTED";
  factIds: string[];
  evidenceIds: string[];
  sourceArtifactIds: string[];
  sourceRevisionHashes: string[];
  sourceEpisodeIds: string[];
  alternativeSupportGroups: string[][];
  createdAt: string;
}

export interface TruthRevision {
  id: string;
  spaceId: string;
  vaultId: string;
  revisionSeq: number;
  revisionHash: string;
  parentRevisionHash: string | null;
  reason: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
}

export interface TemporalFact {
  id: string;
  spaceId: string;
  vaultId: string;
  scopeId: string;
  authorizationPath: string;
  subjectRef: string;
  predicate: string;
  object: unknown;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  sourceEpisodeId: string | null;
  supportSetId: string;
  lifecycle: "ACTIVE" | "DISPUTED";
  truthRevisionHash: string;
  truthRevisionSeq: number;
}

export interface TemporalFactView extends TemporalFact {
  supportState: TruthSupportEvaluation;
  queryRevisionHash: string | null;
  queryRevisionSeq: number;
}

export interface CreateSourceEpisodeInput {
  spaceId: string;
  vaultId: string;
  sourceId: string;
  sourceArtifactId: string;
  sourceHash: string;
  observedAt?: string | null;
  ingestedAt?: string;
  locatorRefs?: string[];
}

export interface CreateTruthSupportSetInput {
  spaceId: string;
  vaultId: string;
  state?: "SUPPORTED" | "DISPUTED";
  factIds?: string[];
  evidenceIds?: string[];
  sourceArtifactIds?: string[];
  sourceRevisionHashes?: string[];
  sourceEpisodeIds?: string[];
  alternativeSupportGroups?: string[][];
}

export interface RecordTemporalFactInput {
  spaceId: string;
  vaultId: string;
  scopeId: string;
  authorizationPath: string;
  subjectRef: string;
  predicate: string;
  object: unknown;
  validFrom: string;
  validTo?: string | null;
  recordedAt?: string;
  sourceEpisodeId?: string | null;
  supportSetId: string;
  lifecycle?: "ACTIVE" | "DISPUTED";
  supersedesFactId?: string;
}

export interface TemporalTruthQuery {
  spaceId: string;
  vaultId: string;
  subjectRef?: string;
  predicate?: string;
  mode?: "CURRENT" | "HISTORY";
  validAt?: string;
  recordedAtOrBefore?: string;
  truthRevisionHash?: string;
  changedSince?: string;
  authorizationPathPrefixes?: Array<string | null>;
  limit?: number;
}

export type DerivedTruthStoreKind =
  | "VECTOR"
  | "GRAPH_SUMMARY"
  | "COMMUNITY_REPORT"
  | "CACHED_SYNTHESIS"
  | "CONTEXT_FRAGMENT"
  | "TASK_ARTIFACT";

export interface DerivedTruthDependency {
  id: string;
  spaceId: string;
  vaultId: string;
  derivedStoreKind: DerivedTruthStoreKind;
  derivedItemRef: string;
  supportSetId: string;
  sourceRevisionHashes: string[];
  truthRevisionHash: string;
  projectionRevision: string | null;
  createdAt: string;
}

export interface RegisterDerivedTruthDependencyInput {
  spaceId: string;
  vaultId: string;
  derivedStoreKind: DerivedTruthStoreKind;
  derivedItemRef: string;
  supportSetId: string;
  sourceRevisionHashes?: string[];
  truthRevisionHash: string;
  projectionRevision?: string | null;
}

export interface TruthSnapshotEntry {
  vaultId: string;
  revisionHash: string | null;
  revisionSeq: number;
}

export interface TruthSnapshot {
  spaceId: string;
  capturedAt: string;
  vaults: TruthSnapshotEntry[];
}

export type DerivedTruthValidationState =
  "SUPPORTED" | "DISPUTED" | "UNSUPPORTED" | "UNANNOTATED";

export interface DerivedTruthValidation {
  derivedItemRef: string;
  state: DerivedTruthValidationState;
  valid: boolean;
  dependency: DerivedTruthDependency | null;
  queryRevisionHash: string | null;
  queryRevisionSeq: number;
}

export interface ValidateDerivedTruthInput {
  spaceId: string;
  vaultId: string;
  derivedStoreKind: DerivedTruthStoreKind;
  derivedItemRefs: string[];
  truthRevisionHash?: string;
  validAt?: string;
}

export type DerivedTruthInvalidationReason =
  "FACT_SUPERSEDED" | "SOURCE_WITHDRAWN" | "EVIDENCE_INVALIDATED";

export interface RebuildDerivedTruthProjectionInput {
  eventId: string;
  spaceId: string;
  vaultId: string;
  truthRevisionHash: string;
  reason: DerivedTruthInvalidationReason;
  resourceId: string;
  validAt: string;
}

export interface DerivedTruthProjectionRevision {
  id: string;
  spaceId: string;
  vaultId: string;
  truthRevisionHash: string;
  truthRevisionSeq: number;
  triggerEventId: string;
  reason: DerivedTruthInvalidationReason;
  resourceId: string;
  evaluatedValidAt: string;
  projectionHash: string;
  itemCount: number;
  createdAt: string;
}

export interface DerivedTruthProjectionItem {
  projectionRevisionId: string;
  spaceId: string;
  vaultId: string;
  derivedStoreKind: DerivedTruthStoreKind;
  derivedItemRef: string;
  state: DerivedTruthValidationState;
  valid: boolean;
  dependencyId: string | null;
  truthRevisionHash: string;
  truthRevisionSeq: number;
  evaluatedValidAt: string;
  triggerEventId: string;
  reason: DerivedTruthInvalidationReason;
  resourceId: string;
  projectionHash: string;
  createdAt: string;
}

export interface DerivedTruthProjectionQuery {
  spaceId: string;
  vaultId: string;
  truthRevisionHash?: string;
  derivedStoreKind?: DerivedTruthStoreKind;
  derivedItemRefs?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH64 = /^[a-f0-9]{64}$/;

function requiredUuid(value: string, code: string): string {
  if (!UUID.test(value)) throw new Error(code);
  return value;
}

function requiredHash(value: string, code: string): string {
  if (!HASH64.test(value)) throw new Error(code);
  return value;
}

function requiredText(value: string, code: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function requiredDate(value: string, code: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(code);
  return new Date(time).toISOString();
}

function optionalDate(
  value: string | null | undefined,
  code: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredDate(value, code);
}

function boundedStrings(
  values: readonly string[] | undefined,
  code: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  const result = [...(values ?? [])];
  if (result.length > maximumItems) throw new Error(code);
  for (const value of result) {
    if (!value.trim() || value.length > maximumLength) throw new Error(code);
  }
  return result;
}

function boundedUuids(
  values: readonly string[] | undefined,
  code: string,
): string[] {
  const result = [...(values ?? [])];
  if (result.length > 500 || result.some((value) => !UUID.test(value))) {
    throw new Error(code);
  }
  return result;
}

function normalizeSourceEpisodeInput(input: CreateSourceEpisodeInput): Required<
  Omit<CreateSourceEpisodeInput, "observedAt">
> & {
  observedAt: string | null;
} {
  return {
    spaceId: requiredUuid(input.spaceId, "TRUTH_SPACE_ID_INVALID"),
    vaultId: requiredUuid(input.vaultId, "TRUTH_VAULT_ID_INVALID"),
    sourceId: requiredUuid(input.sourceId, "TRUTH_SOURCE_ID_INVALID"),
    sourceArtifactId: requiredUuid(
      input.sourceArtifactId,
      "TRUTH_SOURCE_ARTIFACT_ID_INVALID",
    ),
    sourceHash: requiredHash(input.sourceHash, "TRUTH_SOURCE_HASH_INVALID"),
    observedAt:
      optionalDate(input.observedAt, "TRUTH_OBSERVED_AT_INVALID") ?? null,
    ingestedAt:
      optionalDate(input.ingestedAt, "TRUTH_INGESTED_AT_INVALID") ??
      new Date().toISOString(),
    locatorRefs: boundedStrings(
      input.locatorRefs,
      "TRUTH_LOCATOR_REFS_INVALID",
      500,
      2048,
    ),
  };
}

function normalizeSupportSetInput(input: CreateTruthSupportSetInput) {
  const sourceRevisionHashes = [...(input.sourceRevisionHashes ?? [])];
  if (
    sourceRevisionHashes.length > 500 ||
    sourceRevisionHashes.some((value) => !HASH64.test(value))
  ) {
    throw new Error("TRUTH_SOURCE_REVISION_HASHES_INVALID");
  }
  const alternativeSupportGroups = (input.alternativeSupportGroups ?? []).map(
    (group) => boundedStrings(group, "TRUTH_SUPPORT_GROUP_INVALID", 100, 2200),
  );
  if (alternativeSupportGroups.length > 100) {
    throw new Error("TRUTH_SUPPORT_GROUP_INVALID");
  }
  return {
    spaceId: requiredUuid(input.spaceId, "TRUTH_SPACE_ID_INVALID"),
    vaultId: requiredUuid(input.vaultId, "TRUTH_VAULT_ID_INVALID"),
    state: input.state ?? ("SUPPORTED" as const),
    factIds: boundedUuids(input.factIds, "TRUTH_FACT_IDS_INVALID"),
    evidenceIds: boundedUuids(input.evidenceIds, "TRUTH_EVIDENCE_IDS_INVALID"),
    sourceArtifactIds: boundedUuids(
      input.sourceArtifactIds,
      "TRUTH_SOURCE_ARTIFACT_IDS_INVALID",
    ),
    sourceRevisionHashes,
    sourceEpisodeIds: boundedUuids(
      input.sourceEpisodeIds,
      "TRUTH_SOURCE_EPISODE_IDS_INVALID",
    ),
    alternativeSupportGroups,
  };
}

function normalizeFactInput(input: RecordTemporalFactInput) {
  const validFrom = requiredDate(input.validFrom, "TRUTH_VALID_FROM_INVALID");
  const validTo = optionalDate(input.validTo, "TRUTH_VALID_TO_INVALID") ?? null;
  if (validTo && new Date(validTo).getTime() <= new Date(validFrom).getTime()) {
    throw new Error("TRUTH_VALID_INTERVAL_INVALID");
  }
  return {
    spaceId: requiredUuid(input.spaceId, "TRUTH_SPACE_ID_INVALID"),
    vaultId: requiredUuid(input.vaultId, "TRUTH_VAULT_ID_INVALID"),
    scopeId: requiredText(input.scopeId, "TRUTH_SCOPE_ID_INVALID", 512),
    authorizationPath: requiredText(
      input.authorizationPath,
      "TRUTH_AUTHORIZATION_PATH_INVALID",
      4096,
    ),
    subjectRef: requiredText(
      input.subjectRef,
      "TRUTH_SUBJECT_REF_INVALID",
      2048,
    ),
    predicate: requiredText(input.predicate, "TRUTH_PREDICATE_INVALID", 512),
    object: input.object,
    validFrom,
    validTo,
    ...(input.recordedAt
      ? {
          recordedAt: requiredDate(
            input.recordedAt,
            "TRUTH_RECORDED_AT_INVALID",
          ),
        }
      : {}),
    ...(input.sourceEpisodeId !== undefined
      ? {
          sourceEpisodeId:
            input.sourceEpisodeId === null
              ? null
              : requiredUuid(
                  input.sourceEpisodeId,
                  "TRUTH_SOURCE_EPISODE_ID_INVALID",
                ),
        }
      : {}),
    supportSetId: requiredUuid(
      input.supportSetId,
      "TRUTH_SUPPORT_SET_ID_INVALID",
    ),
    lifecycle: input.lifecycle ?? ("ACTIVE" as const),
    ...(input.supersedesFactId
      ? {
          supersedesFactId: requiredUuid(
            input.supersedesFactId,
            "TRUTH_SUPERSEDES_FACT_ID_INVALID",
          ),
        }
      : {}),
  };
}

function normalizeTruthQuery(input: TemporalTruthQuery) {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("TRUTH_QUERY_LIMIT_INVALID");
  }
  return {
    spaceId: requiredUuid(input.spaceId, "TRUTH_SPACE_ID_INVALID"),
    vaultId: requiredUuid(input.vaultId, "TRUTH_VAULT_ID_INVALID"),
    ...(input.subjectRef
      ? {
          subjectRef: requiredText(
            input.subjectRef,
            "TRUTH_SUBJECT_REF_INVALID",
            2048,
          ),
        }
      : {}),
    ...(input.predicate
      ? {
          predicate: requiredText(
            input.predicate,
            "TRUTH_PREDICATE_INVALID",
            512,
          ),
        }
      : {}),
    mode: input.mode ?? ("CURRENT" as const),
    ...(input.validAt
      ? { validAt: requiredDate(input.validAt, "TRUTH_VALID_AT_INVALID") }
      : {}),
    ...(input.recordedAtOrBefore
      ? {
          recordedAtOrBefore: requiredDate(
            input.recordedAtOrBefore,
            "TRUTH_RECORDED_CUTOFF_INVALID",
          ),
        }
      : {}),
    ...(input.truthRevisionHash
      ? {
          truthRevisionHash: requiredHash(
            input.truthRevisionHash,
            "TRUTH_REVISION_HASH_INVALID",
          ),
        }
      : {}),
    ...(input.changedSince
      ? {
          changedSince: requiredDate(
            input.changedSince,
            "TRUTH_CHANGED_SINCE_INVALID",
          ),
        }
      : {}),
    authorizationPathPrefixes: [...(input.authorizationPathPrefixes ?? [])],
    limit,
  };
}

function asAlternativeGroups(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((group) =>
    Array.isArray(group) && group.every((entry) => typeof entry === "string")
      ? [group as string[]]
      : [],
  );
}

import type { PoolClient } from "pg";
import type { Postgres } from "./index.js";
import { appendOutboxEvent } from "./outbox.js";

interface RevisionRow {
  id: string;
  space_id: string;
  vault_id: string;
  revision_seq: string | number;
  revision_hash: string;
  parent_revision_hash: string | null;
  reason: string;
  resource_type: string;
  resource_id: string;
  created_at: Date | string;
}

interface SupportSetRow {
  id: string;
  schema_version: number;
  space_id: string;
  vault_id: string;
  state: "SUPPORTED" | "DISPUTED";
  fact_ids: string[];
  evidence_ids: string[];
  source_artifact_ids: string[];
  source_revision_hashes: string[];
  source_episode_ids: string[];
  alternative_support_groups: unknown;
  created_at: Date | string;
}

interface SourceEpisodeRow {
  id: string;
  space_id: string;
  vault_id: string;
  source_id: string;
  source_artifact_id: string;
  source_hash: string;
  observed_at: Date | string | null;
  ingested_at: Date | string;
  locator_refs: unknown;
}

interface DerivedDependencyRow {
  id: string;
  space_id: string;
  vault_id: string;
  derived_store_kind: DerivedTruthStoreKind;
  derived_item_ref: string;
  support_set_id: string;
  source_revision_hashes: string[];
  truth_revision_hash: string;
  projection_revision: string | null;
  created_at: Date | string;
  revision_seq?: string | number;
}

interface DerivedProjectionRevisionRow {
  id: string;
  space_id: string;
  vault_id: string;
  truth_revision_hash: string;
  truth_revision_seq: string | number;
  trigger_event_id: string;
  reason: DerivedTruthInvalidationReason;
  resource_id: string;
  evaluated_valid_at: Date | string;
  projection_hash: string;
  item_count: string | number;
  created_at: Date | string;
}

interface DerivedProjectionItemRow {
  projection_revision_id: string;
  space_id: string;
  vault_id: string;
  derived_store_kind: DerivedTruthStoreKind;
  derived_item_ref: string;
  state: DerivedTruthValidationState;
  valid: boolean;
  dependency_id: string | null;
  truth_revision_hash: string;
  truth_revision_seq: string | number;
  evaluated_valid_at: Date | string;
  trigger_event_id: string;
  reason: DerivedTruthInvalidationReason;
  resource_id: string;
  projection_hash: string;
  created_at: Date | string;
}

function normalizeDerivedDependency(
  row: DerivedDependencyRow,
): DerivedTruthDependency {
  return {
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    derivedStoreKind: row.derived_store_kind,
    derivedItemRef: row.derived_item_ref,
    supportSetId: row.support_set_id,
    sourceRevisionHashes: row.source_revision_hashes ?? [],
    truthRevisionHash: row.truth_revision_hash,
    projectionRevision: row.projection_revision,
    createdAt: iso(row.created_at),
  };
}

function normalizeDerivedProjectionRevision(
  row: DerivedProjectionRevisionRow,
): DerivedTruthProjectionRevision {
  return {
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    truthRevisionHash: row.truth_revision_hash,
    truthRevisionSeq: Number(row.truth_revision_seq),
    triggerEventId: row.trigger_event_id,
    reason: row.reason,
    resourceId: row.resource_id,
    evaluatedValidAt: iso(row.evaluated_valid_at),
    projectionHash: row.projection_hash,
    itemCount: Number(row.item_count),
    createdAt: iso(row.created_at),
  };
}

function normalizeDerivedProjectionItem(
  row: DerivedProjectionItemRow,
): DerivedTruthProjectionItem {
  return {
    projectionRevisionId: row.projection_revision_id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    derivedStoreKind: row.derived_store_kind,
    derivedItemRef: row.derived_item_ref,
    state: row.state,
    valid: row.valid,
    dependencyId: row.dependency_id,
    truthRevisionHash: row.truth_revision_hash,
    truthRevisionSeq: Number(row.truth_revision_seq),
    evaluatedValidAt: iso(row.evaluated_valid_at),
    triggerEventId: row.trigger_event_id,
    reason: row.reason,
    resourceId: row.resource_id,
    projectionHash: row.projection_hash,
    createdAt: iso(row.created_at),
  };
}

interface FactRow {
  id: string;
  space_id: string;
  vault_id: string;
  scope_id: string;
  authorization_path: string;
  subject_ref: string;
  predicate: string;
  object: unknown;
  valid_from: Date | string;
  valid_to: Date | string | null;
  recorded_at: Date | string;
  source_episode_id: string | null;
  support_set_id: string;
  lifecycle: "ACTIVE" | "DISPUTED";
  truth_revision_hash: string;
  truth_revision_seq: string | number;
}

interface SupportEvaluationContext {
  factStates: Map<string, TruthSupportEvaluation>;
  visitingFactIds: Set<string>;
}

function supportEvaluationContext(): SupportEvaluationContext {
  return {
    factStates: new Map<string, TruthSupportEvaluation>(),
    visitingFactIds: new Set<string>(),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function normalizeRevision(row: RevisionRow): TruthRevision {
  return {
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    revisionSeq: Number(row.revision_seq),
    revisionHash: row.revision_hash,
    parentRevisionHash: row.parent_revision_hash,
    reason: row.reason,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: iso(row.created_at),
  };
}

function normalizeSupportSet(row: SupportSetRow): TruthSupportSet {
  return {
    schemaVersion: 1,
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    state: row.state,
    factIds: row.fact_ids ?? [],
    evidenceIds: row.evidence_ids ?? [],
    sourceArtifactIds: row.source_artifact_ids ?? [],
    sourceRevisionHashes: row.source_revision_hashes ?? [],
    sourceEpisodeIds: row.source_episode_ids ?? [],
    alternativeSupportGroups: asAlternativeGroups(
      row.alternative_support_groups,
    ),
    createdAt: iso(row.created_at),
  };
}

function normalizeFact(row: FactRow): TemporalFact {
  return {
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    scopeId: row.scope_id,
    authorizationPath: row.authorization_path,
    subjectRef: row.subject_ref,
    predicate: row.predicate,
    object: row.object,
    validFrom: iso(row.valid_from),
    validTo: row.valid_to ? iso(row.valid_to) : null,
    recordedAt: iso(row.recorded_at),
    sourceEpisodeId: row.source_episode_id,
    supportSetId: row.support_set_id,
    lifecycle: row.lifecycle,
    truthRevisionHash: row.truth_revision_hash,
    truthRevisionSeq: Number(row.truth_revision_seq),
  };
}

function normalizedPath(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.includes("/../") ||
    value.includes("//")
  ) {
    throw new Error("TRUTH_AUTHORIZATION_PATH_INVALID");
  }
  return value;
}

function pathAllowed(path: string, prefixes: Array<string | null>): boolean {
  if (!prefixes.length) return true;
  return prefixes.some(
    (prefix) =>
      prefix === null ||
      path === prefix ||
      path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

export class PostgresTemporalTruthStore {
  constructor(readonly db: Postgres) {}

  private async publishRevision(
    client: PoolClient,
    input: {
      spaceId: string;
      vaultId: string;
      reason: string;
      resourceType: string;
      resourceId: string;
      correlationId?: string | null;
      causationId?: string | null;
    },
  ): Promise<TruthRevision> {
    await client.query(
      `insert into truth_revision_heads(vault_id,space_id)
       values($1,$2)
       on conflict(vault_id) do nothing`,
      [input.vaultId, input.spaceId],
    );
    const head = await client.query<{
      revision_seq: string | number;
      revision_hash: string | null;
    }>(
      `select revision_seq,revision_hash
         from truth_revision_heads
        where vault_id=$1 and space_id=$2
        for update`,
      [input.vaultId, input.spaceId],
    );
    const current = head.rows[0];
    if (!current) throw new Error("TRUTH_REVISION_HEAD_NOT_FOUND");
    const revisionSeq = Number(current.revision_seq) + 1;
    const revisionHash = createHash("sha256")
      .update(
        [
          input.vaultId,
          String(revisionSeq),
          current.revision_hash ?? "ROOT",
          input.reason,
          input.resourceType,
          input.resourceId,
        ].join("\0"),
      )
      .digest("hex");
    const id = randomUUID();
    const inserted = await client.query<RevisionRow>(
      `insert into truth_revisions(
         id,space_id,vault_id,revision_seq,revision_hash,parent_revision_hash,
         reason,resource_type,resource_id
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning *`,
      [
        id,
        input.spaceId,
        input.vaultId,
        revisionSeq,
        revisionHash,
        current.revision_hash,
        input.reason,
        input.resourceType,
        input.resourceId,
      ],
    );
    await client.query(
      `update truth_revision_heads
          set revision_seq=$2,revision_hash=$3,updated_at=now()
        where vault_id=$1`,
      [input.vaultId, revisionSeq, revisionHash],
    );
    await appendOutboxEvent(client, {
      eventType: "TruthRevisionPublished",
      resourceId: revisionHash,
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      payload: {
        revisionSeq,
        revisionHash,
        parentRevisionHash: current.revision_hash,
        reason: input.reason,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      },
    });
    return normalizeRevision(inserted.rows[0]!);
  }

  async createSourceEpisode(
    rawInput: CreateSourceEpisodeInput,
  ): Promise<SourceEpisode> {
    const input = normalizeSourceEpisodeInput(rawInput);
    const source = await this.db.pool.query(
      `select s.id
         from sources s
         join source_artifacts a on a.source_id=s.id
        where s.id=$1 and a.id=$2 and s.space_id=$3 and s.vault_id=$4
          and s.sha256=$5
        limit 1`,
      [
        input.sourceId,
        input.sourceArtifactId,
        input.spaceId,
        input.vaultId,
        input.sourceHash,
      ],
    );
    if (!source.rowCount)
      throw new Error("TRUTH_SOURCE_EPISODE_SCOPE_MISMATCH");
    const id = randomUUID();
    const ingestedAt = input.ingestedAt ?? new Date().toISOString();
    const result = await this.db.pool.query<SourceEpisodeRow>(
      `insert into source_episodes(
         id,space_id,vault_id,source_id,source_artifact_id,source_hash,
         observed_at,ingested_at,locator_refs
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       returning *`,
      [
        id,
        input.spaceId,
        input.vaultId,
        input.sourceId,
        input.sourceArtifactId,
        input.sourceHash,
        input.observedAt ?? null,
        ingestedAt,
        JSON.stringify(input.locatorRefs),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("TRUTH_SOURCE_EPISODE_PERSISTENCE_FAILED");
    return {
      id: row.id,
      spaceId: row.space_id,
      vaultId: row.vault_id,
      sourceId: row.source_id,
      sourceArtifactId: row.source_artifact_id,
      sourceHash: row.source_hash,
      observedAt: row.observed_at
        ? iso(row.observed_at as Date | string)
        : null,
      ingestedAt: iso(row.ingested_at as Date | string),
      locatorRefs: Array.isArray(row.locator_refs)
        ? row.locator_refs.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  }

  private async validateIds(
    table: string,
    column: string,
    ids: string[],
    spaceId: string,
    vaultId: string,
  ): Promise<void> {
    if (!ids.length) return;
    const allowed = new Set([
      "temporal_facts:id",
      "evidence:id",
      "source_episodes:id",
    ]);
    if (!allowed.has(`${table}:${column}`)) {
      throw new Error("TRUTH_SUPPORT_REFERENCE_KIND_INVALID");
    }
    const result = await this.db.pool.query(
      `select count(*)::int count from ${table}
        where ${column}=any($1::uuid[]) and space_id=$2 and vault_id=$3`,
      [ids, spaceId, vaultId],
    );
    if (Number(result.rows[0]?.count ?? 0) !== new Set(ids).size) {
      throw new Error("TRUTH_SUPPORT_REFERENCE_SCOPE_MISMATCH");
    }
  }

  async createSupportSet(
    rawInput: CreateTruthSupportSetInput,
  ): Promise<TruthSupportSet> {
    const input = normalizeSupportSetInput(rawInput);
    const total =
      input.factIds.length +
      input.evidenceIds.length +
      input.sourceArtifactIds.length +
      input.sourceRevisionHashes.length +
      input.sourceEpisodeIds.length;
    if (!total) throw new Error("TRUTH_SUPPORT_REQUIRED");
    await Promise.all([
      this.validateIds(
        "temporal_facts",
        "id",
        input.factIds,
        input.spaceId,
        input.vaultId,
      ),
      this.validateIds(
        "evidence",
        "id",
        input.evidenceIds,
        input.spaceId,
        input.vaultId,
      ),
      this.validateIds(
        "source_episodes",
        "id",
        input.sourceEpisodeIds,
        input.spaceId,
        input.vaultId,
      ),
    ]);
    if (input.sourceArtifactIds.length) {
      const artifacts = await this.db.pool.query(
        `select count(*)::int count
           from source_artifacts a
           join sources s on s.id=a.source_id
          where a.id=any($1::uuid[]) and s.space_id=$2 and s.vault_id=$3`,
        [input.sourceArtifactIds, input.spaceId, input.vaultId],
      );
      if (
        Number(artifacts.rows[0]?.count ?? 0) !==
        new Set(input.sourceArtifactIds).size
      ) {
        throw new Error("TRUTH_SUPPORT_REFERENCE_SCOPE_MISMATCH");
      }
    }

    const allowedRefs = new Set<string>([
      ...input.factIds.map((id) => `fact:${id}`),
      ...input.evidenceIds.map((id) => `evidence:${id}`),
      ...input.sourceArtifactIds.map((id) => `source_artifact:${id}`),
      ...input.sourceRevisionHashes.map((hash) => `revision:${hash}`),
      ...input.sourceEpisodeIds.map((id) => `source_episode:${id}`),
    ]);
    for (const group of input.alternativeSupportGroups) {
      for (const ref of group) {
        if (!allowedRefs.has(ref)) {
          throw new Error("TRUTH_SUPPORT_GROUP_REFERENCE_UNKNOWN");
        }
      }
    }

    const id = randomUUID();
    const result = await this.db.pool.query<SupportSetRow>(
      `insert into truth_support_sets(
         id,space_id,vault_id,state,fact_ids,evidence_ids,source_artifact_ids,
         source_revision_hashes,source_episode_ids,alternative_support_groups
       ) values($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7::uuid[],$8::text[],$9::uuid[],$10::jsonb)
       returning *`,
      [
        id,
        input.spaceId,
        input.vaultId,
        input.state,
        input.factIds,
        input.evidenceIds,
        input.sourceArtifactIds,
        input.sourceRevisionHashes,
        input.sourceEpisodeIds,
        JSON.stringify(input.alternativeSupportGroups),
      ],
    );
    return normalizeSupportSet(result.rows[0]!);
  }

  async recordFact(
    rawInput: RecordTemporalFactInput,
    metadata: {
      correlationId?: string | null;
      causationId?: string | null;
    } = {},
  ): Promise<{
    fact: ReturnType<typeof normalizeFact>;
    revision: TruthRevision;
  }> {
    const input = normalizeFactInput(rawInput);
    const authorizationPath = normalizedPath(input.authorizationPath);
    const client = await this.db.pool.connect();
    try {
      await client.query("begin");
      const support = await client.query<SupportSetRow>(
        `select * from truth_support_sets
          where id=$1 and space_id=$2 and vault_id=$3
          limit 1`,
        [input.supportSetId, input.spaceId, input.vaultId],
      );
      if (!support.rows[0]) throw new Error("TRUTH_SUPPORT_SET_NOT_FOUND");
      if (input.sourceEpisodeId) {
        const episode = await client.query(
          `select id from source_episodes
            where id=$1 and space_id=$2 and vault_id=$3
            limit 1`,
          [input.sourceEpisodeId, input.spaceId, input.vaultId],
        );
        if (!episode.rowCount)
          throw new Error("TRUTH_SOURCE_EPISODE_NOT_FOUND");
      }
      let oldFact: FactRow | undefined;
      if (input.supersedesFactId) {
        const old = await client.query<FactRow>(
          `select * from temporal_facts
            where id=$1 and space_id=$2 and vault_id=$3
            for share`,
          [input.supersedesFactId, input.spaceId, input.vaultId],
        );
        oldFact = old.rows[0];
        if (!oldFact) throw new Error("TRUTH_FACT_TO_SUPERSEDE_NOT_FOUND");
        if (
          oldFact.subject_ref !== input.subjectRef ||
          oldFact.predicate !== input.predicate
        ) {
          throw new Error("TRUTH_SUPERSESSION_IDENTITY_MISMATCH");
        }
      }

      const factId = randomUUID();
      const revision = await this.publishRevision(client, {
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        reason: input.supersedesFactId ? "FACT_SUPERSEDED" : "FACT_RECORDED",
        resourceType: "temporal_fact",
        resourceId: factId,
        ...(metadata.correlationId !== undefined
          ? { correlationId: metadata.correlationId }
          : {}),
        ...(metadata.causationId !== undefined
          ? { causationId: metadata.causationId }
          : {}),
      });
      const recordedAt = input.recordedAt ?? revision.createdAt;
      const inserted = await client.query<FactRow>(
        `insert into temporal_facts(
           id,space_id,vault_id,scope_id,authorization_path,subject_ref,predicate,
           object,valid_from,valid_to,recorded_at,source_episode_id,support_set_id,
           lifecycle,truth_revision_hash,truth_revision_seq
         ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)
         returning *`,
        [
          factId,
          input.spaceId,
          input.vaultId,
          input.scopeId,
          authorizationPath,
          input.subjectRef,
          input.predicate,
          JSON.stringify(input.object),
          input.validFrom,
          input.validTo ?? null,
          recordedAt,
          input.sourceEpisodeId ?? null,
          input.supportSetId,
          input.lifecycle,
          revision.revisionHash,
          revision.revisionSeq,
        ],
      );
      if (oldFact) {
        const supersessionId = randomUUID();
        await client.query(
          `insert into temporal_fact_supersessions(
             id,space_id,vault_id,old_fact_id,new_fact_id,truth_revision_hash,
             truth_revision_seq,recorded_at
           ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            supersessionId,
            input.spaceId,
            input.vaultId,
            oldFact.id,
            factId,
            revision.revisionHash,
            revision.revisionSeq,
            recordedAt,
          ],
        );
        await appendOutboxEvent(client, {
          eventType: "FactSuperseded",
          resourceId: oldFact.id,
          spaceId: input.spaceId,
          vaultId: input.vaultId,
          correlationId: metadata.correlationId ?? null,
          causationId: metadata.causationId ?? null,
          payload: {
            oldFactId: oldFact.id,
            newFactId: factId,
            truthRevisionHash: revision.revisionHash,
          },
        });
        await appendOutboxEvent(client, {
          eventType: "DerivedSupportInvalidationRequested",
          resourceId: oldFact.id,
          spaceId: input.spaceId,
          vaultId: input.vaultId,
          correlationId: metadata.correlationId ?? null,
          causationId: metadata.causationId ?? null,
          payload: {
            reason: "FACT_SUPERSEDED",
            factId: oldFact.id,
            replacementFactId: factId,
            truthRevisionHash: revision.revisionHash,
          },
        });
      }
      await client.query("commit");
      return { fact: normalizeFact(inserted.rows[0]!), revision };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async withdrawSourceEpisode(input: {
    spaceId: string;
    vaultId: string;
    sourceEpisodeId: string;
    reason: string;
    recordedAt?: string;
    correlationId?: string | null;
    causationId?: string | null;
  }): Promise<TruthRevision> {
    if (!input.reason.trim())
      throw new Error("TRUTH_WITHDRAWAL_REASON_REQUIRED");
    const client = await this.db.pool.connect();
    try {
      await client.query("begin");
      const episode = await client.query(
        `select id from source_episodes
          where id=$1 and space_id=$2 and vault_id=$3
          for share`,
        [input.sourceEpisodeId, input.spaceId, input.vaultId],
      );
      if (!episode.rowCount) throw new Error("TRUTH_SOURCE_EPISODE_NOT_FOUND");
      const existing = await client.query<RevisionRow>(
        `select r.*
           from source_episode_withdrawals w
           join truth_revisions r on r.revision_hash=w.truth_revision_hash
          where w.source_episode_id=$1
          limit 1`,
        [input.sourceEpisodeId],
      );
      if (existing.rows[0]) {
        await client.query("commit");
        return normalizeRevision(existing.rows[0]);
      }
      const revision = await this.publishRevision(client, {
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        reason: "SOURCE_WITHDRAWN",
        resourceType: "source_episode",
        resourceId: input.sourceEpisodeId,
        ...(input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
        ...(input.causationId !== undefined
          ? { causationId: input.causationId }
          : {}),
      });
      await client.query(
        `insert into source_episode_withdrawals(
           id,space_id,vault_id,source_episode_id,reason,truth_revision_hash,
           truth_revision_seq,recorded_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          input.spaceId,
          input.vaultId,
          input.sourceEpisodeId,
          input.reason.trim(),
          revision.revisionHash,
          revision.revisionSeq,
          input.recordedAt ?? revision.createdAt,
        ],
      );
      await appendOutboxEvent(client, {
        eventType: "SourceWithdrawn",
        resourceId: input.sourceEpisodeId,
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: {
          sourceEpisodeId: input.sourceEpisodeId,
          reason: input.reason.trim(),
          truthRevisionHash: revision.revisionHash,
        },
      });
      await appendOutboxEvent(client, {
        eventType: "DerivedSupportInvalidationRequested",
        resourceId: input.sourceEpisodeId,
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: {
          reason: "SOURCE_WITHDRAWN",
          sourceEpisodeId: input.sourceEpisodeId,
          truthRevisionHash: revision.revisionHash,
        },
      });
      await client.query("commit");
      return revision;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async invalidateEvidence(input: {
    spaceId: string;
    vaultId: string;
    evidenceId: string;
    reason: string;
    correlationId?: string | null;
    causationId?: string | null;
  }): Promise<TruthRevision> {
    if (!input.reason.trim())
      throw new Error("TRUTH_INVALIDATION_REASON_REQUIRED");
    const client = await this.db.pool.connect();
    try {
      await client.query("begin");
      const evidence = await client.query(
        `select id from evidence
          where id=$1 and space_id=$2 and vault_id=$3
          for share`,
        [input.evidenceId, input.spaceId, input.vaultId],
      );
      if (!evidence.rowCount) throw new Error("TRUTH_EVIDENCE_NOT_FOUND");
      const existing = await client.query<RevisionRow>(
        `select r.*
           from evidence_invalidations i
           join truth_revisions r on r.revision_hash=i.truth_revision_hash
          where i.evidence_id=$1
          limit 1`,
        [input.evidenceId],
      );
      if (existing.rows[0]) {
        await client.query("commit");
        return normalizeRevision(existing.rows[0]);
      }
      const revision = await this.publishRevision(client, {
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        reason: "EVIDENCE_INVALIDATED",
        resourceType: "evidence",
        resourceId: input.evidenceId,
        ...(input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
        ...(input.causationId !== undefined
          ? { causationId: input.causationId }
          : {}),
      });
      await client.query(
        `insert into evidence_invalidations(
           id,space_id,vault_id,evidence_id,reason,truth_revision_hash,
           truth_revision_seq,recorded_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          input.spaceId,
          input.vaultId,
          input.evidenceId,
          input.reason.trim(),
          revision.revisionHash,
          revision.revisionSeq,
          revision.createdAt,
        ],
      );
      await appendOutboxEvent(client, {
        eventType: "EvidenceInvalidated",
        resourceId: input.evidenceId,
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: {
          evidenceId: input.evidenceId,
          reason: input.reason.trim(),
          truthRevisionHash: revision.revisionHash,
        },
      });
      await appendOutboxEvent(client, {
        eventType: "DerivedSupportInvalidationRequested",
        resourceId: input.evidenceId,
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: {
          reason: "EVIDENCE_INVALIDATED",
          evidenceId: input.evidenceId,
          truthRevisionHash: revision.revisionHash,
        },
      });
      await client.query("commit");
      return revision;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async currentRevision(
    spaceId: string,
    vaultId: string,
  ): Promise<TruthRevision | null> {
    const result = await this.db.pool.query<RevisionRow>(
      `select r.*
         from truth_revision_heads h
         join truth_revisions r on r.revision_hash=h.revision_hash
        where h.space_id=$1 and h.vault_id=$2
        limit 1`,
      [spaceId, vaultId],
    );
    return result.rows[0] ? normalizeRevision(result.rows[0]) : null;
  }

  private async revisionCutoff(
    query: TemporalTruthQuery,
  ): Promise<{ seq: number; hash: string | null }> {
    if (query.truthRevisionHash) {
      const revision = await this.db.pool.query<{
        revision_seq: string | number;
        revision_hash: string;
      }>(
        `select revision_seq,revision_hash from truth_revisions
          where revision_hash=$1 and space_id=$2 and vault_id=$3
          limit 1`,
        [query.truthRevisionHash, query.spaceId, query.vaultId],
      );
      const row = revision.rows[0];
      if (!row) throw new Error("TRUTH_REVISION_NOT_FOUND");
      return { seq: Number(row.revision_seq), hash: row.revision_hash };
    }
    const current = await this.currentRevision(query.spaceId, query.vaultId);
    return current
      ? { seq: current.revisionSeq, hash: current.revisionHash }
      : { seq: 0, hash: null };
  }

  private async factSupportEvaluation(
    factId: string,
    support: TruthSupportSet,
    validAt: string,
    revisionSeq: number,
    recordedAtOrBefore: string | undefined,
    context: SupportEvaluationContext,
  ): Promise<TruthSupportEvaluation> {
    const cached = context.factStates.get(factId);
    if (cached) return cached;
    if (context.visitingFactIds.has(factId)) return "UNSUPPORTED";

    context.visitingFactIds.add(factId);
    try {
      const factResult = await this.db.pool.query<FactRow>(
        `select f.*
           from temporal_facts f
          where f.id=$1
            and f.space_id=$2
            and f.vault_id=$3
            and f.truth_revision_seq<=$4
            and f.valid_from<=$5
            and (f.valid_to is null or f.valid_to>$5)
            and ($6::timestamptz is null or f.recorded_at<=$6)
            and not exists(
              select 1
                from temporal_fact_supersessions s
                join temporal_facts replacement on replacement.id=s.new_fact_id
               where s.old_fact_id=f.id
                 and s.truth_revision_seq<=$4
                 and replacement.valid_from<=$5
                 and (replacement.valid_to is null or replacement.valid_to>$5)
                 and ($6::timestamptz is null or s.recorded_at<=$6)
            )
          limit 1`,
        [
          factId,
          support.spaceId,
          support.vaultId,
          revisionSeq,
          validAt,
          recordedAtOrBefore ?? null,
        ],
      );
      const factRow = factResult.rows[0];
      if (!factRow) {
        context.factStates.set(factId, "UNSUPPORTED");
        return "UNSUPPORTED";
      }

      const supportResult = await this.db.pool.query<SupportSetRow>(
        `select * from truth_support_sets
          where id=$1 and space_id=$2 and vault_id=$3
          limit 1`,
        [factRow.support_set_id, support.spaceId, support.vaultId],
      );
      const supportRow = supportResult.rows[0];
      if (!supportRow) {
        context.factStates.set(factId, "UNSUPPORTED");
        return "UNSUPPORTED";
      }

      const nestedState = await this.supportEvaluation(
        normalizeSupportSet(supportRow),
        validAt,
        revisionSeq,
        recordedAtOrBefore,
        context,
      );
      const state =
        nestedState === "SUPPORTED" && factRow.lifecycle === "DISPUTED"
          ? "DISPUTED"
          : nestedState;
      context.factStates.set(factId, state);
      return state;
    } finally {
      context.visitingFactIds.delete(factId);
    }
  }

  private async supportEvaluation(
    support: TruthSupportSet,
    validAt: string,
    revisionSeq: number,
    recordedAtOrBefore?: string,
    context: SupportEvaluationContext = supportEvaluationContext(),
  ): Promise<TruthSupportEvaluation> {
    const [withdrawn, invalidEvidence] = await Promise.all([
      support.sourceEpisodeIds.length
        ? this.db.pool.query<{ id: string }>(
            `select source_episode_id id from source_episode_withdrawals
              where source_episode_id=any($1::uuid[])
                and truth_revision_seq<=$2
                and ($3::timestamptz is null or recorded_at<=$3)`,
            [support.sourceEpisodeIds, revisionSeq, recordedAtOrBefore ?? null],
          )
        : { rows: [] as { id: string }[] },
      support.evidenceIds.length
        ? this.db.pool.query<{ id: string }>(
            `select evidence_id id from evidence_invalidations
              where evidence_id=any($1::uuid[])
                and truth_revision_seq<=$2
                and ($3::timestamptz is null or recorded_at<=$3)`,
            [support.evidenceIds, revisionSeq, recordedAtOrBefore ?? null],
          )
        : { rows: [] as { id: string }[] },
    ]);

    const withdrawnIds = new Set(withdrawn.rows.map((row) => row.id));
    const invalidEvidenceIds = new Set(
      invalidEvidence.rows.map((row) => row.id),
    );
    const refStates = new Map<string, TruthSupportEvaluation>();
    for (const id of support.sourceEpisodeIds) {
      refStates.set(
        `source_episode:${id}`,
        withdrawnIds.has(id) ? "UNSUPPORTED" : "SUPPORTED",
      );
    }
    for (const id of support.evidenceIds) {
      refStates.set(
        `evidence:${id}`,
        invalidEvidenceIds.has(id) ? "UNSUPPORTED" : "SUPPORTED",
      );
    }
    for (const id of support.factIds) {
      refStates.set(
        `fact:${id}`,
        await this.factSupportEvaluation(
          id,
          support,
          validAt,
          revisionSeq,
          recordedAtOrBefore,
          context,
        ),
      );
    }
    for (const id of support.sourceArtifactIds) {
      refStates.set(`source_artifact:${id}`, "SUPPORTED");
    }
    for (const hash of support.sourceRevisionHashes) {
      refStates.set(`revision:${hash}`, "SUPPORTED");
    }

    const stateForRefs = (refs: readonly string[]): TruthSupportEvaluation => {
      const states = refs.map((ref) => refStates.get(ref) ?? "UNSUPPORTED");
      if (states.some((state) => state === "UNSUPPORTED")) {
        return "UNSUPPORTED";
      }
      return states.some((state) => state === "DISPUTED")
        ? "DISPUTED"
        : "SUPPORTED";
    };

    let state: TruthSupportEvaluation;
    if (support.alternativeSupportGroups.length > 0) {
      const groupStates = support.alternativeSupportGroups.map(stateForRefs);
      const viable = groupStates.filter(
        (candidate) => candidate !== "UNSUPPORTED",
      );
      if (viable.length === 0) return "UNSUPPORTED";
      state = viable.some((candidate) => candidate === "SUPPORTED")
        ? "SUPPORTED"
        : "DISPUTED";
    } else {
      const directRefs = [
        ...support.sourceEpisodeIds.map((id) => `source_episode:${id}`),
        ...support.evidenceIds.map((id) => `evidence:${id}`),
        ...support.factIds.map((id) => `fact:${id}`),
        ...support.sourceArtifactIds.map((id) => `source_artifact:${id}`),
        ...support.sourceRevisionHashes.map((hash) => `revision:${hash}`),
      ];
      state = stateForRefs(directRefs);
      if (state === "UNSUPPORTED") return state;
    }

    return support.state === "DISPUTED" || state === "DISPUTED"
      ? "DISPUTED"
      : "SUPPORTED";
  }

  async listFacts(rawQuery: TemporalTruthQuery): Promise<TemporalFactView[]> {
    const query = normalizeTruthQuery(rawQuery);
    const cutoff = await this.revisionCutoff(query);
    if (cutoff.seq === 0) return [];
    const validAt = query.validAt ?? new Date().toISOString();
    const values: unknown[] = [
      query.spaceId,
      query.vaultId,
      cutoff.seq,
      query.limit,
    ];
    let where = `f.space_id=$1 and f.vault_id=$2 and f.truth_revision_seq<=$3`;
    let recordedCutoffIndex: number | null = null;
    if (query.subjectRef) {
      values.push(query.subjectRef);
      where += ` and f.subject_ref=$${values.length}`;
    }
    if (query.predicate) {
      values.push(query.predicate);
      where += ` and f.predicate=$${values.length}`;
    }
    if (query.recordedAtOrBefore) {
      values.push(query.recordedAtOrBefore);
      recordedCutoffIndex = values.length;
      where += " and f.recorded_at<=$" + recordedCutoffIndex;
    }
    if (query.changedSince) {
      values.push(query.changedSince);
      const changedIndex = values.length;
      const changedParam = "$" + changedIndex;
      const recordedCutoffParam =
        recordedCutoffIndex === null ? null : "$" + recordedCutoffIndex;
      where += ` and (
        f.recorded_at>${changedParam}
        or exists(
          select 1 from temporal_fact_supersessions changed
           where changed.old_fact_id=f.id
             and changed.truth_revision_seq<=$3
             and changed.recorded_at>${changedParam}
             ${
               recordedCutoffParam === null
                 ? ""
                 : `and changed.recorded_at<=${recordedCutoffParam}`
             }
        )
      )`;
    }
    if (query.mode === "CURRENT") {
      values.push(validAt);
      const validIndex = values.length;
      const validParam = "$" + validIndex;
      const recordedCutoffParam =
        recordedCutoffIndex === null ? null : "$" + recordedCutoffIndex;
      where += ` and f.valid_from<=${validParam}
        and (f.valid_to is null or f.valid_to>${validParam})
        and not exists(
          select 1
            from temporal_fact_supersessions s
            join temporal_facts replacement on replacement.id=s.new_fact_id
           where s.old_fact_id=f.id
             and s.truth_revision_seq<=$3
             and replacement.valid_from<=${validParam}
             and (replacement.valid_to is null or replacement.valid_to>${validParam})
             ${
               recordedCutoffParam === null
                 ? ""
                 : `and s.recorded_at<=${recordedCutoffParam}`
             }
        )`;
    }
    const result = await this.db.pool.query<FactRow>(
      `select f.* from temporal_facts f
        where ${where}
        order by f.recorded_at desc,f.id
        limit $4`,
      values,
    );
    const output: TemporalFactView[] = [];
    for (const row of result.rows) {
      const fact = normalizeFact(row);
      if (
        !pathAllowed(fact.authorizationPath, query.authorizationPathPrefixes)
      ) {
        continue;
      }
      const supportRow = await this.db.pool.query<SupportSetRow>(
        `select * from truth_support_sets where id=$1 limit 1`,
        [fact.supportSetId],
      );
      const support = supportRow.rows[0]
        ? normalizeSupportSet(supportRow.rows[0])
        : null;
      const supportState = support
        ? await this.supportEvaluation(
            support,
            validAt,
            cutoff.seq,
            query.recordedAtOrBefore,
          )
        : "UNSUPPORTED";
      if (query.mode === "CURRENT" && supportState === "UNSUPPORTED") continue;
      output.push({
        ...fact,
        supportState,
        queryRevisionHash: cutoff.hash,
        queryRevisionSeq: cutoff.seq,
      });
    }
    return output;
  }

  async supportHistory(factId: string): Promise<{
    fact: ReturnType<typeof normalizeFact>;
    supportSet: TruthSupportSet;
    sourceWithdrawals: Array<Record<string, unknown>>;
    evidenceInvalidations: Array<Record<string, unknown>>;
    supersessions: Array<Record<string, unknown>>;
  }> {
    const factResult = await this.db.pool.query<FactRow>(
      `select * from temporal_facts where id=$1 limit 1`,
      [factId],
    );
    const row = factResult.rows[0];
    if (!row) throw new Error("TRUTH_FACT_NOT_FOUND");
    const fact = normalizeFact(row);
    const supportResult = await this.db.pool.query<SupportSetRow>(
      `select * from truth_support_sets where id=$1 limit 1`,
      [fact.supportSetId],
    );
    if (!supportResult.rows[0]) throw new Error("TRUTH_SUPPORT_SET_NOT_FOUND");
    const supportSet = normalizeSupportSet(supportResult.rows[0]);
    const [sourceWithdrawals, evidenceInvalidations, supersessions] =
      await Promise.all([
        supportSet.sourceEpisodeIds.length
          ? this.db.pool.query(
              `select * from source_episode_withdrawals
                where source_episode_id=any($1::uuid[])
                order by recorded_at,id`,
              [supportSet.sourceEpisodeIds],
            )
          : { rows: [] },
        supportSet.evidenceIds.length
          ? this.db.pool.query(
              `select * from evidence_invalidations
                where evidence_id=any($1::uuid[])
                order by recorded_at,id`,
              [supportSet.evidenceIds],
            )
          : { rows: [] },
        this.db.pool.query(
          `select * from temporal_fact_supersessions
            where old_fact_id=$1 or new_fact_id=$1
            order by recorded_at,id`,
          [factId],
        ),
      ]);
    return {
      fact,
      supportSet,
      sourceWithdrawals: sourceWithdrawals.rows,
      evidenceInvalidations: evidenceInvalidations.rows,
      supersessions: supersessions.rows,
    };
  }

  async captureSnapshot(
    spaceId: string,
    vaultIds: readonly string[],
  ): Promise<TruthSnapshot> {
    const normalizedSpaceId = requiredUuid(spaceId, "TRUTH_SPACE_ID_INVALID");
    const normalizedVaultIds = [...new Set(vaultIds)].map((vaultId) =>
      requiredUuid(vaultId, "TRUTH_VAULT_ID_INVALID"),
    );
    if (normalizedVaultIds.length > 100) {
      throw new Error("TRUTH_SNAPSHOT_VAULT_LIMIT_EXCEEDED");
    }
    const revisions = await Promise.all(
      normalizedVaultIds.map(async (vaultId): Promise<TruthSnapshotEntry> => {
        const revision = await this.currentRevision(normalizedSpaceId, vaultId);
        return revision
          ? {
              vaultId,
              revisionHash: revision.revisionHash,
              revisionSeq: revision.revisionSeq,
            }
          : { vaultId, revisionHash: null, revisionSeq: 0 };
      }),
    );
    return {
      spaceId: normalizedSpaceId,
      capturedAt: new Date().toISOString(),
      vaults: revisions.sort((left, right) =>
        left.vaultId.localeCompare(right.vaultId),
      ),
    };
  }

  async snapshotUnchanged(snapshot: TruthSnapshot): Promise<boolean> {
    const current = await this.captureSnapshot(
      snapshot.spaceId,
      snapshot.vaults.map((entry) => entry.vaultId),
    );
    if (current.vaults.length !== snapshot.vaults.length) return false;
    return current.vaults.every((entry, index) => {
      const expected = snapshot.vaults[index];
      return (
        expected !== undefined &&
        entry.vaultId === expected.vaultId &&
        entry.revisionSeq === expected.revisionSeq &&
        entry.revisionHash === expected.revisionHash
      );
    });
  }

  async registerDerivedDependency(
    rawInput: RegisterDerivedTruthDependencyInput,
  ): Promise<DerivedTruthDependency> {
    const input = {
      spaceId: requiredUuid(rawInput.spaceId, "TRUTH_SPACE_ID_INVALID"),
      vaultId: requiredUuid(rawInput.vaultId, "TRUTH_VAULT_ID_INVALID"),
      derivedStoreKind: rawInput.derivedStoreKind,
      derivedItemRef: requiredText(
        rawInput.derivedItemRef,
        "TRUTH_DERIVED_ITEM_REF_INVALID",
        4096,
      ),
      supportSetId: requiredUuid(
        rawInput.supportSetId,
        "TRUTH_SUPPORT_SET_ID_INVALID",
      ),
      sourceRevisionHashes: [...(rawInput.sourceRevisionHashes ?? [])],
      truthRevisionHash: requiredHash(
        rawInput.truthRevisionHash,
        "TRUTH_REVISION_HASH_INVALID",
      ),
      projectionRevision:
        rawInput.projectionRevision === undefined ||
        rawInput.projectionRevision === null
          ? null
          : requiredText(
              rawInput.projectionRevision,
              "TRUTH_PROJECTION_REVISION_INVALID",
              2048,
            ),
    };
    const allowedKinds = new Set<DerivedTruthStoreKind>([
      "VECTOR",
      "GRAPH_SUMMARY",
      "COMMUNITY_REPORT",
      "CACHED_SYNTHESIS",
      "CONTEXT_FRAGMENT",
      "TASK_ARTIFACT",
    ]);
    if (!allowedKinds.has(input.derivedStoreKind)) {
      throw new Error("TRUTH_DERIVED_STORE_KIND_INVALID");
    }
    if (
      input.sourceRevisionHashes.length > 500 ||
      input.sourceRevisionHashes.some((hash) => !HASH64.test(hash))
    ) {
      throw new Error("TRUTH_SOURCE_REVISION_HASHES_INVALID");
    }
    const [support, revision] = await Promise.all([
      this.db.pool.query<SupportSetRow>(
        `select * from truth_support_sets
          where id=$1 and space_id=$2 and vault_id=$3
          limit 1`,
        [input.supportSetId, input.spaceId, input.vaultId],
      ),
      this.db.pool.query<{ revision_hash: string }>(
        `select revision_hash from truth_revisions
          where revision_hash=$1 and space_id=$2 and vault_id=$3
          limit 1`,
        [input.truthRevisionHash, input.spaceId, input.vaultId],
      ),
    ]);
    if (!support.rows[0]) throw new Error("TRUTH_SUPPORT_SET_NOT_FOUND");
    if (!revision.rows[0]) throw new Error("TRUTH_REVISION_NOT_FOUND");

    const id = randomUUID();
    const inserted = await this.db.pool.query<DerivedDependencyRow>(
      `insert into derived_truth_dependencies(
         id,space_id,vault_id,derived_store_kind,derived_item_ref,
         support_set_id,source_revision_hashes,truth_revision_hash,
         projection_revision
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict(vault_id,derived_store_kind,derived_item_ref,truth_revision_hash)
       do nothing
       returning *`,
      [
        id,
        input.spaceId,
        input.vaultId,
        input.derivedStoreKind,
        input.derivedItemRef,
        input.supportSetId,
        input.sourceRevisionHashes,
        input.truthRevisionHash,
        input.projectionRevision,
      ],
    );
    if (inserted.rows[0]) return normalizeDerivedDependency(inserted.rows[0]);

    const existing = await this.db.pool.query<DerivedDependencyRow>(
      `select * from derived_truth_dependencies
        where vault_id=$1 and derived_store_kind=$2 and derived_item_ref=$3
          and truth_revision_hash=$4
        limit 1`,
      [
        input.vaultId,
        input.derivedStoreKind,
        input.derivedItemRef,
        input.truthRevisionHash,
      ],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("TRUTH_DERIVED_DEPENDENCY_NOT_FOUND");
    if (
      row.space_id !== input.spaceId ||
      row.support_set_id !== input.supportSetId ||
      JSON.stringify(row.source_revision_hashes ?? []) !==
        JSON.stringify(input.sourceRevisionHashes) ||
      row.projection_revision !== input.projectionRevision
    ) {
      throw new Error("TRUTH_DERIVED_DEPENDENCY_CONFLICT");
    }
    return normalizeDerivedDependency(row);
  }

  async validateDerivedItems(
    rawInput: ValidateDerivedTruthInput,
  ): Promise<DerivedTruthValidation[]> {
    const spaceId = requiredUuid(rawInput.spaceId, "TRUTH_SPACE_ID_INVALID");
    const vaultId = requiredUuid(rawInput.vaultId, "TRUTH_VAULT_ID_INVALID");
    const refs = [...new Set(rawInput.derivedItemRefs)].map((ref) =>
      requiredText(ref, "TRUTH_DERIVED_ITEM_REF_INVALID", 4096),
    );
    if (refs.length > 5000) {
      throw new Error("TRUTH_DERIVED_ITEM_LIMIT_EXCEEDED");
    }
    if (refs.length === 0) return [];
    const validAt = rawInput.validAt
      ? requiredDate(rawInput.validAt, "TRUTH_VALID_AT_INVALID")
      : new Date().toISOString();
    const cutoff = await this.revisionCutoff({
      spaceId,
      vaultId,
      ...(rawInput.truthRevisionHash
        ? { truthRevisionHash: rawInput.truthRevisionHash }
        : {}),
      authorizationPathPrefixes: [],
    });
    if (cutoff.seq === 0) {
      return refs.map((derivedItemRef) => ({
        derivedItemRef,
        state: "UNANNOTATED",
        valid: true,
        dependency: null,
        queryRevisionHash: null,
        queryRevisionSeq: 0,
      }));
    }

    const rows = await this.db.pool.query<DerivedDependencyRow>(
      `select d.*,r.revision_seq
         from derived_truth_dependencies d
         join truth_revisions r on r.revision_hash=d.truth_revision_hash
        where d.space_id=$1 and d.vault_id=$2
          and d.derived_store_kind=$3
          and d.derived_item_ref=any($4::text[])
        order by d.derived_item_ref,r.revision_seq desc,d.created_at desc,d.id`,
      [spaceId, vaultId, rawInput.derivedStoreKind, refs],
    );
    const latest = new Map<string, DerivedDependencyRow>();
    const future = new Map<string, DerivedDependencyRow>();
    for (const row of rows.rows) {
      const revisionSeq = Number(row.revision_seq ?? 0);
      if (revisionSeq <= cutoff.seq) {
        if (!latest.has(row.derived_item_ref)) {
          latest.set(row.derived_item_ref, row);
        }
        continue;
      }
      if (!future.has(row.derived_item_ref)) {
        future.set(row.derived_item_ref, row);
      }
    }

    const output: DerivedTruthValidation[] = [];
    for (const derivedItemRef of refs) {
      const row = latest.get(derivedItemRef);
      if (!row) {
        const futureDependency = future.get(derivedItemRef);
        output.push({
          derivedItemRef,
          state: futureDependency ? "UNSUPPORTED" : "UNANNOTATED",
          valid: !futureDependency,
          dependency: futureDependency
            ? normalizeDerivedDependency(futureDependency)
            : null,
          queryRevisionHash: cutoff.hash,
          queryRevisionSeq: cutoff.seq,
        });
        continue;
      }
      const supportRow = await this.db.pool.query<SupportSetRow>(
        `select * from truth_support_sets
          where id=$1 and space_id=$2 and vault_id=$3
          limit 1`,
        [row.support_set_id, spaceId, vaultId],
      );
      const support = supportRow.rows[0]
        ? normalizeSupportSet(supportRow.rows[0])
        : null;
      const state = support
        ? await this.supportEvaluation(support, validAt, cutoff.seq)
        : "UNSUPPORTED";
      output.push({
        derivedItemRef,
        state,
        valid: state !== "UNSUPPORTED",
        dependency: normalizeDerivedDependency(row),
        queryRevisionHash: cutoff.hash,
        queryRevisionSeq: cutoff.seq,
      });
    }
    return output;
  }

  async rebuildDerivedProjection(
    rawInput: RebuildDerivedTruthProjectionInput,
  ): Promise<DerivedTruthProjectionRevision> {
    const input = {
      eventId: requiredUuid(
        rawInput.eventId,
        "TRUTH_PROJECTION_EVENT_ID_INVALID",
      ),
      spaceId: requiredUuid(rawInput.spaceId, "TRUTH_SPACE_ID_INVALID"),
      vaultId: requiredUuid(rawInput.vaultId, "TRUTH_VAULT_ID_INVALID"),
      truthRevisionHash: requiredHash(
        rawInput.truthRevisionHash,
        "TRUTH_REVISION_HASH_INVALID",
      ),
      reason: rawInput.reason,
      resourceId: requiredUuid(
        rawInput.resourceId,
        "TRUTH_PROJECTION_RESOURCE_ID_INVALID",
      ),
      validAt: requiredDate(rawInput.validAt, "TRUTH_VALID_AT_INVALID"),
    };
    const resourceColumns: Record<DerivedTruthInvalidationReason, string> = {
      FACT_SUPERSEDED: "fact_ids",
      SOURCE_WITHDRAWN: "source_episode_ids",
      EVIDENCE_INVALIDATED: "evidence_ids",
    };
    const resourceColumn = resourceColumns[input.reason];
    if (!resourceColumn) {
      throw new Error("TRUTH_PROJECTION_REASON_INVALID");
    }

    const existing = await this.db.pool.query<DerivedProjectionRevisionRow>(
      `select * from derived_truth_projection_revisions
        where trigger_event_id=$1
        limit 1`,
      [input.eventId],
    );
    if (existing.rows[0]) {
      const projection = normalizeDerivedProjectionRevision(existing.rows[0]);
      if (
        projection.spaceId !== input.spaceId ||
        projection.vaultId !== input.vaultId ||
        projection.truthRevisionHash !== input.truthRevisionHash ||
        projection.reason !== input.reason ||
        projection.resourceId !== input.resourceId ||
        projection.evaluatedValidAt !== input.validAt
      ) {
        throw new Error("TRUTH_DERIVED_PROJECTION_EVENT_CONFLICT");
      }
      return projection;
    }

    const cutoff = await this.revisionCutoff({
      spaceId: input.spaceId,
      vaultId: input.vaultId,
      truthRevisionHash: input.truthRevisionHash,
      authorizationPathPrefixes: [],
    });
    if (cutoff.seq === 0 || cutoff.hash !== input.truthRevisionHash) {
      throw new Error("TRUTH_REVISION_NOT_FOUND");
    }

    const affected = await this.db.pool.query<{
      derived_store_kind: DerivedTruthStoreKind;
      derived_item_ref: string;
    }>(
      `with recursive affected_supports(id) as (
         select s.id
           from truth_support_sets s
          where s.space_id=$1 and s.vault_id=$2
            and s.${resourceColumn} @> array[$4::uuid]
         union
         select parent.id
           from affected_supports child
           join temporal_facts f
             on f.support_set_id=child.id
            and f.space_id=$1
            and f.vault_id=$2
            and f.truth_revision_seq<=$3
           join truth_support_sets parent
             on parent.space_id=$1
            and parent.vault_id=$2
            and parent.fact_ids @> array[f.id]
       )
       select distinct d.derived_store_kind,d.derived_item_ref
         from derived_truth_dependencies d
         join affected_supports affected on affected.id=d.support_set_id
         join truth_revisions r on r.revision_hash=d.truth_revision_hash
        where d.space_id=$1 and d.vault_id=$2
          and r.revision_seq<=$3
        order by d.derived_store_kind,d.derived_item_ref
        limit 5001`,
      [input.spaceId, input.vaultId, cutoff.seq, input.resourceId],
    );
    if (affected.rows.length > 5000) {
      throw new Error("TRUTH_DERIVED_PROJECTION_ITEM_LIMIT_EXCEEDED");
    }

    const refsByKind = new Map<DerivedTruthStoreKind, string[]>();
    for (const row of affected.rows) {
      const refs = refsByKind.get(row.derived_store_kind) ?? [];
      refs.push(row.derived_item_ref);
      refsByKind.set(row.derived_store_kind, refs);
    }
    const evaluated: Array<{
      derivedStoreKind: DerivedTruthStoreKind;
      validation: DerivedTruthValidation;
    }> = [];
    for (const [derivedStoreKind, derivedItemRefs] of refsByKind) {
      const validations = await this.validateDerivedItems({
        spaceId: input.spaceId,
        vaultId: input.vaultId,
        derivedStoreKind,
        derivedItemRefs,
        truthRevisionHash: input.truthRevisionHash,
        validAt: input.validAt,
      });
      for (const validation of validations) {
        evaluated.push({ derivedStoreKind, validation });
      }
    }
    evaluated.sort(
      (left, right) =>
        left.derivedStoreKind.localeCompare(right.derivedStoreKind) ||
        left.validation.derivedItemRef.localeCompare(
          right.validation.derivedItemRef,
        ),
    );

    const projectionHash = createHash("sha256")
      .update(
        JSON.stringify({
          spaceId: input.spaceId,
          vaultId: input.vaultId,
          truthRevisionHash: input.truthRevisionHash,
          truthRevisionSeq: cutoff.seq,
          reason: input.reason,
          resourceId: input.resourceId,
          validAt: input.validAt,
          items: evaluated.map(({ derivedStoreKind, validation }) => ({
            derivedStoreKind,
            derivedItemRef: validation.derivedItemRef,
            state: validation.state,
            valid: validation.valid,
            dependencyId: validation.dependency?.id ?? null,
          })),
        }),
      )
      .digest("hex");

    const client = await this.db.pool.connect();
    try {
      await client.query("begin");
      const projectionId = randomUUID();
      const inserted = await client.query<DerivedProjectionRevisionRow>(
        `insert into derived_truth_projection_revisions(
           id,space_id,vault_id,truth_revision_hash,truth_revision_seq,
           trigger_event_id,reason,resource_id,evaluated_valid_at,
           projection_hash,item_count
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict(trigger_event_id) do nothing
         returning *`,
        [
          projectionId,
          input.spaceId,
          input.vaultId,
          input.truthRevisionHash,
          cutoff.seq,
          input.eventId,
          input.reason,
          input.resourceId,
          input.validAt,
          projectionHash,
          evaluated.length,
        ],
      );
      if (!inserted.rows[0]) {
        const concurrent = await client.query<DerivedProjectionRevisionRow>(
          `select * from derived_truth_projection_revisions
            where trigger_event_id=$1
            limit 1`,
          [input.eventId],
        );
        const row = concurrent.rows[0];
        if (!row) {
          throw new Error("TRUTH_DERIVED_PROJECTION_INSERT_FAILED");
        }
        await client.query("commit");
        const projection = normalizeDerivedProjectionRevision(row);
        if (
          projection.spaceId !== input.spaceId ||
          projection.vaultId !== input.vaultId ||
          projection.truthRevisionHash !== input.truthRevisionHash ||
          projection.reason !== input.reason ||
          projection.resourceId !== input.resourceId ||
          projection.evaluatedValidAt !== input.validAt
        ) {
          throw new Error("TRUTH_DERIVED_PROJECTION_EVENT_CONFLICT");
        }
        return projection;
      }

      if (evaluated.length > 0) {
        await client.query(
          `insert into derived_truth_projection_items(
             projection_revision_id,space_id,vault_id,derived_store_kind,
             derived_item_ref,state,valid,dependency_id,truth_revision_hash,
             truth_revision_seq,evaluated_valid_at
           )
           select $1,$2,$3,item.derived_store_kind,item.derived_item_ref,
                  item.state,item.valid,item.dependency_id,$4,$5,$6
             from jsonb_to_recordset($7::jsonb) as item(
               derived_store_kind text,
               derived_item_ref text,
               state text,
               valid boolean,
               dependency_id uuid
             )`,
          [
            projectionId,
            input.spaceId,
            input.vaultId,
            input.truthRevisionHash,
            cutoff.seq,
            input.validAt,
            JSON.stringify(
              evaluated.map(({ derivedStoreKind, validation }) => ({
                derived_store_kind: derivedStoreKind,
                derived_item_ref: validation.derivedItemRef,
                state: validation.state,
                valid: validation.valid,
                dependency_id: validation.dependency?.id ?? null,
              })),
            ),
          ],
        );
      }
      await client.query("commit");
      return normalizeDerivedProjectionRevision(inserted.rows[0]);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDerivedProjectionItems(
    rawQuery: DerivedTruthProjectionQuery,
  ): Promise<DerivedTruthProjectionItem[]> {
    const spaceId = requiredUuid(rawQuery.spaceId, "TRUTH_SPACE_ID_INVALID");
    const vaultId = requiredUuid(rawQuery.vaultId, "TRUTH_VAULT_ID_INVALID");
    const derivedItemRefs = [...new Set(rawQuery.derivedItemRefs ?? [])].map(
      (ref) => requiredText(ref, "TRUTH_DERIVED_ITEM_REF_INVALID", 4096),
    );
    if (derivedItemRefs.length > 5000) {
      throw new Error("TRUTH_DERIVED_ITEM_LIMIT_EXCEEDED");
    }
    const allowedKinds = new Set<DerivedTruthStoreKind>([
      "VECTOR",
      "GRAPH_SUMMARY",
      "COMMUNITY_REPORT",
      "CACHED_SYNTHESIS",
      "CONTEXT_FRAGMENT",
      "TASK_ARTIFACT",
    ]);
    if (
      rawQuery.derivedStoreKind !== undefined &&
      !allowedKinds.has(rawQuery.derivedStoreKind)
    ) {
      throw new Error("TRUTH_DERIVED_STORE_KIND_INVALID");
    }

    const cutoff = await this.revisionCutoff({
      spaceId,
      vaultId,
      ...(rawQuery.truthRevisionHash
        ? {
            truthRevisionHash: requiredHash(
              rawQuery.truthRevisionHash,
              "TRUTH_REVISION_HASH_INVALID",
            ),
          }
        : {}),
      authorizationPathPrefixes: [],
    });
    if (cutoff.seq === 0) return [];

    const values: unknown[] = [spaceId, vaultId, cutoff.seq];
    let where = "i.space_id=$1 and i.vault_id=$2 and i.truth_revision_seq<=$3";
    if (rawQuery.derivedStoreKind !== undefined) {
      values.push(rawQuery.derivedStoreKind);
      where += " and i.derived_store_kind=$" + values.length;
    }
    if (derivedItemRefs.length > 0) {
      values.push(derivedItemRefs);
      where += " and i.derived_item_ref=any($" + values.length + "::text[])";
    }

    const result = await this.db.pool.query<DerivedProjectionItemRow>(
      `select distinct on (i.derived_store_kind,i.derived_item_ref)
              i.*,p.trigger_event_id,p.reason,p.resource_id,p.projection_hash
         from derived_truth_projection_items i
         join derived_truth_projection_revisions p
           on p.id=i.projection_revision_id
        where ${where}
        order by i.derived_store_kind,i.derived_item_ref,
                 i.truth_revision_seq desc,p.created_at desc,p.id desc`,
      values,
    );
    return result.rows.map(normalizeDerivedProjectionItem);
  }
}
