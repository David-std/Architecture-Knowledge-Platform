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

function requiredSet(schema) {
  return new Set(Array.isArray(schema?.required) ? schema.required : []);
}

function hasIdempotencyKey(operation) {
  return (operation?.parameters ?? []).some(
    (parameter) => parameter?.$ref === "#/components/parameters/IdempotencyKey",
  );
}

const openapi = await yaml("contracts/openapi.yaml");
const asyncapi = await yaml("contracts/asyncapi.yaml");
const mcp = await json("contracts/mcp-tools.json");
const knowledgeProfile = await json("contracts/knowledge-profile.schema.json");
await json("contracts/context-packet.schema.json");
await json("contracts/knowledge-document.schema.json");

const requiredPaths = [
  "/v1/search",
  "/v1/context",
  "/v1/ingest",
  "/v1/reviews/{id}/decision",
  "/v1/schema/dry-run",
  "/v1/schema/activate",
  "/v1/auth/session",
  "/v1/audit-events",
];
for (const required of requiredPaths) {
  if (!openapi?.paths?.[required])
    failures.push(`contracts/openapi.yaml: missing ${required}`);
}

const p2WorkspacePaths = {
  "/v1/sessions": { get: "workspace:read", post: "workspace:create" },
  "/v1/sessions/{id}/state": { get: "workspace:read" },
  "/v1/sessions/{id}/participants": {
    post: "workspace:manage-participants",
  },
  "/v1/sessions/{id}/claims": { post: "workspace:claim" },
  "/v1/sessions/{id}/claims/heartbeat": { post: "workspace:claim" },
  "/v1/sessions/{id}/claims/handoff": { post: "workspace:handoff" },
  "/v1/sessions/{id}/events": { post: "workspace:event:append" },
  "/v1/sessions/{id}/agent-processes": { post: "workspace:manage-agents" },
  "/v1/agent-processes/{id}/revoke": { post: "workspace:manage-agents" },
};
for (const [route, methods] of Object.entries(p2WorkspacePaths)) {
  for (const [method, principalAction] of Object.entries(methods)) {
    const operation = openapi?.paths?.[route]?.[method];
    if (!operation) {
      failures.push(
        `contracts/openapi.yaml: missing P2 ${method.toUpperCase()} ${route}`,
      );
      continue;
    }
    if (operation["x-akp-permission"] !== "knowledge:read") {
      failures.push(
        `contracts/openapi.yaml: P2 ${method.toUpperCase()} ${route} must require knowledge:read`,
      );
    }
    if (operation["x-akp-principal-action"] !== principalAction) {
      failures.push(
        `contracts/openapi.yaml: P2 ${method.toUpperCase()} ${route} must require principal action ${principalAction}`,
      );
    }
  }
}

const sessionStartSchema =
  openapi?.paths?.["/v1/sessions"]?.post?.requestBody?.content?.[
    "application/json"
  ]?.schema ?? {};
const sessionStartRequired = requiredSet(sessionStartSchema);
for (const field of ["purpose", "spaceId", "vaultId"]) {
  if (!sessionStartRequired.has(field)) {
    failures.push(
      `contracts/openapi.yaml: session start missing required ${field}`,
    );
  }
}

for (const route of [
  "/v1/sessions",
  "/v1/sessions/{id}/participants",
  "/v1/sessions/{id}/claims",
  "/v1/sessions/{id}/claims/heartbeat",
  "/v1/sessions/{id}/claims/handoff",
  "/v1/sessions/{id}/events",
  "/v1/agent-processes/{id}/revoke",
]) {
  if (!hasIdempotencyKey(openapi?.paths?.[route]?.post)) {
    failures.push(
      `contracts/openapi.yaml: P2 write ${route} must declare Idempotency-Key`,
    );
  }
}
const agentIssue = openapi?.paths?.["/v1/sessions/{id}/agent-processes"]?.post;
if (
  agentIssue?.["x-akp-idempotency-exempt"] !== true ||
  agentIssue?.["x-akp-secret-response"] !== true
) {
  failures.push(
    "contracts/openapi.yaml: agent-process issuance must be marked one-time-secret and idempotency-exempt",
  );
}

if (!asyncapi?.channels?.workspaceEvents) {
  failures.push(
    "contracts/asyncapi.yaml: missing durable workspaceEvents channel",
  );
}
if (
  !asyncapi?.components?.schemas?.AuditEventPayload?.properties?.principalId
) {
  failures.push(
    "contracts/asyncapi.yaml: audit events must expose principalId",
  );
}
const workspaceEvent = asyncapi?.components?.schemas?.WorkspaceEventPayload;
const workspaceEventRequired = requiredSet(workspaceEvent);
for (const field of [
  "sessionId",
  "spaceId",
  "vaultId",
  "sessionVersion",
  "eventType",
  "payload",
]) {
  if (!workspaceEventRequired.has(field)) {
    failures.push(
      `contracts/asyncapi.yaml: workspace event missing required ${field}`,
    );
  }
}

const dryRun = openapi?.paths?.["/v1/schema/dry-run"]?.post;
const dryRunSchema =
  dryRun?.requestBody?.content?.["application/json"]?.schema ?? {};
