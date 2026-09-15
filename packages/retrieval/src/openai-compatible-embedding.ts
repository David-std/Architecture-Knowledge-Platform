import { createHash } from "node:crypto";
import type { EmbeddingDescriptor, EmbeddingPort } from "./embeddings.js";

/**
 * Stable generation-level input conventions. The query/passage role is a
 * per-call concern and must not create a different persisted generation.
 */
export type OpenAICompatibleInputStrategy =
  "none" | "e5-query-passage-prefix-v1";

export type OpenAICompatibleEmbeddingRole = "query" | "passage";
/** Short alias shared by provider integrations that call this a role. */
export type OpenAICompatibleInputRole = OpenAICompatibleEmbeddingRole;

/** A fetch implementation is injectable so providers can be tested without a network. */
export type OpenAICompatibleFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleRetryPolicy {
  /** Number of retries after the first request. */
  maxRetries?: number;
  /** Delay before the first retry. */
  initialDelayMs?: number;
  /** Upper bound for exponential backoff. */
  maxDelayMs?: number;
  /**
   * An injectable wait function. Production callers may omit it to use an
   * abortable timer; tests can record the delay and resolve immediately.
   */
  backoff?: OpenAICompatibleBackoff;
}

export type OpenAICompatibleBackoff = (
  delayMs: number,
  attempt: number,
  signal: AbortSignal,
) => void | Promise<void>;

export interface OpenAICompatibleEmbeddingOptions {
  /** Host or base path. `/v1/embeddings` is appended when absent. */
  baseUrl: string;
  model: string;
  /** Optional provider/model revision used in the generation descriptor. */
  modelRevision?: string;
  /** Required because the endpoint does not make the generation dimension implicit. */
  dimensions: number;
  /** What the provider did to the returned vectors; no local normalization is applied. */
  normalization?: string;
  /** Stable generation strategy; query/passage is selected per embed call. */
  inputStrategy?: OpenAICompatibleInputStrategy;
  configurationVersion?: string;
  timeoutMs?: number;
  maxBatchSize?: number;
  /** Convenience aliases for retry.maxRetries/backoff. */
  maxRetries?: number;
  backoff?: OpenAICompatibleBackoff;
  retry?: OpenAICompatibleRetryPolicy;
  /** The key is held only in memory and is never included in the descriptor or errors. */
  apiKey?: string;
  /** Provider-specific headers. Their values are never copied into errors. */
  headers?: Readonly<Record<string, string>>;
  fetchImpl?: OpenAICompatibleFetch;
  /** Alias useful for callers that conventionally name their dependency `fetch`. */
  fetch?: OpenAICompatibleFetch;
}

export interface OpenAICompatibleEmbeddingRequestOptions {
  /** Cancel all remaining attempts. Timeout cancellation is independent. */
  signal?: AbortSignal;
  /** Role applied only when the configured strategy requires one. */
  role?: OpenAICompatibleEmbeddingRole;
}

export interface OpenAICompatibleEmbeddingData {
  object?: string;
  embedding: readonly number[];
  index: number;
  [key: string]: unknown;
}

export interface OpenAICompatibleEmbeddingUsage {
  prompt_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface OpenAICompatibleEmbeddingResponse {
  object?: string;
  data: readonly OpenAICompatibleEmbeddingData[];
  model?: string;
  usage?: OpenAICompatibleEmbeddingUsage;
  [key: string]: unknown;
}

export type OpenAICompatibleEmbeddingErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "ABORTED"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UPSTREAM_HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "DIMENSION_MISMATCH";

export interface OpenAICompatibleEmbeddingErrorDetails {
  /** Safe, provider-supplied machine-readable code when available. */
  upstreamCode?: string;
  /** Safe, redacted provider message when available. */
  upstreamMessage?: string;
  responseRequestId?: string;
  expectedDimensions?: number;
  actualDimensions?: number;
  expectedModel?: string;
  actualModel?: string;
  index?: number;
}

/**
 * Errors intentionally contain no request headers, API key, raw response body,
 * URL credentials, or upstream exception. This keeps them safe for logs and
 * audit metadata while preserving enough information for retry/triage.
 */
export class OpenAICompatibleEmbeddingError extends Error {
  readonly code: OpenAICompatibleEmbeddingErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly details: OpenAICompatibleEmbeddingErrorDetails | null;

  constructor(
    code: OpenAICompatibleEmbeddingErrorCode,
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      attempts?: number;
      details?: OpenAICompatibleEmbeddingErrorDetails | null;
    } = {},
  ) {
    super(message);
    this.name = "OpenAICompatibleEmbeddingError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
    this.details = options.details ?? null;
  }
}

