export type EvidenceVerifierProvider = "disabled" | "local-multilingual-qa";

export interface ApiRuntimeConfig {
  rateLimitMax: number;
  port: number;
  evidenceVerifierProvider: EvidenceVerifierProvider;
  evidenceVerifierMode: "SHADOW";
  evidenceVerifierMinimumSupportScore: number | null;
  evidenceVerifierMaxCandidates: number;
  evidenceVerifierLocalFilesOnly: boolean;
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
  if (raw === "disabled" || raw === "local-multilingual-qa") return raw;
  throw new Error(
    `AKP_EVIDENCE_VERIFIER_PROVIDER must be "disabled" or "local-multilingual-qa"; received ${JSON.stringify(raw)}.`,
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
  if (evidenceVerifierMode !== "SHADOW") {
    throw new Error(
      `AKP_EVIDENCE_VERIFIER_MODE may only be "SHADOW" until a verifier is promoted; received ${JSON.stringify(evidenceVerifierMode)}.`,
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
    evidenceVerifierMode: "SHADOW",
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
  };
}
