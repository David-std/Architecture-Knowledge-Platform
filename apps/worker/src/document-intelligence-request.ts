import {
  DocumentIntelligenceIngestOptions,
  type DocumentIntelligenceIngestOptions as DocumentIntelligenceOptions,
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
): Record<string, string> {
  const options = parsedOptions ?? parseDocumentIntelligenceOptions(payload);
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
    privacy_policy: options.privacyPolicy,
    ingest_job_id: jobId,
    configuration_json: JSON.stringify(configuration),
  };
}

export function appendDocumentIntelligenceFormFields(
  form: FormData,
  payload: Record<string, unknown>,
  jobId: string,
  parsedOptions?: DocumentIntelligenceOptions,
): void {
  for (const [name, value] of Object.entries(
    documentIntelligenceFormFields(payload, jobId, parsedOptions),
  )) {
    form.set(name, value);
  }
}
