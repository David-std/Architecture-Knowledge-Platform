import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const base = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";
const token = process.env.AKP_API_TOKEN;

async function requestAkp<T>(
  route: string,
  init?: RequestInit,
): Promise<{ response: Response; body: T }> {
  const cookieStore = await cookies();
  const session = cookieStore.get("akp_session")?.value;
  const csrf = cookieStore.get("akp_csrf")?.value;
  if (!session && !token) {
    redirect("/login");
  }
  const method = String(init?.method ?? "GET").toUpperCase();
  const response = await fetch(`${base}${route}`, {
    ...init,
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...(session
        ? { cookie: `akp_session=${encodeURIComponent(session)}` }
        : {}),
      ...(!session && token ? { authorization: `Bearer ${token}` } : {}),
      ...(session && !["GET", "HEAD", "OPTIONS"].includes(method) && csrf
        ? { "x-csrf-token": csrf }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T;
  if (response.status === 401) redirect("/login");
  return { response, body };
}

export async function akp<T = Record<string, unknown>>(
  route: string,
  init?: RequestInit,
): Promise<T> {
  const { response, body } = await requestAkp<T>(route, init);
  if (!response.ok)
    throw new Error(`AKP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * Read an operator projection that may legitimately be outside the caller's
 * effective permission/path scope. Authentication failures still redirect and
 * unexpected server failures remain visible; only 403/404 become absence.
 */
export async function akpOptional<T = Record<string, unknown>>(
  route: string,
  init?: RequestInit,
): Promise<T | null> {
  const { response, body } = await requestAkp<T>(route, init);
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok)
    throw new Error(`AKP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
