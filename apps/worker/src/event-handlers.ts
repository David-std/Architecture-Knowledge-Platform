import type { GitKnowledgeStore } from "@akp/git-store";
import {
  incrementalIndex,
  normalizeManagedPath,
  type ManagedChange,
} from "@akp/indexing";
import type { Postgres } from "@akp/postgres";
import type { EventHandlers } from "./event-worker.js";

type IndexEvent = Parameters<
  NonNullable<EventHandlers["CorpusRevisionPublished"]>
>[0];
type RevisionRequest =
  "lexical_revision" | "vector_revision" | "graph_revision";

async function currentVaultCorpusRevision(
  db: Postgres,
  event: IndexEvent,
): Promise<{ spaceId: string; vaultId: string; corpusRevision: string }> {
  const spaceId = String(event.spaceId ?? event.payload.spaceId ?? "");
  const vaultId = String(event.vaultId ?? event.payload.vaultId ?? "");
  if (!spaceId || !vaultId) throw new Error("INDEX_REQUEST_SCOPE_REQUIRED");
  const result = await db.pool.query<{ corpus_revision: string }>(
    `select corpus_revision from vault_index_revisions
      where space_id=$1 and vault_id=$2`,
    [spaceId, vaultId],
  );
  const corpusRevision = result.rows[0]?.corpus_revision;
  if (!corpusRevision) throw new Error("INDEX_REQUEST_REVISION_NOT_READY");
  return { spaceId, vaultId, corpusRevision };
}

async function markIndexRequestComplete(
  db: Postgres,
  event: IndexEvent,
  field: RevisionRequest,
): Promise<void> {
  const scope = await currentVaultCorpusRevision(db, event);
  // Only advance a projection to the current corpus revision. This prevents a
  // delayed request from regressing a newer revision after a worker restart.
  await db.pool.query(
    `update vault_index_revisions
        set ${field} = corpus_revision,
            status = case when lexical_revision is not null
                                and graph_revision is not null
                                and context_pack_revision is not null
                           then status else 'DEGRADED' end,
            updated_at=now()
      where space_id=$1 and vault_id=$2`,
    [scope.spaceId, scope.vaultId],
  );
}

async function invalidateContextPackets(
  db: Postgres,
  event: IndexEvent,
): Promise<void> {
  const scope = await currentVaultCorpusRevision(db, event);
  await db.pool.query(
    `delete from context_packets
      where space_id=$1 and vault_id=$2 and corpus_revision<>$3`,
    [scope.spaceId, scope.vaultId, scope.corpusRevision],
  );
  await db.pool.query(
    `update vault_index_revisions
        set context_pack_revision=corpus_revision,updated_at=now()
      where space_id=$1 and vault_id=$2`,
    [scope.spaceId, scope.vaultId],
  );
}

async function enqueueImpactedEvaluation(
  db: Postgres,
  event: IndexEvent,
): Promise<void> {
  const scope = await currentVaultCorpusRevision(db, event);
  await db.pool.query(
    `insert into eval_runs(
       space_id,vault_id,eval_pack,corpus_revision,retrieval_config,metrics,
       status,trigger_event_id
     ) values($1,$2,$3,$4,$5::jsonb,'{}'::jsonb,'REQUESTED',$6)
     on conflict(trigger_event_id) where trigger_event_id is not null do nothing`,
    [
      scope.spaceId,
      scope.vaultId,
      typeof event.payload.evalPack === "string"
        ? event.payload.evalPack
        : "generic",
      scope.corpusRevision,
      JSON.stringify({
        trigger: "OUTBOX_IMPACTED",
        eventType: event.eventType,
      }),
      event.eventId,
    ],
  );
}