const dryRunRequired = requiredSet(dryRunSchema);
if (dryRun?.["x-akp-permission"] !== "admin") {
  failures.push("contracts/openapi.yaml: schema dry-run must require admin");
}
if (
  dryRun?.["x-akp-requires-unrestricted-space"] !== true ||
  dryRun?.["x-akp-requires-vault-scope"] !== true
) {
  failures.push(
    "contracts/openapi.yaml: schema dry-run must require unrestricted vault-scoped access",
  );
}
if (!hasIdempotencyKey(dryRun)) {
  failures.push(
    "contracts/openapi.yaml: schema dry-run must declare Idempotency-Key",
  );
}
if (!dryRun?.responses?.["409"]) {
  failures.push(
    "contracts/openapi.yaml: schema dry-run must declare revision-conflict response",
  );
}
for (const field of ["spaceId", "vaultId"]) {
  if (!dryRunRequired.has(field)) {
    failures.push(
      `contracts/openapi.yaml: schema dry-run missing required ${field}`,
    );
  }
}
const dryRunAlternatives = Array.isArray(dryRunSchema.anyOf)
  ? dryRunSchema.anyOf.map(requiredSet)
  : [];
if (
  !dryRunAlternatives.some((required) => required.has("candidateVersion")) ||
  !dryRunAlternatives.some((required) => required.has("profile"))
) {
  failures.push(
    "contracts/openapi.yaml: schema dry-run must accept legacy candidateVersion and KnowledgeProfile profile modes",
  );
}
if (
  dryRunSchema?.properties?.profile?.$ref !== "./knowledge-profile.schema.json"
) {
  failures.push(
    "contracts/openapi.yaml: schema dry-run profile must reference knowledge-profile.schema.json",
  );
}

const activation = openapi?.paths?.["/v1/schema/activate"]?.post;
const activationSchema =
  activation?.requestBody?.content?.["application/json"]?.schema ?? {};
const activationRequired = requiredSet(activationSchema);
if (activation?.["x-akp-permission"] !== "admin") {
  failures.push(
    "contracts/openapi.yaml: profile activation must require admin",
  );
}
if (
  activation?.["x-akp-requires-unrestricted-space"] !== true ||
  activation?.["x-akp-requires-vault-scope"] !== true
) {
  failures.push(
    "contracts/openapi.yaml: profile activation must require unrestricted vault-scoped access",
  );
}
if (!hasIdempotencyKey(activation)) {
  failures.push(
    "contracts/openapi.yaml: profile activation must declare Idempotency-Key",
  );
}
if (!activation?.responses?.["409"]) {
  failures.push(
    "contracts/openapi.yaml: profile activation must declare revision-conflict response",
  );
}
for (const field of [
  "spaceId",
  "vaultId",
  "profileRevisionId",
  "dryRunId",
  "expectedProfileHash",
  "expectedCorpusRevision",
]) {
  if (!activationRequired.has(field)) {
    failures.push(
      `contracts/openapi.yaml: profile activation missing required ${field}`,
    );
  }
}
if (
  activationSchema?.properties?.expectedProfileHash?.pattern !==
  "^[a-f0-9]{64}$"
) {
  failures.push(
    "contracts/openapi.yaml: profile activation must pin a SHA-256 profile hash",
  );
}

if (
  knowledgeProfile?.$schema !== "https://json-schema.org/draft/2020-12/schema"
) {
  failures.push(
    "contracts/knowledge-profile.schema.json: expected JSON Schema 2020-12",
  );
}
if (knowledgeProfile?.properties?.schemaVersion?.const !== 1) {
  failures.push(
    "contracts/knowledge-profile.schema.json: schemaVersion must be fixed to 1",
  );
}
const profileRequired = requiredSet(knowledgeProfile);
for (const field of [
  "schemaVersion",
  "profileId",
  "version",
  "displayName",
  "knowledgeKinds",
  "lifecycles",
  "evidencePolicies",
  "reviewPolicies",
  "artifactContracts",
  "retrievalPolicy",
  "promotionPolicy",
  "freshnessPolicy",
]) {
  if (!profileRequired.has(field)) {
    failures.push(
      `contracts/knowledge-profile.schema.json: missing required ${field}`,
    );
  }
}
for (const defaultedField of ["relationTypes", "modelRoleConstraints"]) {
  if (profileRequired.has(defaultedField)) {
    failures.push(
      `contracts/knowledge-profile.schema.json: ${defaultedField} is defaulted by KnowledgeProfileV1 and must not be required on input`,
    );
  }
}
if (knowledgeProfile?.additionalProperties !== false) {
  failures.push(
    "contracts/knowledge-profile.schema.json: profile input must remain strict",
  );
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

const requiredP2McpTools = [
  "akp_list_sessions",
  "akp_get_session_state",
  "akp_claim_workspace_work",
  "akp_heartbeat_workspace_claim",
  "akp_handoff_workspace_claim",
  "akp_append_workspace_event",
];
const declaredMcpNames = new Set((mcp.tools ?? []).map((tool) => tool.name));
for (const name of requiredP2McpTools) {
  if (!declaredMcpNames.has(name)) {
    failures.push(`contracts/mcp-tools.json: missing P2 tool ${name}`);
  }
}
if (
  (mcp.tools ?? []).some(
    (tool) => tool?.http?.path === "/v1/sessions/{id}/agent-processes",
  )
) {
  failures.push(
    "contracts/mcp-tools.json: one-time agent credential issuance must remain outside MCP",
  );
}

console.log(
  JSON.stringify({
    status: failures.length ? "FAILED" : "PASSED",
    openapiPaths: Object.keys(openapi?.paths ?? {}).length,
    asyncChannels: Object.keys(asyncapi.channels ?? {}).length,
    mcpTools: mcp.tools?.length ?? 0,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
