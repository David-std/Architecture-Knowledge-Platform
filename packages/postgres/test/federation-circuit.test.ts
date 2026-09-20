import { describe, expect, it } from "vitest";
import { federationCircuitBackoffSeconds } from "../src/team-context-fabric.js";

describe("federation peer circuit breaker", () => {
  it("opens after three consecutive failures and caps exponential backoff", () => {
    expect(federationCircuitBackoffSeconds(0)).toBe(0);
    expect(federationCircuitBackoffSeconds(2)).toBe(0);
    expect(federationCircuitBackoffSeconds(3)).toBe(8);
    expect(federationCircuitBackoffSeconds(4)).toBe(16);
    expect(federationCircuitBackoffSeconds(20)).toBe(256);
  });

  it("rejects invalid failure counters", () => {
    expect(() => federationCircuitBackoffSeconds(-1)).toThrow(
      "FEDERATION_FAILURE_COUNT_INVALID",
    );
    expect(() => federationCircuitBackoffSeconds(1.5)).toThrow(
      "FEDERATION_FAILURE_COUNT_INVALID",
    );
  });
});
