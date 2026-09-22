import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Postgres,
  addWorkspaceParticipant,
  appendWorkspaceEvent,
  canAccessVault,
  claimWorkspaceWork,
  createAgentProcessPrincipalCredential,
  createWorkspaceSession,
  getContextFabricPeerRuntime,
  handoffWorkspaceWork,
  listWorkspaceHandoffsForRecipient,
  listWorkspaceSessionsForParticipant,
  loadPinnedWorkspaceContextRevisionSet,
  markContextFabricPeerQueryFailure,
  markContextFabricPeerQuerySuccess,
  queueWorkspaceOfflineDraft,
  revokeAgentProcessPrincipal,
  upsertContextFabricPeer,
  workspaceContextRevisionState,
  workspacePromotionEvidence,
} from "@akp/postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const outputPath = path.resolve(
  process.env.AKP_P12_TEAM_METRICS_REPORT ?? "reports/ci/p12-team-metrics.json",
);

type RateMetric = {
  measured: true;
  value: number;
  numerator: number;
  denominator: number;
  sampleCount: number;
  unit: "ratio";
  scope: "REGISTERED_FIXTURE";
  evidence: string;
  limitation: string;
};

function rate(
  numerator: number,
  denominator: number,
  evidence: string,
  limitation: string,
): RateMetric {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    throw new Error("P12_TEAM_METRIC_DENOMINATOR_INVALID");
  }
  return {
    measured: true,
    value: numerator / denominator,
    numerator,
    denominator,
    sampleCount: denominator,
    unit: "ratio",
    scope: "REGISTERED_FIXTURE",
    evidence,
    limitation,
  };
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const db = new Postgres(databaseUrl);
const organizationId = randomUUID();
const primarySpaceId = randomUUID();
const otherSpaceId = randomUUID();
const primaryVaultId = randomUUID();
const otherVaultId = randomUUID();
const actorA = randomUUID();
const actorB = randomUUID();

