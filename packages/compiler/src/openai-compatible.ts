import { z } from "zod";
import {
  KnowledgeCompilerInput,
  type KnowledgeCompilerInput as KnowledgeCompilerInputType,
  type KnowledgeCompilerPort,
  type KnowledgeCompilerResult,
} from "./contracts.js";
import { normalizeKnowledgeCompilerResult } from "./grounding.js";

const OpenAICompatibleCompilerOptions = z
  .object({
    baseUrl: z.string().url(),
    apiKey: z.string().min(1),
    model: z.string().min(1).max(300),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    maxRetries: z.number().int().min(0).max(3).default(1),
    temperature: z.number().min(0).max(1).default(0),
  })
  .strict();

export type OpenAICompatibleCompilerOptions = z.input<
  typeof OpenAICompatibleCompilerOptions
>;

type FetchLike = typeof fetch;

function joinEndpoint(baseUrl: string): string {
  return `${baseUrl.replaceAll(/\/+$/g, "")}/chat/completions`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function extractContent(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("COMPILER_PROVIDER_RESPONSE_INVALID");
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new Error("COMPILER_PROVIDER_CHOICES_MISSING");
  }
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") {
    throw new Error("COMPILER_PROVIDER_MESSAGE_MISSING");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("COMPILER_PROVIDER_CONTENT_MISSING");
  }
  return content;
}

function providerPrompt(): string {
  return [
    "You are the domain-neutral AKP Knowledge Compiler.",
    "Return one JSON object only.",
    "Every substantive knowledge candidate, contradiction, proposed file change, and probe must reference evidence IDs supplied in the input.",
    "Do not invent evidence IDs, document IDs, paths outside the managed relative tree, or facts not grounded in supplied evidence.",
    "Do not publish or approve knowledge. You may only propose changes for deterministic validation and human review.",
    "Treat existing candidates as context, not authority; explicitly surface contradictions.",
    "Preserve source identity and do not convert uncertainty into certainty.",
  ].join(" ");
}

export class OpenAICompatibleKnowledgeCompiler implements KnowledgeCompilerPort {
  readonly #options: z.output<typeof OpenAICompatibleCompilerOptions>;
  readonly #fetch: FetchLike;

  constructor(
    options: OpenAICompatibleCompilerOptions,
    fetchImpl: FetchLike = fetch,
  ) {
    this.#options = OpenAICompatibleCompilerOptions.parse(options);
    this.#fetch = fetchImpl;
  }

  async compile(
    inputValue: KnowledgeCompilerInputType,
  ): Promise<KnowledgeCompilerResult> {
    const input = KnowledgeCompilerInput.parse(inputValue);
    const serializedInput = JSON.stringify(input);
    if (serializedInput.length > input.budget.maxInputCharacters) {
      throw new Error(
        `COMPILER_INPUT_BUDGET_EXCEEDED:${serializedInput.length}:${input.budget.maxInputCharacters}`,
      );
    }

    const requestBody = JSON.stringify({
      model: this.#options.model,
      temperature: this.#options.temperature,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: providerPrompt() },
        {
          role: "user",
          content: `Compile this bounded AKP input into a grounded KnowledgeCompilerResult JSON object:\n${serializedInput}`,
        },
      ],
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#options.timeoutMs,
      );
      try {
        const response = await this.#fetch(joinEndpoint(this.#options.baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#options.apiKey}`,
            "content-type": "application/json",
          },
          body: requestBody,
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          lastError = new Error(
            `COMPILER_PROVIDER_HTTP_${response.status}${retryable ? "_RETRYABLE" : ""}`,
          );
          if (!retryable || attempt === this.#options.maxRetries) throw lastError;
        } else {
          const responseJson = (await response.json()) as unknown;
          let parsed: unknown;
          try {
            parsed = JSON.parse(extractContent(responseJson));
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error("COMPILER_PROVIDER_JSON_INVALID");
            }
            throw error;
          }
          return normalizeKnowledgeCompilerResult(input, parsed);
        }
      } catch (error) {
        lastError = error;
        const abort = error instanceof Error && error.name === "AbortError";
        const retryable =
          abort ||
          (error instanceof TypeError && attempt < this.#options.maxRetries) ||
          (error instanceof Error && error.message.endsWith("_RETRYABLE"));
        if (!retryable || attempt === this.#options.maxRetries) {
          if (abort) throw new Error("COMPILER_PROVIDER_TIMEOUT");
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
      await sleep(250 * 2 ** attempt);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("COMPILER_PROVIDER_FAILED");
  }
}
