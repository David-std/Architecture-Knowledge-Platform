import { describe, expect, it } from "vitest";
import { lifecycleEventForState } from "../src/lifecycle.js";

describe("ingest lifecycle event plan", () => {
  it("covers extraction, compilation, draft, validation, publication and index requests", () => {
    expect(lifecycleEventForState("ANALYZING")?.eventType).toBe(
      "ExtractionCompleted",
    );
    expect(lifecycleEventForState("PLANNED")?.eventType).toBe(
      "CompilationRequested",
    );
    expect(lifecycleEventForState("DRAFTED")?.eventType).toBe(
      "KnowledgeDraftCreated",
    );
    expect(lifecycleEventForState("VALIDATING")?.eventType).toBe(
      "ValidationRequested",
    );
    expect(lifecycleEventForState("MERGED")?.eventType).toBe(
      "KnowledgePublished",
    );
    expect(lifecycleEventForState("INDEXED")).toEqual({
      eventType: "CorpusRevisionPublished",
      followUps: [
        "LexicalIndexUpdateRequested",
        "VectorIndexUpdateRequested",
        "GraphIndexUpdateRequested",
        "ContextPackInvalidationRequested",
        "ImpactedEvalRunRequested",
      ],
    });
  });
});
