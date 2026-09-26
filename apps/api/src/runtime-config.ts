export interface ApiRuntimeConfig {
  rateLimitMax: number;
  port: number;
}

export function loadApiRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiRuntimeConfig {
  return {
    rateLimitMax: Number(env.AKP_RATE_LIMIT_MAX ?? 120),
    port: Number(env.PORT ?? 8080),
  };
}
