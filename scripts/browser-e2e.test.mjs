import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { chromium, request as playwrightRequest } from "playwright";

const { Client } = pg;

const ROOT = process.cwd();
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://akp:akp@127.0.0.1:55432/akp";
const API_URL = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";
const ADMIN_WEB = "http://127.0.0.1:3100";
const READER_WEB = "http://127.0.0.1:3101";
const SPACE_ID = "00000000-0000-0000-0000-000000000003";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";
const ADMIN_TOKEN = process.env.AKP_API_TOKEN;
const MANAGED_REPO =
  process.env.AKP_MANAGED_REPO ?? "/tmp/akp-managed-knowledge";
const REPORT_DIR = path.join(ROOT, "reports", "ci", "browser-e2e");

if (!ADMIN_TOKEN) {
  throw new Error("AKP_API_TOKEN is required for browser E2E.");
}

const sha256 = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

const fixture = {
  vaultId: randomUUID(),
  vaultKey: "browser-e2e-" + randomUUID().slice(0, 8),
  readerId: randomUUID(),
  readerToken: "akp-browser-reader-" + randomUUID(),
  connectorId: randomUUID(),
  assuranceRunId: randomUUID(),
  assuranceFindingId: randomUUID(),
  projectionId: randomUUID(),
  entryNodeId: randomUUID(),
  helperNodeId: randomUUID(),
  edgeId: randomUUID(),
  sourceId: randomUUID(),
  evidenceId: randomUUID(),
  documentId: randomUUID(),
};

const children = [];
const results = [];

function record(name, status, details = {}) {
  results.push({
    name,
    status,
    at: new Date().toISOString(),
    ...details,
  });
}

async function waitForUrl(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    "Timed out waiting for " +
      url +
      (lastError ? ": " + String(lastError) : ""),
  );
}

function spawnService(label, command, args, env = {}) {
  const log = createWriteStream(path.join(REPORT_DIR, label + ".log"), {
    flags: "a",
  });
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on("exit", (code, signal) => {
    log.write(
      "\n[" +
        new Date().toISOString() +
        "] exited code=" +
        code +
        " signal=" +
        signal +
        "\n",
    );
    log.end();
  });
  children.push(child);
  return child;
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    return;
  }
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    return;
  }
  await Promise.race([exited, delay(1_000)]);
}

async function ensureApi() {
  try {
    await waitForUrl(API_URL + "/health/readiness", 1_500);
    return;
  } catch {
    spawnService("api", "pnpm", ["--filter", "@akp/api", "start"], {
      PORT: "8080",
    });
    await waitForUrl(API_URL + "/health/readiness");
  }
}

