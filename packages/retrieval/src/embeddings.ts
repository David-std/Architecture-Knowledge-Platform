import { createHash } from "node:crypto";

export interface EmbeddingDescriptor {
  provider: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  /** Stable preprocessing convention shared by indexing and querying. */
  inputStrategy: string;
  configurationVersion: string;
  /** Reproducible inference runtime metadata; never include credentials. */
  runtime: string | object;
  /** Optional SHA-256 of canonical, non-secret provider configuration. */
  configurationHash?: string;
}

export type EmbeddingInputRole = "query" | "passage";

export interface EmbeddingRequestOptions {
  role?: EmbeddingInputRole;
  signal?: AbortSignal;
}

/** Provider-neutral semantic/deterministic embedding boundary. */
export interface EmbeddingProvider {
  readonly descriptor: EmbeddingDescriptor;
  embed(
    texts: readonly string[],
    request?: EmbeddingInputRole | EmbeddingRequestOptions,
  ): Promise<number[][]>;
}

/** Backwards-compatible name retained for existing package consumers. */
export interface EmbeddingPort extends EmbeddingProvider {}

export const HASH_EMBEDDING_DESCRIPTOR: EmbeddingDescriptor = {
  provider: "local-deterministic",
  model: "hash-projection",
  modelRevision: "1",
  dimensions: 64,
  normalization: "l2",
  inputStrategy: "deterministic-token-hash-v1",
  configurationVersion: "hash-projection-v1",
  runtime: "node:crypto/sha256",
};

export function deterministicEmbedding(
  text: string,
  dimensions = 64,
): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens =
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .match(/[\p{Letter}\p{Number}_-]+/gu) ?? [];
  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    const sign = (digest[2] ?? 0) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export class DeterministicEmbeddingAdapter implements EmbeddingPort {
  readonly descriptor = HASH_EMBEDDING_DESCRIPTOR;

  async embed(
    texts: readonly string[],
    _request?: EmbeddingInputRole | EmbeddingRequestOptions,
  ): Promise<number[][]> {
    return texts.map((text) =>
      deterministicEmbedding(text, this.descriptor.dimensions),
    );
  }
}

export function toPgVector(vector: readonly number[]): string {
  return `[${vector.map((value) => Number(value.toFixed(8))).join(",")}]`;
}
