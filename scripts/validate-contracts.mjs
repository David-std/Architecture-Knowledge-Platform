import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import * as ts from "typescript";

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

const HTTP_ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch"]);

function normalizeFastifyPath(routePath) {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function registeredFastifyRoutes(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "app"
    ) {
      const method = node.expression.name.text.toLowerCase();
      if (HTTP_ROUTE_METHODS.has(method)) {
        const routeArgument = node.arguments[0];
        if (routeArgument && ts.isStringLiteralLike(routeArgument)) {
          routes.push({
            method,
            path: normalizeFastifyPath(routeArgument.text),
          });
        } else {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          failures.push(
            `${fileName}:${line + 1}: Fastify ${method.toUpperCase()} route path must be a static string for contract validation`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return routes;
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

const workspaceCoordinationPaths = {
  "/v1/sessions": { get: "workspace:read", post: "workspace:create" },
  "/v1/sessions/{id}/state": { get: "workspace:read" },
  "/v1/sessions/{id}/participants": {
    post: "workspace:manage-participants",
  },
  "/v1/sessions/{id}/work-context": { post: "workspace:event:append" },
  "/v1/sessions/{id}/claims": { post: "workspace:claim" },
  "/v1/sessions/{id}/claims/heartbeat": { post: "workspace:claim" },
  "/v1/sessions/{id}/claims/handoff": { post: "workspace:handoff" },
  "/v1/sessions/{id}/events": { post: "workspace:event:append" },
  "/v1/sessions/{id}/agent-processes": { post: "workspace:manage-agents" },
  "/v1/agent-processes/{id}/revoke": { post: "workspace:manage-agents" },
};
for (const [route, methods] of Object.entries(workspaceCoordinationPaths)) {
  for (const [method, principalAction] of Object.entries(methods)) {
    const operation = openapi?.paths?.[route]?.[method];
    if (!operation) {
      failures.push(
        `contracts/openapi.yaml: missing workspace coordination ${method.toUpperCase()} ${route}`,
      );
      continue;
    }
    if (operation["x-akp-permission"] !== "knowledge:read") {
      failures.push(
        `contracts/openapi.yaml: workspace coordination ${method.toUpperCase()} ${route} must require knowledge:read`,
      );
    }
    if (operation["x-akp-principal-action"] !== principalAction) {
      failures.push(
        `contracts/openapi.yaml: workspace coordination ${method.toUpperCase()} ${route} must require principal action ${principalAction}`,
      );
    }
  }
}

const decisionWorkflowOperations = [
  {
    route: "/v1/sessions/{id}/decisions",
    method: "get",
    permission: "knowledge:read",
    principalAction: "workspace:read",
  },
  {
    route: "/v1/sessions/{id}/decisions",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route: "/v1/sessions/{id}/decisions/{decisionId}",
    method: "get",
    permission: "knowledge:read",
    principalAction: "workspace:read",
  },
  {
    route: "/v1/sessions/{id}/decisions/{decisionId}/alternatives",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route:
      "/v1/sessions/{id}/decisions/{decisionId}/alternatives/{alternativeId}/decision",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route: "/v1/sessions/{id}/decisions/{decisionId}/objections",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route:
      "/v1/sessions/{id}/decisions/{decisionId}/objections/{objectionId}/resolve",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route: "/v1/sessions/{id}/decisions/{decisionId}/consultations",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route:
      "/v1/sessions/{id}/decisions/{decisionId}/consultations/{consultationId}/respond",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route: "/v1/sessions/{id}/decisions/{decisionId}/selection",
    method: "post",
    permission: "knowledge:read",
    principalAction: "workspace:event:append",
    idempotentWrite: true,
  },
  {
    route: "/v1/sessions/{id}/decisions/{decisionId}/capture",
    method: "post",
    permission: "knowledge:propose",
    principalAction: "knowledge:propose",
    idempotentWrite: true,
  },
];
for (const expected of decisionWorkflowOperations) {
  const operation = openapi?.paths?.[expected.route]?.[expected.method];
  if (!operation) {
    failures.push(
      `contracts/openapi.yaml: missing decision workflow ${expected.method.toUpperCase()} ${expected.route}`,
    );
    continue;
  }
  if (operation["x-akp-permission"] !== expected.permission) {
    failures.push(
      `contracts/openapi.yaml: decision workflow ${expected.method.toUpperCase()} ${expected.route} must require ${expected.permission}`,
    );
  }
  if (operation["x-akp-principal-action"] !== expected.principalAction) {
    failures.push(
      `contracts/openapi.yaml: decision workflow ${expected.method.toUpperCase()} ${expected.route} must require principal action ${expected.principalAction}`,
    );
  }
  if (expected.idempotentWrite && !hasIdempotencyKey(operation)) {
    failures.push(
      `contracts/openapi.yaml: decision workflow write ${expected.route} must declare Idempotency-Key`,
    );
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
  "/v1/sessions/{id}/work-context",
  "/v1/sessions/{id}/claims",
  "/v1/sessions/{id}/claims/heartbeat",
  "/v1/sessions/{id}/claims/handoff",
  "/v1/sessions/{id}/events",
  "/v1/agent-processes/{id}/revoke",
]) {
  if (!hasIdempotencyKey(openapi?.paths?.[route]?.post)) {
    failures.push(
      `contracts/openapi.yaml: workspace coordination write ${route} must declare Idempotency-Key`,
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
const integrationEventEnum = new Set(
  asyncapi?.components?.schemas?.IntegrationEventEnvelope?.properties?.eventType
    ?.enum ?? [],
);
for (const eventType of [
  "WorkspaceSessionCreated",
  "WorkspaceSessionUpdated",
  "WorkspaceClaimUpdated",
  "WorkspaceHandoffCreated",
  "WorkspacePromotionRequested",
  "PrincipalRevoked",
]) {
  if (!integrationEventEnum.has(eventType)) {
    failures.push(
      `contracts/asyncapi.yaml: missing durable P2 integration event ${eventType}`,
    );
  }
}
const workspaceEventSchema =
  asyncapi?.components?.schemas?.WorkspaceEventPayload ?? {};
const workspaceEventEnum = new Set(
  workspaceEventSchema?.properties?.eventType?.enum ?? [],
);
for (const eventType of [
  "SESSION_CREATED",
  "WORK_CONTEXT_UPDATED",
  "CLAIM_ACQUIRED",
  "CLAIM_HEARTBEAT",
  "CLAIM_RELEASED",
  "CLAIM_HANDOFF",
  "PROMOTION_REQUESTED",
]) {
  if (!workspaceEventEnum.has(eventType)) {
    failures.push(
      `contracts/asyncapi.yaml: missing durable workspace event ${eventType}`,
    );
  }
}
if (!workspaceEventSchema?.properties?.actorPrincipalId) {
  failures.push(
    "contracts/asyncapi.yaml: workspace events must expose actorPrincipalId",
  );
}

const outboxSource = await readFile(
  path.join(root, "packages/postgres/src/outbox.ts"),
  "utf8",
);
const integrationTypeBlock =
  /export const INTEGRATION_EVENT_TYPES = \[([\s\S]*?)\] as const;/.exec(
    outboxSource,
  )?.[1] ?? "";
const runtimeIntegrationEventTypes = new Set(
  [...integrationTypeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
);
if (runtimeIntegrationEventTypes.size === 0) {
  failures.push(
    "packages/postgres/src/outbox.ts: could not resolve runtime integration event types",
  );
} else {
  for (const eventType of runtimeIntegrationEventTypes) {
    if (!integrationEventEnum.has(eventType)) {
      failures.push(
        `contracts/asyncapi.yaml: runtime integration event ${eventType} is undeclared`,
      );
    }
  }
  for (const eventType of integrationEventEnum) {
    if (!runtimeIntegrationEventTypes.has(eventType)) {
      failures.push(
        `contracts/asyncapi.yaml: declares integration event ${eventType} absent from runtime`,
      );
    }
  }
}

const workspaceCoordinationSource = await readFile(
  path.join(root, "packages/postgres/src/workspace-coordination.ts"),
  "utf8",
);
const workspaceTypeBlock =
  /export type WorkspaceEventType =([\s\S]*?);/.exec(
    workspaceCoordinationSource,
  )?.[1] ?? "";
const runtimeWorkspaceEventTypes = new Set(
  [...workspaceTypeBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
);
if (runtimeWorkspaceEventTypes.size === 0) {
  failures.push(
    "packages/postgres/src/workspace-coordination.ts: could not resolve runtime workspace event types",
  );
} else {
  for (const eventType of runtimeWorkspaceEventTypes) {
    if (!workspaceEventEnum.has(eventType)) {
      failures.push(
        `contracts/asyncapi.yaml: runtime workspace event ${eventType} is undeclared`,
      );
    }
  }
  for (const eventType of workspaceEventEnum) {
    if (!runtimeWorkspaceEventTypes.has(eventType)) {
      failures.push(
        `contracts/asyncapi.yaml: declares workspace event ${eventType} absent from runtime`,
      );
    }
  }
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

const requiredWorkspaceMcpTools = [
  "akp_list_sessions",
  "akp_get_session_state",
  "akp_update_work_context",
  "akp_claim_workspace_work",
  "akp_heartbeat_workspace_claim",
  "akp_handoff_workspace_claim",
  "akp_append_workspace_event",
];
const declaredMcpNames = new Set((mcp.tools ?? []).map((tool) => tool.name));
for (const name of requiredWorkspaceMcpTools) {
  if (!declaredMcpNames.has(name)) {
    failures.push(
      `contracts/mcp-tools.json: missing workspace coordination tool ${name}`,
    );
  }
}
// A required-minimum list cannot catch a tool that ships without a contract.
// Every tool the MCP server actually registers must be declared, or agents get
// a surface the platform never described, reviewed or versioned.
const mcpServerSource = await readFile(
  path.join(root, "apps/mcp/src/server.ts"),
  "utf8",
);
const registeredMcpNames = new Set(
  [
    ...mcpServerSource.matchAll(/server\.registerTool\(\s*"([A-Za-z0-9_]+)"/g),
  ].map((match) => match[1]),
);
if (registeredMcpNames.size === 0) {
  failures.push(
    "apps/mcp/src/server.ts: no registered MCP tools found; the parity check cannot run",
  );
}
for (const name of registeredMcpNames) {
  if (!declaredMcpNames.has(name)) {
    failures.push(`contracts/mcp-tools.json: undeclared MCP tool ${name}`);
  }
}
for (const name of declaredMcpNames) {
  if (!registeredMcpNames.has(name)) {
    failures.push(
      `contracts/mcp-tools.json: declares ${name}, which the MCP server does not register`,
    );
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

// HTTP has the same drift risk as MCP: a Fastify route that is reachable but
// absent from OpenAPI bypasses the reviewed/versioned contract surface. Parse
// TypeScript rather than regex so generic route signatures and formatting do
// not create blind spots.
const declaredHttpRoutes = new Set();
for (const [routePath, pathItem] of Object.entries(openapi?.paths ?? {})) {
  for (const method of HTTP_ROUTE_METHODS) {
    if (pathItem?.[method]) {
      declaredHttpRoutes.add(`${method.toUpperCase()} ${routePath}`);
    }
  }
}

const routeDirectory = path.join(root, "apps/api/src/routes");
const routeEntries = await readdir(routeDirectory, { recursive: true });
const httpSourceFiles = [
  path.join(root, "apps/api/src/server.ts"),
  ...routeEntries
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(routeDirectory, entry)),
];
const registeredHttpRouteKeys = new Set();
for (const sourcePath of httpSourceFiles) {
  const source = await readFile(sourcePath, "utf8");
  const displayPath = path.relative(root, sourcePath).split(path.sep).join("/");
  for (const route of registeredFastifyRoutes(source, displayPath)) {
    registeredHttpRouteKeys.add(`${route.method.toUpperCase()} ${route.path}`);
  }
}
if (registeredHttpRouteKeys.size === 0) {
  failures.push(
    "apps/api/src: no Fastify HTTP routes found; the OpenAPI parity check cannot run",
  );
}
for (const route of registeredHttpRouteKeys) {
  if (!declaredHttpRoutes.has(route)) {
    failures.push(`contracts/openapi.yaml: undeclared HTTP route ${route}`);
  }
}

console.log(
  JSON.stringify({
    status: failures.length ? "FAILED" : "PASSED",
    openapiPaths: Object.keys(openapi?.paths ?? {}).length,
    asyncChannels: Object.keys(asyncapi.channels ?? {}).length,
    mcpTools: mcp.tools?.length ?? 0,
    httpRoutes: registeredHttpRouteKeys.size,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
