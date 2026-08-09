import { config } from "dotenv";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Postgres, claimNextIngestJob, runKnowledgeLint } from "@akp/postgres";
import { transitionIngest, type IngestState } from "@akp/domain";
import {
  hashFile,
  MinioObjectStore,
  type RawObjectRef,
} from "@akp/object-store";
import { CompilationPlan } from "@akp/compiler";
import { GitKnowledgeStore } from "@akp/git-store";
import { validateMarkdownDocument } from "@akp/validation";
import mime from "mime-types";

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
const objects = new MinioObjectStore({
  endpoint: process.env.AKP_RAW_ENDPOINT ?? "http://127.0.0.1:19000",
  accessKey: process.env.AKP_RAW_ACCESS_KEY ?? "akp",
  secretKey: process.env.AKP_RAW_SECRET_KEY ?? "change-me",
  bucket: process.env.AKP_RAW_BUCKET ?? "akp-raw",
});
const managedRepository =
  process.env.AKP_MANAGED_REPO || path.join(tmpdir(), "akp-managed-knowledge");
const git = new GitKnowledgeStore(managedRepository);
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
    select s.id,
           (select max(created_at) from knowledge_lint_runs l
             where l.space_id=s.id and l.trigger='SCHEDULED') last_scheduled
      from spaces s order by s.id
    `,
  );
  for (const space of spaces.rows) {
    const last = space.last_scheduled
      ? new Date(String(space.last_scheduled)).getTime()
      : 0;
    if (force || Date.now() - last >= lintIntervalMs) {
      await runKnowledgeLint(db, String(space.id), "SCHEDULED");
    }
  }
}

function localPath(sourceUri: string): string {
  if (sourceUri.startsWith("file:")) return fileURLToPath(sourceUri);
  if (/^https?:/i.test(sourceUri)) {
    throw new Error(
      "Remote URLs require a captured local snapshot before ingestion.",
    );
  }
  return path.resolve(sourceUri);
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
    const updated = await client.query(
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
       returning id
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
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function draftMarkdown(input: {
  externalId: string;
  title: string;
  sourceUri: string;
  sha256: string;
  mediaType: string;
  artifactText: string;
}): string {
  const excerpt = input.artifactText.trim().slice(0, 6000);
  const yamlString = (value: string): string =>
    `'${value.replaceAll("'", "''")}'`;
  return `---
id: ${input.externalId}
type: source-summary
title: ${yamlString(input.title)}
status: draft
knowledge_layer: source
trust_tier: machine-supported
source_uri: ${yamlString(input.sourceUri)}
source_sha256: ${input.sha256}
media_type: ${input.mediaType}
---

# ${input.title}

## Provenance

- Immutable raw object SHA-256: \`${input.sha256}\`
- Original locator: \`${input.sourceUri}\`
- Extraction status: machine-generated; human review required

## Machine extract

${excerpt || "_No textual material was extracted._"}

## Uncertainty

This draft preserves extracted material and provenance. It does not promote the text to a verified claim or architectural rule.
`;
}

