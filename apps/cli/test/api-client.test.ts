import { describe, expect, it, vi } from "vitest";
import {
  AkpApiClientError,
  positiveInteger,
  requestAkpApi,
} from "../src/api-client.js";

describe("CLI API client", () => {
  it.each(["", "abc", "0", "-1", "1.5", "9007199254740992"])(
    "rejects invalid positive integers locally: %j",
    (value) => {
      expect(() => positiveInteger(value)).toThrow(/positive integer/);
    },
  );

  it("preserves HTTP status and non-JSON diagnostics", async () => {
    await expect(
      requestAkpApi({
        baseUrl: "http://akp.invalid",
        token: "test-token",
        route: "/v1/search",
        fetchImpl: async () =>
          new Response("<html>proxy failure</html>", {
            status: 502,
            statusText: "Bad Gateway",
            headers: { "content-type": "text/html" },
          }),
      }),
    ).rejects.toMatchObject<Partial<AkpApiClientError>>({
      status: 502,
      code: "NON_JSON_RESPONSE",
    });
  });

  it("preserves an empty HTTP error instead of failing JSON parsing", async () => {
    await expect(
      requestAkpApi({
        baseUrl: "http://akp.invalid",
        token: "test-token",
        route: "/v1/status",
        fetchImpl: async () =>
          new Response(null, { status: 503, statusText: "Unavailable" }),
      }),
    ).rejects.toMatchObject<Partial<AkpApiClientError>>({
      status: 503,
      code: "AKP_HTTP_ERROR",
      responseBody: null,
    });
  });

  it("reuses an explicit idempotency key for POST recovery", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("idempotency-key")).toBe("retry-key-1234");
      return new Response(JSON.stringify({ id: "same-resource" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(
      requestAkpApi<{ id: string }>({
        baseUrl: "http://akp.invalid",
        token: "test-token",
        route: "/v1/ingest",
        init: { method: "POST", body: "{}" },
        idempotencyKey: "retry-key-1234",
        fetchImpl,
      }),
    ).resolves.toEqual({ id: "same-resource" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
