import { config } from "dotenv";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  Postgres,
  appendOutboxEvent,
  claimNextIngestJob,
  runKnowledgeLint,
} from "@akp/postgres";
import { DocumentIntelligenceRequest } from "@akp/contracts";
import { transitionIngest, type IngestState } from "@akp/domain";
import {
  hashFile,
  MinioObjectStore,
  type RawObjectRef,
} from "@akp/object-store";
import {
  CompilationPlan,
  createConfiguredKnowledgeCompiler,
} from "@akp/compiler";
import { GitKnowledgeStore } from "@akp/git-store";
import { validateMarkdownDocument } from "@akp/validation";
import mime from "mime-types";
import { DurableEventWorker } from "./event-worker.js";
import { createIndexEventHandlers } from "./event-handlers.js";
import { lifecycleEventForState } from "./lifecycle.js";
import {
  DEFAULT_WORKER_DRAIN_DEADLINE_MS,
  drainToQuiescence,
  WorkerDrainError,
  type WorkerDrainSummary,
} from "./drain.js";
import {
  DOCUMENT_ARTIFACT_SCHEMA_VERSION,
  parseCanonicalExtractionResponse,
  renderDocumentArtifactPreview,
} from "./document-artifact.js";
import { buildCompilationStage } from "./compilation-stage.js";
import { evaluateCompilationProbes } from "./compilation-probes.js";
import { selectEvidenceFragment } from "./evidence-fragment.js";
import { resolveAuthorizedLocalSource } from "./source-boundary.js";

config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const extractorUrl = process.env.AKP_EXTRACTOR_URL ?? "http://127.0.0.1:8090";
const workerId = `${hostname()}:${process.pid}`;
const db = new Postgres(databaseUrl);
const managedRepository =
  process.env.AKP_MANAGED_REPO || path.join(tmpdir(), "akp-managed-knowledge");
const git = new GitKnowledgeStore(managedRepository);

const eventWorker = new DurableEventWorker(db, {
  consumerName: process.env.AKP_EVENT_CONSUMER ?? "ingest-and-indexing",
  workerId: `${workerId}:events`,
  maxAttempts: Number(process.env.AKP_EVENT_MAX_ATTEMPTS ?? 8),
  leaseSeconds: Number(process.env.AKP_EVENT_LEASE_SECONDS ?? 60),
  handlers: {
    ...createIndexEventHandlers(db, git),
    // The ingest job remains the durable work record.  This handler turns the
    // event into a prompt for the existing claim loop while preserving the
    // event's idempotent delivery semantics.
    ExtractionRequested: async (event) => {
      const jobId = String(event.payload.jobId ?? event.resourceId);
      await db.pool.query(
        `
        update ingest_jobs
           set next_attempt_at=least(next_attempt_at,now()),updated_at=now()
         where id=$1 and state in ('RECEIVED','HASHED','STORED','NORMALIZING','ANALYZING')
        `,
        [jobId],
      );
    },
  },
});
const objects = new MinioObjectStore({
  endpoint: process.env.AKP_RAW_ENDPOINT ?? "http://127.0.0.1:19000",
  accessKey: process.env.AKP_RAW_ACCESS_KEY ?? "akp",
  secretKey: process.env.AKP_RAW_SECRET_KEY ?? "change-me",
  bucket: process.env.AKP_RAW_BUCKET ?? "akp-raw",
});
const authorName =
  process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform";
