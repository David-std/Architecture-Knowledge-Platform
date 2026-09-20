import { z } from "zod";

export const ModelResidency = z.enum([
  "LOCAL_ONLY",
  "ORG_APPROVED",
  "EXTERNAL_ALLOWED",
]);
export type ModelResidency = z.infer<typeof ModelResidency>;

export const ModelRolePolicy = z
  .object({
    role: z.string().trim().min(1).max(100),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    endpointRef: z.string().trim().min(1).max(200).optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    concurrency: z.number().int().positive(),
    structuredOutputRequired: z.boolean().optional(),
    dataResidency: ModelResidency,
    fallbackRolesOrModels: z
      .array(z.string().trim().min(1).max(300))
      .max(20)
      .optional(),
    costCeiling: z.number().nonnegative().finite().optional(),
    degradationSafe: z.boolean().optional(),
  })
  .strict();
export type ModelRolePolicy = z.infer<typeof ModelRolePolicy>;

const MODEL_RESIDENCY_RANK: Record<ModelResidency, number> = {
  LOCAL_ONLY: 0,
  ORG_APPROVED: 1,
  EXTERNAL_ALLOWED: 2,
};

export function mostRestrictiveModelResidency(
  ...values: ModelResidency[]
): ModelResidency {
  if (values.length === 0) return "EXTERNAL_ALLOWED";
  return values.reduce((mostRestrictive, candidate) =>
    MODEL_RESIDENCY_RANK[candidate] < MODEL_RESIDENCY_RANK[mostRestrictive]
      ? candidate
      : mostRestrictive,
  );
}

export function isModelResidencyCompatible(
  required: ModelResidency,
  candidate: ModelResidency,
): boolean {
  return MODEL_RESIDENCY_RANK[candidate] <= MODEL_RESIDENCY_RANK[required];
}