export interface OpenAICompatibleEmbeddingDescriptor extends EmbeddingDescriptor {
  readonly inputStrategy: OpenAICompatibleInputStrategy;
  readonly runtime: "http";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5_000;

const TRANSIENT_STATUS = (status: number): boolean =>
  status === 408 ||
  status === 425 ||
  status === 429 ||
  (status >= 500 && status <= 599);

function failConfiguration(message: string): never {
  throw new OpenAICompatibleEmbeddingError("INVALID_CONFIGURATION", message);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 1
  ) {
    failConfiguration(`${name} must be a positive safe integer`);
  }
  return candidate;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < 0
  ) {
    failConfiguration(`${name} must be a non-negative safe integer`);
  }
  return candidate;
}

function normalizeEndpoint(baseUrl: string): string {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    failConfiguration("baseUrl must not be empty");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    failConfiguration("baseUrl must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    failConfiguration("baseUrl must use http or https");
  }
  // A query string is a common accidental place to put an API key. Reject it
  // rather than allowing a secret to appear in diagnostics or access logs.
  if (url.username || url.password || url.search || url.hash) {
    failConfiguration(
      "baseUrl must not contain credentials, query or fragment",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/embeddings") || path.endsWith("/embeddings")) {
    url.pathname = path;
  } else if (path.endsWith("/v1")) {
    url.pathname = `${path}/embeddings`;
  } else {
    url.pathname = `${path}/v1/embeddings`;
  }
  return url.toString();
}

function safeMessage(value: unknown, secrets: readonly string[]): string {
  let text = typeof value === "string" ? value : "Upstream request failed";
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/(\bhttps?:\/\/)[^/\s@]*@/giu, "$1[REDACTED]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(api[_ -]?key|authorization|credential|password|passwd|secret|token)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED]",
    )
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseErrorDetails(
  body: unknown,
  secrets: readonly string[],
): OpenAICompatibleEmbeddingErrorDetails {
  if (!isRecord(body)) return {};
  const nested = isRecord(body.error) ? body.error : body;
  const upstreamCode =
    typeof nested.code === "string"
      ? safeMessage(nested.code, secrets)
      : undefined;
  const upstreamMessage =
    typeof nested.message === "string"
      ? safeMessage(nested.message, secrets)
      : undefined;
  return {
    ...(upstreamCode ? { upstreamCode } : {}),
    ...(upstreamMessage ? { upstreamMessage } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function defaultBackoff(
  delayMs: number,
  _attempt: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The embedding request was aborted");
}

function asError(
  code: OpenAICompatibleEmbeddingErrorCode,
  message: string,
  options: ConstructorParameters<typeof OpenAICompatibleEmbeddingError>[2] = {},
): OpenAICompatibleEmbeddingError {
  return new OpenAICompatibleEmbeddingError(code, message, options);
}

/**
 * Adapter for OpenAI-compatible `/v1/embeddings` endpoints. It deliberately
 * has no provider SDK dependency and does not persist credentials.
 */
export class OpenAICompatibleEmbeddingAdapter implements EmbeddingPort {
  readonly descriptor: OpenAICompatibleEmbeddingDescriptor;

  readonly #endpoint: string;
  readonly #model: string;
  readonly #dimensions: number;
  readonly #normalization: string;
  readonly #inputStrategy: OpenAICompatibleInputStrategy;
  readonly #timeoutMs: number;
  readonly #maxBatchSize: number;
  readonly #maxRetries: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #backoff: OpenAICompatibleBackoff;
  readonly #apiKey: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #sensitiveValues: readonly string[];
  readonly #fetch: OpenAICompatibleFetch;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.#endpoint = normalizeEndpoint(options.baseUrl);
    if (typeof options.model !== "string" || !options.model.trim()) {
      failConfiguration("model must not be empty");
    }
    this.#model = options.model;
    this.#dimensions = positiveInteger(
      options.dimensions,
      options.dimensions,
      "dimensions",
    );
    this.#inputStrategy = options.inputStrategy ?? "none";
    if (
      this.#inputStrategy !== "none" &&
      this.#inputStrategy !== "e5-query-passage-prefix-v1"
    ) {
      failConfiguration(
        "inputStrategy must be none or e5-query-passage-prefix-v1",
      );
    }
    this.#timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxBatchSize = positiveInteger(
      options.maxBatchSize,
      DEFAULT_MAX_BATCH_SIZE,
      "maxBatchSize",
    );
    this.#maxRetries = nonNegativeInteger(
      options.maxRetries ?? options.retry?.maxRetries,
      DEFAULT_MAX_RETRIES,
      "maxRetries",
    );
    const initialDelayMs = nonNegativeInteger(
      options.retry?.initialDelayMs,
      DEFAULT_INITIAL_DELAY_MS,
      "initialDelayMs",
    );
    const maxDelayMs = nonNegativeInteger(
      options.retry?.maxDelayMs,
      DEFAULT_MAX_DELAY_MS,
      "maxDelayMs",
    );
    if (maxDelayMs < initialDelayMs) {
      failConfiguration(
        "maxDelayMs must be greater than or equal to initialDelayMs",
      );
    }
    this.#initialDelayMs = initialDelayMs;
    this.#maxDelayMs = maxDelayMs;
    this.#backoff = options.backoff ?? options.retry?.backoff ?? defaultBackoff;
    if (typeof this.#backoff !== "function") {
      failConfiguration("backoff must be a function");
    }
    this.#apiKey =
      options.apiKey === undefined
        ? undefined
        : typeof options.apiKey === "string"
          ? options.apiKey.trim() || undefined
          : (() => {
              failConfiguration("apiKey must be a string");
            })();
    const headerEntries = Object.entries(options.headers ?? {});
    if (
      headerEntries.some(
        ([key, value]) =>
          !key.trim() || typeof value !== "string" || !value.trim(),
      )
    ) {
      failConfiguration(
        "headers must contain non-empty string names and values",
      );
    }
    this.#headers = Object.freeze(Object.fromEntries(headerEntries));
    this.#sensitiveValues = Object.freeze(
      [
        ...new Set([this.#apiKey, ...headerEntries.map(([, value]) => value)]),
      ].filter((value): value is string => Boolean(value)),
    );
    const fetchImpl =
      options.fetchImpl ??
      options.fetch ??
      (typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : undefined);
    if (typeof fetchImpl !== "function") {
      failConfiguration("fetchImpl must be a function");
    }
    this.#fetch = fetchImpl;

    const modelRevision =
      options.modelRevision === undefined
        ? "unversioned"
        : typeof options.modelRevision === "string"
          ? options.modelRevision.trim() || "unversioned"
          : (() => {
              failConfiguration("modelRevision must be a string");
            })();
    const normalization =
      options.normalization === undefined
        ? "provider-defined"
        : typeof options.normalization === "string"
          ? options.normalization.trim() || "provider-defined"
          : (() => {
              failConfiguration("normalization must be a string");
            })();
    this.#normalization = normalization;
    const configurationVersion =
      options.configurationVersion === undefined
        ? `openai-compatible-http-v1:${modelRevision}:${this.#dimensions}:${normalization}:${this.#inputStrategy}`
        : typeof options.configurationVersion === "string"
          ? options.configurationVersion.trim() ||
            `openai-compatible-http-v1:${modelRevision}:${this.#dimensions}:${normalization}:${this.#inputStrategy}`
          : (() => {
              failConfiguration("configurationVersion must be a string");
            })();
    const descriptor = {
      provider: "openai-compatible-http",
      model: this.#model,
      modelRevision,
      dimensions: this.#dimensions,
      normalization,
      configurationVersion,
      inputStrategy: this.#inputStrategy,
      runtime: "http",
    } satisfies Omit<OpenAICompatibleEmbeddingDescriptor, "configurationHash">;
    // The endpoint selects the actual deployment behind an OpenAI-compatible
    // protocol, so it is part of generation identity. Persist only its digest:
    // credentials/query strings are rejected by normalizeEndpoint and API keys
    // never appear in this value. Non-sensitive routing headers do participate
    // because they can select a different deployment behind the same URL.
    const identityHeaders = Object.fromEntries(
      headerEntries
        .filter(
          ([key]) =>
            !/(?:api[_-]?key|authorization|credential|cookie|password|secret|token)/iu.test(
              key,
            ),
        )
        .map(([key, value]) => [key.toLowerCase(), value] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const configurationHash = createHash("sha256")
      .update(
        JSON.stringify({
          ...descriptor,
          endpoint: this.#endpoint,
          identityHeaders,
        }),
      )
      .digest("hex");
    this.descriptor = { ...descriptor, configurationHash };
  }

  /** Embed all texts, splitting requests while preserving caller order. */
  async embed(
    texts: readonly string[],
    requestOptions:
      | OpenAICompatibleEmbeddingRequestOptions
      | OpenAICompatibleEmbeddingRole = {},
  ): Promise<number[][]> {
    const normalizedOptions: OpenAICompatibleEmbeddingRequestOptions =
      typeof requestOptions === "string"
        ? { role: requestOptions }
        : requestOptions;
    if (!Array.isArray(texts)) {
      throw asError("INVALID_INPUT", "texts must be an array");
    }
    for (const text of texts) {
      if (typeof text !== "string") {
        throw asError(
          "INVALID_INPUT",
          "every embedding input must be a string",
        );
      }
    }
    if (
      normalizedOptions.role !== undefined &&
      normalizedOptions.role !== "query" &&
      normalizedOptions.role !== "passage"
    ) {
      throw asError("INVALID_INPUT", "role must be query or passage");
    }
    if (texts.length === 0) return [];
    if (normalizedOptions.signal?.aborted) {
      throw asError("ABORTED", "The embedding request was aborted", {
        retryable: false,
      });
    }

    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.#maxBatchSize) {
      const batch = texts.slice(start, start + this.#maxBatchSize);
      const result = await this.#embedBatch(
        batch,
        normalizedOptions.signal,
        normalizedOptions.role ?? "passage",
      );
      vectors.push(...result);
    }
    return vectors;
  }

  async #embedBatch(
    texts: readonly string[],
    callerSignal: AbortSignal | undefined,
    role: OpenAICompatibleEmbeddingRole,
  ): Promise<number[][]> {
    const input = texts.map((text) => this.#formatInput(text, role));
    for (let retry = 0; retry <= this.#maxRetries; retry += 1) {
      if (callerSignal?.aborted) {
        throw asError("ABORTED", "The embedding request was aborted", {
          attempts: retry + 1,
        });
      }
      try {
        return await this.#request(input, callerSignal, retry + 1);
      } catch (error) {
        const normalized =
          error instanceof OpenAICompatibleEmbeddingError
            ? error
            : asError(
                "NETWORK_ERROR",
                "The embedding provider could not be reached",
                {
                  retryable: true,
                  attempts: retry + 1,
                },
              );
        if (callerSignal?.aborted || normalized.code === "ABORTED") {
          throw asError("ABORTED", "The embedding request was aborted", {
            retryable: false,
            attempts: retry + 1,
          });
        }
        if (!normalized.retryable || retry >= this.#maxRetries) {
          throw normalized;
        }
        const delayMs = Math.min(
          this.#maxDelayMs,
          this.#initialDelayMs * 2 ** retry,
        );
        await this.#waitBeforeRetry(delayMs, retry + 1, callerSignal);
      }
    }
    throw asError(
      "NETWORK_ERROR",
      "The embedding provider could not be reached",
    );
  }

  #formatInput(text: string, role: OpenAICompatibleEmbeddingRole): string {
    if (this.#inputStrategy === "none") return text;
    const withoutExistingRolePrefix = text.replace(
      /^(?:query|passage):\s*/iu,
      "",
    );
    return `${role}: ${withoutExistingRolePrefix}`;
  }

  async #waitBeforeRetry(
    delayMs: number,
    attempt: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    const onCallerAbort = (): void => {
      controller.abort(abortReason(callerSignal as AbortSignal));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    try {
      await this.#backoff(delayMs, attempt, controller.signal);
      if (callerSignal?.aborted) {
        throw new Error("The embedding request was aborted");
      }
    } catch {
      if (callerSignal?.aborted) {
        throw asError("ABORTED", "The embedding request was aborted", {
          retryable: false,
          attempts: attempt,
        });
      }
      throw asError("NETWORK_ERROR", "The embedding retry backoff failed", {
        retryable: false,
        attempts: attempt,
      });
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async #request(
    input: readonly string[],
    callerSignal: AbortSignal | undefined,
    attempt: number,
  ): Promise<number[][]> {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Embedding request timed out"));
    }, this.#timeoutMs);
    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort(abortReason(callerSignal as AbortSignal));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    const signal = controller.signal;
    let response: Response;
    try {
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...this.#headers,
            ...(this.#apiKey
              ? { authorization: `Bearer ${this.#apiKey}` }
              : {}),
          },
          body: JSON.stringify({ model: this.#model, input }),
          signal,
        });
      } catch {
        if (timedOut) {
          throw asError("TIMEOUT", "The embedding provider request timed out", {
            retryable: true,
            attempts: attempt,
          });
        }
        if (callerAborted || callerSignal?.aborted) {
          throw asError("ABORTED", "The embedding request was aborted", {
            retryable: false,
            attempts: attempt,
          });
        }
        throw asError(
          "NETWORK_ERROR",
          "The embedding provider could not be reached",
          {
            retryable: true,
            attempts: attempt,
          },
        );
      }

      const body = await readJson(response);
      if (timedOut) {
        throw asError("TIMEOUT", "The embedding provider request timed out", {
          retryable: true,
          attempts: attempt,
        });
      }
      if (callerAborted || callerSignal?.aborted) {
        throw asError("ABORTED", "The embedding request was aborted", {
          retryable: false,
          attempts: attempt,
        });
      }
      if (!response.ok) {
        const details = responseErrorDetails(body, this.#sensitiveValues);
        const requestId = response.headers.get("x-request-id");
        const enriched = requestId
          ? {
              ...details,
              responseRequestId: safeMessage(requestId, this.#sensitiveValues),
            }
          : details;
        throw asError(
          "UPSTREAM_HTTP_ERROR",
          `OpenAI-compatible embedding request failed with HTTP ${response.status}`,
          {
            status: response.status,
            retryable: TRANSIENT_STATUS(response.status),
            attempts: attempt,
            details: enriched,
          },
        );
      }
      return this.#parseResponse(body, input.length, attempt);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  #parseResponse(
    body: unknown,
    expectedCount: number,
    attempt: number,
  ): number[][] {
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw asError(
        "INVALID_RESPONSE",
        "The embedding provider returned an invalid response",
        {
          attempts: attempt,
        },
      );
    }
    if (typeof body.model === "string" && body.model !== this.#model) {
      throw asError(
        "INVALID_RESPONSE",
        "The embedding provider returned an unexpected model",
        {
          attempts: attempt,
          details: {
            expectedModel: this.#model,
            actualModel: body.model,
          },
        },
      );
    }
    if (body.data.length !== expectedCount) {
      throw asError(
        "INVALID_RESPONSE",
        "The embedding provider returned an incomplete batch",
        {
          attempts: attempt,
        },
      );
    }
    const vectors: Array<number[] | undefined> = Array.from(
      { length: expectedCount },
      () => undefined,
    );
    for (const item of body.data) {
      if (!isRecord(item)) {
        throw asError(
          "INVALID_RESPONSE",
          "The embedding provider returned invalid data",
          {
            attempts: attempt,
          },
        );
      }
      const rawIndex = item.index;
      if (
        typeof rawIndex !== "number" ||
        !Number.isSafeInteger(rawIndex) ||
        rawIndex < 0 ||
        rawIndex >= expectedCount
      ) {
        throw asError(
          "INVALID_RESPONSE",
          "The embedding provider returned an invalid index",
          {
            attempts: attempt,
            details: typeof rawIndex === "number" ? { index: rawIndex } : null,
          },
        );
      }
      const index = rawIndex;
      if (vectors[index] !== undefined || !Array.isArray(item.embedding)) {
        throw asError(
          "INVALID_RESPONSE",
          "The embedding provider returned duplicate or invalid data",
          {
            attempts: attempt,
            details: { index },
          },
        );
      }
      const vector = item.embedding;
      if (
        !vector.every(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        )
      ) {
        throw asError(
          "INVALID_RESPONSE",
          "The embedding provider returned a non-finite vector",
          {
            attempts: attempt,
            details: { index },
          },
        );
      }
      if (vector.length !== this.#dimensions) {
        throw asError(
          "DIMENSION_MISMATCH",
          "The embedding provider returned an unexpected vector dimension",
          {
            attempts: attempt,
            details: {
              expectedDimensions: this.#dimensions,
              actualDimensions: vector.length,
              index,
            },
          },
        );
      }
      if (this.#normalization.toLowerCase() === "l2") {
        const norm = Math.hypot(...vector);
        if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
          throw asError(
            "INVALID_RESPONSE",
            "The embedding provider returned a vector that is not L2-normalized",
            {
              attempts: attempt,
              details: { index },
            },
          );
        }
      }
      vectors[index] = [...vector];
    }
    if (vectors.some((vector) => vector === undefined)) {
      throw asError(
        "INVALID_RESPONSE",
        "The embedding provider omitted an index",
        {
          attempts: attempt,
        },
      );
    }
    return vectors as number[][];
  }
}

/** Provider-neutral factory for dependency-injection sites. */
export function createOpenAICompatibleEmbeddingAdapter(
  options: OpenAICompatibleEmbeddingOptions,
): OpenAICompatibleEmbeddingAdapter {
  return new OpenAICompatibleEmbeddingAdapter(options);
}

/** Alias for code that uses the provider role rather than the transport name. */
export const OpenAICompatibleEmbeddingProvider =
  OpenAICompatibleEmbeddingAdapter;
