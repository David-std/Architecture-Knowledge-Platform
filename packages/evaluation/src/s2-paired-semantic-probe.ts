import { createHash } from "node:crypto";
import type {
  S2SemanticProbe,
  S2SemanticProbeInput,
  S2SemanticProbeResult,
} from "./s2-semantic-evidence.js";

export interface S2PairedSemanticJudgment {
  readonly questionRelevance: S2SemanticProbeResult;
  readonly claimEntailment: S2SemanticProbeResult;
}

/**
 * A single, revision-pinned local reader may return both separate decisions.
 * This saves repeated model inference, but is NOT independent corroboration.
 * F3 remains the sole source of quote and span validation.
 */
export interface S2PairedSemanticReader {
  readonly id: string;
  verify(input: S2SemanticProbeInput): Promise<S2PairedSemanticJudgment>;
}

export interface S2PairedSemanticPorts {
  readonly questionRelevanceProbe: S2SemanticProbe;
  readonly claimEntailmentProbe: S2SemanticProbe;
  readonly pairedJudgmentsNotIndependent: true;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
  clear(): void;
}

const evidenceKey = (input: S2SemanticProbeInput): string => {
  const hash = createHash("sha256");
  for (const part of [
    input.verifiedSourceId,
    input.verifiedSourceSha256,
    String(input.quoteStartUtf16),
    String(input.quoteEndUtf16),
    input.originalQuestion,
    input.answerClaim,
    input.exactQuote,
    input.originalBodyContext,
  ]) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(String(bytes.length)).update(":").update(bytes);
  }
  return hash.digest("hex");
};

/**
 * Bounded in-flight and completed result sharing within an evaluation run.
 * Cache identity includes question, complete claim, exact quote, revision SHA
 * and UTF-16 span; no cross-document or cross-claim result reuse.
 *
 * Failed calls are never cached. The semantic reader is responsible for its
 * own model timeout and valid structured output; the existing F3 validates
 * every returned decision, reason and literal evidence span.
 */
export function createS2PairedSemanticPorts(
  reader: S2PairedSemanticReader,
  maxEntries = 32,
): S2PairedSemanticPorts {
  if (
    !reader?.id?.trim() ||
    !reader.id.includes("@") ||
    typeof reader.verify !== "function" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 128
  ) {
    throw new Error("S2_PAIRED_READER_INVALID");
  }
  const cache = new Map<string, Promise<S2PairedSemanticJudgment>>();
  const read = (input: S2SemanticProbeInput) => {
    const key = evidenceKey(input);
    const existing = cache.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(() => reader.verify(input));
    cache.set(key, promise);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    // Avoid poisoning future attempts if the reader fails, while preserving
    // the original error for the awaiting F3 run.
    void promise.catch(() => {
      if (cache.get(key) === promise) cache.delete(key);
    });
    return promise;
  };
  return {
    questionRelevanceProbe: {
      id: reader.id + ":question",
      verify: async (input) => (await read(input)).questionRelevance,
    },
    claimEntailmentProbe: {
      id: reader.id + ":claim",
      verify: async (input) => (await read(input)).claimEntailment,
    },
    pairedJudgmentsNotIndependent: true,
    productionAdmission: false,
    releaseGateAccepted: false,
    clear: () => cache.clear(),
  };
}
