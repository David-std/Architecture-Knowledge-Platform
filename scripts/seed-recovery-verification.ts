import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const vaultKey =
  process.env.AKP_RECOVERY_VERIFICATION_VAULT_KEY ?? "recovery-verification-vault";
const outputPath = path.resolve(
  process.env.AKP_RECOVERY_VERIFICATION_MANIFEST ??
    "reports/ci/recovery-state-seed.json",
);
const adminId = "00000000-0000-0000-0000-000000000002";
const organizationId = "00000000-0000-0000-0000-000000000001";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

const vaultResult = await client.query<{
  id: string;
  space_id: string;
  current_revision: string;
}>(
  `select id,space_id,current_revision
     from vaults
    where vault_key=$1 and enabled=true
    limit 1`,
  [vaultKey],
);
const vault = vaultResult.rows[0];
if (!vault) {
  throw new Error(`Recovery verification vault was not found: ${vaultKey}`);
}

const principalResult = await client.query<{ id: string }>(
  "select id from principals where kind='HUMAN' and user_id=$1 limit 1",
  [adminId],
);
const adminPrincipalId = principalResult.rows[0]?.id;
if (!adminPrincipalId) {
  throw new Error("Recovery verification admin principal was not found.");
}

const profileRevisionId = randomUUID();
const sessionId = randomUUID();
const claimId = randomUUID();
const offlineDraftId = randomUUID();
const connectorId = randomUUID();
const connectorEventId = randomUUID();
const peerId = randomUUID();
const truthRevisionId = randomUUID();
const truthSupportSetId = randomUUID();
const temporalFactId = randomUUID();
const graphProjectionRevisionId = randomUUID();
const assuranceRunId = randomUUID();
const assuranceFindingId = randomUUID();
let handoffEventId: string | null = null;
let promotionEventId: string | null = null;

const canonicalProfile = JSON.stringify({
  profileId: "recovery-verification",
  version: "1.0.0",
  purpose: "durable recovery sentinel",
});
const profileHash = sha256(canonicalProfile);
const revisionSet = {
  knowledgeGit: vault.current_revision,
  recoverySentinel: "workspace-state",
};
const revisionSetJson = JSON.stringify(revisionSet);
const revisionSetHash = sha256(revisionSetJson);
const sourceRevisionHash = sha256("recovery-verification-source-revision");
const truthRevisionHash = sha256("recovery-verification-truth-revision");
const connectorPayloadHash = sha256("recovery-verification-connector-event");

