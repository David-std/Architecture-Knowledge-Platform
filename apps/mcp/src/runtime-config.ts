export interface McpRuntimeConfig {
  port: number;
}

export function loadMcpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpRuntimeConfig {
  return {
    port: Number(env.AKP_MCP_HTTP_PORT ?? 8081),
  };
}
