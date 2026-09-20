import { describe, expect, it } from "vitest";
import { decisionReadiness } from "./decision-readiness";

describe("decisionReadiness", () => {
  it("does not count an unaccepted agent suggestion as considered", () => {
    const state = decisionReadiness({
      candidateStatus: "CONSULTATION",
      alternatives: [
        { status: "CONSIDERED" },
        { status: "SUGGESTED" },
      ],
      objections: [],
      consultations: [{ status: "RESPONDED" }],
    });

    expect(state.consideredAlternatives).toBe(1);
    expect(state.selectionReady).toBe(false);
  });

  it("requires resolved objections before selection", () => {
    const blocked = decisionReadiness({
      candidateStatus: "CONSULTATION",
      alternatives: [
        { status: "CONSIDERED" },
        { status: "CONSIDERED" },
      ],
      objections: [{ status: "OPEN" }],
      consultations: [{ status: "RESPONDED" }],
    });
    expect(blocked.selectionReady).toBe(false);

    const ready = decisionReadiness({
      candidateStatus: "CONSULTATION",
      alternatives: [
        { status: "CONSIDERED" },
        { status: "CONSIDERED" },
      ],
      objections: [{ status: "RESOLVED" }],
      consultations: [{ status: "RESPONDED" }],
    });
    expect(ready.selectionReady).toBe(true);
  });

  it("separates capture readiness from promotion readiness", () => {
    expect(
      decisionReadiness({
        candidateStatus: "READY_FOR_REVIEW",
        alternatives: [],
        objections: [],
        consultations: [],
      }),
    ).toMatchObject({
      captureReady: true,
      promotionReady: false,
    });

    expect(
      decisionReadiness({
        candidateStatus: "READY_FOR_REVIEW",
        alternatives: [],
        objections: [],
        consultations: [],
        capturedEventId: "42",
      }),
    ).toMatchObject({
      captureReady: true,
      promotionReady: true,
    });
  });
});
