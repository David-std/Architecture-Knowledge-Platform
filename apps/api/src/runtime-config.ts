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
  shortlistStrategy: "score" | "document-diverse";
  confirmQuoteSufficiency: boolean;
  timeoutMs: number;
  /** Bounded completion-token budget; default 256 preserves current behavior. */
  maxOutputTokens: number;
  /** Optional OpenAI-compatible reasoning control; null omits it. */
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
  jsonResponseFormat: boolean;
}

export type EvidenceVerifierMode = "SHADOW" | "ENFORCE" | "LAYERED";

export interface ApiRuntimeConfig {
  rateLimitMax: number;
  port: number;
  evidenceVerifierProvider: EvidenceVerifierProvider;
  evidenceVerifierMode: EvidenceVerifierMode;
  evidenceVerifierMinimumSupportScore: number | null;
  evidenceVerifierMaxCandidates: number;
  evidenceVerifierLocalFilesOnly: boolean;
  /** Fail-closed bound for one LAYERED admission batch. */
  evidenceAdmissionTimeoutMs: number;
  evidenceAdmissionMinDistinctDocuments: number;
  evidenceAdmissionAbstainOnConflict: boolean;
  evidenceReader: EvidenceReaderRuntimeConfig | null;
  queryTransformProvider: QueryTransformProvider;
  queryTranslation: QueryTranslationRuntimeConfig | null;
}

export type QueryTransformProvider =
  "disabled" | "deterministic-decomposer" | "openai-compatible-translation";

export interface QueryTranslationRuntimeConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
  corpusLanguages: string[];
  timeoutMs: number;
  jsonResponseFormat: boolean;
}

function queryTransformProvider(
  env: NodeJS.ProcessEnv,
): QueryTransformProvider {
  // AKP_QUERY_TRANSFORM_ENABLED=true keeps selecting the deterministic
  // decomposer when no provider is named.
  const raw =
    env.AKP_QUERY_TRANSFORM_PROVIDER ??
    (env.AKP_QUERY_TRANSFORM_ENABLED === "true"
      ? "deterministic-decomposer"
      : "disabled");
  if (
    raw === "disabled" ||
    raw === "deterministic-decomposer" ||
    raw === "openai-compatible-translation"
  )
    return raw;
  throw new Error(
    `AKP_QUERY_TRANSFORM_PROVIDER must be "disabled", "deterministic-decomposer" or "openai-compatible-translation"; received ${JSON.stringify(raw)}.`,
  );
}

