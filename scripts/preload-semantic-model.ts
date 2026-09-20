import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { LocalSemanticEmbeddingAdapter } from "../packages/retrieval/src/local-semantic-embedding.js";

const maxAttempts = 3;
let lastError: unknown;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const adapter = new LocalSemanticEmbeddingAdapter({
    ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
      ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
      : {}),
    localFilesOnly: false,
    maxBatchSize: 1,
  });
  try {
    await adapter.load();
    await adapter.embedQueries(["semantic cache readiness probe"]);
    await adapter.dispose();
    process.stdout.write(
      `${JSON.stringify({
        status: "READY",
        attempt,
        cacheDir: Boolean(process.env.AKP_MODEL_CACHE_DIR?.trim()),
      })}\n`,
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    await adapter.dispose().catch(() => undefined);
    if (attempt < maxAttempts) {
      await sleep(attempt * 2_000);
    }
  }
}

throw new Error(
  `PINNED_SEMANTIC_MODEL_PREFETCH_FAILED_AFTER_${maxAttempts}_ATTEMPTS: ${
    lastError instanceof Error ? lastError.name : "UNKNOWN"
  }`,
);
