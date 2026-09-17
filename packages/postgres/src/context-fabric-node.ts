import type { Postgres } from "./index.js";

export type ContextFabricDeploymentMode =
  "SOLO_LOCAL" | "GIT_SYNC_SMALL_TEAM" | "TEAM_NODE" | "FEDERATED_ORG";

const DEPLOYMENT_MODES: readonly ContextFabricDeploymentMode[] = [
  "SOLO_LOCAL",
  "GIT_SYNC_SMALL_TEAM",
  "TEAM_NODE",
  "FEDERATED_ORG",
];

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface ContextFabricNodeClaim {
  nodeId: string;
  deploymentMode: ContextFabricDeploymentMode;
  claimedAt: Date;
  lastSeenAt: Date;
  adoptedFrom: string | null;
}

export class ContextFabricNodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextFabricNodeError";
    this.code = code;
  }
}

export function isContextFabricDeploymentMode(
  value: string,
): value is ContextFabricDeploymentMode {
  return (DEPLOYMENT_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the deployment mode and node identity this process is configured to
 * run as, failing closed on configuration that cannot be honoured.
 *
 * `SOLO_LOCAL` keeps the historical implicit default so a single workstation
 * needs no new configuration. The shared modes do not: a node that owns other
 * people's derived state must be named deliberately, because that name is what
 * a second node is later checked against.
 */
export function resolveContextFabricIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): { deploymentMode: ContextFabricDeploymentMode; nodeId: string } {
  const rawMode = environment.AKP_CONTEXT_FABRIC_MODE?.trim() || "SOLO_LOCAL";
  if (!isContextFabricDeploymentMode(rawMode)) {
    throw new ContextFabricNodeError(
      "CONTEXT_FABRIC_MODE_INVALID",
      `AKP_CONTEXT_FABRIC_MODE must be one of ${DEPLOYMENT_MODES.join(", ")}; received "${rawMode}".`,
    );
  }
  const rawNodeId = environment.AKP_CONTEXT_FABRIC_NODE_ID?.trim() || "";
  const sharesDerivedState =
    rawMode === "TEAM_NODE" || rawMode === "FEDERATED_ORG";
  if (!rawNodeId) {
    if (sharesDerivedState) {
      throw new ContextFabricNodeError(
        "CONTEXT_FABRIC_NODE_ID_REQUIRED",
        `AKP_CONTEXT_FABRIC_MODE=${rawMode} owns shared derived state and requires an explicit AKP_CONTEXT_FABRIC_NODE_ID.`,
      );
    }
    return { deploymentMode: rawMode, nodeId: "local-context-node" };
  }
  if (!NODE_ID_PATTERN.test(rawNodeId)) {
    throw new ContextFabricNodeError(
      "CONTEXT_FABRIC_NODE_ID_INVALID",
      "AKP_CONTEXT_FABRIC_NODE_ID must be 1-200 characters of [A-Za-z0-9._:-] starting alphanumeric.",
    );
  }
  return { deploymentMode: rawMode, nodeId: rawNodeId };
}

/**
 * Claim this database on behalf of one context-fabric node.
 *
 * Replicas of the same node re-claim freely: identity, not process count, is
 * what the mode constrains. A *different* identity is refused, because the two
 * realistic ways to reach that state — pointing a second node at a shared
 * database, or restoring a copy of someone else's database and running it as
 * your own — are both the failure the deployment guidance forbids. Renaming a
 * node is legitimate but deliberate, so it requires `adopt`.
 */
export async function claimContextFabricNode(
  db: Postgres,
  input: {
    nodeId: string;
    deploymentMode: ContextFabricDeploymentMode;
    adopt?: boolean;
  },
): Promise<ContextFabricNodeClaim> {
  if (!NODE_ID_PATTERN.test(input.nodeId)) {
    throw new ContextFabricNodeError(
      "CONTEXT_FABRIC_NODE_ID_INVALID",
      "Node id must be 1-200 characters of [A-Za-z0-9._:-] starting alphanumeric.",
    );
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    // The singleton unique key is the serialization point. A pre-read with
    // SELECT ... FOR UPDATE is insufficient while the table is empty because
    // there is no row to lock; two first-starting nodes can both observe
    // "unclaimed" and race into the upsert. The conditional conflict update
    // below makes PostgreSQL arbitrate that race atomically.
    const claimed = await client.query<Record<string, unknown>>(
      `insert into context_fabric_node_claim(
         singleton,node_id,deployment_mode,adopted_from
       ) values(true,$1,$2,null)
       on conflict(singleton) do update set
         node_id=excluded.node_id,
         deployment_mode=excluded.deployment_mode,
         last_seen_at=now(),
         adopted_from=case
           when context_fabric_node_claim.node_id=excluded.node_id
             then context_fabric_node_claim.adopted_from
           else context_fabric_node_claim.node_id
         end,
         claimed_at=case
           when context_fabric_node_claim.node_id=excluded.node_id
             then context_fabric_node_claim.claimed_at
           else now()
         end
       where context_fabric_node_claim.node_id=excluded.node_id
          or $3::boolean
       returning *`,
      [input.nodeId, input.deploymentMode, input.adopt === true],
    );
    const row = claimed.rows[0];
    if (!row) {
      // A conflicting insert may have committed while this statement waited
      // on the singleton key. Read the authoritative owner only to make the
      // refusal diagnosable; the conditional upsert already prevented takeover.
      const existing = await client.query<{
        node_id: string;
        deployment_mode: ContextFabricDeploymentMode;
      }>(
        "select node_id,deployment_mode from context_fabric_node_claim where singleton limit 1",
      );
      const current = existing.rows[0];
      if (current && current.node_id !== input.nodeId && !input.adopt) {
        throw new ContextFabricNodeError(
          "CONTEXT_FABRIC_NODE_CONFLICT",
          `This database is already claimed by context-fabric node "${current.node_id}" (${current.deployment_mode}); ` +
            `refusing to serve it as "${input.nodeId}". Shared derived state belongs to one node. ` +
            "If this rename is intentional, restart once with AKP_CONTEXT_FABRIC_NODE_ADOPT=true.",
        );
      }
      throw new ContextFabricNodeError(
        "CONTEXT_FABRIC_NODE_CLAIM_FAILED",
        "The context-fabric node claim did not return a row.",
      );
    }
    await client.query("commit");
    return normalizeClaim(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Read the claim without asserting one, for reporting surfaces. */
export async function readContextFabricNodeClaim(
  db: Postgres,
): Promise<ContextFabricNodeClaim | null> {
  const result = await db.pool.query<Record<string, unknown>>(
    "select * from context_fabric_node_claim where singleton limit 1",
  );
  const row = result.rows[0];
  return row ? normalizeClaim(row) : null;
}

function normalizeClaim(row: Record<string, unknown>): ContextFabricNodeClaim {
  return {
    nodeId: String(row.node_id),
    deploymentMode: String(row.deployment_mode) as ContextFabricDeploymentMode,
    claimedAt: new Date(String(row.claimed_at)),
    lastSeenAt: new Date(String(row.last_seen_at)),
    adoptedFrom: row.adopted_from === null ? null : String(row.adopted_from),
  };
}
