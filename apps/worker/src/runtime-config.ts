export interface WorkerRuntimeConfig {
  eventMaxAttempts: number;
  eventLeaseSeconds: number;
  lintIntervalMs: number;
  drainDeadlineMs: number;
}

function positiveIntegerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name} must be a positive safe integer; received ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

export function loadWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultDrainDeadlineMs = 60_000,
): WorkerRuntimeConfig {
  return {
    eventMaxAttempts: positiveIntegerSetting(env, "AKP_EVENT_MAX_ATTEMPTS", 8),
    eventLeaseSeconds: positiveIntegerSetting(
      env,
      "AKP_EVENT_LEASE_SECONDS",
      60,
    ),
    lintIntervalMs: Math.max(
      60_000,
      positiveIntegerSetting(env, "AKP_LINT_INTERVAL_MS", 24 * 60 * 60 * 1000),
    ),
    drainDeadlineMs: positiveIntegerSetting(
      env,
      "AKP_WORKER_DRAIN_DEADLINE_MS",
      defaultDrainDeadlineMs,
    ),
  };
}
