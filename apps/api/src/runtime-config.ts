export type EvidenceVerifierProvider =
  | "disabled"
  | "local-multilingual-qa"
  | "contextual-cross-encoder"
  | "cross-encoder-reader";

export interface EvidenceReaderRuntimeConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  shortlistSize: number;
  timeoutMs: number;
}

export interface ApiRuntimeConfig {
  rateLimitMax: number;
  port: number;
  evidenceVerifierProvider: EvidenceVerifierProvider;
  evidenceVerifierMode: "SHADOW" | "ENFORCE";
  evidenceVerifierMinimumSupportScore: number | null;
  evidenceVerifierMaxCandidates: number;
  evidenceVerifierLocalFilesOnly: boolean;
  evidenceReader: EvidenceReaderRuntimeConfig | null;
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}; received ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

function booleanSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `${name} must be "true" or "false"; received ${JSON.stringify(raw)}.`,
  );
}

function verifierProvider(env: NodeJS.ProcessEnv): EvidenceVerifierProvider {
  const raw = env.AKP_EVIDENCE_VERIFIER_PROVIDER ?? "disabled";
  if (
    raw === "disabled" ||
    raw === "local-multilingual-qa" ||
    raw === "contextual-cross-encoder" ||
    raw === "cross-encoder-reader"
  )
    return raw;
  throw new Error(
    `AKP_EVIDENCE_VERIFIER_PROVIDER must be "disabled", "local-multilingual-qa", "contextual-cross-encoder" or "cross-encoder-reader"; received ${JSON.stringify(raw)}.`,
  );
}

function optionalFraction(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > 1
  ) {
    throw new Error(
      `${name} must be a finite number in (0,1]; received ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

export function loadApiRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiRuntimeConfig {
  const evidenceVerifierProvider = verifierProvider(env);
  const evidenceVerifierMode = env.AKP_EVIDENCE_VERIFIER_MODE ?? "SHADOW";
  if (evidenceVerifierMode !== "SHADOW" && evidenceVerifierMode !== "ENFORCE") {
    throw new Error(
      `AKP_EVIDENCE_VERIFIER_MODE must be "SHADOW" or "ENFORCE"; received ${JSON.stringify(evidenceVerifierMode)}.`,
    );
  }
  // Only a verifier calibrated on the domain-disjoint admission pack may
  // decide support; the extractive QA reader remains a diagnostic.
  if (
    evidenceVerifierMode === "ENFORCE" &&
    evidenceVerifierProvider !== "contextual-cross-encoder" &&
    evidenceVerifierProvider !== "cross-encoder-reader"
  ) {
    throw new Error(
      `AKP_EVIDENCE_VERIFIER_MODE "ENFORCE" requires AKP_EVIDENCE_VERIFIER_PROVIDER "contextual-cross-encoder" or "cross-encoder-reader"; ${JSON.stringify(evidenceVerifierProvider)} remains SHADOW only.`,
    );
  }
  const evidenceVerifierMinimumSupportScore = optionalFraction(
    env,
    "AKP_EVIDENCE_VERIFIER_MIN_SCORE",
  );
  if (
    evidenceVerifierProvider === "local-multilingual-qa" &&
    evidenceVerifierMinimumSupportScore === null
  ) {
    throw new Error(
      "AKP_EVIDENCE_VERIFIER_MIN_SCORE is required when the local multilingual QA verifier is enabled.",
    );
  }

  let evidenceReader: EvidenceReaderRuntimeConfig | null = null;
  if (evidenceVerifierProvider === "cross-encoder-reader") {
    const baseUrl = env.AKP_EVIDENCE_READER_BASE_URL?.trim();
    const model = env.AKP_EVIDENCE_READER_MODEL?.trim();
    if (!baseUrl || !model) {
      throw new Error(
        "AKP_EVIDENCE_READER_BASE_URL and AKP_EVIDENCE_READER_MODEL are required when the cross-encoder reader verifier is enabled.",
      );
    }
    evidenceReader = {
      baseUrl,
      model,
      apiKey: env.AKP_EVIDENCE_READER_API_KEY?.trim() || null,
      shortlistSize: integerSetting(
        env,
        "AKP_EVIDENCE_READER_SHORTLIST",
        4,
        1,
        16,
      ),
      timeoutMs: integerSetting(
        env,
        "AKP_EVIDENCE_READER_TIMEOUT_MS",
        30_000,
        1_000,
        300_000,
      ),
    };
  }

  return {
    rateLimitMax: integerSetting(
      env,
      "AKP_RATE_LIMIT_MAX",
      120,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    port: integerSetting(env, "PORT", 8080, 1, 65_535),
    evidenceVerifierProvider,
    evidenceVerifierMode,
    evidenceVerifierMinimumSupportScore,
    evidenceVerifierMaxCandidates: integerSetting(
      env,
      "AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES",
      16,
      1,
      64,
    ),
    evidenceVerifierLocalFilesOnly: booleanSetting(
      env,
      "AKP_EVIDENCE_VERIFIER_LOCAL_FILES_ONLY",
      false,
    ),
    evidenceReader,
  };
}
