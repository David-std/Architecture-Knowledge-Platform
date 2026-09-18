// Verify that a running Team Context Node is actually a Team Context Node.
//
// This probes a live topology rather than inspecting configuration, because the
// failure this mode exists to prevent — a second writable node interleaving
// its writes into shared derived state — is invisible to a config check.
//
// Usage:
//   node scripts/verify-team-node.mjs
//
// Environment:
//   AKP_API_URL                  base URL of the node's API   (default http://127.0.0.1:8080)
//   AKP_WEB_URL                  base URL of the node's web surface (optional)
//   AKP_API_TOKEN                a token with knowledge:read
//   AKP_CONTEXT_FABRIC_NODE_ID   the node id the topology was started with

const apiUrl = (process.env.AKP_API_URL ?? "http://127.0.0.1:8080").replace(
  /\/$/,
  "",
);
const webUrl = process.env.AKP_WEB_URL?.replace(/\/$/, "");
const token = process.env.AKP_API_TOKEN;
const expectedNodeId = process.env.AKP_CONTEXT_FABRIC_NODE_ID;

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, status: ok ? "PASS" : "FAIL", detail });
}

async function getJson(path, headers = {}) {
  const response = await fetch(`${apiUrl}${path}`, { headers });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

if (!token) {
  console.error("AKP_API_TOKEN is required to verify a Team Context Node.");
  process.exit(2);
}
if (!expectedNodeId) {
  console.error("AKP_CONTEXT_FABRIC_NODE_ID is required.");
  process.exit(2);
}
const authHeaders = { authorization: `Bearer ${token}` };

// 1. The node is not merely up, it is ready: a node that cannot reach its
//    database, raw object store or extractor is not serving authoritative
//    shared context.
const readiness = await getJson("/health/readiness");
record(
  "node reports readiness with every dependency reachable",
  readiness.status === 200 &&
    readiness.body?.database === true &&
    readiness.body?.rawObjectStore === true &&
    readiness.body?.extractor === true,
  JSON.stringify(readiness.body),
);

// 2. The node claimed this database under the identity it was started with,
//    and reports that claim rather than echoing its own environment.
const capabilities = await getJson(
  "/v1/context-fabric/capabilities",
  authHeaders,
);
const node = capabilities.body?.node;
record(
  "deployment mode is TEAM_NODE",
  capabilities.body?.deploymentMode === "TEAM_NODE",
  String(capabilities.body?.deploymentMode),
);
record(
  "node claimed its database under the configured identity",
  node?.claimed === true && node?.id === expectedNodeId,
  JSON.stringify(node),
);
record(
  "node declares ownership of shared derived state",
  node?.sharedDerivedState === true,
  String(node?.sharedDerivedState),
);
const manifest = capabilities.body?.manifest;
record(
  "node publishes the safe discovery manifest",
  manifest?.nodeId === expectedNodeId &&
    manifest?.contextApiVersion === "v1" &&
    Array.isArray(manifest?.requiredAuthenticationModes) &&
    manifest.requiredAuthenticationModes.includes("BEARER_TOKEN") &&
    Array.isArray(manifest?.supportedExchangeFormats) &&
    manifest.supportedExchangeFormats.some(
      (entry) =>
        entry?.format === "OKF_0_2" &&
        entry?.import === true &&
        entry?.export === true,
    ) &&
    manifest?.graphCapabilities?.authorizationBeforeTraversal === true &&
    Array.isArray(manifest?.graphCapabilities?.domains) &&
    manifest.graphCapabilities.domains.includes("EPISTEMIC") &&
    manifest.graphCapabilities.domains.includes("WORK") &&
    JSON.stringify(manifest?.federationModes) ===
      JSON.stringify(["CATALOG_ONLY"]),
  JSON.stringify(manifest),
);

// 3. The boundary the mode exists to protect is still advertised as closed.
record(
  "writable database file sync is never offered",
  capabilities.body?.capabilities?.writableDatabaseFileSync === false,
  String(capabilities.body?.capabilities?.writableDatabaseFileSync),
);

// 4. Two clients of one node see one authority. Distinct sessions created
//    through the same node must agree on the context revision they pinned;
//    disagreement would mean the node is not a single source of shared state.
//    This leaves two named workspace sessions behind: they are coordination
//    state, never canonical knowledge, and the node has no delete endpoint for
//    them by design.
const spaces = capabilities.body?.authorizedSpaces ?? [];
if (spaces.length === 0) {
  record(
    "token is authorized for at least one space",
    false,
    "no authorized spaces",
  );
} else {
  const vaults = await getJson("/v1/vaults", authHeaders);
  const vault = (vaults.body?.vaults ?? []).find(
    (candidate) => candidate.enabled !== false,
  );
  if (!vault) {
    record(
      "a vault is available to pin a context revision against",
      false,
      JSON.stringify(vaults.body),
    );
  } else {
    const created = await Promise.all(
      ["first client", "second client"].map(async (purpose) => {
        const response = await fetch(`${apiUrl}/v1/sessions`, {
          method: "POST",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            spaceId: vault.spaceId ?? vault.space_id ?? spaces[0],
            vaultId: vault.id,
            purpose: `Team node verification: ${purpose}`,
            contextBudget: 2048,
          }),
        });
        return { status: response.status, body: await response.json() };
      }),
    );
    const hashes = created.map(
      (session) => session.body?.contextRevisionSetHash,
    );
    record(
      "two clients of one node pin the same context revision",
      created.every((session) => session.status === 201) &&
        hashes[0] !== undefined &&
        hashes[0] === hashes[1],
      JSON.stringify(hashes),
    );
  }
}

// 5. The web surface belongs to the node, not to each developer's laptop.
if (webUrl) {
  const web = await fetch(webUrl).catch(() => null);
  record(
    "node serves its web surface",
    web !== null && web.ok,
    web ? String(web.status) : "unreachable",
  );
}

const failed = checks.filter((check) => check.status === "FAIL");
console.log(
  JSON.stringify(
    {
      status: failed.length === 0 ? "PASSED" : "FAILED",
      nodeId: expectedNodeId,
      apiUrl,
      checks,
    },
    null,
    2,
  ),
);
process.exit(failed.length === 0 ? 0 : 1);
