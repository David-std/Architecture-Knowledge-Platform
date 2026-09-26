export interface WorkerRuntimeConfig {
  eventMaxAttempts: number;
  eventLeaseSeconds: number;
  lintIntervalMs: number;
  drainDeadlineMs: number;
}

export function loadWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultDrainDeadlineMs = 60_000,
): WorkerRuntimeConfig {
  return {
    eventMaxAttempts: Number(env.AKP_EVENT_MAX_ATTEMPTS ?? 8),
    eventLeaseSeconds: Number(env.AKP_EVENT_LEASE_SECONDS ?? 60),
    lintIntervalMs: Math.max(
      60_000,
      Number(env.AKP_LINT_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
    ),
    drainDeadlineMs: Number(
      env.AKP_WORKER_DRAIN_DEADLINE_MS ?? defaultDrainDeadlineMs,
    ),
  };
}
