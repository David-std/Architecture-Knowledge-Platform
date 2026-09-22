import {
  DocumentIntelligenceIngestOptions,
  ModelResidency,
  type DocumentIntelligenceIngestOptions as DocumentIntelligenceOptions,
  type ModelResidency as ModelResidencyValue,
} from "@akp/contracts";

export function parseDocumentIntelligenceOptions(
  payload: Record<string, unknown>,
): DocumentIntelligenceOptions {
  const parsed = DocumentIntelligenceIngestOptions.safeParse(
    payload.documentIntelligence ?? {},
  );
  if (!parsed.success) {
    throw new Error("INVALID_DOCUMENT_INTELLIGENCE_PAYLOAD");
  }
  return parsed.data;
}

export function documentIntelligenceFormFields(
  payload: Record<string, unknown>,
  jobId: string,
  parsedOptions?: DocumentIntelligenceOptions,
  persistedModelResidency?: ModelResidencyValue,
): Record<string, string> {
  const options = parsedOptions ?? parseDocumentIntelligenceOptions(payload);
  const modelResidency =
    persistedModelResidency ??
    (payload.modelResidency === undefined
      ? "EXTERNAL_ALLOWED"
      : ModelResidency.parse(payload.modelResidency));
  const privacyPolicy =
    modelResidency === "LOCAL_ONLY" ? "LOCAL_ONLY" : options.privacyPolicy;
  const configuration: Record<string, unknown> = {
    ...(options.language ? { language: options.language } : {}),
    ...(options.extractor ? { extractor: options.extractor } : {}),
    ...(options.ocr === undefined ? {} : { ocr: options.ocr }),
    ...(options.ocrEngine ? { ocr_engine: options.ocrEngine } : {}),
    ...(options.forceFullPageOcr === undefined
      ? {}
      : { force_full_page_ocr: options.forceFullPageOcr }),
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeout_seconds: options.timeoutSeconds }),
  };
  const ocrRequired = options.ocrRequired || options.ocr === true;

  return {
    ...(options.complexity ? { complexity: options.complexity } : {}),
    ocr_required: String(ocrRequired),
    tables: String(options.tables),
    formula: String(options.formula),
    cost_policy: options.costPolicy,
    privacy_policy: privacyPolicy,
    ingest_job_id: jobId,
    configuration_json: JSON.stringify(configuration),
  };
}

export function appendDocumentIntelligenceFormFields(
  form: FormData,
  payload: Record<string, unknown>,
  jobId: string,
  parsedOptions?: DocumentIntelligenceOptions,
  persistedModelResidency?: ModelResidencyValue,
): void {
  for (const [name, value] of Object.entries(
    documentIntelligenceFormFields(
      payload,
      jobId,
      parsedOptions,
      persistedModelResidency,
    ),
  )) {
    form.set(name, value);
  }
}
