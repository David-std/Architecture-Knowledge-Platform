import { createServer } from "node:http";
import { pipeline } from "@huggingface/transformers";

const MODEL =
  process.env.AKP_LOCAL_AGENT_MODEL ?? "onnx-community/Qwen2.5-0.5B-Instruct";
const REVISION =
  process.env.AKP_LOCAL_AGENT_MODEL_REVISION ??
  "cc5cc01a65cc3ff17bdb73a7de33d879f62599b0";
const DTYPE = process.env.AKP_LOCAL_AGENT_DTYPE ?? "q4";
const PORT = Number(process.env.AKP_LOCAL_AGENT_PORT ?? "18081");

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("AKP_LOCAL_AGENT_PORT must be a valid TCP port.");
}

console.error(
  JSON.stringify({
    event: "model_load_start",
    model: MODEL,
    revision: REVISION,
    dtype: DTYPE,
  }),
);

async function loadGenerator() {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await pipeline("text-generation", MODEL, {
        dtype: DTYPE,
        revision: REVISION,
      });
    } catch (error) {
      lastError = error;
      console.error(
        JSON.stringify({
          event: "model_load_retry",
          attempt,
          maxAttempts: 3,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "MODEL_LOAD_FAILED"));
}

const generator = await loadGenerator();

console.error(
  JSON.stringify({
    event: "model_load_complete",
    model: MODEL,
    revision: REVISION,
    dtype: DTYPE,
  }),
);

function jsonResponse(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function requestBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function chatPrompt(messages: unknown[]): string {
  const turns = messages.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Each message must be an object.");
    }
    const message = value as Record<string, unknown>;
    if (
      !["system", "user", "assistant"].includes(String(message.role)) ||
      typeof message.content !== "string"
    ) {
      throw new Error("Each message needs a valid role and text content.");
    }
    const content = message.content
      .replaceAll("<|im_start|>", "[im_start]")
      .replaceAll("<|im_end|>", "[im_end]");
    return `<|im_start|>${message.role}\n${content}<|im_end|>\n`;
  });
  return `${turns.join("")}<|im_start|>assistant\n`;
}
const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return jsonResponse(response, 200, {
        status: "UP",
        provider: "transformers.js-local",
        model: MODEL,
        revision: REVISION,
        dtype: DTYPE,
      });
    }
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      return jsonResponse(response, 404, { error: "NOT_FOUND" });
    }

    const body = await requestBody(request);
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages) {
      return jsonResponse(response, 400, { error: "MESSAGES_REQUIRED" });
    }
    const requestedModel = typeof body.model === "string" ? body.model : MODEL;
    if (requestedModel !== MODEL) {
      return jsonResponse(response, 400, {
        error: "MODEL_MISMATCH",
        expected: MODEL,
        received: requestedModel,
      });
    }
    const requestedMax = Number(body.max_tokens ?? 320);
    const maxNewTokens = Number.isFinite(requestedMax)
      ? Math.max(64, Math.min(512, Math.trunc(requestedMax)))
      : 320;
    const requestedTemperature = Number(body.temperature ?? 0);
    const doSample =
      Number.isFinite(requestedTemperature) && requestedTemperature > 0;

    const started = performance.now();
    const output = await generator(chatPrompt(messages), {
      max_new_tokens: maxNewTokens,
      do_sample: doSample,
      ...(doSample
        ? { temperature: Math.max(0.01, Math.min(2, requestedTemperature)) }
        : {}),
      return_full_text: false,
    });
    const first = Array.isArray(output) ? output[0] : output;
    const record = first as Record<string, unknown> | undefined;
    const content =
      typeof record?.generated_text === "string"
        ? record.generated_text.trim()
        : null;
    if (!content) {
      throw new Error("Local model returned no assistant message.");
    }

    return jsonResponse(response, 200, {
      id: `local-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content },
        },
      ],
      provider_evidence: {
        implementation: "@huggingface/transformers",
        model: MODEL,
        revision: REVISION,
        dtype: DTYPE,
        latency_ms: performance.now() - started,
      },
    });
  } catch (error) {
    console.error(error);
    return jsonResponse(response, 500, {
      error: "LOCAL_MODEL_FAILURE",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(
    JSON.stringify({
      event: "provider_ready",
      url: `http://127.0.0.1:${PORT}`,
      model: MODEL,
      revision: REVISION,
      dtype: DTYPE,
    }),
  );
});

const close = () => server.close(() => process.exit(0));
process.once("SIGTERM", close);
process.once("SIGINT", close);
