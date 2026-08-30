import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const base = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";
const token = process.env.AKP_API_TOKEN;

export async function akp<T = Record<string, unknown>>(
  route: string,
  init?: RequestInit,
): Promise<T> {
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
  if (!response.ok)
    throw new Error(`AKP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}
