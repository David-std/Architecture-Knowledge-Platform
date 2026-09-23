import { describe, expect, it } from "vitest";
import { sessionObjectGroups } from "./session-object";

describe("sessionObjectGroups", () => {
  it("separates durable captures and handoffs without inferring relationships", () => {
    const grouped = sessionObjectGroups([
      { id: 1, event_type: "DECISION_CANDIDATE" },
      { id: 2, event_type: "ARTIFACT" },
      { id: 3, event_type: "CLAIM_HANDOFF" },
      { id: 4, event_type: "NOTE" },
      { id: 5, event_type: "QUESTION" },
    ]);

    expect(grouped.captures.map((event) => event.id)).toEqual([1, 2]);
    expect(grouped.handoffs.map((event) => event.id)).toEqual([3]);
    expect(grouped.blockers.map((event) => event.id)).toEqual([5]);
  });
});
