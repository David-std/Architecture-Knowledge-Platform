export type QueryTransformationKind =
  | "DECOMPOSITION"
  | "MULTI_QUERY"
  | "HYDE";

export interface QueryTransformationInput {
  originalQuery: string;
  intent?: string;
  maxVariants?: number;
}

export interface QueryTransformationVariant {
  ordinal: number;
  kind: QueryTransformationKind;
  query: string;
  reason: string;
}

export interface QueryTransformationResult {
  transformerId: string;
  originalQuery: string;
  variants: QueryTransformationVariant[];
}

export interface QueryTransformerPort {
  readonly id: string;
  readonly kind: QueryTransformationKind;
  transform(
    input: QueryTransformationInput,
  ): Promise<QueryTransformationResult>;
}

export interface QueryTransformationTrace {
  transformerId: string;
  kind: QueryTransformationKind;
  originalQuery: string;
  variants: QueryTransformationVariant[];
}

export const DETERMINISTIC_QUERY_DECOMPOSER_ID =
  "deterministic-query-decomposition-v1";

const MAX_QUERY_CHARS = 4096;
const DEFAULT_MAX_VARIANTS = 4;
const HARD_MAX_VARIANTS = 8;

function normalizeQuery(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundedMaxVariants(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_VARIANTS;
  if (!Number.isInteger(value) || value < 1 || value > HARD_MAX_VARIANTS) {
    throw new Error("QUERY_TRANSFORM_MAX_VARIANTS_INVALID");
  }
  return value;
}

function validateOriginalQuery(value: string): string {
  const normalized = normalizeQuery(value);
  if (!normalized) throw new Error("QUERY_TRANSFORM_QUERY_REQUIRED");
  if (normalized.length > MAX_QUERY_CHARS) {
    throw new Error("QUERY_TRANSFORM_QUERY_TOO_LARGE");
  }
  return normalized;
}

function splitTechnicalQuery(query: string): string[] {
  return query
    .split(
      /(?:\s*;\s*|\s*\n+\s*|\s+\bvs\.?\b\s+|\s+\bversus\b\s+|\s+\bfrente\s+a\b\s+|\s+\bcontra\b\s+)/giu,
    )
    .map(normalizeQuery)
    .filter((part) => part.length >= 3);
}

export class DeterministicQueryDecomposer implements QueryTransformerPort {
  readonly id = DETERMINISTIC_QUERY_DECOMPOSER_ID;
  readonly kind = "DECOMPOSITION" as const;

  async transform(
    input: QueryTransformationInput,
  ): Promise<QueryTransformationResult> {
    const originalQuery = validateOriginalQuery(input.originalQuery);
    const maxVariants = boundedMaxVariants(input.maxVariants);
    const variants = [...new Set(splitTechnicalQuery(originalQuery))]
      .filter(
        (variant) =>
          variant.toLocaleLowerCase() !== originalQuery.toLocaleLowerCase(),
      )
      .slice(0, maxVariants)
      .map((query, index) => ({
        ordinal: index + 1,
        kind: this.kind,
        query,
        reason: "strong-delimiter decomposition",
      }));

    return {
      transformerId: this.id,
      originalQuery,
      variants,
    };
  }
}

export function validateQueryTransformationResult(
  result: QueryTransformationResult,
  expectedOriginalQuery: string,
  maxVariants = HARD_MAX_VARIANTS,
): QueryTransformationTrace {
  const originalQuery = validateOriginalQuery(expectedOriginalQuery);
  if (result.originalQuery !== originalQuery) {
    throw new Error("QUERY_TRANSFORM_ORIGINAL_QUERY_CHANGED");
  }
  if (!result.transformerId.trim()) {
    throw new Error("QUERY_TRANSFORM_TRANSFORMER_ID_REQUIRED");
  }
  if (
    !Number.isInteger(maxVariants) ||
    maxVariants < 1 ||
    maxVariants > HARD_MAX_VARIANTS
  ) {
    throw new Error("QUERY_TRANSFORM_MAX_VARIANTS_INVALID");
  }

  const seen = new Set<string>();
  const variants = result.variants.slice(0, maxVariants).map((variant, index) => {
    const query = validateOriginalQuery(variant.query);
    const key = query.toLocaleLowerCase();
    if (key === originalQuery.toLocaleLowerCase()) {
      throw new Error("QUERY_TRANSFORM_VARIANT_DUPLICATES_ORIGINAL");
    }
    if (seen.has(key)) {
      throw new Error("QUERY_TRANSFORM_VARIANT_DUPLICATE");
    }
    seen.add(key);
    if (variant.ordinal !== index + 1) {
      throw new Error("QUERY_TRANSFORM_VARIANT_ORDINAL_INVALID");
    }
    if (!variant.reason.trim()) {
      throw new Error("QUERY_TRANSFORM_VARIANT_REASON_REQUIRED");
    }
    return {
      ordinal: variant.ordinal,
      kind: variant.kind,
      query,
      reason: variant.reason.trim(),
    };
  });

  return {
    transformerId: result.transformerId.trim(),
    kind: variants[0]?.kind ?? "DECOMPOSITION",
    originalQuery,
    variants,
  };
}
