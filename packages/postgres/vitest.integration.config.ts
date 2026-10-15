import { assertTestDatabaseSafety } from "./src/database-safety.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for integration tests");
assertTestDatabaseSafety(databaseUrl, { ...process.env, NODE_ENV: "test" });

export { default } from "./vitest.config.js";
