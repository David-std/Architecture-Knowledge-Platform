import { describe, expect, it } from "vitest";
import { searchResultPresentation } from "./search-result.js";

describe("search result presentation", () => {
  it("keeps exploratory candidates distinct from supported evidence", () => {
    expect(
      searchResultPresentation({
        retrievalOutcome: "EXPLORATORY_ONLY",
        hits: [],
        exploratoryHits: [{ id: "candidate-a" }, { id: "candidate-b" }],
      }),
    ).toEqual({
      supportedCount: 0,
      exploratoryCount: 2,
      outcome: "EXPLORATORY_ONLY",
    });
  });

  it("reports supported evidence without exploratory leakage", () => {
    expect(
      searchResultPresentation({
        retrievalOutcome: "SUPPORTED",
        hits: [{ id: "supported-a" }],
        exploratoryHits: [],
      }),
    ).toEqual({
      supportedCount: 1,
      exploratoryCount: 0,
      outcome: "SUPPORTED",
    });
  });

  it("distinguishes a true empty retrieval from rejected candidates", () => {
    expect(searchResultPresentation({ hits: [] })).toEqual({
      supportedCount: 0,
      exploratoryCount: 0,
      outcome: "NO_CANDIDATES",
    });
  });
});
