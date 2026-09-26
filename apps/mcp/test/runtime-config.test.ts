import { describe, expect, it } from "vitest";
import { loadMcpRuntimeConfig } from "../src/runtime-config.js";

describe("MCP HTTP runtime configuration", () => {
  it.each(["", "abc", "0", "-1", "65536"])(
    "rejects invalid AKP_MCP_HTTP_PORT=%j",
    (value) => {
      expect(() => loadMcpRuntimeConfig({ AKP_MCP_HTTP_PORT: value })).toThrow(
        /AKP_MCP_HTTP_PORT/,
      );
    },
  );

  it("accepts a valid port and preserves the default", () => {
    expect(loadMcpRuntimeConfig({})).toEqual({ port: 8081 });
    expect(loadMcpRuntimeConfig({ AKP_MCP_HTTP_PORT: "18081" })).toEqual({
      port: 18081,
    });
  });
});