const authorEmail = process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost";
const lintIntervalMs = Math.max(
  60_000,
  Number(process.env.AKP_LINT_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
);
let nextLintCheckAt = 0;

async function runScheduledLintIfDue(force = false): Promise<void> {
  if (!force && Date.now() < nextLintCheckAt) return;
  nextLintCheckAt = Date.now() + Math.min(lintIntervalMs, 60 * 60 * 1000);
  const spaces = await db.pool.query(
    `
    select s.id,v.id vault_id,
           (select max(created_at) from knowledge_lint_runs l
             where l.space_id=s.id and l.vault_id=v.id and l.trigger='SCHEDULED') last_scheduled
      from spaces s left join vaults v on v.space_id=s.id and v.enabled
     order by s.id,v.id
    `,
  );
  for (const space of spaces.rows) {
    const last = space.last_scheduled
      ? new Date(String(space.last_scheduled)).getTime()
      : 0;
    if (space.vault_id && (force || Date.now() - last >= lintIntervalMs)) {
      await runKnowledgeLint(
        db,
        String(space.id),
        String(space.vault_id),
        "SCHEDULED",
      );
    }
  }
}

async function updateState(
  jobId: string,
  current: IngestState,
  next: IngestState,
  stageOutput?: Record<string, unknown>,
  result?: unknown,
): Promise<void> {
  transitionIngest(current, next);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const updated = await client.query<{
      id: string;
      space_id: string;
      vault_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `
      update ingest_jobs
         set state = $3,
             result = coalesce($4::jsonb, result),
             stage_outputs = stage_outputs || coalesce($5::jsonb, '{}'::jsonb),
             lease_owner = null,
             lease_expires_at = null,
             heartbeat_at = now(),
             updated_at = now()
       where id = $1 and state = $2 and lease_owner = $6 and cancelled_at is null
       returning id,space_id,vault_id,payload
      `,
      [
        jobId,
        current,
        next,
        result === undefined ? null : JSON.stringify(result),
        stageOutput === undefined ? null : JSON.stringify(stageOutput),
        workerId,
      ],
    );
    if (!updated.rowCount) {
      throw new Error("JOB_LEASE_LOST_OR_CANCELLED");
    }
    await client.query(
      `
      insert into ingest_job_events(job_id,state,event_type,payload)
      values($1,$2,'STATE_TRANSITION',$3::jsonb)
      `,
      [jobId, next, JSON.stringify({ from: current, workerId })],
    );
    const lifecycleEvent = lifecycleEventForState(next);
    if (lifecycleEvent) {
      const emitted = await appendOutboxEvent(client, {
        eventType: lifecycleEvent.eventType,
        resourceId: String(updated.rows[0]?.id ?? jobId),
        spaceId: String(updated.rows[0]?.space_id),
        vaultId: updated.rows[0]?.vault_id ?? null,
        correlationId: jobId,
        payload: {
          jobId,
          state: next,
          sourceId:
            typeof (stageOutput ?? {}).sourceId === "string"
              ? (stageOutput as Record<string, unknown>).sourceId
              : null,
          revision:
            typeof (stageOutput ?? {}).revision === "string"
              ? (stageOutput as Record<string, unknown>).revision
              : null,
        },
      });
      for (const eventType of lifecycleEvent.followUps) {
        await appendOutboxEvent(client, {
          eventType,
          resourceId: String(updated.rows[0]?.id ?? jobId),
          spaceId: String(updated.rows[0]?.space_id),
          vaultId: updated.rows[0]?.vault_id ?? null,
          correlationId: jobId,
          causationId: emitted.eventId,
          payload: {
            jobId,
            state: next,
            revision:
              typeof (stageOutput ?? {}).revision === "string"
                ? (stageOutput as Record<string, unknown>).revision
                : null,
            changedPaths: Array.isArray((stageOutput ?? {}).changedPaths)
              ? (stageOutput as Record<string, unknown>).changedPaths
              : [],
            tombstones: Array.isArray((stageOutput ?? {}).tombstones)
              ? (stageOutput as Record<string, unknown>).tombstones
              : [],
          },
        });
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

type ProviderTaskEvent =
  "PROVIDER_TASK_STARTED" | "PROVIDER_TASK_SUCCEEDED" | "PROVIDER_TASK_FAILED";

async function recordProviderTaskEvent(
  jobId: string,
  state: IngestState,
  eventType: ProviderTaskEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const inserted = await db.pool.query(
    `
    insert into ingest_job_events(job_id,state,event_type,payload)
    select $1,$2,$3,$4::jsonb
     where exists (
       select 1 from ingest_jobs
        where id=$1 and lease_owner=$5 and cancelled_at is null
     )
    returning id
    `,
    [jobId, state, eventType, JSON.stringify(payload), workerId],
  );
  if (!inserted.rowCount) {
    throw new Error("JOB_LEASE_LOST_OR_CANCELLED");
  }
}

function providerTaskErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g,
      "[REDACTED_PATH]",
    )
    .slice(0, 2_000);
}

function extractorConfiguration(
  documentIntelligence: ReturnType<typeof DocumentIntelligenceRequest.parse>,
): Record<string, unknown> {
  return {
    ...(documentIntelligence.extractor
      ? { extractor: documentIntelligence.extractor }
      : {}),
    ...(documentIntelligence.ocr === undefined
      ? {}
      : { ocr: documentIntelligence.ocr }),
    ...(documentIntelligence.ocrEngine
      ? { ocr_engine: documentIntelligence.ocrEngine }
      : {}),
    ...(documentIntelligence.forceFullPageOcr === undefined
      ? {}
      : { force_full_page_ocr: documentIntelligence.forceFullPageOcr }),
    ...(documentIntelligence.timeoutSeconds === undefined
      ? {}
      : { timeout_seconds: documentIntelligence.timeoutSeconds }),
  };
}

async function processJob(job: Record<string, unknown>): Promise<void> {
  const id = String(job.id);
  const state = String(job.state) as IngestState;
  const payload = job.payload as Record<string, unknown>;
  const outputs = (job.stage_outputs ?? {}) as Record<string, unknown>;
  const sourceUri = String(payload.sourceUri ?? job.source_uri);
  const spaceId = String(job.space_id);
  const vaultId =
    typeof job.vault_id === "string" && job.vault_id.trim()
      ? job.vault_id
      : null;

  if (state === "RECEIVED") {
    const sourcePath = await resolveAuthorizedLocalSource(sourceUri);
    const mediaType = String(
      payload.mediaType ||
        mime.lookup(sourcePath) ||
        "application/octet-stream",
    );
    const raw = await objects.putImmutable({
      stream: createReadStream(sourcePath),
      mediaType,
      ...(typeof payload.expectedSha256 === "string"
        ? { expectedSha256: payload.expectedSha256 }
        : {}),
    });
    // Migration 013 replaces the bootstrap `(space_id, sha256)` key with
    // vault-aware partial unique indexes.  Infer the correct index explicitly
    // so a source with the same bytes can exist in two isolated vaults while
    // legacy managed rows (vault_id IS NULL) remain deduplicated per space.
    const sourceValues = [
      spaceId,
      vaultId,
      String(payload.title ?? basename(sourcePath)),
      sourceUri,
      mediaType,
      raw.sha256,
      raw.bytes,
      raw.key,
      job.created_by ?? null,
      JSON.stringify({ bucket: raw.bucket, immutable: true }),
    ];
    const source = vaultId
      ? await db.pool.query<{ id: string }>(
          `
          insert into sources(
            space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
            object_key,created_by,metadata
          )
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
          on conflict (vault_id,sha256) where vault_id is not null
            do update set source_uri=excluded.source_uri
          returning id
          `,
          sourceValues,
        )
      : await db.pool.query<{ id: string }>(
          `
          insert into sources(
            space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
            object_key,created_by,metadata
          )
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
          on conflict (space_id,sha256) where vault_id is null
            do update set source_uri=excluded.source_uri
          returning id
          `,
          sourceValues,
        );
    await updateState(id, state, "HASHED", {
      raw,
      sourceId: source.rows[0]?.id,
      originalName: basename(sourcePath),
      mediaType,
    });
    return;
  }
  if (state === "HASHED") {
    const raw = outputs.raw as { sha256?: string };
    if (!raw?.sha256 || !(await objects.exists(raw.sha256))) {
      throw new Error("Immutable raw object is missing.");
    }
    await updateState(id, state, "STORED");
    return;
  }
  if (state === "STORED") {
    await updateState(id, state, "NORMALIZING");
    return;
  }
  if (state === "NORMALIZING") {
    const raw = outputs.raw as RawObjectRef;
    const suffix = extname(String(outputs.originalName ?? sourceUri));
    const immutablePath = path.join(
      tmpdir(),
      `akp-${id}-${raw.sha256}${suffix}`,
    );
    const objectStream = await objects.get(raw);
    await pipeline(
      objectStream,
      createWriteStream(immutablePath, { flags: "wx" }),
    ).catch(async (error) => {
      await rm(immutablePath, { force: true });
      throw error;
    });
    try {
      const materialized = await hashFile(immutablePath);
      if (materialized.sha256 !== raw.sha256) {
        throw new Error("IMMUTABLE_OBJECT_HASH_MISMATCH");
      }
      const documentIntelligence = DocumentIntelligenceRequest.parse(
        payload.documentIntelligence ?? {},
      );
      const configuration = extractorConfiguration(documentIntelligence);
      const mediaType = String(outputs.mediaType ?? payload.mediaType ?? "");
      const attempt = Number(job.attempts ?? 0) + 1;
      const upload = new FormData();
      upload.set(
        "file",
        await openAsBlob(immutablePath, { type: mediaType }),
        String(outputs.originalName ?? basename(sourceUri)),
      );
      upload.set("source_uri", sourceUri);
      upload.set("source_id", String(outputs.sourceId));
      upload.set("media_type", mediaType);
      upload.set("expected_sha256", raw.sha256);
      if (documentIntelligence.complexity) {
        upload.set("complexity", documentIntelligence.complexity);
      }
      if (Object.keys(configuration).length) {
        upload.set("configuration", JSON.stringify(configuration));
      }
      await recordProviderTaskEvent(id, state, "PROVIDER_TASK_STARTED", {
        attempt,
        mediaType,
        complexity: documentIntelligence.complexity ?? null,
        requestedExtractor: documentIntelligence.extractor ?? null,
        ocrRequested: documentIntelligence.ocr ?? false,
      });

      let canonical: ReturnType<typeof parseCanonicalExtractionResponse>;
      try {
        const response = await fetch(`${extractorUrl}/v1/extract-upload`, {
          method: "POST",
          headers: {
            "x-akp-extractor-token":
              process.env.AKP_EXTRACTOR_TOKEN ??
              "local-extractor-development-token",
          },
          body: upload,
        });
        if (!response.ok) {
          throw new Error(
            `Extractor failed: ${response.status} ${await response.text()}`,
          );
        }
        const extractedResponse = (await response.json()) as unknown;
        const expectedIdentity = {
          sourceId: String(outputs.sourceId),
          sourceHash: raw.sha256,
          ...(mediaType ? { mediaType } : {}),
        };
        canonical = parseCanonicalExtractionResponse(
          extractedResponse,
          expectedIdentity,
        );
      } catch (error) {
        await recordProviderTaskEvent(id, state, "PROVIDER_TASK_FAILED", {
          attempt,
          mediaType,
          complexity: documentIntelligence.complexity ?? null,
          requestedExtractor: documentIntelligence.extractor ?? null,
          ocrRequested: documentIntelligence.ocr ?? false,
          message: providerTaskErrorMessage(error),
        });
        throw error;
      }

      await recordProviderTaskEvent(id, state, "PROVIDER_TASK_SUCCEEDED", {
        attempt,
        extractor: canonical.extractor,
        extractorVersion: canonical.extractorVersion,
        selectedAdapter:
          typeof canonical.routing.selected_adapter === "string"
            ? canonical.routing.selected_adapter
            : canonical.extractor,
        selectionReason:
          typeof canonical.routing.selection_reason === "string"
            ? canonical.routing.selection_reason
            : null,
        fallback: canonical.routing.fallback === true,
        configurationHash: canonical.configurationHash,
        structuredContentHash: canonical.contentHash,
        warnings: canonical.warnings,
      });

      const storedArtifact = await db.pool.query<{ id: string }>(
        `
        insert into source_artifacts(
          source_id,kind,object_key,source_hash,extractor,extractor_version,
          quality,metadata,document_artifact,artifact_schema_version,
          configuration_hash,structured_content_hash
        )
        values($1,'document-artifact',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
        on conflict (source_id,extractor,extractor_version,configuration_hash)
          where kind='document-artifact'
        do update set
          object_key=excluded.object_key,
          source_hash=excluded.source_hash,
          quality=excluded.quality,
          metadata=excluded.metadata,
          document_artifact=excluded.document_artifact,
          artifact_schema_version=excluded.artifact_schema_version,
          structured_content_hash=excluded.structured_content_hash
        returning id
        `,
        [
          outputs.sourceId,
          String(raw.key ?? ""),
          raw.sha256,
          canonical.extractor,
          canonical.extractorVersion,
          canonical.artifact.quality,
          JSON.stringify({
            routing: canonical.routing,
            warnings: canonical.warnings,
            quality_metrics: canonical.artifact.quality_metrics,
          }),
          JSON.stringify(canonical.artifact),
          DOCUMENT_ARTIFACT_SCHEMA_VERSION,
          canonical.configurationHash,
          canonical.contentHash,
        ],
      );
      const artifactId =
        storedArtifact.rows[0]?.id ??
        (
          await db.pool.query<{ id: string }>(
            `
            select id from source_artifacts
             where source_id=$1 and kind='document-artifact'
               and extractor=$2 and extractor_version=$3
               and configuration_hash=$4
             limit 1
            `,
            [
              outputs.sourceId,
              canonical.extractor,
              canonical.extractorVersion,
              canonical.configurationHash,
            ],
          )
        ).rows[0]?.id;
      if (!artifactId) throw new Error("Could not persist document artifact.");
      const preview = renderDocumentArtifactPreview(canonical.artifact, 4_000);
      const evidenceFragment = selectEvidenceFragment(
        canonical.artifact,
        preview.markdown,
      );
      const storedEvidence = await db.pool.query<{ id: string }>(
        `
        insert into evidence(
          space_id,vault_id,source_id,artifact_id,locator,content_hash,excerpt,review_status
        )
        values($1,$2,$3,$4,$5::jsonb,$6,$7,'MACHINE_EXTRACTED')
        on conflict(artifact_id) where artifact_id is not null do update set
          vault_id=excluded.vault_id,locator=excluded.locator,
          content_hash=excluded.content_hash,excerpt=excluded.excerpt,
          review_status=excluded.review_status
        returning id
        `,
        [
          spaceId,
          vaultId,
          outputs.sourceId,
          artifactId,
          JSON.stringify(evidenceFragment.locator),
          evidenceFragment.excerptHash,
          evidenceFragment.excerpt,
        ],
      );
      const evidenceId = storedEvidence.rows[0]?.id;
      if (!evidenceId) throw new Error("Could not persist evidence.");
      const extracted = {
        extractor: canonical.extractor,
        extractor_version: canonical.extractorVersion,
        document_artifact: canonical.artifact,
        artifact_schema_version: DOCUMENT_ARTIFACT_SCHEMA_VERSION,
        configuration_hash: canonical.configurationHash,
        structured_content_hash: canonical.contentHash,
        routing: canonical.routing,
        warnings: canonical.warnings,
        source_artifact_id: artifactId,
        evidence_id: evidenceId,
        evidence_precision: evidenceFragment.precision,
      };
      await updateState(id, state, "ANALYZING", { extracted });
    } finally {
      await rm(immutablePath, { force: true });
    }
    return;
  }
  if (state === "ANALYZING") {
    const extracted = outputs.extracted as {
      document_artifact?: unknown;
      source_artifact_id?: string;
      evidence_id?: string;
      extractor?: string;
      extractor_version?: string;
    };
    if (
      !extracted?.document_artifact ||
      !extracted.source_artifact_id ||
      !extracted.evidence_id
    ) {
      throw new Error("DOCUMENT_ARTIFACT_STAGE_OUTPUT_REQUIRED");
    }
    const expectedIdentity = {
      sourceId: String(outputs.sourceId),
      sourceHash: String((outputs.raw as { sha256?: string })?.sha256 ?? ""),
      ...(String(outputs.mediaType ?? payload.mediaType ?? "")
        ? { mediaType: String(outputs.mediaType ?? payload.mediaType) }
        : {}),
    };
    const artifactResult = parseCanonicalExtractionResponse(
      {
        extractor: extracted.extractor,
        extractor_version: extracted.extractor_version,
        document_artifact: extracted.document_artifact,
      },
      expectedIdentity,
    );
    const raw = outputs.raw as { sha256: string };
    const sameMaterial = await db.pool.query(
      `
      select id,path,current_revision from knowledge_documents
       where space_id=$1
         and (($2::uuid is null and vault_id is null) or vault_id=$2::uuid)
         and frontmatter->>'source_sha256'=$3
         and lifecycle in ('ACTIVE','DISPUTED')
       limit 1
      `,
      [spaceId, vaultId, raw.sha256],
    );
    if (sameMaterial.rowCount) {
      await updateState(
        id,
        state,
        "NO_MATERIAL",
        {
          identity: {
            classification: "SAME_IDENTITY",
            document: sameMaterial.rows[0],
          },
        },
        {
          disposition: "NO_MATERIAL",
          reason:
            "The immutable source hash is already represented by active knowledge.",
        },
      );
      return;
    }

    const title = String(
      payload.title ?? outputs.originalName ?? basename(sourceUri),
    );
    const compilationStage = await buildCompilationStage(
      db,
      {
        spaceId,
        vaultId,
        sourceId: String(outputs.sourceId),
        sourceArtifactId: extracted.source_artifact_id,
        evidenceId: extracted.evidence_id,
        sha256: raw.sha256,
        title,
        mediaType: String(
          outputs.mediaType ?? payload.mediaType ?? "application/octet-stream",
        ),
        extractor: artifactResult.extractor,
        extractorVersion: artifactResult.extractorVersion,
        artifact: artifactResult.artifact,
        vectorEnabled: process.env.AKP_VECTOR_ENABLED === "true",
      },
      createConfiguredKnowledgeCompiler(process.env),
    );
    const plan = CompilationPlan.parse(compilationStage.plan);
    if (plan.disposition === "NO_MATERIAL" || !plan.proposedChanges.length) {
      await updateState(
        id,
        state,
        "NO_MATERIAL",
        { plan, compilation: compilationStage.metadata },
        { disposition: "NO_MATERIAL", reason: plan.summary },
      );
      return;
    }
    await db.pool.query(
      "insert into compilation_plans(job_id,source_id,plan) values($1,$2,$3::jsonb)",
      [id, outputs.sourceId, JSON.stringify(plan)],
    );
    await updateState(id, state, "PLANNED", {
      plan,
      compilation: compilationStage.metadata,
    });
    return;
  }
  if (state === "PLANNED") {
    const plan = CompilationPlan.parse(outputs.plan);
    const baseRevision = await git.ensureRepository(authorName, authorEmail);
    const branchName = await git.createDraftBranch(id, baseRevision);
    for (const change of plan.proposedChanges) {
      await git.writeDraftFile(change.path, change.content);
    }
    const headCommit = await git.commitAll(
      `knowledge: draft source ${String(outputs.sourceId)}`,
      authorName,
      authorEmail,
    );
    await updateState(id, state, "DRAFTED", {
      draft: { branchName, baseRevision, headCommit },
    });
    return;
  }
  if (state === "DRAFTED") {
    const plan = CompilationPlan.parse(outputs.plan);
    const issues = plan.proposedChanges.flatMap((change) =>
      validateMarkdownDocument(change.content).map((issue) => ({
        ...issue,
        path: change.path,
      })),
    );
    const errors = issues.filter((issue) => issue.severity === "ERROR");
    const compilation = outputs.compilation as { mode?: string } | undefined;
    const probeResults =
      compilation?.mode === "GENERATIVE"
        ? await (async () => {
            if (!vaultId) throw new Error("KNOWLEDGE_COMPILER_VAULT_REQUIRED");
            return evaluateCompilationProbes(db, {
              plan,
              spaceId,
              vaultId,
              sourceId: String(outputs.sourceId),
            });
          })()
        : plan.probes.map((probe) => {
            const proposedText = plan.proposedChanges
              .map((change) => change.content)
              .join("\n");
            const passed =
              proposedText.includes(
                String((outputs.raw as { sha256?: string })?.sha256 ?? ""),
              ) &&
              /uncertainty|incertidumbre|human review required/i.test(
                proposedText,
              );
            return {
              ...probe,
              passed,
              method: "DETERMINISTIC_DRAFT_INVARIANT",
            };
          });
    const failedCritical = probeResults.filter(
      (probe) => probe.criticality === "CRITICAL" && !probe.passed,
    );
    if (failedCritical.length) {
      throw new Error(
        `Critical compilation probes failed: ${JSON.stringify(failedCritical)}`,
      );
    }
    if (errors.length)
      throw new Error(`Draft validation failed: ${JSON.stringify(errors)}`);
    await updateState(id, state, "VALIDATING", {
      validation: { issues, errors: 0, probeResults },
    });
    return;
  }
  if (state === "VALIDATING") {
    const draft = outputs.draft as {
      branchName: string;
      baseRevision: string;
      headCommit: string;
    };
    const plan = CompilationPlan.parse(outputs.plan);
    const reviewId = randomUUID();
    await db.pool.query(
      `
      insert into reviews(id,space_id,vault_id,branch_name,base_commit,head_commit,status,author_id,
                          impact_manifest,validation_report)
      values($1,$2,$3,$4,$5,$6,'PENDING',$7,$8::jsonb,$9::jsonb)
      `,
      [
        reviewId,
        spaceId,
        vaultId,
        draft.branchName,
        draft.baseRevision,
        draft.headCommit,
        job.created_by ?? null,
        JSON.stringify({ jobId: id, ...plan }),
        JSON.stringify(outputs.validation ?? { issues: [], errors: 0 }),
      ],
    );
    await updateState(id, state, "REVIEW_REQUIRED", { reviewId });
    return;
  }

  await db.pool.query(
    "update ingest_jobs set lease_owner=null,lease_expires_at=null,updated_at=now() where id=$1",
    [id],
  );
}

async function handleFailure(
  job: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const attempts = Number(job.attempts ?? 0) + 1;
  const maxAttempts = Number(job.max_attempts ?? 5);
  const terminal = attempts >= maxAttempts;
  const delaySeconds = Math.min(300, 2 ** attempts);
  await db.pool.query(
    `
    update ingest_jobs
       set state = case when $2 then 'FAILED' else state end,
           attempts = $3,
           error = $4::jsonb,
           next_attempt_at = now() + make_interval(secs => $5),
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = $1 and lease_owner = $6 and cancelled_at is null
    `,
    [
      job.id,
      terminal,
      attempts,
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
      }),
      delaySeconds,
      workerId,
    ],
  );
  await db.pool.query(
    "insert into ingest_job_events(job_id,state,event_type,payload) values($1,$2,'FAILURE',$3::jsonb)",
    [
      job.id,
      terminal ? "FAILED" : String(job.state),
      JSON.stringify({
        attempts,
        maxAttempts,
        delaySeconds,
        message: String(error),
      }),
    ],
  );
}

