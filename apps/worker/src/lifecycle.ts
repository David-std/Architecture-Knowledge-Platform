import type { IngestState } from "@akp/domain";
import type { IntegrationEventType } from "@akp/postgres";

export interface LifecycleEventPlan {
  eventType: IntegrationEventType;
  followUps: readonly IntegrationEventType[];
}

/** Maps durable ingest state transitions to the integration event contract. */
export function lifecycleEventForState(
  next: IngestState,
): LifecycleEventPlan | null {
  switch (next) {
    case "ANALYZING":
      return { eventType: "ExtractionCompleted", followUps: [] };
    case "PLANNED":
      return { eventType: "CompilationRequested", followUps: [] };
    case "DRAFTED":
      return { eventType: "KnowledgeDraftCreated", followUps: [] };
    case "VALIDATING":
      return { eventType: "ValidationRequested", followUps: [] };
    case "MERGED":
      return { eventType: "KnowledgePublished", followUps: [] };
    case "INDEXED":
      return {
        eventType: "CorpusRevisionPublished",
        followUps: [
          "LexicalIndexUpdateRequested",
          "VectorIndexUpdateRequested",
          "GraphIndexUpdateRequested",
          "ContextPackInvalidationRequested",
          "ImpactedEvalRunRequested",
        ],
      };
    default:
      return null;
  }
}
