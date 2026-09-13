import { describe, expect, it } from "vitest";
import {
  OpenAICompatibleEmbeddingAdapter,
  type OpenAICompatibleFetch,
} from "../src/openai-compatible-embedding.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-for-test",
    },
  });
}

function requestBody(init: RequestInit | undefined): {
  model: string;
  input: string[];
} {
  return JSON.parse(String(init?.body)) as {
    model: string;
    input: string[];
  };
}

describe("OpenAI-compatible embedding adapter", () => {
  it("batches inputs, applies the strategy prefix and restores index order", async () => {
    const calls: Array<{
      endpoint: string | URL;
      body: { model: string; input: string[] };
    }> = [];
    const fetchImpl: OpenAICompatibleFetch = async (endpoint, init) => {
      const body = requestBody(init);
      calls.push({ endpoint, body });
      const data = body.input
        .map((_, index) => ({
          object: "embedding",
          index,
          embedding: [index + 1, index + 1, index + 1],
        }))
        .reverse();
      return jsonResponse(200, { object: "list", model: body.model, data });
    };
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 3,
      inputStrategy: "e5-query-passage-prefix-v1",
      maxBatchSize: 2,
      maxRetries: 0,
      fetchImpl,
    });

    const vectors = await adapter.embed(
      ["uno", "dos", "tres", "cuatro", "cinco"],
      "query",
    );

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.endpoint.toString())).toEqual([
      "http://provider.test/v1/embeddings",
      "http://provider.test/v1/embeddings",
      "http://provider.test/v1/embeddings",
    ]);
    expect(calls.map((call) => call.body.input)).toEqual([
      ["query: uno", "query: dos"],
      ["query: tres", "query: cuatro"],
      ["query: cinco"],
    ]);
    expect(vectors).toEqual([
      [1, 1, 1],
      [2, 2, 2],
      [1, 1, 1],
      [2, 2, 2],
      [1, 1, 1],
    ]);
    expect(adapter.descriptor).toMatchObject({
      provider: "openai-compatible-http",
      model: "embed-v1",
      dimensions: 3,
      inputStrategy: "e5-query-passage-prefix-v1",
      runtime: "http",
    });
  });

  it("leaves inputs unchanged when the generation strategy is none", async () => {
    let inputs: string[] | undefined;
    const fetchImpl: OpenAICompatibleFetch = async (_endpoint, init) => {
      inputs = requestBody(init).input;
      return jsonResponse(200, {
        model: "embed-v1",
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
      });
    };
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      inputStrategy: "none",
      fetchImpl,
    });

    await expect(
      adapter.embed(["query: uno", "dos"], "query"),
    ).resolves.toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(inputs).toEqual(["query: uno", "dos"]);
    expect(adapter.descriptor.inputStrategy).toBe("none");
  });

  it("sends optional auth only on the request and redacts it from typed errors", async () => {
    const secret = "sk-test-secret-do-not-log";
    let authorization: string | undefined;
    let calls = 0;
    const fetchImpl: OpenAICompatibleFetch = async (_endpoint, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? undefined;
      return jsonResponse(401, {
        error: {
          code: "invalid_api_key",
          message: `provider saw ${secret}`,
        },
      });
    };
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test/v1",
      model: "embed-v1",
      dimensions: 2,
      apiKey: secret,
      maxRetries: 4,
      fetchImpl,
    });

    let error: unknown;
    try {
      await adapter.embed(["texto"]);
    } catch (caught) {
      error = caught;
    }

    expect(calls).toBe(1);
    expect(authorization).toBe(`Bearer ${secret}`);
    expect(error).toMatchObject({
      code: "UPSTREAM_HTTP_ERROR",
      status: 401,
      retryable: false,
      attempts: 1,
      details: {
        upstreamCode: "invalid_api_key",
        upstreamMessage: "provider saw [REDACTED]",
      },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(adapter.descriptor)).not.toContain(secret);
  });

  it("redacts echoed credentials from custom headers and upstream text", async () => {
    const headerSecret = "custom-header-secret";
    const fetchImpl: OpenAICompatibleFetch = async () =>
      jsonResponse(401, {
        error: {
          code: "AUTHORIZATION:Bearer opaque-token",
          message: `header=${headerSecret}; password=hunter2; Authorization: Bearer opaque-token`,
        },
      });
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      headers: { "x-provider-token": headerSecret },
      maxRetries: 0,
      fetchImpl,
    });

    let serialized = "";
    try {
      await adapter.embed(["texto"]);
    } catch (error) {
      serialized = JSON.stringify(error);
    }
    expect(serialized).not.toContain(headerSecret);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("opaque-token");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts userinfo credentials from upstream URLs while preserving context", async () => {
    const fetchImpl: OpenAICompatibleFetch = async () =>
      jsonResponse(502, {
        error: {
          message:
            "upstream rejected https://user:hunter2@example.test/v1/embeddings",
        },
      });
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      maxRetries: 0,
      fetchImpl,
    });

    let error: unknown;
    try {
      await adapter.embed(["texto"]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "UPSTREAM_HTTP_ERROR",
      status: 502,
      details: {
        upstreamMessage:
          "upstream rejected https://[REDACTED]@example.test/v1/embeddings",
      },
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("example.test/v1/embeddings");
  });

  it("includes non-secret routing headers in generation identity", () => {
    const options = {
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      fetchImpl: async () => jsonResponse(500, {}),
    };
    const deploymentA = new OpenAICompatibleEmbeddingAdapter({
      ...options,
      headers: { "x-deployment": "deployment-a" },
    });
    const deploymentB = new OpenAICompatibleEmbeddingAdapter({
      ...options,
      headers: { "x-deployment": "deployment-b" },
    });
    const rotatedSecret = new OpenAICompatibleEmbeddingAdapter({
      ...options,
      headers: {
        "x-deployment": "deployment-a",
        "x-api-key": "rotated-secret",
      },
    });

    expect(deploymentA.descriptor.configurationHash).not.toBe(
      deploymentB.descriptor.configurationHash,
    );
    expect(deploymentA.descriptor.configurationHash).toBe(
      rotatedSecret.descriptor.configurationHash,
    );
    expect(JSON.stringify(rotatedSecret.descriptor)).not.toContain(
      "rotated-secret",
    );
  });

  it("retries 429 and 5xx responses with injected backoff and no test sleep", async () => {
    const statuses = [429, 503, 200];
    const delays: Array<{ delayMs: number; attempt: number }> = [];
    let calls = 0;
    const fetchImpl: OpenAICompatibleFetch = async (_endpoint, init) => {
      const status = statuses[calls++];
      if (status !== 200)
        return jsonResponse(status, { error: { message: "temporary" } });
      const body = requestBody(init);
      return jsonResponse(status, {
        model: body.model,
        data: [{ index: 0, embedding: [0.25, 0.75] }],
      });
    };
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      maxRetries: 2,
      retry: {
        initialDelayMs: 7,
        maxDelayMs: 20,
        backoff: async (delayMs, attempt, signal) => {
          expect(signal.aborted).toBe(false);
          delays.push({ delayMs, attempt });
        },
      },
      fetchImpl,
    });

    await expect(adapter.embed(["texto"])).resolves.toEqual([[0.25, 0.75]]);
    expect(calls).toBe(3);
    expect(delays).toEqual([
      { delayMs: 7, attempt: 1 },
      { delayMs: 14, attempt: 2 },
    ]);
  });

  it("aborts and retries transient request timeouts within policy", async () => {
    let calls = 0;
    let aborted = 0;
    const delays: number[] = [];
    const fetchImpl: OpenAICompatibleFetch = async (_endpoint, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls += 1;
        const signal = init?.signal as AbortSignal;
        signal.addEventListener(
          "abort",
          () => {
            aborted += 1;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      timeoutMs: 15,
      maxRetries: 2,
      retry: {
        initialDelayMs: 3,
        maxDelayMs: 10,
        backoff: async (delayMs) => {
          delays.push(delayMs);
        },
      },
      fetchImpl,
    });

    await expect(adapter.embed(["texto"])).rejects.toMatchObject({
      code: "TIMEOUT",
      retryable: true,
      attempts: 3,
    });
    expect(calls).toBe(3);
    expect(aborted).toBe(3);
    expect(delays).toEqual([3, 6]);
  });

  it("rejects a vector whose dimension differs from the configured generation", async () => {
    let calls = 0;
    const fetchImpl: OpenAICompatibleFetch = async () => {
      calls += 1;
      return jsonResponse(200, {
        model: "embed-v1",
        data: [{ index: 0, embedding: [1, 2] }],
      });
    };
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 3,
      maxRetries: 3,
      fetchImpl,
    });

    await expect(adapter.embed(["texto"])).rejects.toMatchObject({
      code: "DIMENSION_MISMATCH",
      retryable: false,
      details: {
        expectedDimensions: 3,
        actualDimensions: 2,
        index: 0,
      },
    });
    expect(calls).toBe(1);
  });

  it("rejects vectors that contradict an l2 normalization descriptor", async () => {
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      normalization: "l2",
      fetchImpl: async () =>
        jsonResponse(200, {
          model: "embed-v1",
          data: [{ index: 0, embedding: [3, 4] }],
        }),
    });

    await expect(adapter.embed(["texto"])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
      details: { index: 0 },
    });
  });

  it("does not retry non-transient 4xx responses", async () => {
    let calls = 0;
    const fetchImpl: OpenAICompatibleFetch = async () => {
      calls += 1;
      return jsonResponse(400, {
        error: { code: "invalid_request_error", message: "bad input" },
      });
    };
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      maxRetries: 5,
      fetchImpl,
    });

    await expect(adapter.embed(["texto"])).rejects.toMatchObject({
      code: "UPSTREAM_HTTP_ERROR",
      status: 400,
      retryable: false,
      attempts: 1,
    });
    expect(calls).toBe(1);
  });

  it("rejects duplicate or missing provider indexes as an invalid response", async () => {
    const fetchImpl: OpenAICompatibleFetch = async () =>
      jsonResponse(200, {
        model: "embed-v1",
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 0, embedding: [3, 4] },
        ],
      });
    const adapter = new OpenAICompatibleEmbeddingAdapter({
      baseUrl: "http://provider.test",
      model: "embed-v1",
      dimensions: 2,
      fetchImpl,
    });

    await expect(adapter.embed(["uno", "dos"])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });
});
