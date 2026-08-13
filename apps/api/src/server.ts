import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { Postgres } from "@akp/postgres";
import { MinioObjectStore } from "@akp/object-store";
import { OpenTelemetryBridge, type ActiveTrace } from "@akp/observability";
import { registerSearchRoutes } from "./routes/search.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerEvaluationRoutes } from "./routes/evaluation.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerGovernanceRoutes } from "./routes/governance.js";
import { registerAuthentication } from "./auth.js";
import { registerWriteIdempotency } from "./idempotency.js";
import { registerWebAuthRoutes } from "./routes/web-auth.js";
import { registerSchemaGovernanceRoutes } from "./routes/schema-governance.js";
import { registerErrorBookRoutes } from "./routes/error-book.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuditExportRoutes } from "./routes/audit-export.js";

config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env",
  ),
});

export function buildServer() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 10 * 1024 * 1024,
    requestTimeout: 30_000,
  });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = new Postgres(databaseUrl);
  const rawStoreConfig = [
    process.env.AKP_RAW_ENDPOINT,
    process.env.AKP_RAW_ACCESS_KEY,
    process.env.AKP_RAW_SECRET_KEY,
    process.env.AKP_RAW_BUCKET,
  ];
  const rawObjectStore = rawStoreConfig.every((value): value is string =>
    Boolean(value?.trim()),
  )
    ? new MinioObjectStore({
        endpoint: process.env.AKP_RAW_ENDPOINT as string,
        accessKey: process.env.AKP_RAW_ACCESS_KEY as string,
        secretKey: process.env.AKP_RAW_SECRET_KEY as string,
        bucket: process.env.AKP_RAW_BUCKET as string,
      })
    : undefined;
  const telemetry = new OpenTelemetryBridge();
  const requestTraces = new Map<
    string,
    { trace: ActiveTrace; started: number }
  >();

  app.addHook("onRequest", async (request) => {
    requestTraces.set(request.id, {
      trace: telemetry.startTrace("http.request", {
        "http.request.method": request.method,
        "url.path": request.url.split("?")[0] ?? request.url,
      }),
      started: performance.now(),
    });
  });
  app.addHook("onError", async (request, _reply, error) => {
    requestTraces.get(request.id)?.trace.fail(error);
  });
  app.addHook("onResponse", async (request, reply) => {
    const active = requestTraces.get(request.id);
    if (!active) return;
    telemetry.histogram(
      "akp.http.server.duration",
      performance.now() - active.started,
      {
        method: request.method,
        status: String(reply.statusCode),
      },
    );
    active.trace.end({ "http.response.status_code": reply.statusCode });
    requestTraces.delete(request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    if ((error as { code?: string }).code === "22P02") {
      return reply.code(400).send({
        code: "INVALID_IDENTIFIER",
        message: "The requested identifier has an invalid format.",
      });
    }
    request.log.error(error);
    return reply.send(error);
  });

  void app.register(cors, {
    origin: (
      process.env.AKP_CORS_ORIGINS ??
      "http://127.0.0.1:3000,http://localhost:3000"
    )
      .split(",")
      .map((origin) => origin.trim()),
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  });
  void app.register(rateLimit, {
    max: Number(process.env.AKP_RATE_LIMIT_MAX ?? 120),
    timeWindow: "1 minute",
  });

  app.get("/health/liveness", async () => ({ status: "UP" }));
  app.get("/health/readiness", async (_request, reply) => {
    const probe = async (url: string): Promise<boolean> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    };
    const [database, rawObjectStore, extractor] = await Promise.all([
      db.health().catch(() => false),
      probe(
        `${process.env.AKP_RAW_ENDPOINT ?? "http://127.0.0.1:19000"}/minio/health/live`,
      ),
      probe(
        `${process.env.AKP_EXTRACTOR_URL ?? "http://127.0.0.1:8090"}/health`,
      ),
    ]);
    const health = { database, rawObjectStore, extractor };
    if (!Object.values(health).every(Boolean)) {
      return reply.code(503).send({ status: "DOWN", ...health });
    }
    return { status: "UP", ...health };
  });

  registerAuthentication(app, db);
  registerWriteIdempotency(app, db);
  registerWebAuthRoutes(app, db);
  registerSchemaGovernanceRoutes(app, db);
  registerErrorBookRoutes(app, db);
  registerAuditRoutes(app, db);
  registerAuditExportRoutes(app, db, rawObjectStore);
  registerSearchRoutes(app, db);
  registerIngestRoutes(app, db);
  registerKnowledgeRoutes(app, db);
  registerReviewRoutes(app, db);
  registerEvaluationRoutes(app, db);
  registerProjectRoutes(app, db);
  registerSessionRoutes(app, db);
  registerGovernanceRoutes(app, db);

  app.addHook("onClose", async () => db.close());
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "127.0.0.1" });
}
