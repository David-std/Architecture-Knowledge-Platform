import { describe, expect, it, vi } from "vitest";

vi.mock("@akp/postgres", () => ({
  Postgres: class {
    async health() { return true; }
    async close() {}
    pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  }
}));

describe("health", () => {
  it("builds the server", async () => {
    process.env.DATABASE_URL = "postgres://unused";
    process.env.NODE_ENV = "test";
    const { buildServer } = await import("../src/server.js");
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health/liveness" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "UP" });
    await app.close();
  });
});
