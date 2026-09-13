import { DocumentIntelligenceIngestOptions } from "@akp/contracts";

/**
 * Build the only document-intelligence values the ingest worker may send to
 * the internal extractor. Durable job payloads are revalidated even though
 * the API validated them at submission time. Legacy jobs without P5 policy
 * receive safe defaults; malformed/tampered P5 policy fails closed.
 */
export function documentIntelligenceFormFields(
  payload: Record<string, unknown>,
  jobId: string,
): Record<string, string> {
  const parsed = DocumentIntelligenceIngestOptions.safeParse(
    payload.documentIntelligence ?? {},
  );
  if (!parsed.success) {
    throw new Error("INVALID_DOCUMENT_INTELLIGENCE_PAYLOAD");
  }
  const options = parsed.data;
  const configuration = options.language ? { language: options.language } : {};

  return {
    ...(options.complexity ? { complexity: options.complexity } : {}),
    ocr_required: String(options.ocrRequired),
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
): void {
  for (const [name, value] of Object.entries(
    documentIntelligenceFormFields(payload, jobId),
  )) {
    form.set(name, value);
  }
}
