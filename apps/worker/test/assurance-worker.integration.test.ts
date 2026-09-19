import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPLEMENTED_ASSURANCE_DETECTORS } from "@akp/domain";
import {
  Postgres,
  appendSourceConnectorEvent,
  applyNextSourceConnectorEvent,
  claimNextAssuranceRun,
  registerSourceConnector,
  submitAssuranceRun,
} from "@akp/postgres";
import { runClaimedAssuranceRun } from "../src/assurance-worker.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describeDb("continuous assurance detector execution", () => {
  let db: Postgres;
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();

  beforeAll(async () => {
    db = new Postgres(databaseUrl!);
    await db.pool.query(
      "insert into organizations(id,slug,name) values($1,$2,$3)",
      [
        organizationId,
        `assurance-worker-${organizationId.slice(0, 8)}`,
        "Assurance worker integration",
      ],
    );
    await db.pool.query(
      `insert into spaces(
         id,organization_id,slug,name,visibility,knowledge_repo_path
       ) values($1,$2,$3,$4,'PRIVATE',$5)`,
      [
        spaceId,
        organizationId,
        `assurance-worker-${spaceId.slice(0, 8)}`,
        "Assurance worker integration",
        `test/${spaceId}`,
      ],
    );
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path
       ) values($1,$2,$3,$4,true,'rev-1',$5,$3)`,
      [
        vaultId,
        spaceId,
        `test/assurance-worker/${vaultId}`,
        "Assurance worker vault",
        `assurance-worker-${vaultId}`,
      ],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.pool.query("delete from spaces where id=$1", [spaceId]);
    await db.pool.query("delete from organizations where id=$1", [
      organizationId,
    ]);
    await db.close();
  });

  it("executes every implemented detector against the live schema", async () => {
    const run = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "MANUAL",
      detectors: [...IMPLEMENTED_ASSURANCE_DETECTORS],
      idempotencyKey: `all-detectors-${randomUUID()}`,
      maxAttempts: 1,
    });
    const workerId = `assurance-detector-smoke-${randomUUID()}`;
    const claimed = await claimNextAssuranceRun(db, workerId, 60, {
      runId: run.id,
    });
    expect(claimed?.id).toBe(run.id);
    if (!claimed) throw new Error("expected assurance run claim");

    await expect(runClaimedAssuranceRun(db, claimed, workerId)).resolves.toBe(
      "COMPLETED",
    );

    const stored = await db.pool.query<{
      status: string;
      cursor: { detectorIndex?: number };
      result_summary: {
        detectorCounts?: Record<string, number>;
        supportedDetectors?: string[];
      };
    }>(
      `select status,cursor,result_summary
         from assurance_runs
        where id=$1`,
      [run.id],
    );
    expect(stored.rows[0]?.status).toBe("COMPLETED");
    expect(stored.rows[0]?.cursor.detectorIndex).toBe(
      IMPLEMENTED_ASSURANCE_DETECTORS.length,
    );
    expect(stored.rows[0]?.result_summary.supportedDetectors).toEqual([
      ...IMPLEMENTED_ASSURANCE_DETECTORS,
    ]);
    for (const detector of IMPLEMENTED_ASSURANCE_DETECTORS) {
      expect(
        stored.rows[0]?.result_summary.detectorCounts?.[detector],
        detector,
      ).toBe(0);
    }
  });

  it("reports connector freshness and ACL drift, then catches a damaged deletion projection", async () => {
    const connector = await registerSourceConnector(db, {
      spaceId,
      vaultId,
      connectorKey: `assurance-connector-${randomUUID()}`,
      sourceSystem: "assurance-fixture",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=\n-----END PUBLIC KEY-----",
      descriptor: {
        schemaVersion: 1,
        sourceSystem: "assurance-fixture",
        objectTypes: ["WORK_ITEM"],
        incremental: { cursor: false, webhook: true },
        permissionFidelity: "SOURCE_ACL_EXACT",
        replication: "FULL_MIRROR",
        dataResidency: "LOCAL",
        attachments: { supported: false },
        rateLimit: { kind: "NONE" },
        checkpointModel: "SOURCE_SEQUENCE",
        deletionPropagation: "TOMBSTONE",
        sourceVersioning: true,
        freshnessSlaSeconds: 60,
        contentTrust: "UNTRUSTED_EXTERNAL",
      },
    });
    const connectorId = String(connector.id);
    const oldOccurredAt = new Date(Date.now() - 3_600_000).toISOString();

    await appendSourceConnectorEvent(db, {
      connectorId,
      eventId: `acl-event-${randomUUID()}`,
      sequence: 1,
      occurredAt: oldOccurredAt,
      operation: "UPSERT",
      objectId: "ticket-assurance",
      objectType: "WORK_ITEM",
      sourceVersion: "v1",
      title: "Connector assurance fixture",
      content: "External untrusted work item.",
      contentType: "text/plain",
      permissionFidelity: "UNKNOWN",
      permissionUncertain: true,
      metadata: {},
      payloadHash: sha256("acl-event-v1"),
    });
    expect(await applyNextSourceConnectorEvent(db)).toMatchObject({
      connectorId,
      sequence: 1,
      operation: "UPSERT",
    });

    const firstRun = await db.pool.query<{ id: string }>(
      `select id
         from assurance_runs
        where space_id=$1 and vault_id=$2
          and idempotency_key=$3
          and trigger='CONNECTOR_EVENT'`,
      [spaceId, vaultId, `connector-event:${connectorId}:1`],
    );
    const firstRunId = firstRun.rows[0]?.id;
    expect(firstRunId).toBeTruthy();
    if (!firstRunId) throw new Error("expected automatic connector assurance");

    const firstWorker = `connector-assurance-${randomUUID()}`;
    const firstClaim = await claimNextAssuranceRun(db, firstWorker, 60, {
      runId: firstRunId,
    });
    expect(firstClaim?.id).toBe(firstRunId);
    if (!firstClaim) throw new Error("expected connector assurance run");

    await expect(
      runClaimedAssuranceRun(db, firstClaim, firstWorker),
    ).resolves.toBe("COMPLETED");

    const firstFindings = await db.pool.query<{
      detector: string;
      code: string;
      severity: string;
    }>(
      `select detector,code,severity
         from assurance_findings
        where run_id=$1
        order by detector,code`,
      [firstRunId],
    );
    expect(firstFindings.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "CONNECTOR_FRESHNESS",
          code: "CONNECTOR_FRESHNESS_SLA_EXCEEDED",
          severity: "HIGH",
        }),
        expect.objectContaining({
          detector: "CONNECTOR_ACL_DRIFT",
          code: "CONNECTOR_ACL_UNCERTAIN",
          severity: "HIGH",
        }),
      ]),
    );
    expect(
      firstFindings.rows.some(
        (finding) => finding.detector === "CONNECTOR_DELETION",
      ),
    ).toBe(false);

    await appendSourceConnectorEvent(db, {
      connectorId,
      eventId: `delete-event-${randomUUID()}`,
      sequence: 2,
      occurredAt: new Date().toISOString(),
      operation: "DELETE",
      objectId: "ticket-assurance",
      objectType: "WORK_ITEM",
      sourceVersion: "v2",
      permissionFidelity: "SOURCE_ACL_EXACT",
      permissionUncertain: false,
      aclFingerprint: "acl-v2",
      metadata: { deleted: true },
      payloadHash: sha256("delete-event-v2"),
    });
    expect(await applyNextSourceConnectorEvent(db)).toMatchObject({
      connectorId,
      sequence: 2,
      operation: "DELETE",
    });

    await db.pool.query(
      `update source_connector_objects
          set lifecycle='ACTIVE',updated_at=now()
        where connector_id=$1 and object_id='ticket-assurance'`,
      [connectorId],
    );

    const deletionRun = await db.pool.query<{ id: string }>(
      `select id
         from assurance_runs
        where space_id=$1 and vault_id=$2
          and idempotency_key=$3
          and trigger='CONNECTOR_EVENT'`,
      [spaceId, vaultId, `connector-event:${connectorId}:2`],
    );
    const deletionRunId = deletionRun.rows[0]?.id;
    expect(deletionRunId).toBeTruthy();
    if (!deletionRunId) {
      throw new Error("expected automatic deletion assurance");
    }

    const deletionWorker = `connector-deletion-${randomUUID()}`;
    const deletionClaim = await claimNextAssuranceRun(db, deletionWorker, 60, {
      runId: deletionRunId,
    });
    expect(deletionClaim?.id).toBe(deletionRunId);
    if (!deletionClaim) throw new Error("expected connector deletion run");

    await expect(
      runClaimedAssuranceRun(db, deletionClaim, deletionWorker),
    ).resolves.toBe("COMPLETED");

    const deletionFinding = await db.pool.query<{
      detector: string;
      code: string;
      severity: string;
    }>(
      `select detector,code,severity
         from assurance_findings
        where run_id=$1 and detector='CONNECTOR_DELETION'`,
      [deletionRunId],
    );
    expect(deletionFinding.rows[0]).toMatchObject({
      detector: "CONNECTOR_DELETION",
      code: "CONNECTOR_DELETE_NOT_TOMBSTONED",
      severity: "CRITICAL",
    });
  });
  it("detects ambiguous identities, missing governed links, orphan graph nodes, and repository SHA drift", async () => {
    const documentA = randomUUID();
    const documentB = randomUUID();
    const projectId = randomUUID();
    const generationId = randomUUID();
    const unitA1 = randomUUID();
    const unitA2 = randomUUID();
    const unitB1 = randomUUID();
    const unitB2 = randomUUID();
    const projectionId = randomUUID();
    const runtimeProjectionId = randomUUID();
    const nodeId = randomUUID();
    const slug = `assurance-project-${projectId.slice(0, 8)}`;
    const currentCommit = "b".repeat(40);
    const indexedCommit = "a".repeat(40);
    const graphRevision = `${indexedCommit}:fixture-v1`;
    const corpusRevision = "assurance-semantic-corpus-v1";
    const semanticVector = `[${Array.from({ length: 64 }, (_, index) =>
      index === 0 ? "1" : "0",
    ).join(",")}]`;
    const scopeId = `project:${vaultId.toLowerCase()}:${slug.toLowerCase()}`;

    try {
      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
           current_revision,body_cache,frontmatter,aliases,layer,content_hash,
           token_estimate,raw_links
         ) values
           ($1,$3,$4,'assurance/alpha.md','ASSURANCE-ALPHA',
            'Assurance Alpha','concept','ACTIVE','HUMAN_REVIEWED','rev-identity',
            'alpha','{}'::jsonb,array['shared-assurance-identity'],'compiled',
            $5,10,$7::jsonb),
           ($2,$3,$4,'assurance/beta.md','ASSURANCE-BETA',
            'Assurance Beta','concept','ACTIVE','HUMAN_REVIEWED','rev-identity',
            'beta','{}'::jsonb,array['shared-assurance-identity'],'compiled',
            $6,10,'[]'::jsonb)`,
        [
          documentA,
          documentB,
          spaceId,
          vaultId,
          sha256("assurance-alpha"),
          sha256("assurance-beta"),
          JSON.stringify(["ASSURANCE-BETA"]),
        ],
      );

      await db.pool.query(
        `insert into vault_index_revisions(
           space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
           graph_revision,context_pack_revision,status,warnings
         ) values($1,$2,$3,$3,$3,$3,$3,'READY','[]'::jsonb)`,
        [spaceId, vaultId, corpusRevision],
      );
      await db.pool.query(
        `insert into knowledge_units(
           id,document_id,space_id,vault_id,unit_key,unit_type,body,content_hash,
           corpus_revision,lifecycle,trust_tier,token_estimate,
           document_revision,structural_order,container_only,embedding_eligible
         ) values
           ($1,$5,$7,$8,'a-1','RULE','Semantic duplicate rule alpha one',$9,
            $13,'ACTIVE','HUMAN_REVIEWED',8,'rev-identity',1,false,true),
           ($2,$5,$7,$8,'a-2','RULE','Semantic duplicate rule alpha two',$10,
            $13,'ACTIVE','HUMAN_REVIEWED',8,'rev-identity',2,false,true),
           ($3,$6,$7,$8,'b-1','RULE','Semantically equivalent beta one',$11,
            $13,'ACTIVE','HUMAN_REVIEWED',8,'rev-identity',1,false,true),
           ($4,$6,$7,$8,'b-2','RULE','Semantically equivalent beta two',$12,
            $13,'ACTIVE','HUMAN_REVIEWED',8,'rev-identity',2,false,true)`,
        [
          unitA1,
          unitA2,
          unitB1,
          unitB2,
          documentA,
          documentB,
          spaceId,
          vaultId,
          sha256("semantic-unit-a-1"),
          sha256("semantic-unit-a-2"),
          sha256("semantic-unit-b-1"),
          sha256("semantic-unit-b-2"),
          corpusRevision,
        ],
      );
      await db.pool.query(
        `insert into embedding_generations(
           id,space_id,vault_id,provider,model,model_revision,dimensions,
           normalization,configuration_version,corpus_revision,status,
           input_strategy,configuration_hash,runtime
         ) values(
           $1,$2,$3,'assurance-fixture','semantic-fixture','1',64,
           'l2','semantic-assurance-v1',$4,'BUILDING',
           'unit-body-v1',$5,'integration-test'
         )`,
        [
          generationId,
          spaceId,
          vaultId,
          corpusRevision,
          sha256("semantic-assurance-v1"),
        ],
      );
      await db.pool.query(
        `insert into unit_embeddings(
           unit_id,generation_id,content_hash,embedding,embedding_dimensions
         ) values
           ($1,$5,$6,$10::vector,64),
           ($2,$5,$7,$10::vector,64),
           ($3,$5,$8,$10::vector,64),
           ($4,$5,$9,$10::vector,64)`,
        [
          unitA1,
          unitA2,
          unitB1,
          unitB2,
          generationId,
          sha256("semantic-unit-a-1"),
          sha256("semantic-unit-a-2"),
          sha256("semantic-unit-b-1"),
          sha256("semantic-unit-b-2"),
          semanticVector,
        ],
      );
      await db.pool.query(
        "update embedding_generations set status='READY' where id=$1",
        [generationId],
      );
      await db.pool.query(
        "select * from akp_activate_embedding_generation($1)",
        [generationId],
      );

      await db.pool.query(
        `insert into projects(
           id,space_id,vault_id,slug,root_path,metadata
         ) values($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          projectId,
          spaceId,
          vaultId,
          slug,
          `test/project/${projectId}`,
          JSON.stringify({
            commit: currentCommit,
            codeGraph: {
              status: "ACTIVE",
              sourceRevision: indexedCommit,
            },
          }),
        ],
      );

      await db.pool.query(
        `insert into federated_graph_projection_revisions(
           id,space_id,vault_id,graph_domain,scope_id,revision,source_revision,
           provider,provider_version,configuration_version,lifecycle,freshness,
           built_at,activated_at,last_successful_update
         ) values(
           $1,$2,$3,'CODE',$4,$5,$6,
           'assurance-fixture','1','fixture-v1','ACTIVE','FRESH',
           now(),now(),now()
         )`,
        [projectionId, spaceId, vaultId, scopeId, graphRevision, indexedCommit],
      );
      await db.pool.query(
        `insert into federated_graph_projection_revisions(
           id,space_id,vault_id,graph_domain,scope_id,revision,source_revision,
           provider,provider_version,configuration_version,lifecycle,freshness,
           built_at,activated_at,last_successful_update
         ) values(
           $1,$2,$3,'RUNTIME',$4,$5,$6,
           'node-v8','test','runtime-v1','ACTIVE','FRESH',
           now(),now(),now()
         )`,
        [
          runtimeProjectionId,
          spaceId,
          vaultId,
          scopeId,
          `runtime:${indexedCommit}`,
          indexedCommit,
        ],
      );

      await db.pool.query(
        `insert into federated_graph_nodes(
           id,space_id,vault_id,graph_domain,scope_id,kind,canonical_key,
           revision,authorization_path,payload,payload_hash
         ) values(
           $1,$2,$3,'CODE',$4,'function','fixture-node',$5,
           $6,'{}'::jsonb,$7
         )`,
        [
          nodeId,
          spaceId,
          vaultId,
          scopeId,
          graphRevision,
          `projects/${slug}/src/fixture.ts`,
          sha256("{}"),
        ],
      );
      await db.pool.query(
        `insert into federated_graph_projection_nodes(
           projection_revision_id,node_id
         ) values($1,$2)`,
        [projectionId, nodeId],
      );

      const run = await submitAssuranceRun(db, {
        spaceId,
        vaultId,
        trigger: "MANUAL",
        detectors: [
          "FRESHNESS",
          "DUPLICATE_IDENTITY",
          "GRAPH_HEALTH",
          "CODE_GRAPH_FRESHNESS",
          "LINK_GAP",
        ],
        idempotencyKey: `structural-detectors-${randomUUID()}`,
        maxAttempts: 1,
      });
      const workerId = `structural-detectors-${randomUUID()}`;
      const claimed = await claimNextAssuranceRun(db, workerId, 60, {
        runId: run.id,
      });
      if (!claimed) throw new Error("expected structural detector run");

      await expect(runClaimedAssuranceRun(db, claimed, workerId)).resolves.toBe(
        "COMPLETED",
      );

      const findings = await db.pool.query<{
        detector: string;
        code: string;
        target_ids: string[];
      }>(
        `select detector,code,target_ids
           from assurance_findings
          where run_id=$1
          order by detector,code`,
        [run.id],
      );
      expect(findings.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detector: "DUPLICATE_IDENTITY",
            code: "AMBIGUOUS_KNOWLEDGE_IDENTITY",
          }),
          expect.objectContaining({
            detector: "DUPLICATE_IDENTITY",
            code: "SEMANTIC_DUPLICATE_CANDIDATE",
          }),
          expect.objectContaining({
            detector: "FRESHNESS",
            code: "CODE_GRAPH_BEHIND_REPOSITORY_HEAD",
          }),
          expect.objectContaining({
            detector: "LINK_GAP",
            code: "MISSING_RESOLVED_LINK_RELATION",
          }),
          expect.objectContaining({
            detector: "GRAPH_HEALTH",
            code: "GRAPH_ORPHAN_NODE",
          }),
          expect.objectContaining({
            detector: "CODE_GRAPH_FRESHNESS",
            code: "CODE_GRAPH_REPO_SHA_MISMATCH",
          }),
          expect.objectContaining({
            detector: "CODE_GRAPH_FRESHNESS",
            code: "STALE_RUNTIME_EVIDENCE",
          }),
        ]),
      );
      const identity = findings.rows.find(
        (finding) => finding.code === "AMBIGUOUS_KNOWLEDGE_IDENTITY",
      );
      expect(new Set(identity?.target_ids)).toEqual(
        new Set([documentA, documentB]),
      );
    } finally {
      await db.pool.query(
        "delete from federated_graph_projection_revisions where id=any($1::uuid[])",
        [[projectionId, runtimeProjectionId]],
      );
      await db.pool.query("delete from federated_graph_nodes where id=$1", [
        nodeId,
      ]);
      await db.pool.query("delete from projects where id=$1", [projectId]);
      await db.pool.query(
        "delete from unit_embeddings where generation_id=$1",
        [generationId],
      );
      await db.pool.query("delete from embedding_generations where id=$1", [
        generationId,
      ]);
      await db.pool.query(
        "delete from knowledge_units where id=any($1::uuid[])",
        [[unitA1, unitA2, unitB1, unitB2]],
      );
      await db.pool.query(
        "delete from vault_index_revisions where space_id=$1 and vault_id=$2",
        [spaceId, vaultId],
      );
      await db.pool.query(
        "delete from knowledge_documents where id=any($1::uuid[])",
        [[documentA, documentB]],
      );
    }
  });

  it("detects withdrawn source dependencies and evidence hash integrity failures", async () => {
    const sourceId = randomUUID();
    const artifactId = randomUUID();
    const evidenceId = randomUUID();
    const documentId = randomUUID();
    const sourceHash = sha256(`source-${sourceId}`);
    const wrongArtifactHash = sha256(`artifact-${artifactId}`);

    try {
      await db.pool.query(
        `insert into sources(
           id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
           object_key,status,metadata
         ) values(
           $1,$2,$3,'Assurance source',$4,'text/plain',$5,16,$6,
           'WITHDRAWN','{}'::jsonb
         )`,
        [
          sourceId,
          spaceId,
          vaultId,
          `fixture://${sourceId}`,
          sourceHash,
          `sources/${sourceHash}`,
        ],
      );
      await db.pool.query(
        `insert into source_artifacts(
           id,source_id,kind,object_key,source_hash,extractor,
           extractor_version,quality,metadata
         ) values(
           $1,$2,'fixture',$3,$4,'deterministic','1',
           'MACHINE_EXTRACTED','{}'::jsonb
         )`,
        [artifactId, sourceId, `artifacts/${artifactId}`, wrongArtifactHash],
      );
      await db.pool.query(
        `insert into evidence(
           id,space_id,vault_id,source_id,artifact_id,locator,content_hash,
           excerpt,review_status
         ) values(
           $1,$2,$3,$4,$5,$6::jsonb,$7,'bounded evidence','APPROVED'
         )`,
        [
          evidenceId,
          spaceId,
          vaultId,
          sourceId,
          artifactId,
          JSON.stringify({
            kind: "source",
            source_hash: sourceHash,
            path: `source:${sourceId}`,
          }),
          sha256("bounded evidence"),
        ],
      );
      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
           current_revision,body_cache,frontmatter,aliases,layer,content_hash,
           token_estimate,raw_links
         ) values(
           $1,$2,$3,$4,$5,'Grounding fixture','claim','ACTIVE',
           'HUMAN_REVIEWED','grounding-rev','grounded claim','{}'::jsonb,
           '{}','compiled',$6,8,'[]'::jsonb
         )`,
        [
          documentId,
          spaceId,
          vaultId,
          `assurance/grounding-${documentId}.md`,
          `GROUNDING-${documentId}`,
          sha256("grounded claim"),
        ],
      );
      await db.pool.query(
        `insert into document_evidence(document_id,evidence_id)
         values($1,$2)`,
        [documentId, evidenceId],
      );

      const run = await submitAssuranceRun(db, {
        spaceId,
        vaultId,
        trigger: "MANUAL",
        detectors: ["GROUNDING", "FRESHNESS"],
        idempotencyKey: `grounding-freshness-${randomUUID()}`,
        maxAttempts: 1,
      });
      const workerId = `grounding-freshness-${randomUUID()}`;
      const claimed = await claimNextAssuranceRun(db, workerId, 60, {
        runId: run.id,
      });
      if (!claimed) throw new Error("expected grounding/freshness run");

      await expect(
        runClaimedAssuranceRun(db, claimed, workerId),
      ).resolves.toBe("COMPLETED");

      const findings = await db.pool.query<{
        detector: string;
        code: string;
      }>(
        `select detector,code
           from assurance_findings
          where run_id=$1
          order by detector,code`,
        [run.id],
      );
      expect(findings.rows).toEqual(
        expect.arrayContaining([
          {
            detector: "GROUNDING",
            code: "ARTIFACT_SOURCE_HASH_MISMATCH",
          },
          {
            detector: "FRESHNESS",
            code: "DEPENDENCY_SOURCE_REMOVED",
          },
        ]),
      );
    } finally {
      await db.pool.query("delete from knowledge_documents where id=$1", [
        documentId,
      ]);
      await db.pool.query("delete from evidence where id=$1", [evidenceId]);
      await db.pool.query("delete from source_artifacts where id=$1", [
        artifactId,
      ]);
      await db.pool.query("delete from sources where id=$1", [sourceId]);
    }
  });
  it("probes persisted context for cross-vault, cross-space, federation, and evidence leakage", async () => {
    const siblingVaultId = randomUUID();
    const siblingDocumentId = randomUUID();
    const siblingSourceId = randomUUID();
    const siblingEvidenceId = randomUUID();
    const foreignSpaceId = randomUUID();
    const foreignVaultId = randomUUID();
    const foreignDocumentId = randomUUID();
    const crossVaultPacketId = randomUUID();
    const crossSpacePacketId = randomUUID();
    const nonFederatedPacketId = randomUUID();
    const foreignScopePacketId = randomUUID();
    const continuationHandle = sha256(`continuation-${crossSpacePacketId}`);

    try {
      await db.pool.query(
        `insert into vaults(
           id,space_id,canonical_path,name,read_only,current_revision,
           vault_key,local_path
         ) values($1,$2,$3,$4,true,'rev-1',$5,$3)`,
        [
          siblingVaultId,
          spaceId,
          `test/assurance-sibling/${siblingVaultId}`,
          "Assurance sibling vault",
          `assurance-sibling-${siblingVaultId}`,
        ],
      );
      await db.pool.query(
        `insert into spaces(
           id,organization_id,slug,name,visibility,knowledge_repo_path
         ) values($1,$2,$3,$4,'PRIVATE',$5)`,
        [
          foreignSpaceId,
          organizationId,
          `assurance-foreign-${foreignSpaceId.slice(0, 8)}`,
          "Assurance foreign space",
          `test/foreign-space/${foreignSpaceId}`,
        ],
      );
      await db.pool.query(
        `insert into vaults(
           id,space_id,canonical_path,name,read_only,current_revision,
           vault_key,local_path
         ) values($1,$2,$3,$4,true,'rev-1',$5,$3)`,
        [
          foreignVaultId,
          foreignSpaceId,
          `test/assurance-foreign/${foreignVaultId}`,
          "Assurance foreign vault",
          `assurance-foreign-${foreignVaultId}`,
        ],
      );

      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
           current_revision,body_cache,frontmatter,aliases,layer,content_hash,
           token_estimate,raw_links
         ) values
           ($1,$3,$4,$5,$6,'Sibling boundary fixture','concept','ACTIVE',
            'HUMAN_REVIEWED','boundary-v1','sibling','{}'::jsonb,'{}','compiled',
            $7,4,'[]'::jsonb),
           ($2,$8,$9,$10,$11,'Foreign boundary fixture','concept','ACTIVE',
            'HUMAN_REVIEWED','boundary-v1','foreign','{}'::jsonb,'{}','compiled',
            $12,4,'[]'::jsonb)`,
        [
          siblingDocumentId,
          foreignDocumentId,
          spaceId,
          siblingVaultId,
          `assurance/sibling-${siblingDocumentId}.md`,
          `BOUNDARY-SIBLING-${siblingDocumentId}`,
          sha256("sibling-boundary-document"),
          foreignSpaceId,
          foreignVaultId,
          `assurance/foreign-${foreignDocumentId}.md`,
          `BOUNDARY-FOREIGN-${foreignDocumentId}`,
          sha256("foreign-boundary-document"),
        ],
      );

      const siblingSourceHash = sha256(`boundary-source-${siblingSourceId}`);
      await db.pool.query(
        `insert into sources(
           id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
           object_key,status,metadata
         ) values(
           $1,$2,$3,'Boundary source',$4,'text/plain',$5,16,$6,
           'ACTIVE','{}'::jsonb
         )`,
        [
          siblingSourceId,
          spaceId,
          siblingVaultId,
          `fixture://boundary/${siblingSourceId}`,
          siblingSourceHash,
          `sources/${siblingSourceHash}`,
        ],
      );
      await db.pool.query(
        `insert into evidence(
           id,space_id,vault_id,source_id,locator,content_hash,excerpt,
           review_status
         ) values(
           $1,$2,$3,$4,$5::jsonb,$6,'sibling evidence','APPROVED'
         )`,
        [
          siblingEvidenceId,
          spaceId,
          siblingVaultId,
          siblingSourceId,
          JSON.stringify({
            kind: "source",
            source_hash: siblingSourceHash,
            path: `source:${siblingSourceId}`,
          }),
          sha256("sibling evidence"),
        ],
      );

      const insertPacket = async (
        id: string,
        persistedVaultId: string | null,
        packet: Record<string, unknown>,
        packetScope: Record<string, unknown>,
      ) => {
        await db.pool.query(
          `insert into context_packets(
             id,space_id,vault_id,actor_id,corpus_revision,query_hash,
             packet_hash,request,packet,scope
           ) values(
             $1,$2,$3,null,'boundary-rev',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb
           )`,
          [
            id,
            spaceId,
            persistedVaultId,
            sha256(`query-${id}`),
            sha256(`packet-${id}`),
            JSON.stringify({ query: "controlled access boundary probe" }),
            JSON.stringify(packet),
            JSON.stringify(packetScope),
          ],
        );
      };

      await insertPacket(
        crossVaultPacketId,
        vaultId,
        {
          sections: [
            {
              documentId: siblingDocumentId,
              vaultId: siblingVaultId,
              sourceOrEvidenceIds: [siblingEvidenceId],
            },
          ],
        },
        {
          spaceId,
          vaultIds: [vaultId],
          federated: false,
        },
      );

      await insertPacket(
        crossSpacePacketId,
        vaultId,
        { sections: [] },
        {
          spaceId,
          vaultIds: [vaultId],
          federated: false,
        },
      );
      await db.pool.query(
        `insert into context_packet_continuations(
           packet_id,handle,reason,remaining_tokens,sections
         ) values($1,$2,'controlled boundary fixture',1,$3::jsonb)`,
        [
          crossSpacePacketId,
          continuationHandle,
          JSON.stringify([
            {
              documentId: foreignDocumentId,
              vaultId: foreignVaultId,
              sourceOrEvidenceIds: [],
            },
          ]),
        ],
      );

      await insertPacket(
        nonFederatedPacketId,
        null,
        { sections: [] },
        {
          spaceId,
          vaultIds: [vaultId, siblingVaultId],
          federated: false,
        },
      );

      await insertPacket(
        foreignScopePacketId,
        null,
        { sections: [] },
        {
          spaceId,
          vaultIds: [vaultId, foreignVaultId],
          federated: true,
        },
      );

      const run = await submitAssuranceRun(db, {
        spaceId,
        vaultId,
        trigger: "MANUAL",
        detectors: ["ACCESS_BOUNDARY"],
        idempotencyKey: `access-boundary-${randomUUID()}`,
        maxAttempts: 1,
      });
      const workerId = `access-boundary-${randomUUID()}`;
      const claimed = await claimNextAssuranceRun(db, workerId, 60, {
        runId: run.id,
      });
      if (!claimed) throw new Error("expected access-boundary assurance run");

      await expect(runClaimedAssuranceRun(db, claimed, workerId)).resolves.toBe(
        "COMPLETED",
      );

      const findings = await db.pool.query<{
        code: string;
        target_ids: string[];
        metadata: Record<string, unknown>;
      }>(
        `select code,target_ids,metadata
           from assurance_findings
          where run_id=$1 and detector='ACCESS_BOUNDARY'
          order by code,target_ids::text`,
        [run.id],
      );

      expect(findings.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "CONTEXT_PACKET_CROSS_VAULT_LEAK",
          }),
          expect.objectContaining({
            code: "CONTEXT_PACKET_CROSS_SPACE_LEAK",
          }),
          expect.objectContaining({
            code: "CONTEXT_PACKET_EVIDENCE_SCOPE_LEAK",
          }),
          expect.objectContaining({
            code: "NON_FEDERATED_MULTI_VAULT_SCOPE",
          }),
          expect.objectContaining({
            code: "CONTEXT_PACKET_SCOPE_VAULT_OUTSIDE_SPACE",
          }),
        ]),
      );

      const crossSpace = findings.rows.find(
        (finding) => finding.code === "CONTEXT_PACKET_CROSS_SPACE_LEAK",
      );
      expect(crossSpace?.target_ids).toEqual(
        expect.arrayContaining([crossSpacePacketId, foreignDocumentId]),
      );
      expect(crossSpace?.metadata).toMatchObject({
        location: "CONTINUATION",
        handle: continuationHandle,
        documentSpaceId: foreignSpaceId,
        documentVaultId: foreignVaultId,
      });

      const crossVault = findings.rows.find(
        (finding) => finding.code === "CONTEXT_PACKET_CROSS_VAULT_LEAK",
      );
      expect(crossVault?.target_ids).toEqual(
        expect.arrayContaining([crossVaultPacketId, siblingDocumentId]),
      );
      expect(crossVault?.metadata).toMatchObject({
        location: "PACKET",
        documentSpaceId: spaceId,
        documentVaultId: siblingVaultId,
      });
    } finally {
      await db.pool.query(
        "delete from context_packets where id=any($1::uuid[])",
        [[
          crossVaultPacketId,
          crossSpacePacketId,
          nonFederatedPacketId,
          foreignScopePacketId,
        ]],
      );
      await db.pool.query("delete from evidence where id=$1", [
        siblingEvidenceId,
      ]);
      await db.pool.query("delete from sources where id=$1", [siblingSourceId]);
      await db.pool.query(
        "delete from knowledge_documents where id=any($1::uuid[])",
        [[siblingDocumentId, foreignDocumentId]],
      );
      await db.pool.query("delete from vaults where id=$1", [siblingVaultId]);
      await db.pool.query("delete from spaces where id=$1", [foreignSpaceId]);
    }
  });

  it("paginates a large detector scan beyond the first 500 findings", async () => {
    const paginationRevision = `assurance-pagination-${randomUUID()}`;
    try {
      await db.pool.query(
        `insert into context_packets(
           id,space_id,vault_id,actor_id,corpus_revision,query_hash,
           packet_hash,request,packet,scope
         )
         select gen_random_uuid(),$1,$2,null,$3,
                'pagination-query-'||g::text,
                'pagination-packet-'||g::text,
                '{}'::jsonb,
                jsonb_build_object('sections','[]'::jsonb),
                jsonb_build_object(
                  'spaceId',$1::text,
                  'federated',false
                )
           from generate_series(1,501) g`,
        [spaceId, vaultId, paginationRevision],
      );

      const run = await submitAssuranceRun(db, {
        spaceId,
        vaultId,
        trigger: "MANUAL",
        detectors: ["ACCESS_BOUNDARY"],
        idempotencyKey: `pagination-${randomUUID()}`,
        maxAttempts: 1,
      });
      const workerId = `pagination-${randomUUID()}`;
      const claimed = await claimNextAssuranceRun(db, workerId, 60, {
        runId: run.id,
      });
      if (!claimed) throw new Error("expected paginated assurance run");

      await expect(runClaimedAssuranceRun(db, claimed, workerId)).resolves.toBe(
        "COMPLETED",
      );

      const persisted = await db.pool.query<{
        status: string;
        cursor: {
          detectorIndex: number;
          detectorCursor?: string;
          detectorCounts?: Record<string, number>;
        };
        result_summary: {
          detectorCounts?: Record<string, number>;
          pagination?: { pageSize?: number; maxOffset?: number };
        };
      }>(
        `select status,cursor,result_summary
           from assurance_runs
          where id=$1`,
        [run.id],
      );
      expect(persisted.rows[0]).toMatchObject({
        status: "COMPLETED",
        cursor: {
          detectorIndex: 1,
          detectorCounts: { ACCESS_BOUNDARY: 501 },
        },
        result_summary: {
          detectorCounts: { ACCESS_BOUNDARY: 501 },
          pagination: { pageSize: 500 },
        },
      });
      expect(persisted.rows[0]?.cursor.detectorCursor).toBeUndefined();

      const findings = await db.pool.query<{ count: number }>(
        `select count(*)::int count
           from assurance_findings
          where run_id=$1
            and detector='ACCESS_BOUNDARY'
            and code='CONTEXT_PACKET_SCOPE_MISMATCH'`,
        [run.id],
      );
      expect(findings.rows[0]?.count).toBe(501);
    } finally {
      await db.pool.query(
        `delete from context_packets
          where space_id=$1 and vault_id=$2 and corpus_revision=$3`,
        [spaceId, vaultId, paginationRevision],
      );
    }
  });

});
