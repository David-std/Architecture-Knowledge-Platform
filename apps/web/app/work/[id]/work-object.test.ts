import { describe, expect, it } from "vitest";
import { relatedObjectId, relationDirection } from "./work-object";

describe("work object relations", () => {
  it("keeps explicit relation direction around the focused work object", () => {
    const outgoing = {
      id: "1",
      objectRefId: "ticket",
      targetRefId: "deployment",
      action: "LINKED",
      derivation: "SOURCE_EXPLICIT",
    };
    const incoming = {
      id: "2",
      objectRefId: "deployment",
      targetRefId: "ticket",
      action: "RESOLVED",
      derivation: "HUMAN_ASSERTED",
    };

    expect(relationDirection(outgoing, "ticket")).toBe("OUTGOING");
    expect(relatedObjectId(outgoing, "ticket")).toBe("deployment");
    expect(relationDirection(incoming, "ticket")).toBe("INCOMING");
    expect(relatedObjectId(incoming, "ticket")).toBe("deployment");
  });

  it("does not infer a relation from unrelated activity", () => {
    const event = {
      id: "3",
      objectRefId: "other",
      targetRefId: null,
      action: "UPDATED",
      derivation: "SOURCE_EXPLICIT",
    };

    expect(relationDirection(event, "ticket")).toBe("NONE");
    expect(relatedObjectId(event, "ticket")).toBeNull();
  });
});
