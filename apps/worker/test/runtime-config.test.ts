import { describe, expect, it } from "vitest";
import { loadWorkerRuntimeConfig } from "../src/runtime-config.js";

const variables = [
  "AKP_EVENT_MAX_ATTEMPTS",
  "AKP_EVENT_LEASE_SECONDS",
  "AKP_LINT_INTERVAL_MS",
  "AKP_PROVIDER_SYNC_INTERVAL_MS",
  "AKP_WORKER_DRAIN_DEADLINE_MS",
] as const;

describe("worker runtime configuration", () => {
  for (const name of variables) {
    it.each(["", "abc", "0", "-1", "9007199254740992"])(
      `rejects invalid ${name}=%j`,
      (value) => {
        expect(() =>
          loadWorkerRuntimeConfig({ [name]: value }, 90_000),
        ).toThrow(new RegExp(name));
      },
    );
  }

  it("preserves defaults and the existing one-minute lint floor", () => {
    expect(loadWorkerRuntimeConfig({}, 90_000)).toEqual({
      eventMaxAttempts: 8,
      eventLeaseSeconds: 60,
      lintIntervalMs: 24 * 60 * 60 * 1000,
      providerSyncIntervalMs: 60_000,
      drainDeadlineMs: 90_000,
    });
    expect(
      loadWorkerRuntimeConfig(
        {
          AKP_EVENT_MAX_ATTEMPTS: "3",
          AKP_EVENT_LEASE_SECONDS: "20",
          AKP_LINT_INTERVAL_MS: "1",
          AKP_PROVIDER_SYNC_INTERVAL_MS: "1",
          AKP_WORKER_DRAIN_DEADLINE_MS: "120000",
        },
        90_000,
      ),
    ).toEqual({
      eventMaxAttempts: 3,
      eventLeaseSeconds: 20,
      lintIntervalMs: 60_000,
      providerSyncIntervalMs: 10_000,
      drainDeadlineMs: 120_000,
    });
  });
});
