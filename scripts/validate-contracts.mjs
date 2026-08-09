import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const root = process.cwd();
const failures = [];

async function yaml(relativePath) {
  const raw = await readFile(path.join(root, relativePath), "utf8");
  const document = YAML.parseDocument(raw, { uniqueKeys: true });
  if (document.errors.length) {
    failures.push(
      ...document.errors.map((error) => `${relativePath}: ${error.message}`),
    );
  }
  return document.toJS();
}

async function json(relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    failures.push(
      `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

const openapi = await yaml("contracts/openapi.yaml");
const asyncapi = await yaml("contracts/asyncapi.yaml");
const mcp = await json("contracts/mcp-tools.json");
await json("contracts/context-packet.schema.json");
await json("contracts/knowledge-document.schema.json");

const requiredPaths = [
  "/v1/search",
  "/v1/context",
  "/v1/ingest",
  "/v1/reviews/{id}/decision",
  "/v1/schema/dry-run",
  "/v1/auth/session",
  "/v1/audit-events",
];
for (const required of requiredPaths) {
  if (!openapi?.paths?.[required])
    failures.push(`contracts/openapi.yaml: missing ${required}`);
}
if (!asyncapi?.channels || Object.keys(asyncapi.channels).length === 0) {
  failures.push("contracts/asyncapi.yaml: no channels declared");
}
if (!Array.isArray(mcp.tools) || mcp.tools.length < 18) {
  failures.push(
    "contracts/mcp-tools.json: expected at least 18 declared tools",
  );
}
for (const tool of mcp.tools ?? []) {
  if (!tool.name || !tool.permission || !tool.http || !mcp.version) {
    failures.push(
      `contracts/mcp-tools.json: incomplete tool ${tool.name ?? "<unnamed>"}`,
    );
  }
  if (tool.mutates && !tool.requiresIdempotencyKey) {
    failures.push(
      `contracts/mcp-tools.json: write tool lacks idempotency ${tool.name}`,
    );
  }
}

console.log(
  JSON.stringify({
    status: failures.length ? "FAILED" : "PASSED",
    openapiPaths: Object.keys(openapi?.paths ?? {}).length,
    asyncChannels: Object.keys(asyncapi?.channels ?? {}).length,
    mcpTools: mcp.tools?.length ?? 0,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