async function apiJson(
  pathname,
  { method = "GET", body, token = ADMIN_TOKEN, expected } = {},
) {
  const headers = {
    authorization: "Bearer " + token,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (!["GET", "HEAD"].includes(method)) {
    headers["idempotency-key"] = "browser-" + randomUUID();
  }
  const response = await fetch(API_URL + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (expected !== undefined) {
    assert.equal(
      response.status,
      expected,
      pathname + " returned " + response.status + ": " + text,
    );
  } else {
    assert.ok(
      response.ok,
      pathname + " returned " + response.status + ": " + text,
    );
  }
  return { response, payload };
}

async function setupDatabase(db) {
  const revision = execFileSync(
    "git",
    ["-C", MANAGED_REPO, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const canonicalPath = MANAGED_REPO;
  const documentBody =
    "# Browser E2E bootstrap\n\n" +
    "This human-reviewed fixture proves workspace bootstrap retrieval.";
  const documentHash = sha256(documentBody);

  await db.query(
    "insert into vaults(" +
      "id,space_id,canonical_path,name,read_only,current_revision," +
      "vault_key,local_path,visibility,enabled" +
      ") values($1,$2,$3,$4,false,$5,$6,$3,'PRIVATE',true)",
    [
      fixture.vaultId,
      SPACE_ID,
      canonicalPath,
      "Browser E2E Vault",
      revision,
      fixture.vaultKey,
    ],
  );

  await db.query(
    "insert into vault_memberships(" +
      "user_id,vault_id,role,path_prefix,permissions" +
      ") values($1,$2,'ADMIN',null,$3::jsonb)",
    [
      ADMIN_ID,
      fixture.vaultId,
      JSON.stringify([
        "knowledge:read",
        "source:read",
        "source:write",
        "knowledge:propose",
        "knowledge:review",
        "eval:run",
        "admin",
      ]),
    ],
  );

  await db.query(
    "insert into vault_index_revisions(" +
      "space_id,vault_id,corpus_revision,lexical_revision,vector_revision," +
      "graph_revision,context_pack_revision,retrieval_configuration_version," +
      "status,warnings" +
      ") values($1,$2,$3,$3,$3,$3,$3,'browser-e2e','CONSISTENT','[]'::jsonb)",
    [SPACE_ID, fixture.vaultId, revision],
  );

  await db.query(
    "insert into knowledge_documents(" +
      "id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier," +
      "current_revision,body_cache,frontmatter,aliases,layer,content_hash," +
      "token_estimate,raw_links" +
      ") values(" +
      "$1,$2,$3,'browser/bootstrap.md','BROWSER-BOOTSTRAP'," +
      "'Browser bootstrap fixture','concept','ACTIVE','HUMAN_REVIEWED'," +
      "$4,$5,$6::jsonb,'{}','concept',$7,24,'[]'::jsonb" +
      ")",
    [
      fixture.documentId,
      SPACE_ID,
      fixture.vaultId,
      revision,
      documentBody,
      JSON.stringify({
        id: "BROWSER-BOOTSTRAP",
        type: "concept",
        title: "Browser bootstrap fixture",
        status: "ACTIVE",
        knowledge_layer: "concept",
      }),
      documentHash,
    ],
  );

  await db.query("insert into users(id,email,display_name) values($1,$2,$3)", [
    fixture.readerId,
    fixture.readerId + "@browser-e2e.test",
    "Browser Read Only",
  ]);
  await db.query(
    "insert into memberships(user_id,space_id,role,path_prefix) " +
      "values($1,$2,'VIEWER',null)",
    [fixture.readerId, SPACE_ID],
  );
  await db.query(
    "insert into vault_memberships(" +
      "user_id,vault_id,role,path_prefix,permissions" +
      ") values($1,$2,'VIEWER',null,$3::jsonb)",
    [
      fixture.readerId,
      fixture.vaultId,
      JSON.stringify(["knowledge:read", "source:read"]),
    ],
  );
  await db.query(
    "insert into api_tokens(user_id,token_hash,label,scopes) " +
      "values($1,$2,'browser-e2e-reader',$3::jsonb)",
    [
      fixture.readerId,
      sha256(fixture.readerToken),
      JSON.stringify({
        spaces: [
          {
            spaceId: SPACE_ID,
            pathPrefix: null,
            permissions: ["knowledge:read", "source:read"],
          },
        ],
      }),
    ],
  );

  const descriptor = {
    schemaVersion: 1,
    sourceSystem: "browser-e2e",
    objectTypes: ["WORK_ITEM"],
    incremental: { cursor: false, webhook: true },
    permissionFidelity: "SOURCE_ACL_MAPPED",
    replication: "FULL_MIRROR",
    dataResidency: "LOCAL",
    attachments: { supported: false },
    rateLimit: { kind: "NONE" },
    checkpointModel: "SOURCE_SEQUENCE",
    deletionPropagation: "TOMBSTONE",
    sourceVersioning: true,
    contentTrust: "UNTRUSTED_EXTERNAL",
  };
  await db.query(
    "insert into source_connector_registrations(" +
      "id,space_id,vault_id,connector_key,source_system,public_key_pem," +
      "descriptor,state,created_by_user_id" +
      ") values($1,$2,$3,'browser-e2e-connector','browser-e2e',$4,$5::jsonb," +
      "'ACTIVE',$6)",
    [
      fixture.connectorId,
      SPACE_ID,
      fixture.vaultId,
      "-----BEGIN PUBLIC KEY-----\n" +
        "BROWSER-E2E-PLACEHOLDER-KEY-MATERIAL\n" +
        "-----END PUBLIC KEY-----",
      JSON.stringify(descriptor),
      ADMIN_ID,
    ],
  );
  await db.query(
    "insert into source_connector_checkpoints(connector_id,applied_sequence) " +
      "values($1,0)",
    [fixture.connectorId],
  );
  await db.query(
    "insert into source_connector_events(" +
      "connector_id,event_id,sequence,occurred_at,operation,object_id," +
      "object_type,source_version,title,content,content_type," +
      "permission_fidelity,permission_uncertain,acl_fingerprint,metadata," +
      "payload_hash,status,error_code,apply_attempts,max_apply_attempts," +
      "next_attempt_at,last_error_at" +
      ") values(" +
      "$1,'browser-failure-1',1,now(),'UPSERT','BROWSER-42','WORK_ITEM','v1'," +
      "'Browser connector failure','retryable payload','text/plain'," +
      "'SOURCE_ACL_MAPPED',false,'browser-acl','{}'::jsonb,$2,'PENDING'," +
      "'PROVIDER_TIMEOUT',3,8,now()+interval '10 minutes',now()" +
      ")",
    [fixture.connectorId, sha256("browser-connector-failure")],
  );

  await db.query(
    "insert into assurance_runs(" +
      "id,space_id,vault_id,trigger,detectors,status,idempotency_key," +
      "requested_by_user_id,completed_at,result_summary" +
      ") values(" +
      "$1,$2,$3,'MANUAL',array['FRESHNESS'],'COMPLETED'," +
      "'browser-e2e-assurance',$4,now(),'{}'::jsonb" +
      ")",
    [fixture.assuranceRunId, SPACE_ID, fixture.vaultId, ADMIN_ID],
  );
  await db.query(
    "insert into assurance_findings(" +
      "id,run_id,space_id,vault_id,detector,detector_version,severity," +
      "finding_key,subject_kind,subject_id,code,summary,evidence_refs,metadata," +
      "status,category,scope_id,target_ids,support_set_ids,first_seen_at," +
      "last_seen_at,proposed_action,revision_set" +
      ") values(" +
      "$1,$2,$3,$4,'FRESHNESS','1.0.0','HIGH',$5,'DOCUMENT',$6," +
      "'BROWSER_FRESHNESS_STALE','Browser E2E stale finding'," +
      "'[]'::jsonb,'{}'::jsonb,'OPEN','FRESHNESS',$7,$8::jsonb," +
      "'[]'::jsonb,now(),now(),'Acknowledge browser finding',$9::jsonb" +
      ")",
    [
      fixture.assuranceFindingId,
      fixture.assuranceRunId,
      SPACE_ID,
      fixture.vaultId,
      sha256("browser-e2e-finding"),
      fixture.documentId,
      "vault:" + fixture.vaultId,
      JSON.stringify([fixture.documentId]),
      JSON.stringify({ knowledgeGit: revision }),
    ],
  );

  await db.query(
    "insert into federated_graph_projection_revisions(" +
      "id,space_id,vault_id,graph_domain,scope_id,revision,source_revision," +
      "provider,provider_version,configuration_version,lifecycle,freshness," +
      "built_at,activated_at,last_successful_update" +
      ") values(" +
      "$1,$2,$3,'CODE','browser-code','browser-code-r1',$4," +
      "'browser-e2e','1','browser-e2e-v1','ACTIVE','FRESH'," +
      "now(),now(),now()" +
      ")",
    [fixture.projectionId, SPACE_ID, fixture.vaultId, revision],
  );

  const entryPayload = {
    title: "BrowserEntry",
    qualifiedName: "BrowserEntry",
    path: "src/browser-entry.ts",
    lineStart: 1,
    lineEnd: 12,
  };
  const helperPayload = {
    title: "BrowserHelper",
    qualifiedName: "BrowserHelper",
    path: "src/browser-helper.ts",
    lineStart: 1,
    lineEnd: 8,
  };

  for (const [id, key, payload] of [
    [fixture.entryNodeId, "BrowserEntry", entryPayload],
    [fixture.helperNodeId, "BrowserHelper", helperPayload],
  ]) {
    await db.query(
      "insert into federated_graph_nodes(" +
        "id,space_id,vault_id,graph_domain,scope_id,kind,canonical_key," +
        "revision,authorization_path,payload,payload_hash" +
        ") values($1,$2,$3,'CODE','browser-code','FUNCTION',$4," +
        "'browser-code-r1',null,$5::jsonb,$6)",
      [
        id,
        SPACE_ID,
        fixture.vaultId,
        key,
        JSON.stringify(payload),
        sha256(JSON.stringify(payload)),
      ],
    );
    await db.query(
      "insert into federated_graph_projection_nodes(" +
        "projection_revision_id,node_id" +
        ") values($1,$2)",
      [fixture.projectionId, id],
    );
  }

  await db.query(
    "insert into federated_graph_edges(" +
      "id,space_id,owner_graph_domain,from_node_id,to_node_id,relation_type," +
      "authorization_path,derivation,source_ids,evidence_ids,locator_refs," +
      "provenance_revision,support_set_id,confidence,valid_from,valid_to," +
      "recorded_at,provenance_hash" +
      ") values(" +
      "$1,$2,'CODE',$3,$4,'CALLS',null,'STATICALLY_RESOLVED'," +
      "'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'browser-code-r1',null,1.0," +
      "'2026-06-01T00:00:00.000Z',null,'2026-06-01T00:00:00.000Z',$5" +
      ")",
    [
      fixture.edgeId,
      SPACE_ID,
      fixture.entryNodeId,
      fixture.helperNodeId,
      sha256("browser-code-edge"),
    ],
  );
  await db.query(
    "insert into federated_graph_projection_edges(" +
      "projection_revision_id,edge_id" +
      ") values($1,$2)",
    [fixture.projectionId, fixture.edgeId],
  );

  return revision;
}

async function seedReviewEvidence(db, reviewId) {
  const excerpt =
    "Browser evidence proves the review workspace renders grounded context.";
  await db.query(
    "insert into sources(" +
      "id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size," +
      "object_key,status,metadata,created_by" +
      ") values($1,$2,$3,'Browser evidence',$4,'text/plain',$5,$6,$7," +
      "'ACTIVE','{}'::jsonb,$8)",
    [
      fixture.sourceId,
      SPACE_ID,
      fixture.vaultId,
      "browser://evidence/" + fixture.sourceId,
      sha256(excerpt),
      Buffer.byteLength(excerpt),
      "browser-e2e/" + fixture.sourceId + ".txt",
      ADMIN_ID,
    ],
  );
  await db.query(
    "insert into evidence(" +
      "id,space_id,vault_id,source_id,locator,content_hash,excerpt,review_status" +
      ") values($1,$2,$3,$4,$5::jsonb,$6,$7,'REVIEWED')",
    [
      fixture.evidenceId,
      SPACE_ID,
      fixture.vaultId,
      fixture.sourceId,
      JSON.stringify({ kind: "browser-e2e", line: 1 }),
      sha256(excerpt),
      excerpt,
    ],
  );
  await db.query(
    "update reviews set impact_manifest=jsonb_set(" +
      "impact_manifest,'{evidenceIds}',to_jsonb($2::text[]),true" +
      ") where id=$1",
    [reviewId, [fixture.evidenceId]],
  );
  return excerpt;
}

async function screenshot(page, name) {
  try {
    await page.screenshot({
      path: path.join(
        REPORT_DIR,
        name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() + ".png",
      ),
      fullPage: true,
    });
  } catch {
    // Best-effort diagnostics only.
  }
}

async function browserStep(t, name, pages, fn) {
  await t.test(name, { timeout: 45_000 }, async () => {
    const started = Date.now();
    console.log(`[browser-e2e] START ${name}`);
    try {
      await fn();
      record(name, "PASSED", { durationMs: Date.now() - started });
      console.log(`[browser-e2e] PASS ${name}`);
    } catch (error) {
      for (const [label, page] of Object.entries(pages)) {
        await screenshot(page, name + "-" + label);
      }
      record(name, "FAILED", {
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}

test("critical browser workflows", { timeout: 300_000 }, async (t) => {
  await mkdir(REPORT_DIR, { recursive: true });
  const db = new Client({ connectionString: DATABASE_URL });
  let browser;
  let adminPage;
  let readerPage;
  let apiWasSpawned = false;
  let databaseConnected = false;

  try {
    await db.connect();
    databaseConnected = true;
    await setupDatabase(db);

    try {
      await waitForUrl(API_URL + "/health/readiness", 1_500);
    } catch {
      apiWasSpawned = true;
      spawnService("api", "pnpm", ["--filter", "@akp/api", "start"], {
        PORT: "8080",
      });
      await waitForUrl(API_URL + "/health/readiness");
    }

    const session = (
      await apiJson("/v1/sessions", {
        method: "POST",
        body: {
          purpose: "Browser E2E workspace bootstrap",
          contextBudget: 4096,
          spaceId: SPACE_ID,
          vaultId: fixture.vaultId,
        },
      })
    ).payload;

    await apiJson("/v1/sessions/" + session.id + "/participants", {
      method: "POST",
      body: { userId: fixture.readerId },
    });

    const bootstrap = (
      await apiJson("/v1/sessions/" + session.id + "/bootstrap", {
        method: "POST",
        body: {
          query: "Browser E2E bootstrap",
          intent: "WORKFLOW_EXECUTION",
          packetMode: "COMPACT_AGENT_PACKET",
        },
      })
    ).payload;

    const claim = (
      await apiJson("/v1/sessions/" + session.id + "/claims", {
        method: "POST",
        body: {
          workKey: "browser/task-1",
          leaseSeconds: 300,
        },
      })
    ).payload;

    await apiJson("/v1/sessions/" + session.id + "/claims/handoff", {
      method: "POST",
      body: {
        workKey: "browser/task-1",
        toUserId: fixture.readerId,
        fencingToken: claim.fencingToken,
        leaseSeconds: 300,
        summary: "Browser handoff verified",
        completed: ["Bootstrap context pinned"],
        remaining: ["Review evidence"],
        blockers: [],
        changedResourceRefs: ["browser/task-1"],
        evidenceRefs: [
          bootstrap.context?.packetId ?? bootstrap.packetId ?? "packet",
        ],
        questions: ["Can the reader continue safely?"],
      },
    });

    spawnService(
      "web-admin",
      "pnpm",
      [
        "--filter",
        "@akp/web",
        "exec",
        "next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        "3100",
      ],
      {
        AKP_API_URL: API_URL,
        AKP_API_TOKEN: ADMIN_TOKEN,
      },
    );
    spawnService(
      "web-reader",
      "pnpm",
      [
        "--filter",
        "@akp/web",
        "exec",
        "next",
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        "3101",
      ],
      {
        AKP_API_URL: API_URL,
        AKP_API_TOKEN: fixture.readerToken,
      },
    );
    await Promise.all([waitForUrl(ADMIN_WEB), waitForUrl(READER_WEB)]);

    browser = await chromium.launch({ headless: true });
    const adminContext = await browser.newContext();
    const readerContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    readerPage = await readerContext.newPage();
    const pages = { admin: adminPage, reader: readerPage };

    await browserStep(t, "1 bootstrap workspace", pages, async () => {
      await adminPage.goto(ADMIN_WEB + "/sessions/" + session.id);
      await adminPage
        .getByText("Browser E2E workspace bootstrap", { exact: true })
        .waitFor();
      const body = await adminPage.locator("body").innerText();
      assert.match(body, /Browser E2E workspace bootstrap/);
      assert.match(body, /Retrieved context IDs/);
      assert.match(body, /packet/i);
      assert.match(body, /CURRENT/);
    });

    await browserStep(t, "7 agent claim and handoff", pages, async () => {
      await adminPage.goto(ADMIN_WEB + "/sessions/" + session.id);
      await adminPage
        .getByText("Browser handoff verified", { exact: true })
        .waitFor();
      const body = await adminPage.locator("body").innerText();
      assert.match(body, /browser\/task-1/);
      assert.match(body, /Browser handoff verified/);
      assert.match(body, /Handoffs/);
    });

    await browserStep(
      t,
      "2a author autosave survives Git failure",
      pages,
      async () => {
        const canonicalHeadBefore = execFileSync(
          "git",
          ["-C", MANAGED_REPO, "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim();
        const gitDirectory = path.join(MANAGED_REPO, ".git");
        const disabledGitDirectory = path.join(
          MANAGED_REPO,
          ".git-browser-e2e-disabled",
        );
        const recoverySummary = "Browser E2E autosave recovery";
        const recoveryContent = [
          "---",
          "id: BROWSER-E2E-RECOVERY",
          "type: rule",
          "title: Browser E2E recovery",
          "status: ACTIVE",
          "knowledge_layer: rules",
          "---",
          "",
          "# Browser E2E recovery",
          "",
          "Local recovery must survive a failed governed Git save.",
        ].join("\n");

        await adminPage.goto(ADMIN_WEB + "/author");
        await adminPage
          .locator('select[name="vaultId"]')
          .selectOption(fixture.vaultId);
        await adminPage.locator('input[name="summary"]').fill(recoverySummary);
        await adminPage
          .locator('input[name="path"]')
          .fill("browser/e2e-recovery.md");
        await adminPage
          .locator('input[name="reason"]')
          .fill("Prove autosave recovery after Git failure");
        await adminPage
          .locator('textarea[name="content"]')
          .fill(recoveryContent);

        await adminPage.waitForFunction(
          ({ expectedSummary, expectedContent }) => {
            const raw = window.localStorage.getItem("akp.author.recovery.v1");
            if (!raw) return false;
            try {
              const parsed = JSON.parse(raw);
              return (
                parsed.summary === expectedSummary &&
                parsed.content === expectedContent
              );
            } catch {
              return false;
            }
          },
          {
            expectedSummary: recoverySummary,
            expectedContent: recoveryContent,
          },
        );

        await rename(gitDirectory, disabledGitDirectory);
        try {
          await adminPage
            .getByRole("button", { name: "Save: crear draft Git" })
            .click();
          await adminPage
            .getByRole("alert")
            .getByText(/Save rechazado:/)
            .waitFor();
        } finally {
          await rename(disabledGitDirectory, gitDirectory);
        }

        assert.equal(
          execFileSync("git", ["-C", MANAGED_REPO, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          canonicalHeadBefore,
        );

        await adminPage.reload();
        await adminPage
          .getByText(/Recovery local restaurado\./)
          .first()
          .waitFor();
        assert.equal(
          await adminPage.locator('input[name="summary"]').inputValue(),
          recoverySummary,
        );
        assert.equal(
          await adminPage.locator('textarea[name="content"]').inputValue(),
          recoveryContent,
        );
        assert.equal(
          execFileSync("git", ["-C", MANAGED_REPO, "rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
          canonicalHeadBefore,
        );

        await adminPage
          .getByRole("button", { name: "Descartar recovery local" })
          .click();
      },
    );

    let reviewId = "";
    await browserStep(t, "2 author save and submit", pages, async () => {
      await adminPage.goto(ADMIN_WEB + "/author");
      await adminPage
        .locator('select[name="vaultId"]')
        .selectOption(fixture.vaultId);
      await adminPage
        .locator('input[name="summary"]')
        .fill("Browser E2E governed authoring");
      await adminPage.locator('input[name="path"]').fill("browser/e2e-rule.md");
      await adminPage
        .locator('input[name="reason"]')
        .fill("Browser E2E governed authoring flow");
      await adminPage
        .locator('textarea[name="content"]')
        .fill(
          [
            "---",
            "id: BROWSER-E2E-RULE",
            "type: rule",
            "title: Browser E2E rule",
            "status: ACTIVE",
            "knowledge_layer: rules",
            "---",
            "",
            "# Browser E2E rule",
            "",
            "A governed browser proposal must require human review.",
          ].join("\n"),
        );
      await adminPage
        .getByRole("button", { name: "Save: crear draft Git" })
        .click();
      await adminPage
        .getByRole("heading", { name: "Draft Git guardado", exact: true })
        .waitFor();
      const codes = await adminPage.locator("code").allTextContents();
      reviewId =
        codes
          .find((value) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              value.trim(),
            ),
          )
          ?.trim() ?? "";
      assert.match(reviewId, /^[0-9a-f-]{36}$/i);

      await seedReviewEvidence(db, reviewId);
      await adminPage.getByRole("button", { name: "Submit review" }).click();
      await adminPage
        .getByText(/Review enviado\./)
        .first()
        .waitFor();
    });

    await browserStep(t, "3 review approve with evidence", pages, async () => {
      await adminPage.goto(ADMIN_WEB + "/reviews/" + reviewId);
      await adminPage
        .getByText(
          "Browser evidence proves the review workspace renders grounded context.",
          { exact: true },
        )
        .waitFor();
      const body = await adminPage.locator("body").innerText();
      assert.match(
        body,
        /Browser evidence proves the review workspace renders grounded context/,
      );
      await adminPage
        .locator('input[name="reason"]')
        .first()
        .fill("Browser E2E evidence verified");
      await adminPage
        .getByRole("button", { name: "Aprobar y publicar" })
        .click();
      await adminPage.getByText("APPROVED", { exact: true }).first().waitFor();
    });

    let deniedReviewId = "";
    await browserStep(t, "4 denied unauthorized approve", pages, async () => {
      const proposal = (
        await apiJson("/v1/proposals", {
          method: "POST",
          body: {
            spaceId: SPACE_ID,
            vaultId: fixture.vaultId,
            summary: "Browser reader denial",
            changes: [
              {
                path: "browser/reader-denial.md",
                reason: "Exercise read-only review denial",
                content: [
                  "---",
                  "id: BROWSER-READER-DENIAL",
                  "type: rule",
                  "title: Browser reader denial",
                  "status: ACTIVE",
                  "knowledge_layer: rules",
                  "---",
                  "",
                  "# Browser reader denial",
                  "",
                  "A read-only browser identity must never approve.",
                ].join("\n"),
              },
            ],
          },
        })
      ).payload;
      deniedReviewId = proposal.reviewId;
      await readerPage.goto(READER_WEB + "/reviews/" + deniedReviewId);
      await readerPage
        .getByText("Esta sesión puede leer la revisión, pero no decidirla.", {
          exact: true,
        })
        .waitFor();
      const body = await readerPage.locator("body").innerText();
      assert.match(body, /leer la revisión, pero no decidirla|no decidir/i);
      assert.equal(
        await readerPage
          .getByRole("button", { name: "Aprobar y publicar" })
          .count(),
        0,
      );

      const request = await playwrightRequest.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: {
          authorization: "Bearer " + fixture.readerToken,
          "content-type": "application/json",
          "idempotency-key": "browser-reader-denied-" + randomUUID(),
        },
      });
      try {
        const response = await request.post(
          "/v1/reviews/" + deniedReviewId + "/decision",
          {
            data: {
              decision: "APPROVE",
              reason: "This must be denied",
            },
          },
        );
        assert.equal(response.status(), 403);
      } finally {
        await request.dispose();
      }
    });

    await browserStep(t, "5 code impact visualization", pages, async () => {
      await adminPage.goto(
        ADMIN_WEB + "/graph?vaultId=" + encodeURIComponent(fixture.vaultId),
      );
      const entryRow = adminPage.locator("tr", { hasText: "BrowserEntry" });
      await entryRow
        .getByRole("button", { name: /Seleccionar|Seleccionado/ })
        .click();
      await adminPage
        .getByLabel("Target")
        .selectOption("federated:" + fixture.helperNodeId);
      await adminPage
        .getByText("Camino dirigido encontrado: 2 nodos.", { exact: true })
        .waitFor();
      const body = await adminPage.locator("body").innerText();
      assert.match(body, /STATICALLY_RESOLVED/);
      assert.match(body, /CODE/);
      assert.match(
        body,
        /Validity 2026-06-01T00:00:00\.000Z → open · Recorded 2026-06-01T00:00:00\.000Z/,
      );
    });

    await browserStep(t, "6 temporal as-of view", pages, async () => {
      const asOf = "2026-01-01T00:00:00.000Z";
      await adminPage.goto(
        ADMIN_WEB +
          "/graph?vaultId=" +
          encodeURIComponent(fixture.vaultId) +
          "&asOf=" +
          encodeURIComponent(asOf),
      );
      const entryRow = adminPage.locator("tr", { hasText: "BrowserEntry" });
      await entryRow
        .getByRole("button", { name: /Seleccionar|Seleccionado/ })
        .click();
      await adminPage
        .getByLabel("Target")
        .selectOption("federated:" + fixture.helperNodeId);
      await adminPage
        .getByText("No existe camino dirigido visible entre seed y target.", {
          exact: true,
        })
        .waitFor();
      const body = await adminPage.locator("body").innerText();
      assert.match(body, /HISTORICAL SNAPSHOT/);
      assert.match(body, /Query effective time/);
      assert.match(body, /2026-01-01T00:00:00.000Z/);
    });

    await browserStep(t, "8 connector failure state", pages, async () => {
      await adminPage.goto(
        ADMIN_WEB +
          "/admin/connectors?vaultId=" +
          encodeURIComponent(fixture.vaultId),
      );
      await adminPage
        .getByText("browser-e2e-connector", { exact: true })
        .waitFor();
      const body = await adminPage.locator("body").innerText();
      assert.match(body, /browser-e2e-connector/);
      assert.match(body, /PROVIDER_TIMEOUT/);
      assert.match(body, /pending 1/);
      assert.match(body, /retry 1/);
    });

    await browserStep(t, "9 assurance finding triage", pages, async () => {
      await adminPage.goto(
        ADMIN_WEB +
          "/admin/assurance?vaultId=" +
          encodeURIComponent(fixture.vaultId),
      );
      const row = adminPage.locator("tr", {
        hasText: "BROWSER_FRESHNESS_STALE",
      });
      await row.locator('select[name="status"]').selectOption("ACKNOWLEDGED");
      await row
        .locator('input[name="reason"]')
        .first()
        .fill("Browser E2E triage verified");
      await row.getByRole("button", { name: "Guardar" }).click();
      const updatedRow = adminPage.locator("tr", {
        hasText: "BROWSER_FRESHNESS_STALE",
      });
      await updatedRow
        .locator("td")
        .nth(2)
        .getByText("ACKNOWLEDGED", { exact: true })
        .waitFor();
      assert.equal(
        await updatedRow.locator('select[name="status"]').inputValue(),
        "ACKNOWLEDGED",
      );
    });
  } finally {
    await writeFile(
      path.join(REPORT_DIR, "browser-e2e.json"),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          fixture: {
            vaultId: fixture.vaultId,
            connectorId: fixture.connectorId,
            assuranceFindingId: fixture.assuranceFindingId,
          },
          results,
        },
        null,
        2,
      ),
      "utf8",
    ).catch(() => undefined);

    if (browser) await browser.close().catch(() => undefined);
    if (databaseConnected) {
      await db.query(
        "update source_connector_registrations " +
          "set state='DISABLED',updated_at=now() where id=$1",
        [fixture.connectorId],
      );
    }
    await db.end().catch(() => undefined);
    for (const child of children.reverse()) {
      await stopService(child);
    }
    if (apiWasSpawned) {
      console.log("[browser-e2e] disposable API stopped");
    }
  }
});
