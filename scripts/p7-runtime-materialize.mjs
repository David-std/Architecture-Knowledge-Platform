import fs from "node:fs";

function patchFile(path, patches) {
  let source = fs.readFileSync(path, "utf8");
  for (const [label, before, after] of patches) {
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`P7_PATCH_MISSING:${path}:${label}`);
    if (source.indexOf(before, first + before.length) >= 0) {
      throw new Error(`P7_PATCH_AMBIGUOUS:${path}:${label}`);
    }
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

patchFile("apps/mcp/src/server.ts", [
  [
    "instrumentation-import",
    'import { config } from "dotenv";\n',
    'import "./instrumentation.js";\nimport { config } from "dotenv";\n',
  ],
  [
    "otel-import",
    'import { z } from "zod";\n',
    'import { z } from "zod";\nimport { shutdownOpenTelemetry, withSpan } from "@akp/observability";\n',
  ],
  [
    "api-span-open",
    'async function api(route: string, init?: RequestInit): Promise<unknown> {\n  const response = await fetch(`${apiBase}${route}`, {',
    'async function api(route: string, init?: RequestInit): Promise<unknown> {\n  const routeTemplate = route\n    .split("?")[0]\n    ?.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id") ?? "/";\n  return withSpan("mcp.tool", { "akp.mcp.route": routeTemplate }, async () => {\n    const response = await fetch(`${apiBase}${route}`, {',
  ],
  [
    "api-span-close",
    '  return body;\n}\n\nasync function writeApi(',
    '    return body;\n  });\n}\n\nasync function writeApi(',
  ],
  [
    "shutdown",
    '  await server.connect(transport);\n}\n',
    '  process.once("SIGTERM", () => void shutdownOpenTelemetry());\n  process.once("SIGINT", () => void shutdownOpenTelemetry());\n  await server.connect(transport);\n}\n',
  ],
]);

patchFile("apps/worker/src/worker.ts", [
  [
    "instrumentation-import",
    'import { config } from "dotenv";\n',
    'import "./instrumentation.js";\nimport { config } from "dotenv";\n',
  ],
  [
    "otel-import",
    'import { appendDocumentIntelligenceFormFields } from "./document-intelligence-request.js";\n',
    'import { appendDocumentIntelligenceFormFields } from "./document-intelligence-request.js";\nimport {\n  OpenTelemetryBridge,\n  shutdownOpenTelemetry,\n  withSpan,\n} from "@akp/observability";\n',
  ],
  [
    "telemetry-instance",
    'const git = new GitKnowledgeStore(managedRepository);\n',
    'const git = new GitKnowledgeStore(managedRepository);\nconst telemetry = new OpenTelemetryBridge();\n',
  ],
  [
    "run-claimed-job",
    `async function runClaimedJob(job: Record<string, unknown>): Promise<void> {\n  const stopHeartbeat = startLeaseHeartbeat(String(job.id));\n  try {\n    await processJob(job);\n  } catch (error) {\n    await handleFailure(job, error);\n  } finally {\n    stopHeartbeat();\n  }\n}`,
    `async function tracedProcessJob(job: Record<string, unknown>): Promise<void> {\n  const state = String(job.state);\n  const attributes = { "akp.ingest.state": state };\n  if (state === "RECEIVED") {\n    return withSpan("ingest.receive", attributes, () =>\n      withSpan("raw.store", attributes, () => processJob(job)),\n    );\n  }\n  if (state === "NORMALIZING") {\n    return withSpan("extract.request", attributes, () =>\n      withSpan("extract.process", attributes, () => processJob(job)),\n    );\n  }\n  if (state === "DRAFTED") {\n    return withSpan("compile.validate", attributes, () => processJob(job));\n  }\n  return processJob(job);\n}\n\nasync function runClaimedJob(job: Record<string, unknown>): Promise<void> {\n  const stopHeartbeat = startLeaseHeartbeat(String(job.id));\n  const state = String(job.state);\n  const started = performance.now();\n  const createdAt = new Date(String(job.created_at ?? ""));\n  try {\n    await tracedProcessJob(job);\n    telemetry.counter("ingest_jobs_total", 1, { state });\n    if (!Number.isNaN(createdAt.getTime())) {\n      telemetry.histogram(\n        "ingest_job_age",\n        Math.max(0, (Date.now() - createdAt.getTime()) / 1000),\n        { state },\n      );\n    }\n    if (state === "NORMALIZING") {\n      telemetry.histogram(\n        "extract_latency",\n        (performance.now() - started) / 1000,\n        { provider: "extractor-service" },\n      );\n    }\n  } catch (error) {\n    if (state === "NORMALIZING") {\n      telemetry.counter("provider_failures", 1, { provider: "extractor-service" });\n    }\n    await handleFailure(job, error);\n  } finally {\n    stopHeartbeat();\n  }\n}`,
  ],
  [
    "sigterm-shutdown",
    `process.on("SIGTERM", async () => {\n  eventWorker.stop();\n  await db.close();\n  process.exit(0);\n});`,
    `process.on("SIGTERM", async () => {\n  eventWorker.stop();\n  await db.close();\n  await shutdownOpenTelemetry();\n  process.exit(0);\n});`,
  ],
  [
    "final-shutdown",
    'finally {\n  await db.close();\n}\n',
    'finally {\n  await db.close();\n  await shutdownOpenTelemetry();\n}\n',
  ],
]);

patchFile("apps/worker/src/knowledge-compilation.ts", [
  [
    "otel-import",
    'import type { Postgres } from "@akp/postgres";\n',
    'import type { Postgres } from "@akp/postgres";\nimport { OpenTelemetryBridge, withSpan } from "@akp/observability";\n\nconst telemetry = new OpenTelemetryBridge();\n',
  ],
  [
    "retrieve-existing",
    '  const retrieval = await retrieveExistingKnowledgeCandidates(db, {',
    '  const retrieval = await withSpan(\n    "compile.retrieve_existing",\n    { "akp.vector.enabled": request.vectorEnabled ?? false },\n    () => retrieveExistingKnowledgeCandidates(db, {',
  ],
  [
    "retrieve-existing-close",
    '    ...(request.vectorEnabled === undefined\n      ? {}\n      : { vectorEnabled: request.vectorEnabled }),\n  });\n  const input = KnowledgeCompilerInput.parse({',
    '    ...(request.vectorEnabled === undefined\n      ? {}\n      : { vectorEnabled: request.vectorEnabled }),\n    }),\n  );\n  const input = KnowledgeCompilerInput.parse({',
  ],
  [
    "compiler-call",
    '  const result = await configured.compiler.compile(input);\n  return {',
    '  let result: KnowledgeCompilerResult;\n  try {\n    result = await configured.compiler.compile(input);\n  } catch (error) {\n    telemetry.counter("provider_failures", 1, { provider: "knowledge-compiler" });\n    throw error;\n  }\n  return {',
  ],
]);

patchFile("apps/api/src/routes/reviews.ts", [
  [
    "otel-import",
    'import { validateMarkdownDocument } from "@akp/validation";\n',
    'import { validateMarkdownDocument } from "@akp/validation";\nimport { withSpan } from "@akp/observability";\n',
  ],
  [
    "publish-span",
    `          revision = await store.mergeDraft(\n            String(review.branch_name),\n            String(review.base_commit),\n            String(review.head_commit),\n            process.env.AKP_GIT_AUTHOR_NAME ??\n              "Architecture Knowledge Platform",\n            process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",\n          );`,
    `          revision = await withSpan(\n            "review.publish",\n            { "akp.review.operation": "approve" },\n            () =>\n              store.mergeDraft(\n                String(review.branch_name),\n                String(review.base_commit),\n                String(review.head_commit),\n                process.env.AKP_GIT_AUTHOR_NAME ??\n                  "Architecture Knowledge Platform",\n                process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",\n              ),\n          );`,
  ],
  [
    "rollback-span",
    '        revision = await store.rollbackMain(String(review.merged_commit));\n',
    '        revision = await withSpan(\n          "review.rollback",\n          { "akp.review.operation": "rollback" },\n          () => store.rollbackMain(String(review.merged_commit)),\n        );\n',
  ],
]);

patchFile("apps/api/src/routes/search.ts", [
  [
    "otel-import",
    '} from "@akp/retrieval";\nimport {\n  actorOf,',
    '} from "@akp/retrieval";\nimport { OpenTelemetryBridge, withSpan } from "@akp/observability";\nimport {\n  actorOf,',
  ],
  [
    "telemetry-helper",
    'const TRUST_RANK: Record<string, number> = {',
    `const telemetry = new OpenTelemetryBridge();\n\ntype RequiredRetrievalChannel = "exact" | "lexical" | "vector" | "graph";\n\nasync function observedRetrieval<T>(\n  channel: RequiredRetrievalChannel,\n  operation: () => Promise<T>,\n): Promise<T> {\n  const started = performance.now();\n  try {\n    return await withSpan(\n      \`retrieve.\${channel}\`,\n      { "akp.retrieval.channel": channel },\n      operation,\n    );\n  } finally {\n    telemetry.histogram(\n      "retrieval_channel_latency",\n      (performance.now() - started) / 1000,\n      { channel },\n    );\n  }\n}\n\nfunction recordRetrievalCandidates(\n  channel: RequiredRetrievalChannel,\n  count: number,\n): void {\n  telemetry.histogram("retrieval_candidates", count, { channel });\n}\n\nconst TRUST_RANK: Record<string, number> = {`,
  ],
  [
    "exact-query",
    '    ? await db.pool.query<ExactSearchRow>(\n',
    '    ? await observedRetrieval("exact", () =>\n        db.pool.query<ExactSearchRow>(\n',
  ],
  [
    "exact-query-close",
    '        [spaceId, input.query, Math.max(input.limit * 2, 20)],\n      )\n    : { rows: [] as ExactSearchRow[] };',
    '        [spaceId, input.query, Math.max(input.limit * 2, 20)],\n        ),\n      )\n    : { rows: [] as ExactSearchRow[] };\n  recordRetrievalCandidates("exact", exact.rows.length);',
  ],
  [
    "lexical-query",
    '      ? await db.pool.query<LexicalSearchRow>(\n',
    '      ? await observedRetrieval("lexical", () =>\n          db.pool.query<LexicalSearchRow>(\n',
  ],
  [
    "lexical-query-close",
    '          [spaceId, input.query, Math.max(input.limit * 3, 30)],\n        )\n      : { rows: [] as LexicalSearchRow[] };',
    '          [spaceId, input.query, Math.max(input.limit * 3, 30)],\n          ),\n        )\n      : { rows: [] as LexicalSearchRow[] };\n  recordRetrievalCandidates("lexical", lexical.rows.length);',
  ],
  [
    "vector-query",
    '        const result = await db.pool.query<VectorSearchRow>(\n',
    '        const result = await observedRetrieval("vector", () =>\n          db.pool.query<VectorSearchRow>(\n',
  ],
  [
    "vector-query-close",
    '          ],\n        );\n        options.availableChannelSink?.add("vector");',
    '          ],\n          ),\n        );\n        options.availableChannelSink?.add("vector");',
  ],
  [
    "vector-candidates",
    '    vector.rows.splice(Math.max(input.limit * 3, 30));\n  }\n\n  const seedIds = [',
    '    vector.rows.splice(Math.max(input.limit * 3, 30));\n  }\n  recordRetrievalCandidates("vector", vector.rows.length);\n\n  const seedIds = [',
  ],
  [
    "graph-query",
    '      : (\n          await db.pool.query<GraphTraversalRow>(\n',
    '      : (\n          await observedRetrieval("graph", () =>\n            db.pool.query<GraphTraversalRow>(\n',
  ],
  [
    "graph-query-close",
    '            ],\n          )\n        ).rows;',
    '            ],\n            ),\n          )\n        ).rows;',
  ],
  [
    "graph-candidates",
    '  const graph = { rows: graphCandidates };\n',
    '  const graph = { rows: graphCandidates };\n  recordRetrievalCandidates("graph", graph.rows.length);\n',
  ],
  [
    "fuse-span",
    '  const fused = reciprocalRankFusion(rankedChannels).slice(0, input.limit * 2);\n',
    '  const fused = (\n    await withSpan("retrieve.fuse", {}, async () =>\n      reciprocalRankFusion(rankedChannels),\n    )\n  ).slice(0, input.limit * 2);\n',
  ],
  [
    "search-request-metric",
    '      const retrievalWarnings: string[] = plan.omittedChannels.map(',
    '      telemetry.counter("retrieval_requests", 1, { intent: plan.intent });\n      telemetry.gauge(\n        "index_revision_mismatch",\n        String(index.status ?? "DEGRADED") === "CONSISTENT" ? 0 : 1,\n        { projection: "aggregate" },\n      );\n      const retrievalWarnings: string[] = plan.omittedChannels.map(',
  ],
  [
    "context-build",
    `        if (packetMode === "COMPACT_AGENT_PACKET") {\n          const pair = buildContextPacketPair(packetInput);\n          packet = pair.full;\n          responsePacket = pair.compact;\n        } else {\n          packet = buildContextPacket(packetInput);\n          responsePacket = packet;\n        }`,
    `        const built = await withSpan(\n          "context.build",\n          { "akp.context.mode": packetMode },\n          async () => {\n            if (packetMode === "COMPACT_AGENT_PACKET") {\n              const pair = buildContextPacketPair(packetInput);\n              return { packet: pair.full, responsePacket: pair.compact };\n            }\n            const full = buildContextPacket(packetInput);\n            return { packet: full, responsePacket: full };\n          },\n        );\n        packet = built.packet;\n        responsePacket = built.responsePacket;\n        telemetry.histogram("context_packet_tokens", packet.budget.usedTokens, {\n          mode: packetMode,\n        });\n        telemetry.histogram("context_packet_sections", packet.sections.length, {\n          mode: packetMode,\n        });`,
  ],
]);
