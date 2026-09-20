import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  Postgres,
  upsertContextFabricPeer,
} from "../packages/postgres/src/index.js";

const args = new Map(
  process.argv.slice(2).map((value) => {
    const [key, ...rest] = value.split("=");
    return [key, rest.join("=")] as const;
  }),
);
const phase = args.get("--phase");
if (!["setup", "live", "dead"].includes(phase ?? "")) {
  throw new Error("--phase must be setup, live or dead.");
}

const databaseUrl = process.env.AKP_TWO_NODE_LOCAL_DATABASE_URL;
const localToken = process.env.AKP_TWO_NODE_LOCAL_TOKEN;
const remoteTokenRef = process.env.AKP_TWO_NODE_REMOTE_TOKEN_REF;
if (!databaseUrl || !localToken || !remoteTokenRef) {
  throw new Error("Two-node proof environment is incomplete.");
}

const localUrl = process.env.AKP_TWO_NODE_LOCAL_URL ?? "http://127.0.0.1:18100";
const remoteUrl =
  process.env.AKP_TWO_NODE_REMOTE_URL ?? "http://127.0.0.1:18101";
const remoteNodeId =
  process.env.AKP_TWO_NODE_REMOTE_NODE_ID ?? "federation-proof-b";
const remoteRevision =
  process.env.AKP_TWO_NODE_REMOTE_REVISION ?? "two-node-proof-b-r1";
const statePath = path.resolve(
  process.env.AKP_TWO_NODE_STATE ?? "reports/ci/two-node-state.json",
);
const reportPath = path.resolve(
  process.env.AKP_TWO_NODE_FEDERATION_REPORT ??
    "reports/ci/two-node-federation.json",
);
const spaceId = "00000000-0000-0000-0000-000000000003";
const organizationId = "00000000-0000-0000-0000-000000000001";
const remoteVaultId = "10000000-0000-4000-8000-000000000001";

async function request(
  peerId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${localUrl}/v1/context-fabric/peers/${peerId}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${localToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        scope: { spaceId, vaultIds: [remoteVaultId] },
        request: {
          query: "peer revocation credential reference",
          intent: "EXACT_LOOKUP",
          mode: "SOURCE_BACKED",
        },
        budget: {
          maxResults: 5,
          maxWallMs: phase === "dead" ? 1000 : 5000,
          maxResponseBytes: 1000000,
        },
        revisionPreferences: [],
      }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const raw = await response.text();
  return {
    status: response.status,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

if (phase === "setup") {
  const db = new Postgres(databaseUrl);
  try {
    const before = await db.pool.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents",
    );
    const peer = await upsertContextFabricPeer(db, {
      organizationId,
      spaceId,
      peerKey: remoteNodeId,
      displayName: "Two-node federation proof peer",
      endpoint: remoteUrl,
      discoveryMode: "REMOTE_QUERY",
      trustState: "APPROVED",
      capabilities: {
        schemaVersion: 1,
        accessMode: "REFERENCE_LIVE",
        sourceAuthority: "REFERENCE",
        dataResidency: "EXTERNAL",
      },
      revision: remoteRevision,
      credentialRef: remoteTokenRef,
      lastSeenAt: new Date(),
    });
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          peerId: peer.id,
          beforeDocuments: before.rows[0]?.count ?? 0,
          remoteNodeId,
          remoteVaultId,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(JSON.stringify({ status: "SETUP", peerId: peer.id }));
  } finally {
    await db.close();
  }
} else {
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    peerId: string;
    beforeDocuments: number;
    remoteNodeId: string;
    remoteVaultId: string;
    startedAt: string;
    live?: Record<string, unknown>;
  };

  if (phase === "live") {
    const result = await request(state.peerId);
    if (result.status !== 200) {
      throw new Error(
        `Two-node live query returned ${result.status}: ${JSON.stringify(result.body)}`,
      );
    }
    const hits = Array.isArray(result.body.hits) ? result.body.hits : [];
    if (hits.length === 0) {
      throw new Error("Two-node live query returned no remote hits.");
    }
    const provenancePreserved = hits.every((hit) => {
      const value = hit as Record<string, unknown>;
      const provenance = value.remoteProvenance as
        | Record<string, unknown>
        | undefined;
      return provenance?.nodeId === state.remoteNodeId;
    });
    if (!provenancePreserved) {
      throw new Error("Two-node live query lost remote provenance.");
    }

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const documents = await client.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents",
    );
    await client.end();
    const afterDocuments = documents.rows[0]?.count ?? 0;
    if (afterDocuments !== state.beforeDocuments) {
      throw new Error("Remote query materialized remote documents locally.");
    }

    const next = {
      ...state,
      live: {
        status: result.status,
        hitCount: hits.length,
        remoteProvenancePreserved: true,
        remoteMaterializedLocally: false,
      },
    };
    await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(next.live));
  } else {
    const result = await request(state.peerId);
    if (![502, 503, 504].includes(result.status)) {
      throw new Error(
        `Dead-peer query did not degrade safely: ${result.status} ${JSON.stringify(result.body)}`,
      );
    }
    const liveness = await fetch(`${localUrl}/health/liveness`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!liveness.ok) {
      throw new Error("Local node lost liveness after remote peer failure.");
    }

    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const health = await client.query<{
      failure_count: number;
      last_failure_code: string | null;
    }>(
      "select failure_count,last_failure_code from context_fabric_peers where id=$1",
      [state.peerId],
    );
    await client.end();
    const peerHealth = health.rows[0];
    if (
      !peerHealth ||
      peerHealth.failure_count < 1 ||
      !["FEDERATION_PEER_UNAVAILABLE", "FEDERATION_PEER_TIMEOUT"].includes(
        peerHealth.last_failure_code ?? "",
      )
    ) {
      throw new Error("Remote peer failure was not persisted safely.");
    }

    const report = {
      schemaVersion: 1,
      evidenceLevel: "REAL_TWO_NODE_FEDERATION",
      status: "PROVEN",
      localNode: "federation-proof-a",
      remoteNode: state.remoteNodeId,
      remoteVaultId: state.remoteVaultId,
      liveQuery: state.live ?? null,
      deadPeer: {
        status: result.status,
        code: result.body.code ?? null,
        localNodeRemainedLive: true,
        persistedFailureCount: peerHealth.failure_count,
        persistedFailureCode: peerHealth.last_failure_code,
      },
      limitations: [
        "Both API nodes run on one CI host with separate PostgreSQL databases; this proves protocol and failure semantics, not WAN performance.",
      ],
      generatedAt: new Date().toISOString(),
    };
    if (!report.liveQuery) {
      throw new Error("Two-node live phase evidence is missing.");
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    console.log(JSON.stringify(report, null, 2));
  }
}
