import { withSpan } from "@akp/observability";
import {
  PostgresTemporalTruthStore,
  type DerivedTruthInvalidationReason,
  type RebuildDerivedTruthProjectionInput,
  type Postgres,
} from "@akp/postgres";
import type { EventHandlers } from "./event-worker.js";

type TruthInvalidationEvent = Parameters<
  NonNullable<EventHandlers["DerivedSupportInvalidationRequested"]>
>[0];

const resourcePayloadKey: Record<DerivedTruthInvalidationReason, string> = {
  FACT_SUPERSEDED: "factId",
  SOURCE_WITHDRAWN: "sourceEpisodeId",
  EVIDENCE_INVALIDATED: "evidenceId",
};

export function projectionInputFromEvent(
  event: TruthInvalidationEvent,
): RebuildDerivedTruthProjectionInput {
  const spaceId = String(event.spaceId ?? "");
  const vaultId = String(event.vaultId ?? "");
  const reason = String(
    event.payload.reason ?? "",
  ) as DerivedTruthInvalidationReason;
  const truthRevisionHash = String(event.payload.truthRevisionHash ?? "");
  const resourceKey = resourcePayloadKey[reason];
  if (!spaceId || !vaultId) {
    throw new Error("TRUTH_INVALIDATION_EVENT_SCOPE_REQUIRED");
  }
  if (!resourceKey) {
    throw new Error("TRUTH_INVALIDATION_EVENT_REASON_INVALID");
  }
  const resourceId = String(event.payload[resourceKey] ?? "");
  if (!resourceId) {
    throw new Error("TRUTH_INVALIDATION_EVENT_RESOURCE_REQUIRED");
  }
  if (event.resourceId !== resourceId) {
    throw new Error("TRUTH_INVALIDATION_EVENT_RESOURCE_MISMATCH");
  }
  if (!truthRevisionHash) {
    throw new Error("TRUTH_INVALIDATION_EVENT_REVISION_REQUIRED");
  }
  return {
    eventId: event.eventId,
    spaceId,
    vaultId,
    truthRevisionHash,
    reason,
    resourceId,
    validAt: event.occurredAt,
  };
}

export function createTruthMaintenanceHandlers(
  db: Postgres,
): Pick<EventHandlers, "DerivedSupportInvalidationRequested"> {
  const store = new PostgresTemporalTruthStore(db);
  return {
    DerivedSupportInvalidationRequested: (event) => {
      const input = projectionInputFromEvent(event);
      return withSpan(
        "truth.derived_projection.rebuild",
        {
          "akp.event.type": event.eventType,
          "akp.truth.invalidation_reason": input.reason,
        },
        async () => {
          await store.rebuildDerivedProjection(input);
        },
      );
    },
  };
}