export function changesFromEvent(event: IndexEvent): ManagedChange[] {
  const changes: ManagedChange[] = [];
  const seen = new Map<string, number>();
  const relativeManagedPath = (value: string): string =>
    normalizeManagedPath(value).slice("managed/".length);
  const addChange = (
    value: unknown,
    fallbackOperation?: "CREATE" | "UPDATE",
  ): void => {
    if (typeof value === "string") {
      const normalized = relativeManagedPath(value);
      const existing = seen.get(normalized);
      if (existing !== undefined) {
        // Publication payloads carry changedPaths and tombstones separately.
        // A deleted path may therefore appear twice; retain the stronger
        // UPDATE operation so downstream documents are invalidated rather
        // than silently treated as an operation-less upsert.
        if (fallbackOperation === "UPDATE") {
          changes[existing] = {
            path: normalized,
            operation: fallbackOperation,
          };
        }
        return;
      }
      seen.set(normalized, changes.length);
      changes.push({
        path: normalized,
        ...(fallbackOperation ? { operation: fallbackOperation } : {}),
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.path !== "string") return;
    const normalized = relativeManagedPath(candidate.path);
    const operation =
      candidate.operation === "CREATE" || candidate.operation === "UPDATE"
        ? candidate.operation
        : fallbackOperation;
    const existing = seen.get(normalized);
    if (existing !== undefined) {
      if (operation === "UPDATE") {
        changes[existing] = { path: normalized, operation };
      }
      return;
    }
    seen.set(normalized, changes.length);
    changes.push({ path: normalized, ...(operation ? { operation } : {}) });
  };
  if (Array.isArray(event.payload.changedPaths)) {
    for (const change of event.payload.changedPaths) addChange(change);
  }
  if (Array.isArray(event.payload.tombstones)) {
    for (const tombstone of event.payload.tombstones) {
      addChange(tombstone, "UPDATE");
    }
  }
  return changes;
}

export function createIndexEventHandlers(
  db: Postgres,
  git: GitKnowledgeStore,
): Pick<
  EventHandlers,
  | "CorpusRevisionPublished"
  | "LexicalIndexUpdateRequested"
  | "VectorIndexUpdateRequested"
  | "GraphIndexUpdateRequested"
  | "ContextPackInvalidationRequested"
  | "ImpactedEvalRunRequested"
> {
  return {
    CorpusRevisionPublished: async (event) => {
      const spaceId = String(event.spaceId ?? event.payload.spaceId ?? "");
      const vaultId = String(event.vaultId ?? event.payload.vaultId ?? "");
      const revision = String(event.payload.revision ?? "");
      if (!spaceId || !vaultId || !revision) {
        throw new Error("INCREMENTAL_INDEX_SCOPE_REQUIRED");
      }
      // A publication event carries the managed-Git commit that was merged
      // for that review. If another publication has already advanced main,
      // this is a stale redelivery: indexing it would regress the projection
      // after the newer event has completed. The newer commit has its own
      // durable event, so acknowledge this event without replaying old bytes.
      if (typeof git.revision === "function") {
        const currentRevision = await git.revision();
        if (currentRevision !== revision) return;
      }
      await incrementalIndex(db, git, {
        spaceId,
        vaultId,
        revision,
        changes: changesFromEvent(event),
        eventId: event.eventId,
        ...(typeof event.payload.sourceId === "string"
          ? { sourceId: event.payload.sourceId }
          : {}),
      });
    },
    LexicalIndexUpdateRequested: (event) =>
      markIndexRequestComplete(db, event, "lexical_revision"),
    VectorIndexUpdateRequested: async (event) => {
      if (process.env.AKP_VECTOR_ENABLED === "true") {
        await markIndexRequestComplete(db, event, "vector_revision");
      } else {
        await currentVaultCorpusRevision(db, event);
      }
    },
    GraphIndexUpdateRequested: (event) =>
      markIndexRequestComplete(db, event, "graph_revision"),
    ContextPackInvalidationRequested: (event) =>
      invalidateContextPackets(db, event),
    ImpactedEvalRunRequested: (event) => enqueueImpactedEvaluation(db, event),
  };
}
