import Fastify from "fastify";
import { Postgres } from "@akp/postgres";
import { registerSearchRoutes } from "./routes/search.js";
import { registerIngestRoutes } from "./routes/ingest.js";

export function buildServer() {
  const app = Fastify({ logger: true });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = new Postgres(databaseUrl);

  app.get("/health/liveness", async () => ({ status: "UP" }));
  app.get("/health/readiness", async (_request, reply) => {
    const database = await db.health().catch(() => false);
    if (!database) return reply.code(503).send({ status: "DOWN", database });
    return { status: "UP", database };
  });

  registerSearchRoutes(app, db);
  registerIngestRoutes(app, db);

  app.addHook("onClose", async () => db.close());
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: "127.0.0.1" });
}
