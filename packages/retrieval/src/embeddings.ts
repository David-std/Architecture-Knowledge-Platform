import { createHash } from "node:crypto";

export interface EmbeddingDescriptor {
  provider: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  configurationVersion: string;
}

export interface EmbeddingPort {
  readonly descriptor: EmbeddingDescriptor;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const HASH_EMBEDDING_DESCRIPTOR: EmbeddingDescriptor = {
  provider: "local-deterministic",
  model: "hash-projection",
  modelRevision: "1",
  dimensions: 64,
  normalization: "l2",
  configurationVersion: "hash-projection-v1",
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

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) =>
      deterministicEmbedding(text, this.descriptor.dimensions),
    );
  }
}

export function toPgVector(vector: readonly number[]): string {
  return `[${vector.map((value) => Number(value.toFixed(8))).join(",")}]`;
}