async function processJob(job: Record<string, unknown>): Promise<void> {
  const id = String(job.id);
  const state = String(job.state) as IngestState;
  const payload = job.payload as Record<string, unknown>;
  const outputs = (job.stage_outputs ?? {}) as Record<string, unknown>;
  const sourceUri = String(payload.sourceUri ?? job.source_uri);
  const spaceId = String(job.space_id);

  if (state === "RECEIVED") {
    const sourcePath = localPath(sourceUri);
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
    const source = await db.pool.query<{ id: string }>(
      `
      insert into sources(space_id,title,source_uri,media_type,sha256,byte_size,object_key,created_by,metadata)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      on conflict(space_id,sha256) do update set source_uri=excluded.source_uri
      returning id
      `,
      [
        spaceId,
        String(payload.title ?? basename(sourcePath)),
        sourceUri,
        mediaType,
        raw.sha256,
        raw.bytes,
        raw.key,
        job.created_by ?? null,
        JSON.stringify({ bucket: raw.bucket, immutable: true }),
      ],
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
      const upload = new FormData();
      upload.set(
        "file",
        await openAsBlob(immutablePath, {
          type: String(outputs.mediaType ?? payload.mediaType ?? ""),
        }),
        String(outputs.originalName ?? basename(sourceUri)),
      );
      upload.set("source_uri", sourceUri);
      upload.set(
        "media_type",
        String(outputs.mediaType ?? payload.mediaType ?? ""),
      );
      upload.set("expected_sha256", raw.sha256);
      const response = await fetch(`${extractorUrl}/v1/extract-upload`, {
        method: "POST",
        headers: {
          "x-akp-extractor-token":
            process.env.AKP_EXTRACTOR_TOKEN ??
            "local-extractor-development-token",
        },
        body: upload,
      });
      if (!response.ok)
        throw new Error(
          `Extractor failed: ${response.status} ${await response.text()}`,
        );
      const extracted = (await response.json()) as {
        extractor: string;
        extractor_version: string;
        artifacts: Array<Record<string, unknown>>;
      };
      for (const artifact of extracted.artifacts) {
        const normalizedLocator = {
          ...((artifact.locator as Record<string, unknown> | undefined) ?? {}),
          source_uri: sourceUri,
          object_key: raw.key,
          source_hash: raw.sha256,
        };
        if ("path" in normalizedLocator) normalizedLocator.path = sourceUri;
        const storedArtifact = await db.pool.query<{ id: string }>(
          `
          insert into source_artifacts(source_id,kind,object_key,source_hash,extractor,
                                       extractor_version,quality,metadata)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          on conflict do nothing
          returning id
          `,
          [
            outputs.sourceId,
            String(artifact.kind ?? "unknown"),
            String(raw.key ?? ""),
            String(raw.sha256 ?? ""),
            extracted.extractor,
            extracted.extractor_version,
            String(artifact.quality ?? "UNREVIEWED"),
            JSON.stringify({
              locator: normalizedLocator,
              warnings: artifact.warnings,
            }),
          ],
        );
        const artifactId =
          storedArtifact.rows[0]?.id ??
          (
            await db.pool.query<{ id: string }>(
              `
              select id from source_artifacts
               where source_id=$1 and kind=$2 and extractor_version=$3
                 and metadata->'locator'=$4::jsonb
               limit 1
              `,
              [
                outputs.sourceId,
                String(artifact.kind ?? "unknown"),
                extracted.extractor_version,
                JSON.stringify(normalizedLocator),
              ],
            )
          ).rows[0]?.id;
        if (!artifactId)
          throw new Error("Could not persist extracted artifact.");
        const artifactContent =
          typeof artifact.content === "string" ? artifact.content : "";
        await db.pool.query(
          `
          insert into evidence(
            space_id,source_id,artifact_id,locator,content_hash,excerpt,review_status
          )
          values($1,$2,$3,$4::jsonb,$5,$6,'MACHINE_EXTRACTED')
          on conflict(artifact_id) where artifact_id is not null do update set
            locator=excluded.locator,content_hash=excluded.content_hash,
            excerpt=excluded.excerpt,review_status=excluded.review_status
          `,
          [
            spaceId,
            outputs.sourceId,
            artifactId,
            JSON.stringify(normalizedLocator),
            createHash("sha256").update(artifactContent).digest("hex"),
            artifactContent.slice(0, 2000) || null,
          ],
        );
      }
      await updateState(id, state, "ANALYZING", { extracted });
    } finally {
      await rm(immutablePath, { force: true });
    }
    return;
  }
  if (state === "ANALYZING") {
    const extracted = outputs.extracted as {
      artifacts?: Array<Record<string, unknown>>;
    };
    const artifactText = (extracted?.artifacts ?? [])
      .map((artifact) =>
        typeof artifact.content === "string" ? artifact.content : "",
      )
      .filter(Boolean)
      .join("\n\n");
    const raw = outputs.raw as { sha256: string };
    const sameMaterial = await db.pool.query(
      `
      select id,path,current_revision from knowledge_documents
       where space_id=$1 and frontmatter->>'source_sha256'=$2
         and lifecycle in ('ACTIVE','DISPUTED')
       limit 1
      `,
      [spaceId, raw.sha256],
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
    const externalId = `SRC-INGEST-${raw.sha256.slice(0, 12).toUpperCase()}`;
    const title = String(
      payload.title ?? outputs.originalName ?? basename(sourceUri),
    );
    const priorSource = await db.pool.query(
      `
      select id,path,external_id,current_revision from knowledge_documents
       where space_id=$1 and frontmatter->>'source_uri'=$2
         and lifecycle in ('ACTIVE','DISPUTED')
       order by updated_at desc limit 1
      `,
      [spaceId, sourceUri],
    );
    const prior = priorSource.rows[0];
    const relativePath = prior?.path
      ? String(prior.path).replace(/^managed\//, "")
      : `10-sources/ingested/source-${raw.sha256.slice(0, 16)}.md`;
    const content = draftMarkdown({
      externalId,
      title,
      sourceUri,
      sha256: raw.sha256,
      mediaType: String(outputs.mediaType ?? "application/octet-stream"),
      artifactText,
    });
    const plan = CompilationPlan.parse({
      sourceId: String(outputs.sourceId),
      corpusRevision: String(
        (
          await db.pool.query(
            "select current_revision from vaults where space_id=$1 order by last_imported_at desc limit 1",
            [spaceId],
          )
        ).rows[0]?.current_revision ?? "managed:initial",
      ),
      disposition: prior ? "UPDATE" : "NEW",
      summary:
        "Create a provenance-preserving machine draft; no claim is activated.",
      proposedChanges: [
        {
          path: relativePath,
          operation: prior ? "UPDATE" : "CREATE",
          content,
          reasons: [
            "New immutable source requires an inspectable summary draft.",
          ],
          evidenceIds: [],
        },
      ],
      impactedDocumentIds: prior ? [String(prior.id)] : [],
      conflicts: [],
      probes: [
        {
          question:
            "Does the draft retain the immutable source hash and uncertainty?",
          criticality: "CRITICAL",
          evidenceIds: [String(outputs.sourceId)],
        },
      ],
    });
    await db.pool.query(
      "insert into compilation_plans(job_id,source_id,plan) values($1,$2,$3::jsonb)",
      [id, outputs.sourceId, JSON.stringify(plan)],
    );
    await updateState(id, state, "PLANNED", { plan });
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
    const probeResults = plan.probes.map((probe) => {
      const proposedText = plan.proposedChanges
        .map((change) => change.content)
        .join("\n");
      const passed =
        proposedText.includes(
          String((outputs.raw as { sha256?: string })?.sha256 ?? ""),
        ) &&
        /uncertainty|incertidumbre|human review required/i.test(proposedText);
      return { ...probe, passed, method: "DETERMINISTIC_DRAFT_INVARIANT" };
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
      insert into reviews(id,space_id,branch_name,base_commit,head_commit,status,author_id,
                          impact_manifest,validation_report)
      values($1,$2,$3,$4,$5,'PENDING',$6,$7::jsonb,$8::jsonb)
      `,
      [
        reviewId,
        spaceId,
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

async function loop(): Promise<void> {
  const drain = process.env.AKP_WORKER_DRAIN === "true";
  await runScheduledLintIfDue(process.env.AKP_LINT_RUN_ONCE === "true");
  for (;;) {
    const job = await claimNextIngestJob(db, workerId, 60);
    if (!job) {
      if (drain) return;
      await runScheduledLintIfDue();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const stopHeartbeat = startLeaseHeartbeat(String(job.id));
    try {
      await processJob(job);
    } catch (error) {
      await handleFailure(job, error);
    } finally {
      stopHeartbeat();
    }
  }
}

process.on("SIGTERM", async () => {
  await db.close();
  process.exit(0);
});

try {
  await loop();
} finally {
  await db.close();
}
