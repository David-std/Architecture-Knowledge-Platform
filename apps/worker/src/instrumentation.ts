import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MinioObjectStore } from "@akp/object-store";
import {
  bootstrapOpenTelemetry,
  OpenTelemetryBridge,
  shutdownOpenTelemetry,
  withSpan,
} from "@akp/observability";

config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

bootstrapOpenTelemetry({ serviceName: "akp-worker" });

const telemetry = new OpenTelemetryBridge();
const knownExtractorProviders = new Set([
  "deterministic-baseline",
  "tesseract-ocr",
  "chunkr",
  "docling",
  "marker",
  "openai-compatible-transcription",
]);

function boundedExtractorProvider(value: unknown): string {
  return typeof value === "string" && knownExtractorProviders.has(value)
    ? value
    : "extractor";
}

async function providerFromResponse(response: Response): Promise<string> {
  try {
    const payload = (await response.clone().json()) as {
      extractor?: unknown;
      routing?: { selected_adapter?: unknown };
    };
    return boundedExtractorProvider(
      payload.routing?.selected_adapter ?? payload.extractor,
    );
  } catch {
    return "extractor";
  }
}

const originalPutImmutable = MinioObjectStore.prototype.putImmutable;
MinioObjectStore.prototype.putImmutable = async function (
  this: MinioObjectStore,
  input: Parameters<typeof originalPutImmutable>[0],
) {
  return withSpan("raw.store", { "akp.storage.kind": "raw" }, () =>
    originalPutImmutable.call(this, input),
  );
};

const originalFetch: typeof globalThis.fetch =
  globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const rawUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  let url: URL | null = null;
  try {
    url = new URL(rawUrl);
  } catch {
    return originalFetch(input, init);
  }
  if (url.pathname !== "/v1/extract" && url.pathname !== "/v1/extract-upload") {
    return originalFetch(input, init);
  }

  const started = performance.now();
  let provider = "extractor";
  try {
    return await withSpan(
      "extract.process",
      { "akp.extractor.transport": "http" },
      () =>
        withSpan(
          "extract.request",
          { "akp.extractor.transport": "http" },
          async () => {
            const response = await originalFetch(input, init);
            provider = await providerFromResponse(response);
            return response;
          },
        ),
    );
  } finally {
    telemetry.histogram(
      "extract_latency",
      (performance.now() - started) / 1000,
      { provider },
    );
  }
};

process.once("beforeExit", () => {
  void shutdownOpenTelemetry().catch(() => undefined);
});
