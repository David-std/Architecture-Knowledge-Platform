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
  dryRunSchema?.properties?.profile?.$ref !==
  "./knowledge-profile.schema.json"
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
  failures.push("contracts/openapi.yaml: profile activation must require admin");
}
if (
  activation?.["x-akp-requires-unrestricted-space"] !== true ||
  activation?.["x-akp-requires-vault-scope"] !== true
) {
  failures.push(
    "contracts/openapi.yaml: profile activation must require unrestricted vault-scoped access",
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

if (knowledgeProfile?.$schema !== "https://json-schema.org/draft/2020-12/schema") {
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
