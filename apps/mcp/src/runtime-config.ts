export interface McpRuntimeConfig {
  port: number;
}

export function loadMcpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpRuntimeConfig {
  const raw = env.AKP_MCP_HTTP_PORT;
  if (raw === undefined) return { port: 8081 };
  const port = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `AKP_MCP_HTTP_PORT must be an integer between 1 and 65535; received ${JSON.stringify(raw)}.`,
    );
  }
  return { port };
}