function queryTranslationConfig(
  env: NodeJS.ProcessEnv,
): QueryTranslationRuntimeConfig {
  const baseUrl = env.AKP_QUERY_TRANSLATION_BASE_URL?.trim();
  const model = env.AKP_QUERY_TRANSLATION_MODEL?.trim();
  const corpusLanguages = (env.AKP_QUERY_TRANSLATION_LANGUAGES ?? "")
    .split(",")
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  if (!baseUrl || !model || corpusLanguages.length === 0) {
    throw new Error(
      "AKP_QUERY_TRANSLATION_BASE_URL, AKP_QUERY_TRANSLATION_MODEL and AKP_QUERY_TRANSLATION_LANGUAGES are required when the openai-compatible-translation query transform is enabled.",
    );
  }
  if (corpusLanguages.some((code) => !/^[a-z]{2}$/u.test(code))) {
    throw new Error(
      `AKP_QUERY_TRANSLATION_LANGUAGES must list ISO 639-1 codes such as "es,en"; received ${JSON.stringify(env.AKP_QUERY_TRANSLATION_LANGUAGES)}.`,
    );
  }
  return {
    baseUrl,
    model,
    apiKey: env.AKP_QUERY_TRANSLATION_API_KEY?.trim() || null,
    corpusLanguages: [...new Set(corpusLanguages)],
    timeoutMs: integerSetting(
      env,
      "AKP_QUERY_TRANSLATION_TIMEOUT_MS",
      10_000,
      1_000,
      60_000,
    ),
    jsonResponseFormat: booleanSetting(
      env,
      "AKP_QUERY_TRANSLATION_JSON_RESPONSE_FORMAT",
      true,
    ),
  };
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
  const transformProvider = queryTransformProvider(env);
  const evidenceVerifierMode = env.AKP_EVIDENCE_VERIFIER_MODE ?? "SHADOW";
  if (
    evidenceVerifierMode !== "SHADOW" &&
    evidenceVerifierMode !== "ENFORCE" &&
    evidenceVerifierMode !== "LAYERED"
  ) {
    throw new Error(
      `AKP_EVIDENCE_VERIFIER_MODE must be "SHADOW", "ENFORCE" or "LAYERED"; received ${JSON.stringify(evidenceVerifierMode)}.`,
    );
  }
  // A relevance-only score does not establish that the requested fact is
  // present. Only the reader path can be explicitly selected for admission;
  // cross-encoder and extractive QA diagnostics remain shadow-only.
  if (
    evidenceVerifierMode !== "SHADOW" &&
    evidenceVerifierProvider !== "cross-encoder-reader"
  ) {
    throw new Error(
      `AKP_EVIDENCE_VERIFIER_MODE ${JSON.stringify(evidenceVerifierMode)} requires AKP_EVIDENCE_VERIFIER_PROVIDER "cross-encoder-reader"; ${JSON.stringify(evidenceVerifierProvider)} remains SHADOW only.`,
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
    const rawEffort = env.AKP_EVIDENCE_READER_REASONING_EFFORT?.trim() ?? "";
    if (
      rawEffort &&
      !["none", "minimal", "low", "medium", "high"].includes(rawEffort)
    ) {
      throw new Error(
        "AKP_EVIDENCE_READER_REASONING_EFFORT must be none, minimal, low, medium or high.",
      );
    }
    const shortlistStrategy =
      env.AKP_EVIDENCE_READER_SHORTLIST_STRATEGY ?? "score";
    if (
      shortlistStrategy !== "score" &&
      shortlistStrategy !== "document-diverse"
    ) {
      throw new Error(
        "AKP_EVIDENCE_READER_SHORTLIST_STRATEGY must be score or document-diverse",
      );
    }
    evidenceReader = {
      baseUrl,
      model,
      shortlistStrategy,
      confirmQuoteSufficiency: booleanSetting(
        env,
        "AKP_EVIDENCE_READER_CONFIRM_QUOTE",
        false,
      ),
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
      maxOutputTokens: integerSetting(
        env,
        "AKP_EVIDENCE_READER_MAX_OUTPUT_TOKENS",
        256,
        16,
        16_384,
      ),
      reasoningEffort: rawEffort
        ? (rawEffort as EvidenceReaderRuntimeConfig["reasoningEffort"])
        : null,
      // Some OpenAI-compatible hosts reject `response_format`; replies are
      // parsed and source-bound either way.
      jsonResponseFormat: booleanSetting(
        env,
        "AKP_EVIDENCE_READER_JSON_RESPONSE_FORMAT",
        true,
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
    // Below the 30 s HTTP request timeout so a slow reader yields an
    // INSUFFICIENT admission instead of a dropped request.
    evidenceAdmissionTimeoutMs: integerSetting(
      env,
      "AKP_EVIDENCE_ADMISSION_TIMEOUT_MS",
      25_000,
      10,
      60_000,
    ),
    evidenceAdmissionMinDistinctDocuments: integerSetting(
      env,
      "AKP_EVIDENCE_ADMISSION_MIN_DISTINCT_DOCUMENTS",
      1,
      1,
      16,
    ),
    evidenceAdmissionAbstainOnConflict: booleanSetting(
      env,
      "AKP_EVIDENCE_ADMISSION_ABSTAIN_ON_CONFLICT",
      false,
    ),
    evidenceReader,
    queryTransformProvider: transformProvider,
    queryTranslation:
      transformProvider === "openai-compatible-translation"
        ? queryTranslationConfig(env)
        : null,
  };
}
