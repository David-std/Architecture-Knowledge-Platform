import { describe, expect, it, vi } from "vitest";
import {
  assessRequestedAnswerCoverage,
  buildRequestedAnswerFollowUpQuery,
  runRequestedAnswerFollowUp,
  type RequestedAnswerSupportAssessment,
} from "../src/requested-answer-followup.js";

function assessment(supported: boolean): RequestedAnswerSupportAssessment {
  return {
    supported,
    reason: supported ? "PASSAGE_TEXT_SUPPORT" : "SUPPORT_NOT_DEMONSTRATED",
    supportedCandidateKeys: supported ? ["doc:unit"] : [],
  };
}

describe("requested-answer follow-up", () => {
  it.each([
    [
      "Who reviews release exceptions before deployment?",
      "reviews release exceptions before deployment",
    ],
    [
      "What artifact does gateway publish to the registry?",
      "publish gateway to registry",
    ],
    [
      "Who is the designated custodian of the audit ledger?",
      "custodian audit ledger",
    ],
    ["Where does collector persist telemetry?", "persist collector telemetry"],
    [
      "Quién es la persona responsable de la cola crítica?",
      "responsable cola critica",
    ],
    ["Dónde publica servicio eventos?", "publica servicio eventos"],
  ])("builds bounded projected query for %s", (query, expected) => {
    const coverage = assessRequestedAnswerCoverage(query, assessment(false));
    expect(coverage.status).toBe("MISSING");
    expect(coverage.followUpQuery).toBe(expected);
  });

  it("fails closed for an unsafe projection", () => {
    expect(
      buildRequestedAnswerFollowUpQuery({
        role: "OBJECT",
        relationAnchor: "publish registry",
        boundArgumentAnchors: ["gateway"],
        language: "EN",
        derivation: "SURFACE_GRAMMAR",
      }),
    ).toBeNull();
  });

  it("does not follow up when current evidence is already supported", async () => {
    const retrieve = vi.fn(async () => ["unexpected"]);
    const assess = vi.fn(() => assessment(true));
    const result = await runRequestedAnswerFollowUp({
      query: "Who reviews release exceptions before deployment?",
      initialCandidates: ["initial"],
      initialAssessment: assessment(true),
      retrieve,
      assess,
    });

    expect(result.outcome).toBe("SUPPORTED_INITIAL");
    expect(result.followUpAttemptCount).toBe(0);
    expect(result.followUpQuery).toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
  });

  it.each([
    "Why does gateway retry?",
    "How does worker recover?",
    "When does deployment start?",
    "Explain the deployment pipeline.",
  ])("does not follow up unsupported query form: %s", async (query) => {
    const retrieve = vi.fn(async () => ["unexpected"]);
    const assess = vi.fn(() => assessment(true));
    const result = await runRequestedAnswerFollowUp({
      query,
      initialCandidates: ["initial"],
      initialAssessment: assessment(false),
      retrieve,
      assess,
    });

    expect(result.outcome).toBe("INSUFFICIENT_KNOWLEDGE");
    expect(result.coverage.status).toBe("UNSUPPORTED_QUERY");
    expect(result.followUpAttemptCount).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
  });

  it("runs exactly one retrieval and reassesses against the original query", async () => {
    const original = "Where does collector persist telemetry?";
    const retrieve = vi.fn(async (query: string) => {
      expect(query).toBe("persist collector telemetry");
      return ["cold-archive"];
    });
    const assess = vi.fn((candidates: readonly string[], query: string) => {
      expect(candidates).toEqual(["cold-archive"]);
      expect(query).toBe(original);
      return assessment(true);
    });

    const result = await runRequestedAnswerFollowUp({
      query: original,
      initialCandidates: ["topical-only"],
      initialAssessment: assessment(false),
      retrieve,
      assess,
    });

    expect(result.outcome).toBe("SUPPORTED_FOLLOW_UP");
    expect(result.followUpAttemptCount).toBe(1);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(assess).toHaveBeenCalledTimes(1);
  });

  it("fails to insufficient knowledge after one unsupported follow-up", async () => {
    const retrieve = vi.fn(async () => ["still-topical"]);
    const assess = vi.fn(() => assessment(false));
    const result = await runRequestedAnswerFollowUp({
      query: "Who is the designated custodian of the audit ledger?",
      initialCandidates: ["replication-only"],
      initialAssessment: assessment(false),
      retrieve,
      assess,
    });

    expect(result.outcome).toBe("INSUFFICIENT_KNOWLEDGE");
    expect(result.followUpAttemptCount).toBe(1);
    expect(result.finalAssessment.supported).toBe(false);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(assess).toHaveBeenCalledTimes(1);
  });
});