try {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'P12 team metrics')`,
    [organizationId, `p12-team-${organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values
       ($1,$3,$4,'P12 primary team space','PRIVATE',$5),
       ($2,$3,$6,'P12 other team space','PRIVATE',$7)`,
    [
      primarySpaceId,
      otherSpaceId,
      organizationId,
      `p12-primary-${primarySpaceId.slice(0, 8)}`,
      `/tmp/p12-primary-${primarySpaceId}`,
      `p12-other-${otherSpaceId.slice(0, 8)}`,
      `/tmp/p12-other-${otherSpaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values
       ($1,$3,$4,'P12 private vault',true,'p12-workspace:r1',$5,$4,'PRIVATE',true),
       ($2,$6,$7,'P12 other vault',true,'p12-other:r1',$8,$7,'PRIVATE',true)`,
    [
      primaryVaultId,
      otherVaultId,
      primarySpaceId,
      `/tmp/p12-private-${primaryVaultId}`,
      `p12-private-${primaryVaultId.slice(0, 8)}`,
      otherSpaceId,
      `/tmp/p12-other-vault-${otherVaultId}`,
      `p12-other-${otherVaultId.slice(0, 8)}`,
    ],
  );
  for (const [userId, label] of [
    [actorA, "Actor A"],
    [actorB, "Actor B"],
  ] as const) {
    await db.pool.query(
      "insert into users(id,email,display_name) values($1,$2,$3)",
      [userId, `${userId}@example.test`, `P12 ${label}`],
    );
  }

  const privateInherited = canAccessVault(
    "PRIVATE",
    { role: "CONTRIBUTOR", pathPrefix: null },
    null,
    "knowledge:read",
  );
  const teamInherited = canAccessVault(
    "TEAM",
    { role: "CONTRIBUTOR", pathPrefix: null },
    null,
    "knowledge:read",
  );
  const privateToTeamLeakRate = rate(
    privateInherited.allowed ? 1 : 0,
    1,
    "canAccessVault requires an explicit vault grant for PRIVATE while TEAM may inherit space membership",
    "This metric covers the shared authorization predicate; API integration separately exercises persisted authorization state.",
  );
  const teamInheritanceSanity =
    !privateInherited.allowed && teamInherited.allowed;

  const session = await createWorkspaceSession(db, {
    spaceId: primarySpaceId,
    vaultId: primaryVaultId,
    actorId: actorA,
    purpose: "P12 workspace handoff and fencing fixture",
    contextBudget: 2048,
  });
  await addWorkspaceParticipant(db, {
    sessionId: session.id,
    actorId: actorA,
    userId: actorB,
  });

  const otherSession = await createWorkspaceSession(db, {
    spaceId: otherSpaceId,
    vaultId: otherVaultId,
    actorId: actorB,
    purpose: "P12 cross-space isolation fixture",
    contextBudget: 1024,
  });
  const leakedSessions = await listWorkspaceSessionsForParticipant(
    db,
    actorA,
    [otherSpaceId],
    [otherVaultId],
  );
  const crossSpaceLeakRate = rate(
    leakedSessions.some((entry) => entry.id === otherSession.id) ? 1 : 0,
    1,
    "listWorkspaceSessionsForParticipant against a foreign space/vault where the actor is not a participant",
    "One persisted cross-space workspace isolation case is measured.",
  );

  const pinnedFirst = await loadPinnedWorkspaceContextRevisionSet(
    db.pool,
    session.id,
  );
  const pinnedSecond = await loadPinnedWorkspaceContextRevisionSet(
    db.pool,
    session.id,
  );
  const pinnedContextReproducibility = rate(
    pinnedFirst &&
      pinnedSecond &&
      pinnedFirst.revisionSetHash === session.contextRevisionSetHash &&
      pinnedSecond.revisionSetHash === pinnedFirst.revisionSetHash
      ? 1
      : 0,
    1,
    "Repeated reads of the durable workspace_context_revision_sets pin",
    "Reproducibility is measured for one freshly created registered workspace.",
  );
  if (!pinnedFirst) throw new Error("P12_PINNED_CONTEXT_MISSING");

  const principalRows = await db.pool.query<{ id: string; user_id: string }>(
    `select id,user_id
       from principals
      where kind='HUMAN' and user_id=any($1::uuid[])
      order by user_id`,
    [[actorA, actorB]],
  );
  const principalByUser = new Map(
    principalRows.rows.map((row) => [row.user_id, row.id]),
  );
  const principalA = principalByUser.get(actorA);
  if (!principalA) throw new Error("P12_HUMAN_PRINCIPAL_A_MISSING");

  const processToken = `p12-agent-${randomUUID()}`;
  const agent = await createAgentProcessPrincipalCredential(db, {
    parentPrincipalId: principalA,
    userId: actorA,
    sessionId: session.id,
    displayName: "P12 revoked agent",
    allowedActions: ["workspace:read", "workspace:event:append"],
    tokenHash: createHash("sha256").update(processToken).digest("hex"),
    scopes: {
      spaces: [
        {
          spaceId: primarySpaceId,
          pathPrefix: null,
          permissions: ["knowledge:read"],
        },
      ],
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  await revokeAgentProcessPrincipal(db, {
    principalId: agent.id,
    parentPrincipalId: principalA,
  });
  let revokedDenied = false;
  try {
    await appendWorkspaceEvent(db, {
      sessionId: session.id,
      actorId: actorA,
      actorPrincipalId: agent.id,
      eventType: "NOTE",
      payload: { p12: "revoked-agent-must-not-write" },
    });
  } catch (error) {
    revokedDenied = errorCode(error) === "WORKSPACE_PRINCIPAL_SCOPE_DENIED";
  }
  const revokedPrincipalAccessRate = rate(
    revokedDenied ? 0 : 1,
    1,
    "appendWorkspaceEvent using an explicitly revoked AGENT_PROCESS principal",
    "One registered revoked-principal write attempt is measured; the expected unauthorized access rate is zero.",
  );

  const claim = await claimWorkspaceWork(db, {
    sessionId: session.id,
    actorId: actorA,
    workKey: "packages/compiler/**",
    leaseSeconds: 300,
  });
  let overlapDenied = false;
  try {
    await claimWorkspaceWork(db, {
      sessionId: session.id,
      actorId: actorB,
      workKey: "packages/compiler/src/reasoning.ts",
      leaseSeconds: 300,
    });
  } catch (error) {
    overlapDenied = errorCode(error) === "WORK_CLAIM_OVERLAP";
  }

  const handoffInput = {
    summary: "Compiler reasoning work is ready for receiver validation.",
    completed: ["P7 reasoning constraints hardened."],
    remaining: ["Validate P12 workspace metrics."],
    blockers: ["No known blocker."],
    changedResourceRefs: ["packages/compiler/**"],
    evidenceRefs: ["benchmark:p12-team-metrics"],
    questions: ["Does the receiver observe the exact pinned context revision?"],
  };
  const handedOff = await handoffWorkspaceWork(db, {
    sessionId: session.id,
    actorId: actorA,
    workKey: "packages/compiler/**",
    toUserId: actorB,
    fencingToken: claim.fencingToken,
    leaseSeconds: 300,
    handoff: handoffInput,
  });
  let staleFenceDenied = false;
  try {
    await appendWorkspaceEvent(db, {
      sessionId: session.id,
      actorId: actorA,
      claimId: claim.id,
      fencingToken: claim.fencingToken,
      eventType: "FINDING",
      payload: { p12: "stale-fence-write" },
    });
  } catch (error) {
    staleFenceDenied = errorCode(error) === "WORK_CLAIM_FENCE_STALE";
  }
  const overlappingClaimFencing = rate(
    Number(overlapDenied) +
      Number(
        staleFenceDenied &&
          handedOff.fencingToken === claim.fencingToken + 1 &&
          handedOff.ownerId === actorB,
      ),
    2,
    "Overlapping prefix denial plus post-handoff stale fencing-token denial",
    "Two coordination safety behaviors are measured in one registered workspace.",
  );

  const inbox = await listWorkspaceHandoffsForRecipient(db, {
    actorId: actorB,
    spaceId: primarySpaceId,
    vaultId: primaryVaultId,
  });
  const handoff = inbox.find(
    (entry) =>
      entry.sourceSessionId === session.id &&
      entry.workKey === "packages/compiler/**",
  );
  const handoffChecks = [
    handoff?.summary === handoffInput.summary,
    JSON.stringify(handoff?.completed) === JSON.stringify(handoffInput.completed),
    JSON.stringify(handoff?.remaining) === JSON.stringify(handoffInput.remaining),
    JSON.stringify(handoff?.blockers) === JSON.stringify(handoffInput.blockers),
    JSON.stringify(handoff?.changedResourceRefs) ===
      JSON.stringify(handoffInput.changedResourceRefs),
    JSON.stringify(handoff?.evidenceRefs) ===
      JSON.stringify(handoffInput.evidenceRefs),
    JSON.stringify(handoff?.questions) === JSON.stringify(handoffInput.questions),
    handoff?.contextRevisionSetHash === pinnedFirst.revisionSetHash &&
      JSON.stringify(handoff?.contextRevision) ===
        JSON.stringify(pinnedFirst.revisionSet),
  ];
  const handoffCompleteness = rate(
    handoffChecks.filter(Boolean).length,
    handoffChecks.length,
    "StructuredWorkspaceHandoff retrieved from the recipient inbox",
    "Eight mandatory structured handoff fields are compared exactly in one fixture.",
  );

  const finding = await appendWorkspaceEvent(db, {
    sessionId: session.id,
    actorId: actorA,
    eventType: "FINDING",
    payload: { summary: "P12 promotable finding" },
  });
  const note = await appendWorkspaceEvent(db, {
    sessionId: session.id,
    actorId: actorA,
    eventType: "NOTE",
    payload: { summary: "P12 non-promotable note" },
  });
  const promotion = await workspacePromotionEvidence(db, {
    sessionId: session.id,
    actorId: actorA,
    eventIds: [String(finding.id)],
  });
  let noteRejected = false;
  try {
    await workspacePromotionEvidence(db, {
      sessionId: session.id,
      actorId: actorA,
      eventIds: [String(note.id)],
    });
  } catch (error) {
    noteRejected = errorCode(error) === "PROMOTION_EVIDENCE_NOT_FOUND";
  }
  const promotionCorrectness = rate(
    Number(
      promotion.events.length === 1 &&
        String(promotion.events[0]?.id) === String(finding.id),
    ) + Number(noteRejected),
    2,
    "workspacePromotionEvidence accepts only promotable workspace event types",
    "This measures promotion-evidence eligibility, while governed publication/review is proven by the publication lifecycle suite.",
  );

  const currentDraft = await queueWorkspaceOfflineDraft(db, {
    sessionId: session.id,
    actorId: actorA,
    clientDraftId: "p12-current-draft",
    baseRevisionSetHash: pinnedFirst.revisionSetHash,
    eventType: "FINDING",
    payload: { summary: "Current offline draft" },
  });
  await db.pool.query(
    "update vaults set current_revision='p12-workspace:r2' where id=$1",
    [primaryVaultId],
  );
  const changedState = await workspaceContextRevisionState(
    db.pool,
    session.id,
    primarySpaceId,
    primaryVaultId,
  );
  const staleDraft = await queueWorkspaceOfflineDraft(db, {
    sessionId: session.id,
    actorId: actorA,
    clientDraftId: "p12-stale-draft",
    baseRevisionSetHash: pinnedFirst.revisionSetHash,
    eventType: "FINDING",
    payload: { summary: "Stale offline draft" },
  });
  const offlineStaleDisclosure = rate(
    Number(currentDraft.status === "QUEUED") +
      Number(
        changedState.status === "CHANGED" &&
          changedState.pinned?.revisionSetHash === pinnedFirst.revisionSetHash &&
          staleDraft.status === "RECONCILE_REQUIRED",
      ),
    2,
    "queueWorkspaceOfflineDraft before and after the pinned ContextRevisionSet becomes stale",
    "One current and one stale offline-draft state are measured.",
  );

  const peer = await upsertContextFabricPeer(db, {
    organizationId,
    spaceId: primarySpaceId,
    peerKey: `p12-peer-${randomUUID()}`,
    displayName: "P12 partial failure peer",
    endpoint: "https://peer.invalid.example",
    discoveryMode: "REMOTE_QUERY",
    trustState: "APPROVED",
    capabilities: {
      schemaVersion: 1,
      boundary: "P12_REGISTERED_FIXTURE",
    },
    revision: "p12-peer-r1",
    credentialRef: "AKP_P12_PEER_TOKEN",
    lastSeenAt: new Date(),
  });
  await markContextFabricPeerQueryFailure(
    db,
    peer.id,
    "FEDERATION_PEER_TIMEOUT",
  );
  await markContextFabricPeerQueryFailure(
    db,
    peer.id,
    "FEDERATION_PEER_TIMEOUT",
  );
  await markContextFabricPeerQueryFailure(
    db,
    peer.id,
    "FEDERATION_PEER_TIMEOUT",
  );
  const failedPeer = await getContextFabricPeerRuntime(db, peer.id, [
    primarySpaceId,
  ]);
  await markContextFabricPeerQuerySuccess(db, peer.id);
  const recoveredPeer = await getContextFabricPeerRuntime(db, peer.id, [
    primarySpaceId,
  ]);
  const federationPartialFailure = rate(
    Number(
      failedPeer?.failureCount === 3 &&
        failedPeer.lastFailureCode === "FEDERATION_PEER_TIMEOUT" &&
        failedPeer.circuitOpenUntil !== null,
    ) +
      Number(
        recoveredPeer?.failureCount === 0 &&
          recoveredPeer.lastFailureCode === null &&
          recoveredPeer.circuitOpenUntil === null &&
          recoveredPeer.lastSuccessAt !== null,
      ),
    2,
    "Persisted federation failure/circuit state followed by recovery reset",
    "This fixture measures local failure-state behavior; the real two-node workflow separately proves remote liveness and dead-peer degradation.",
  );

  const team = {
    crossSpaceLeakRate,
    privateToTeamLeakRate,
    revokedPrincipalAccessRate,
    pinnedContextReproducibility,
    handoffCompleteness,
    overlappingClaimFencing,
    promotionCorrectness,
    offlineStaleDisclosure,
    federationPartialFailure,
  };
  const zeroRates = [
    crossSpaceLeakRate,
    privateToTeamLeakRate,
    revokedPrincipalAccessRate,
  ];
  const positiveRates = [
    pinnedContextReproducibility,
    handoffCompleteness,
    overlappingClaimFencing,
    promotionCorrectness,
    offlineStaleDisclosure,
    federationPartialFailure,
  ];
  const status =
    teamInheritanceSanity &&
    zeroRates.every((metric) => metric.value === 0) &&
    positiveRates.every((metric) => metric.value === 1)
      ? "PROVEN"
      : "FAILED";

  const report = {
    schemaVersion: 1,
    benchmark: "AKP_P12_REGISTERED_WORKSPACE_TEAM_METRICS",
    commit: process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    evidenceLevel: "REGISTERED_SYNTHETIC_RUNTIME_FIXTURE",
    claimPolicy: {
      externalParityClaimAllowed: false,
      fixtureRatesAreProductionRates: false,
      scenarioPassRateRelabelledAsTeamMetric: false,
      zeroLeakageClaimScope: "REGISTERED_FIXTURE_ONLY",
      realTwoNodeFederationEvidenceSeparate: true,
    },
    status,
    fixture: {
      primarySpaceId,
      otherSpaceId,
      primaryVaultId,
      otherVaultId,
      sessionId: session.id,
      participants: 2,
      teamInheritanceSanity,
    },
    team,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        status,
        outputPath,
        team: Object.fromEntries(
          Object.entries(team).map(([name, metric]) => [name, metric.value]),
        ),
      },
      null,
      2,
    ),
  );
  if (status !== "PROVEN") process.exitCode = 1;
} finally {
  await db.pool
    .query(
      "delete from event_outbox where space_id=any($1::uuid[])",
      [[primarySpaceId, otherSpaceId]],
    )
    .catch(() => undefined);
  await db.pool
    .query(
      "delete from spaces where id=any($1::uuid[])",
      [[primarySpaceId, otherSpaceId]],
    )
    .catch(() => undefined);
  await db.pool
    .query("delete from users where id=any($1::uuid[])", [[actorA, actorB]])
    .catch(() => undefined);
  await db.pool
    .query("delete from organizations where id=$1", [organizationId])
    .catch(() => undefined);
  await db.close();
}
