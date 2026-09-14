import { describe, expect, it, vi } from "vitest";
import { Postgres } from "../src/index.js";

describe("Postgres pool lifecycle", () => {
  it("handles idle-client pool errors without an uncaught EventEmitter failure", async () => {
    const onIdleClientError = vi.fn();
    const db = new Postgres(
      "postgres://akp:akp@127.0.0.1:1/akp-pool-listener-test",
      { onIdleClientError },
    );
    const error = Object.assign(
      new Error("terminating connection due to administrator command"),
      { code: "57P01" },
    );

    try {
      expect(() => db.pool.emit("error", error)).not.toThrow();
      expect(onIdleClientError).toHaveBeenCalledTimes(1);
      expect(onIdleClientError).toHaveBeenCalledWith(error);
    } finally {
      await db.close();
    }
  });

  it("keeps the pool error event handled when no reporter is configured", async () => {
    const db = new Postgres(
      "postgres://akp:akp@127.0.0.1:1/akp-pool-listener-test",
    );
    const error = Object.assign(new Error("connection terminated"), {
      code: "57P01",
    });

    try {
      expect(db.pool.listenerCount("error")).toBeGreaterThan(0);
      expect(() => db.pool.emit("error", error)).not.toThrow();
    } finally {
      await db.close();
    }
  });
});