await client.query("begin");
try {
  await client.query(
    `insert into knowledge_profile_revisions(
       id,space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
       status,compatibility_class,created_by,validation_report,validated_at,
       activated_at
     ) values(
       $1,$2,$3,'recovery-verification','1.0.0',$4,$5,'ACTIVE','NON_BREAKING',$6,
       '{"recoverySentinel":true}'::jsonb,now(),now()
     )`,
    [
      profileRevisionId,
      vault.space_id,
      vault.id,
      profileHash,
      canonicalProfile,
      adminId,
    ],
  );
  await client.query(
    `update vaults
        set active_knowledge_profile_revision_id=$2
      where id=$1`,
    [vault.id, profileRevisionId],
  );

  await client.query(
    `insert into agent_sessions(
       id,space_id,actor_id,purpose,context_budget,state,vault_id
     ) values(
       $1,$2,$3,'Recovery verification workspace',4096,
       '{"recoverySentinel":true}'::jsonb,$4
     )`,
    [sessionId, vault.space_id, adminId, vault.id],
  );
  await client.query(
    `insert into workspace_session_participants(session_id,user_id,role)
     values($1,$2,'OWNER')`,
    [sessionId, adminId],
  );
  await client.query(
    `insert into workspace_context_revision_sets(
       session_id,space_id,vault_id,revision_set,revision_set_hash
     ) values($1,$2,$3,$4::jsonb,$5)`,
    [sessionId, vault.space_id, vault.id, revisionSetJson, revisionSetHash],
  );
  await client.query(
    `insert into workspace_claims(
       id,session_id,work_key,owner_id,owner_principal_id,status,
       fencing_token,lease_expires_at
     ) values(
       $1,$2,'recovery:workspace-sentinel',$3,$4,'ACTIVE',7,
       now()+interval '1 hour'
     )`,
    [claimId, sessionId, adminId, adminPrincipalId],
  );
  await client.query(
    `insert into workspace_events(
       session_id,space_id,vault_id,actor_id,actor_principal_id,claim_id,
       event_type,payload,session_version
     ) values(
       $1,$2,$3,$4,$5,$6,'NOTE',
       '{"recoverySentinel":"workspace-event"}'::jsonb,1
     )`,
    [sessionId, vault.space_id, vault.id, adminId, adminPrincipalId, claimId],
  );
  const handoffEvent = await client.query<{ id: string }>(
    `insert into workspace_events(
       session_id,space_id,vault_id,actor_id,actor_principal_id,claim_id,
       event_type,payload,session_version
     ) values(
       $1,$2,$3,$4,$5,$6,'CLAIM_HANDOFF',$7::jsonb,2
     )
     returning id::text`,
    [
      sessionId,
      vault.space_id,
      vault.id,
      adminId,
      adminPrincipalId,
      claimId,
      JSON.stringify({
        recoverySentinel: "handoff",
        summary: "Recovery verification structured handoff",
        completed: ["seed durable state"],
        remaining: ["verify restore"],
        blockers: [],
        changedResourceRefs: ["managed/restore-probe.md"],
        evidenceRefs: [],
        questions: [],
        contextRevision: revisionSet,
      }),
    ],
  );
  handoffEventId = handoffEvent.rows[0]?.id ?? null;
  if (!handoffEventId) {
    throw new Error("Recovery verification handoff sentinel was not created.");
  }

  const promotionEvent = await client.query<{ id: string }>(
    `insert into workspace_events(
       session_id,space_id,vault_id,actor_id,actor_principal_id,claim_id,
       event_type,payload,session_version
     ) values(
       $1,$2,$3,$4,$5,null,'PROMOTION_REQUESTED',$6::jsonb,3
     )
     returning id::text`,
    [
      sessionId,
      vault.space_id,
      vault.id,
      adminId,
      adminPrincipalId,
      JSON.stringify({
        recoverySentinel: "promotion",
        sourceScope: "PROJECT",
        targetScope: "TEAM",
        sourceEventIds: [],
        evidenceRefs: [],
        requestedStatus: "REVIEW_REQUIRED",
      }),
    ],
  );
  promotionEventId = promotionEvent.rows[0]?.id ?? null;
  if (!promotionEventId) {
    throw new Error("Recovery verification promotion sentinel was not created.");
  }

  await client.query(
    "update agent_sessions set coordination_version=3 where id=$1",
    [sessionId],
  );
  await client.query(
    `insert into workspace_offline_drafts(
       id,client_draft_id,session_id,space_id,vault_id,actor_id,
       base_revision_set_hash,event_type,payload,status
     ) values(
       $1,'recovery-offline-draft',$2,$3,$4,$5,$6,'NOTE',
       '{"recoverySentinel":"offline-draft"}'::jsonb,'QUEUED'
     )`,
    [
      offlineDraftId,
      sessionId,
      vault.space_id,
      vault.id,
      adminId,
      revisionSetHash,
    ],
  );

  await client.query(
    `insert into federated_graph_projection_revisions(
       id,space_id,vault_id,graph_domain,scope_id,revision,source_revision,
       source_hash,provider,provider_version,configuration_version,lifecycle,
       freshness,requested_at,building_at,ready_at,built_at,activated_at,
       last_successful_update
     ) values(
       $1,$2,$3,'EPISTEMIC','recovery:graph-sentinel',
       'recovery-graph-v1',$4,$5,'recovery-verification','1','recovery-v1','ACTIVE',
       'FRESH',now()-interval '4 seconds',now()-interval '3 seconds',
       now()-interval '2 seconds',now()-interval '2 seconds',
       now()-interval '1 second',now()-interval '1 second'
     )`,
    [
      graphProjectionRevisionId,
      vault.space_id,
      vault.id,
      vault.current_revision,
      sha256("recovery-verification-graph-source"),
    ],
  );

  await client.query(
    `insert into assurance_runs(
       id,space_id,vault_id,trigger,detectors,status,idempotency_key,
       requested_by_user_id,requested_by_principal_id,cursor,started_at,
       completed_at,result_summary
     ) values(
       $1,$2,$3,'MANUAL',array['GROUNDING']::text[],'COMPLETED',
       'recovery-verification-assurance',$4,$5,'{"detectorIndex":1}'::jsonb,
       now()-interval '1 second',now(),
       '{"recoverySentinel":true}'::jsonb
     )`,
    [assuranceRunId, vault.space_id, vault.id, adminId, adminPrincipalId],
  );
  const assuranceFindingKey = sha256(
    `GROUNDING\u001fRECOVERY_SENTINEL\u001f${vault.id}\u001frecovery-verification`,
  );
  await client.query(
    `insert into assurance_findings(
       id,run_id,space_id,vault_id,detector,severity,finding_key,
       subject_kind,subject_id,code,summary,evidence_refs,metadata,
       detector_version,category,scope_id,target_ids,support_set_ids,status,
       proposed_action,revision_set
     ) values(
       $1,$2,$3,$4::uuid,'GROUNDING','INFO',$5,'RECOVERY_SENTINEL',
       'recovery-verification','RECOVERY_SENTINEL','Recovery verification assurance finding',
       '[]'::jsonb,'{"recoverySentinel":true}'::jsonb,'1.0.0','GROUNDING',
       ($4::uuid)::text,'["recovery-verification"]'::jsonb,'[]'::jsonb,'OPEN',null,$6::jsonb
     )`,
    [
      assuranceFindingId,
      assuranceRunId,
      vault.space_id,
      vault.id,
      assuranceFindingKey,
      revisionSetJson,
    ],
  );

  await client.query(
    `insert into source_connector_registrations(
       id,space_id,vault_id,connector_key,source_system,public_key_pem,
       descriptor,state,created_by_user_id
     ) values(
       $1,$2,$3,'recovery-verification-connector','recovery-verification',
       '-----BEGIN PUBLIC KEY----- RECOVERY-VERIFICATION-KEY-MATERIAL -----END PUBLIC KEY-----',
       '{"recoverySentinel":true}'::jsonb,'ACTIVE',$4
     )`,
    [connectorId, vault.space_id, vault.id, adminId],
  );
  await client.query(
    `insert into source_connector_checkpoints(connector_id,applied_sequence)
     values($1,7)`,
    [connectorId],
  );
  await client.query(
    `insert into source_connector_events(
       id,connector_id,event_id,sequence,occurred_at,operation,object_id,
       object_type,source_version,title,content,content_type,
       permission_fidelity,permission_uncertain,acl_fingerprint,metadata,
       payload_hash,status
     ) values(
       $1,$2,'recovery-event-8',8,now(),'UPSERT','RECOVERY-OBJECT',
       'WORK_ITEM','v8','Recovery connector sentinel','durable connector state',
       'text/plain','SOURCE_ACL_MAPPED',false,'recovery-acl',
       '{"recoverySentinel":true}'::jsonb,$3,'PENDING'
     )`,
    [connectorEventId, connectorId, connectorPayloadHash],
  );

  await client.query(
    `insert into context_fabric_peers(
       id,organization_id,space_id,peer_key,display_name,endpoint,
       discovery_mode,trust_state,capabilities,revision,last_seen_at,
       credential_ref,failure_count,last_failure_code
     ) values(
       $1,$2,$3,'recovery-verification-peer','Recovery Proof Peer',
       'https://recovery-peer.example.test','REMOTE_QUERY','APPROVED',
       '{"query":true,"recoverySentinel":true}'::jsonb,'peer:recovery:1',
       now(),'AKP_RECOVERY_PEER_TOKEN',2,'FEDERATION_PEER_TIMEOUT'
     )`,
    [peerId, organizationId, vault.space_id],
  );

  await client.query(
    `insert into truth_revisions(
       id,space_id,vault_id,revision_seq,revision_hash,parent_revision_hash,
       reason,resource_type,resource_id
     ) values(
       $1,$2,$3,1,$4,null,'recovery verification','RECOVERY_SENTINEL',
       'truth-recovery-sentinel'
     )`,
    [truthRevisionId, vault.space_id, vault.id, truthRevisionHash],
  );
  await client.query(
    `insert into truth_support_sets(
       id,space_id,vault_id,state,source_revision_hashes
     ) values($1,$2,$3,'SUPPORTED',array[$4]::text[])`,
    [truthSupportSetId, vault.space_id, vault.id, sourceRevisionHash],
  );
  await client.query(
    `insert into temporal_facts(
       id,space_id,vault_id,scope_id,authorization_path,subject_ref,predicate,
       object,valid_from,recorded_at,support_set_id,lifecycle,
       truth_revision_hash,truth_revision_seq
     ) values(
       $1,$2,$3,'recovery:truth','managed/restore-probe.md',
       'recovery-verification','survives_restore',
       '{"value":true,"recoverySentinel":true}'::jsonb,
       now()-interval '1 minute',now(),$4,'ACTIVE',$5,1
     )`,
    [
      temporalFactId,
      vault.space_id,
      vault.id,
      truthSupportSetId,
      truthRevisionHash,
    ],
  );
  await client.query(
    `insert into truth_revision_heads(
       vault_id,space_id,revision_seq,revision_hash
     ) values($1,$2,1,$3)
     on conflict(vault_id) do update
       set revision_seq=excluded.revision_seq,
           revision_hash=excluded.revision_hash,
           updated_at=now()`,
    [vault.id, vault.space_id, truthRevisionHash],
  );

  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}

const manifest = {
  schemaVersion: 1,
  evidenceLevel: "DURABLE_RECOVERY_SENTINELS",
  vaultKey,
  vaultId: vault.id,
  spaceId: vault.space_id,
  expected: {
    minimumKnowledgeDocuments: 1,
    profileRevisionId,
    sessionId,
    claimId,
    offlineDraftId,
    handoffEventId,
    promotionEventId,
    graphProjectionRevisionId,
    assuranceFindingId,
    connectorId,
    connectorEventId,
    connectorCheckpoint: 7,
    peerId,
    peerCredentialRef: "AKP_RECOVERY_PEER_TOKEN",
    peerFailureCount: 2,
    truthRevisionId,
    truthRevisionHash,
    truthSupportSetId,
    temporalFactId,
  },
  generatedAt: new Date().toISOString(),
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
