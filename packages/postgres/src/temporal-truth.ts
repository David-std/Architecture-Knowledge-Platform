import { createHash, randomUUID } from "node:crypto";
import {
  CreateSourceEpisodeInput,
  CreateTruthSupportSetInput,
  RecordTemporalFactInput,
  SourceEpisode,
  TemporalFact,
  TemporalFactView,
  TemporalTruthQuery,
  TruthRevision,
  TruthSupportSet,
  type CreateSourceEpisodeInput as CreateSourceEpisodeInputType,
  type CreateTruthSupportSetInput as CreateTruthSupportSetInputType,
  type RecordTemporalFactInput as RecordTemporalFactInputType,
  type TemporalFactView as TemporalFactViewType,
  type TemporalTruthQuery as TemporalTruthQueryType,
  type TruthRevision as TruthRevisionType,
  type TruthSupportEvaluation,
  type TruthSupportSet as TruthSupportSetType,
} from "@akp/contracts";
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

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function normalizeRevision(row: RevisionRow): TruthRevisionType {
  return TruthRevision.parse({
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
  });
}

function normalizeSupportSet(row: SupportSetRow): TruthSupportSetType {
  return TruthSupportSet.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    state: row.state,
    factIds: row.fact_ids ?? [],
    evidenceIds: row.evidence_ids ?? [],
    sourceArtifactIds: row.source_artifact_ids ?? [],
    sourceRevisionHashes: row.source_revision_hashes ?? [],
    sourceEpisodeIds: row.source_episode_ids ?? [],
    alternativeSupportGroups: row.alternative_support_groups ?? [],
    createdAt: iso(row.created_at),
  });
}

function normalizeFact(row: FactRow) {
  return TemporalFact.parse({
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
  });
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
  ): Promise<TruthRevisionType> {
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
    rawInput: CreateSourceEpisodeInputType,
  ): Promise<SourceEpisode> {
    const input = CreateSourceEpisodeInput.parse(rawInput);
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
    const result = await this.db.pool.query(
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
    const row = result.rows[0] as Record<string, unknown>;
    return SourceEpisode.parse({
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
      locatorRefs: row.locator_refs,
    });
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
    rawInput: CreateTruthSupportSetInputType,
  ): Promise<TruthSupportSetType> {
    const input = CreateTruthSupportSetInput.parse(rawInput);
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
    rawInput: RecordTemporalFactInputType,
    metadata: {
      correlationId?: string | null;
      causationId?: string | null;
    } = {},
  ): Promise<{
    fact: ReturnType<typeof normalizeFact>;
    revision: TruthRevisionType;
  }> {
    const input = RecordTemporalFactInput.parse(rawInput);
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
  }): Promise<TruthRevisionType> {
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
  }): Promise<TruthRevisionType> {
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
  ): Promise<TruthRevisionType | null> {
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
    query: TemporalTruthQueryType,
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

  private async supportEvaluation(
    support: TruthSupportSetType,
    validAt: string,
    revisionSeq: number,
  ): Promise<TruthSupportEvaluation> {
    const [withdrawn, invalidEvidence, supersededFacts] = await Promise.all([
      support.sourceEpisodeIds.length
        ? this.db.pool.query<{ id: string }>(
            `select source_episode_id id from source_episode_withdrawals
              where source_episode_id=any($1::uuid[])
                and truth_revision_seq<=$2`,
            [support.sourceEpisodeIds, revisionSeq],
          )
        : { rows: [] as { id: string }[] },
      support.evidenceIds.length
        ? this.db.pool.query<{ id: string }>(
            `select evidence_id id from evidence_invalidations
              where evidence_id=any($1::uuid[])
                and truth_revision_seq<=$2`,
            [support.evidenceIds, revisionSeq],
          )
        : { rows: [] as { id: string }[] },
      support.factIds.length
        ? this.db.pool.query<{ id: string }>(
            `select distinct s.old_fact_id id
               from temporal_fact_supersessions s
               join temporal_facts replacement on replacement.id=s.new_fact_id
              where s.old_fact_id=any($1::uuid[])
                and s.truth_revision_seq<=$2
                and replacement.valid_from<=$3
                and (replacement.valid_to is null or replacement.valid_to>$3)`,
            [support.factIds, revisionSeq, validAt],
          )
        : { rows: [] as { id: string }[] },
    ]);
    const unavailable = new Set<string>([
      ...withdrawn.rows.map((row) => `source_episode:${row.id}`),
      ...invalidEvidence.rows.map((row) => `evidence:${row.id}`),
      ...supersededFacts.rows.map((row) => `fact:${row.id}`),
    ]);
    const directRefs = [
      ...support.sourceEpisodeIds.map((id) => `source_episode:${id}`),
      ...support.evidenceIds.map((id) => `evidence:${id}`),
      ...support.factIds.map((id) => `fact:${id}`),
      ...support.sourceArtifactIds.map((id) => `source_artifact:${id}`),
      ...support.sourceRevisionHashes.map((hash) => `revision:${hash}`),
    ];
    const valid =
      support.alternativeSupportGroups.length > 0
        ? support.alternativeSupportGroups.some((group) =>
            group.every((ref) => !unavailable.has(ref)),
          )
        : directRefs.every((ref) => !unavailable.has(ref));
    if (!valid) return "UNSUPPORTED";
    return support.state === "DISPUTED" ? "DISPUTED" : "SUPPORTED";
  }

  async listFacts(
    rawQuery: TemporalTruthQueryType,
  ): Promise<TemporalFactViewType[]> {
    const query = TemporalTruthQuery.parse(rawQuery);
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
      where += ` and f.recorded_at<=$${values.length}`;
    }
    if (query.changedSince) {
      values.push(query.changedSince);
      where += ` and (
        f.recorded_at>$${values.length}
        or exists(
          select 1 from temporal_fact_supersessions changed
           where changed.old_fact_id=f.id
             and changed.truth_revision_seq<=$3
             and changed.recorded_at>$${values.length}
        )
      )`;
    }
    if (query.mode === "CURRENT") {
      values.push(validAt);
      const validIndex = values.length;
      where += ` and f.valid_from<=$${validIndex}
        and (f.valid_to is null or f.valid_to>$${validIndex})
        and not exists(
          select 1
            from temporal_fact_supersessions s
            join temporal_facts replacement on replacement.id=s.new_fact_id
           where s.old_fact_id=f.id
             and s.truth_revision_seq<=$3
             and replacement.valid_from<=$${validIndex}
             and (replacement.valid_to is null or replacement.valid_to>$${validIndex})
        )`;
    }
    const result = await this.db.pool.query<FactRow>(
      `select f.* from temporal_facts f
        where ${where}
        order by f.recorded_at desc,f.id
        limit $4`,
      values,
    );
    const output: TemporalFactViewType[] = [];
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
        ? await this.supportEvaluation(support, validAt, cutoff.seq)
        : "UNSUPPORTED";
      if (query.mode === "CURRENT" && supportState === "UNSUPPORTED") continue;
      output.push(
        TemporalFactView.parse({
          ...fact,
          supportState,
          queryRevisionHash: cutoff.hash,
          queryRevisionSeq: cutoff.seq,
        }),
      );
    }
    return output;
  }

  async supportHistory(factId: string): Promise<{
    fact: ReturnType<typeof normalizeFact>;
    supportSet: TruthSupportSetType;
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
}