function startLeaseHeartbeat(jobId: string, leaseSeconds = 60): () => void {
  let updateInFlight = false;
  const timer = setInterval(
    () => {
      if (updateInFlight) return;
      updateInFlight = true;
      void db.pool
        .query(
          `
        update ingest_jobs
           set lease_expires_at=now()+make_interval(secs => $3),
               heartbeat_at=now(),updated_at=now()
         where id=$1 and lease_owner=$2 and cancelled_at is null
        `,
          [jobId, workerId, leaseSeconds],
        )
        .catch(() => undefined)
        .finally(() => {
          updateInFlight = false;
        });
    },
    Math.max(5_000, Math.floor((leaseSeconds * 1000) / 3)),
  );
  timer.unref();
  return () => clearInterval(timer);
}

async function runClaimedJob(job: Record<string, unknown>): Promise<void> {
  const stopHeartbeat = startLeaseHeartbeat(String(job.id));
  try {
    await processJob(job);
  } catch (error) {
    await handleFailure(job, error);
  } finally {
    stopHeartbeat();
  }
}

async function loop(): Promise<WorkerDrainSummary | undefined> {
  const drain = process.env.AKP_WORKER_DRAIN === "true";
  await eventWorker.register();
  await runScheduledLintIfDue(process.env.AKP_LINT_RUN_ONCE === "true");
  if (drain) {
    return drainToQuiescence({
      db,
      consumerName: eventWorker.consumerName,
      workerId,
      leaseSeconds: 60,
      deadlineMs: Number(
        process.env.AKP_WORKER_DRAIN_DEADLINE_MS ??
          DEFAULT_WORKER_DRAIN_DEADLINE_MS,
      ),
      runEventOnce: () => eventWorker.runOnce(),
      runIngestJob: runClaimedJob,
    });
  }
  for (;;) {
    const eventHandled = await eventWorker.runOnce();
    const job = await claimNextIngestJob(db, workerId, 60);
    if (!job) {
      await runScheduledLintIfDue();
      if (eventHandled) continue;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    await runClaimedJob(job);
  }
}

process.on("SIGTERM", async () => {
  eventWorker.stop();
  await db.close();
  process.exit(0);
});

try {
  const summary = await loop();
  if (summary) process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  if (error instanceof WorkerDrainError) {
    process.stderr.write(`${JSON.stringify(error.summary)}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await db.close();
}
