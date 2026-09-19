import { submitAssuranceRun, type Postgres } from "@akp/postgres";
import type { EventHandlers } from "./event-worker.js";

type SourceChangeEventName =
  | "SourceRegistered"
  | "ExtractionCompleted"
  | "SourceWithdrawn"
  | "EvidenceInvalidated";

const SOURCE_CHANGE_DETECTORS = [
  "GROUNDING",
  "FRESHNESS",
  "CONTRADICTION",
  "DUPLICATE_IDENTITY",
  "TEMPORAL_CONSISTENCY",
  "LINK_ORPHAN",
] as const;

async function scheduleSourceChangeAssurance(
  db: Postgres,
  event: Parameters<NonNullable<EventHandlers["SourceRegistered"]>>[0],
): Promise<void> {
  const spaceId = String(event.spaceId ?? "");
  const vaultId = String(event.vaultId ?? "");
  if (!spaceId || !vaultId) {
    throw new Error("ASSURANCE_SOURCE_CHANGE_SCOPE_REQUIRED");
  }
  await submitAssuranceRun(db, {
    spaceId,
    vaultId,
    trigger: "SOURCE_CHANGE",
    detectors: [...SOURCE_CHANGE_DETECTORS],
    idempotencyKey: `source-change:${event.eventId}`,
  });
}

export function createContinuousAssuranceEventHandlers(
  db: Postgres,
): Pick<EventHandlers, SourceChangeEventName> {
  return {
    SourceRegistered: (event) => scheduleSourceChangeAssurance(db, event),
    ExtractionCompleted: (event) => scheduleSourceChangeAssurance(db, event),
    SourceWithdrawn: (event) => scheduleSourceChangeAssurance(db, event),
    EvidenceInvalidated: (event) => scheduleSourceChangeAssurance(db, event),
  };
}
