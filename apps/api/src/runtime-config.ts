export interface ApiRuntimeConfig {
  rateLimitMax: number;
  port: number;
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

export function loadApiRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiRuntimeConfig {
  return {
    rateLimitMax: integerSetting(
      env,
      "AKP_RATE_LIMIT_MAX",
      120,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    port: integerSetting(env, "PORT", 8080, 1, 65_535),
  };
}
