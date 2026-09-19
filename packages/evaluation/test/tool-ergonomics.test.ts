import { describe, expect, it } from "vitest";
import {
  aggregateToolErgonomics,
  parseToolSelection,
  scoreToolSelection,
  type ToolErgonomicsObservation,
} from "../src/tool-ergonomics.js";

describe("agent tool ergonomics evaluation", () => {
  it("parses bounded line-oriented tool selections", () => {
    expect(
      parseToolSelection(
        "CALL: akp_context || SEARCH\nCALL: akp_context || VERIFY",
      ),
    ).toEqual([
      { tool: "akp_context", action: "SEARCH" },
      { tool: "akp_context", action: "VERIFY" },
    ]);
    expect(() => parseToolSelection("akp_context SEARCH")).toThrow(
      "TOOL_SELECTION_FORMAT_INVALID",
    );
    expect(() =>
      parseToolSelection(
        "CALL: akp_search || NONE\nCALL: akp_search || NONE\nCALL: akp_search || NONE\nCALL: akp_search || NONE",
      ),
    ).toThrow("TOOL_SELECTION_TOO_MANY_CALLS");
  });

  it("scores missing, unexpected, and duplicate selections explicitly", () => {
    expect(
      scoreToolSelection(
        [
          { tool: "akp_context", action: "SEARCH" },
          { tool: "akp_context", action: "SEARCH" },
          { tool: "akp_context", action: "STATUS" },
        ],
        [{ tool: "akp_context", action: "SEARCH" }],
      ),
    ).toEqual({
      callsPerTask: 3,
      toolSelectionErrors: 2,
      missingExpectedCalls: 0,
      unexpectedCalls: 2,
      exactSelection: false,
    });

    expect(
      scoreToolSelection(
        [{ tool: "akp_build_context", action: null }],
        [{ tool: "akp_search", action: null }],
      ),
    ).toMatchObject({
      toolSelectionErrors: 2,
      missingExpectedCalls: 1,
      unexpectedCalls: 1,
      exactSelection: false,
    });
  });

  it("aggregates each arm without manufacturing a winner", () => {
    const observation: ToolErgonomicsObservation = {
      taskId: "knowledge-1",
      arm: "AKP_CONTEXT_FACADE",
      callsPerTask: 1,
      toolSelectionErrors: 0,
      exactSelection: true,
      inputTokens: 100,
      contextTokens: 200,
      providerPromptTokens: 320,
      providerCompletionTokens: 40,
      latencyMs: 50,
      correctness: 1,
      missedConstraints: 0,
      unsupportedClaims: 0,
      unsupportedClaimRate: 0,
      citationPrecision: 1,
    };
    expect(aggregateToolErgonomics([observation])).toEqual(
      expect.objectContaining({
        arm: "AKP_CONTEXT_FACADE",
        tasks: 1,
        meanCallsPerTask: 1,
        meanToolSelectionErrors: 0,
        exactSelectionRate: 1,
        meanCorrectness: 1,
        meanCitationPrecision: 1,
      }),
    );
  });
});
