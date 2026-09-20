const SAFE_OPERATIONAL_ERROR_CODE = /^[A-Z][A-Z0-9_]*(?::[A-Z0-9_.-]+)*$/;

export interface OperationalErrorRecord {
  code: string;
  message: string;
}

function explicitOperationalCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SAFE_OPERATIONAL_ERROR_CODE.test(code)
    ? code
    : null;
}

/**
 * Durable job/event diagnostics must never become a side channel for source
 * contents, credentials, authorization headers, signed URLs, or private
 * endpoint details. Only explicit machine-safe codes are persisted verbatim.
 * Arbitrary exception messages are intentionally replaced rather than
 * heuristically scrubbed.
 */
export function operationalErrorRecord(error: unknown): OperationalErrorRecord {
  const explicit = explicitOperationalCode(error);
  if (explicit) return { code: explicit, message: explicit };

  const message = error instanceof Error ? error.message : String(error);
  if (SAFE_OPERATIONAL_ERROR_CODE.test(message)) {
    return { code: message, message };
  }

  return {
    code: "OPERATIONAL_FAILURE_REDACTED",
    message: "Operational failure details redacted.",
  };
}
