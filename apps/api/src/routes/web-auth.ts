import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import { actorOf, audit, serializeEffectiveScopes } from "../auth.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  httpOnly: boolean,
): string {
  const secure =
    process.env.AKP_COOKIE_SECURE === "true" ||
    process.env.NODE_ENV === "production";
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Strict",
    httpOnly ? "HttpOnly" : "",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function registerWebAuthRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post<{ Body: { durationMinutes?: number } }>(
    "/v1/auth/session",
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor)
        return reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      if (actor.authenticationKind !== "API_TOKEN") {
        return reply.code(409).send({ code: "SESSION_ALREADY_ACTIVE" });
      }
      const durationMinutes = Math.max(
        5,
        Math.min(Number(request.body?.durationMinutes ?? 480), 720),
      );
      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const scopes = serializeEffectiveScopes(actor);
      const result = await db.pool.query(
        `
      insert into web_sessions(
        user_id,token_hash,csrf_hash,expires_at,user_agent,remote_address,scopes
      ) values($1,$2,$3,now()+make_interval(mins => $4),$5,$6,$7::jsonb)
      returning id,expires_at,created_at
      `,
        [
          actor.id,
          hash(sessionToken),
          hash(csrfToken),
          durationMinutes,
          request.headers["user-agent"] ?? null,
          request.ip,
          JSON.stringify(scopes),
        ],
      );
      const maxAge = durationMinutes * 60;
      reply.header("set-cookie", [
        cookie("akp_session", sessionToken, maxAge, true),
        cookie("akp_csrf", csrfToken, maxAge, false),
      ]);
      await audit(
        db,
        request,
        "web_session.create",
        "web_session",
        String(result.rows[0]?.id),
      );
      return reply.code(201).send({
        id: result.rows[0]?.id,
        expiresAt: result.rows[0]?.expires_at,
        csrfToken,
        authenticationKind: "WEB_SESSION",
      });
    },
  );

  app.get("/v1/auth/session", async (request) => {
    const actor = actorOf(request);
    return {
      authenticated: true,
      actor: actor
        ? {
            id: actor.id,
            email: actor.email,
            roles: actor.roles,
            spaceIds: actor.spaceIds,
            authenticationKind: actor.authenticationKind,
          }
        : null,
    };
  });

  app.post("/v1/auth/session/revoke", async (request, reply) => {
    const actor = actorOf(request);
    if (!actor?.sessionId) {
      return reply.code(409).send({ code: "WEB_SESSION_REQUIRED" });
    }
    await db.pool.query(
      "update web_sessions set revoked_at=now() where id=$1",
      [actor.sessionId],
    );
    reply.header("set-cookie", [
      cookie("akp_session", "", 0, true),
      cookie("akp_csrf", "", 0, false),
    ]);
    await audit(
      db,
      request,
      "web_session.revoke",
      "web_session",
      actor.sessionId,
    );
    return { id: actor.sessionId, status: "REVOKED" };
  });
}
