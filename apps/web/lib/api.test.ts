import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redirect = vi.fn((destination: string): never => {
  throw new Error(`NEXT_REDIRECT:${destination}`);
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn(() => undefined),
  })),
}));

vi.mock("next/navigation", () => ({ redirect }));

describe("AKP web authentication boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    redirect.mockClear();
    vi.unstubAllGlobals();
    delete process.env.AKP_API_TOKEN;
  });

  afterEach(() => {
    delete process.env.AKP_API_TOKEN;
  });

  it("redirects an unauthenticated server render to login", async () => {
    const { akp } = await import("./api.js");

    await expect(akp("/v1/status")).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("redirects an expired server-side credential instead of rendering 500", async () => {
    process.env.AKP_API_TOKEN = "expired-test-credential";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "INVALID_TOKEN" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const { akp } = await import("./api.js");

    await expect(akp("/v1/status")).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
