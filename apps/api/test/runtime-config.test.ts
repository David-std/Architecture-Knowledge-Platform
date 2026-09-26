import { describe, expect, it } from "vitest";
import { loadApiRuntimeConfig } from "../src/runtime-config.js";

describe("API runtime configuration", () => {
  it.each(["", "abc", "0", "-1", "9007199254740992"])(
    "rejects invalid AKP_RATE_LIMIT_MAX=%j",
    (value) => {
      expect(() =>
        loadApiRuntimeConfig({ AKP_RATE_LIMIT_MAX: value }),
      ).toThrow(/AKP_RATE_LIMIT_MAX/);
    },
  );

  it.each(["", "abc", "0", "-1", "65536"])(
    "rejects invalid PORT=%j",
    (value) => {
      expect(() => loadApiRuntimeConfig({ PORT: value })).toThrow(/PORT/);
    },
  );

  it("accepts bounded integer settings and preserves defaults", () => {
    expect(loadApiRuntimeConfig({})).toEqual({
      rateLimitMax: 120,
      port: 8080,
    });
    expect(
      loadApiRuntimeConfig({ AKP_RATE_LIMIT_MAX: "240", PORT: "9090" }),
    ).toEqual({ rateLimitMax: 240, port: 9090 });
  });
});
