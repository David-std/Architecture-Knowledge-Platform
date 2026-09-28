import { describe, expect, it } from "vitest";
import { assertTestDatabaseSafety } from "../src/index.js";

describe("test database safety", () => {
  it("rejects a normal operational database during local tests", () => {
    expect(() =>
      assertTestDatabaseSafety("postgres://akp:akp@localhost:55432/akp", {
        NODE_ENV: "test",
      }),
    ).toThrow("TEST_DATABASE_NOT_DISPOSABLE:akp");
  });

  it("allows explicitly disposable local test databases", () => {
    expect(() =>
      assertTestDatabaseSafety(
        "postgres://akp:akp@localhost:55432/akp_test_local",
        { NODE_ENV: "test" },
      ),
    ).not.toThrow();
    expect(() =>
      assertTestDatabaseSafety(
        "postgres://akp:akp@localhost:55432/akp-browser-e2e",
        { NODE_ENV: "test" },
      ),
    ).not.toThrow();
  });

  it("allows CI and an explicit local escape hatch without weakening production", () => {
    expect(() =>
      assertTestDatabaseSafety("postgres://akp:akp@localhost:55432/akp", {
        NODE_ENV: "test",
        CI: "true",
      }),
    ).not.toThrow();
    expect(() =>
      assertTestDatabaseSafety("postgres://akp:akp@localhost:55432/akp", {
        NODE_ENV: "test",
        AKP_TEST_ALLOW_UNSAFE_DATABASE: "1",
      }),
    ).not.toThrow();
    expect(() =>
      assertTestDatabaseSafety("postgres://akp:akp@localhost:55432/akp", {
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });
});
