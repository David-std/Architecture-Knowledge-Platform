import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const browserOrigin = "http://127.0.0.1:3000";

function loginRequest(origin = browserOrigin) {
  return new Request("http://localhost:3000/api/auth/session", {
    method: "POST",
    headers: {
      origin,
      host: "127.0.0.1:3000",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: "test-secret" }),
  });
}

describe("Web login form", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes both session cookies through and returns to the browser origin", async () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "akp_session=session; Path=/; HttpOnly; SameSite=Strict",
    );
    headers.append("set-cookie", "akp_csrf=csrf; Path=/; SameSite=Strict");
    const fetchMock = vi.fn(
      async () => new Response("{}", { status: 201, headers }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(loginRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${browserOrigin}/`);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer test-secret",
        }),
      }),
    );
  });

  it("rejects a cross-origin form before contacting the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(loginRequest("https://other.example"));

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an invalid token out of the redirect URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const response = await POST(loginRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${browserOrigin}/login?error=invalid`,
    );
  });
});
