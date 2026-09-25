import { NextResponse } from "next/server";

const api = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";

function loginError(origin: string, error: "invalid" | "unavailable") {
  return NextResponse.redirect(new URL(`/login?error=${error}`, origin), 303);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  let browserOrigin: URL;
  try {
    browserOrigin = new URL(origin ?? "");
  } catch {
    return new Response(null, { status: 403 });
  }
  if (!host || browserOrigin.host !== host) {
    return new Response(null, { status: 403 });
  }
  const site = browserOrigin.origin;

  const form = await request.formData();
  const action = String(form.get("action") ?? "").trim();

  if (action === "logout") {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const csrf = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("akp_csrf="))
      ?.slice("akp_csrf=".length);
    if (cookieHeader.includes("akp_session=") && csrf) {
      let revoked: Response;
      try {
        revoked = await fetch(`${api}/v1/auth/session/revoke`, {
          method: "POST",
          cache: "no-store",
          headers: {
            cookie: cookieHeader,
            "x-csrf-token": csrf,
          },
        });
      } catch {
        return new Response(null, { status: 503 });
      }
      if (!revoked.ok && revoked.status !== 401) {
        return new Response(null, { status: revoked.status });
      }
    }
    const response = NextResponse.redirect(new URL("/login", site), 303);
    response.cookies.delete("akp_session");
    response.cookies.delete("akp_csrf");
    return response;
  }

  const token = String(form.get("token") ?? "").trim();
  if (!token || token.length > 4096) return loginError(site, "invalid");

  let upstream: Response;
  try {
    upstream = await fetch(`${api}/v1/auth/session`, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ durationMinutes: 480 }),
    });
  } catch {
    return loginError(site, "unavailable");
  }

  if (!upstream.ok) return loginError(site, "invalid");
  const cookies = upstream.headers.getSetCookie();
  if (
    !cookies.some((value) => value.startsWith("akp_session=")) ||
    !cookies.some((value) => value.startsWith("akp_csrf="))
  ) {
    return loginError(site, "unavailable");
  }

  const response = NextResponse.redirect(new URL("/", site), 303);
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}
