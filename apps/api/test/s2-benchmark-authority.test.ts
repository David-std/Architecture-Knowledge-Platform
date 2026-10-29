import { describe, expect, it } from "vitest";
import {
  assertBenchmarkScopeBound,
  runEvaluation,
} from "../src/routes/evaluation.js";

const spaceId = "33333333-3333-4333-8333-333333333333";
const vaultId = "11111111-1111-4111-8111-111111111111";
const foreignVault = "22222222-2222-4222-8222-222222222222";
const authority = { spaceId, vaultId };
const input = { spaceId, vaultId, vaultIds: [vaultId], federated: false };

describe("S2.1 explicitly authorized benchmark retrieval boundary", () => {
  it("accepts only exact full-vault, single-vault non-federated scope", () => {
    expect(() => assertBenchmarkScopeBound(input, authority)).not.toThrow();
  });
  it("rejects cross-vault, cross-space, implicit scope and federation widening", () => {
    for (const request of [
      { ...input, spaceId: foreignVault },
      { ...input, vaultId: foreignVault },
      { ...input, vaultIds: [foreignVault] },
      { ...input, vaultIds: [vaultId, foreignVault], federated: true },
      { ...input, vaultIds: [] },
      { ...input, federated: true },
    ]) {
      expect(() => assertBenchmarkScopeBound(request, authority)).toThrow(
        "BENCHMARK_SCOPE_ESCALATION_DENIED",
      );
    }
  });
  it("does not allow unbranded direct runEvaluation even with valid IDs", async () => {
    await expect(
      runEvaluation(
        {} as Parameters<typeof runEvaluation>[0],
        {},
        "generic",
        authority as Parameters<typeof runEvaluation>[3],
      ),
    ).rejects.toThrow("BENCHMARK_AUTHORIZATION_REQUIRED");
  });
});
