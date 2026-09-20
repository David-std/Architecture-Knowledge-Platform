import { ModelResidency, mostRestrictiveModelResidency } from "@akp/contracts";
import type { ModelResidency as ModelResidencyValue } from "@akp/contracts";

export function resolveSourceModelResidency(
  payload: Record<string, unknown>,
): ModelResidencyValue {
  let requested: ModelResidencyValue = "EXTERNAL_ALLOWED";
  if (payload.modelResidency !== undefined) {
    const parsed = ModelResidency.safeParse(payload.modelResidency);
    if (!parsed.success) throw new Error("INVALID_MODEL_RESIDENCY");
    requested = parsed.data;
  }

  const documentIntelligence =
    payload.documentIntelligence &&
    typeof payload.documentIntelligence === "object" &&
    !Array.isArray(payload.documentIntelligence)
      ? (payload.documentIntelligence as Record<string, unknown>)
      : null;
  const extractionBoundary =
    documentIntelligence?.privacyPolicy === "LOCAL_ONLY"
      ? "LOCAL_ONLY"
      : "EXTERNAL_ALLOWED";

  return mostRestrictiveModelResidency(requested, extractionBoundary);
}
