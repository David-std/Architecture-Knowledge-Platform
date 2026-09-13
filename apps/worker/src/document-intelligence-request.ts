const COMPLEXITIES = new Set([
  "simple",
  "digital",
  "complex",
  "scanned",
  "formula",
  "table-heavy",
  "unknown",
]);
const COST_POLICIES = new Set(["NO_PAID", "STANDARD", "QUALITY"]);
const PRIVACY_POLICIES = new Set([
  "LOCAL_ONLY",
  "LOCAL_PREFERRED",
  "REMOTE_ALLOWED",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function allowedString(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

/**
 * Build the only document-intelligence values the ingest worker may send to
 * the internal extractor. The durable job payload is treated as untrusted
 * even though the API validated it when the job was created: provider URLs,
 * provider names and arbitrary extractor configuration are never forwarded.
 */
export function documentIntelligenceFormFields(
  payload: Record<string, unknown>,
  jobId: string,
): Record<string, string> {
  const options = asRecord(payload.documentIntelligence) ?? {};
  const complexity =
    typeof options.complexity === "string" && COMPLEXITIES.has(options.complexity)
      ? options.complexity
      : null;
  const language =
    typeof options.language === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(options.language)
      ? options.language
      : null;
  const configuration = language ? { language } : {};

  return {
    ...(complexity ? { complexity } : {}),
    ocr_required: String(options.ocrRequired === true),
    tables: String(options.tables === true),
    formula: String(options.formula === true),
    cost_policy: allowedString(
      options.costPolicy,
      COST_POLICIES,
      "STANDARD",
    ),
    privacy_policy: allowedString(
      options.privacyPolicy,
      PRIVACY_POLICIES,
      "LOCAL_PREFERRED",
    ),
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
