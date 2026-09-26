import { randomUUID } from "node:crypto";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class AkpApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly responseBody: unknown;
  readonly idempotencyKey?: string;

  constructor(input: {
    message: string;
    status: number;
    code: string;
    responseBody: unknown;
    idempotencyKey?: string;
  }) {
    super(input.message);
    this.name = "AkpApiClientError";
    this.status = input.status;
    this.code = input.code;
    this.responseBody = input.responseBody;
    if (input.idempotencyKey) this.idempotencyKey = input.idempotencyKey;
  }
}

export function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function validIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 200) {
    throw new Error("Idempotency key must contain 8 to 200 characters.");
  }
  return key;
}

async function decodeResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      code: "NON_JSON_RESPONSE",
      contentType: response.headers.get("content-type"),
      preview: text.slice(0, 512),
    };
  }
}

function errorCode(body: unknown): string {
  if (
    body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).code === "string"
  ) {
    return String((body as Record<string, unknown>).code);
  }
  return "AKP_HTTP_ERROR";
}

export async function requestAkpApi<T>(input: {
  baseUrl: string;
  token: string | undefined;
  route: string;
  init?: RequestInit | undefined;
  idempotencyKey?: string | undefined;
  fetchImpl?: FetchLike;
}): Promise<T> {
  if (!input.token) {
    throw new Error("AKP_API_TOKEN is required for API commands.");
  }
  const method = String(input.init?.method ?? "GET").toUpperCase();
  const headers = new Headers(input.init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("authorization", `Bearer ${input.token}`);

  let idempotencyKey: string | undefined;
  if (method === "POST") {
    const supplied =
      input.idempotencyKey ?? headers.get("idempotency-key") ?? undefined;
    idempotencyKey = validIdempotencyKey(supplied ?? `cli-${randomUUID()}`);
    headers.set("idempotency-key", idempotencyKey);
  }

  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl}${input.route}`,
    {
      ...input.init,
      headers,
    },
  );
  const body = await decodeResponse(response);
  if (!response.ok) {
    const code = errorCode(body);
    const retryContext = idempotencyKey
      ? ` idempotency-key=${idempotencyKey}`
      : "";
    throw new AkpApiClientError({
      status: response.status,
      code,
      responseBody: body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      message: `AKP API ${response.status} ${response.statusText || code}:${retryContext} ${JSON.stringify(body)}`,
    });
  }
  if (
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).code === "NON_JSON_RESPONSE"
  ) {
    throw new AkpApiClientError({
      status: response.status,
      code: "NON_JSON_RESPONSE",
      responseBody: body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      message: `AKP API ${response.status} returned a non-JSON response.`,
    });
  }
  return body as T;
}
