function databaseNameFromUrl(databaseUrl: string): string {
  try {
    return decodeURIComponent(
      new URL(databaseUrl).pathname.replace(/^\//u, ""),
    );
  } catch {
    throw new Error("DATABASE_URL_INVALID");
  }
}

function disposableDatabaseName(databaseName: string): boolean {
  return /(?:^|[_-])(test|e2e|ci|bench|benchmark)(?:$|[_-])/iu.test(
    databaseName,
  );
}

/**
 * Synthetic benchmark/fixture writers must never silently seed an operator
 * database. CI is already ephemeral; local execution requires an obviously
 * disposable database name or an explicit unsafe override.
 */
export function assertSyntheticFixtureDatabaseSafety(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.CI === "true" ||
    environment.AKP_SYNTHETIC_ALLOW_UNSAFE_DATABASE === "1"
  ) {
    return;
  }
  const databaseName = databaseNameFromUrl(databaseUrl);
  if (!disposableDatabaseName(databaseName)) {
    throw new Error(
      `SYNTHETIC_DATABASE_NOT_DISPOSABLE:${databaseName || "unknown"}`,
    );
  }
}

export function assertTestDatabaseSafety(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (
    environment.NODE_ENV !== "test" ||
    environment.CI === "true" ||
    environment.AKP_TEST_ALLOW_UNSAFE_DATABASE === "1"
  ) {
    return;
  }
  let databaseName = "";
  try {
    databaseName = databaseNameFromUrl(databaseUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL_INVALID");
  }
  if (!disposableDatabaseName(databaseName)) {
    throw new Error(
      `TEST_DATABASE_NOT_DISPOSABLE:${databaseName || "unknown"}`,
    );
  }
}
