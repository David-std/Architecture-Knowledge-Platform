from pathlib import Path

sessions_path = Path("apps/api/src/routes/sessions.ts")
sessions = sessions_path.read_text()

old = '''      const result = await bootstrap.execute(
        {
          sessionId: session.id,
          actorId: actor.id,
          ...(query ? { query } : {}),
          intent: intent.data,
          mode: packetMode,
        },
        {
          principalId: actor.principalId,
          principalKind: actor.principalKind,
          principalPolicyRevision: actor.principalPolicyRevision,
          scopeFingerprint: actor.idempotencyScopeFingerprint,
        },
      );
      workspaceTelemetry.counter("akp.workspace.bootstrap_total", 1, {'''
new = '''      let result: Awaited<ReturnType<typeof bootstrap.execute>>;
      try {
        result = await bootstrap.execute(
          {
            sessionId: session.id,
            actorId: actor.id,
            ...(query ? { query } : {}),
            intent: intent.data,
            mode: packetMode,
          },
          {
            principalId: actor.principalId,
            principalKind: actor.principalKind,
            principalPolicyRevision: actor.principalPolicyRevision,
            scopeFingerprint: actor.idempotencyScopeFingerprint,
          },
        );
      } catch (error) {
        const code =
          error instanceof Error
            ? String((error as Error & { code?: string }).code ?? error.message)
            : "BOOTSTRAP_CONTEXT_FAILED";
        if (code === "SESSION_NOT_FOUND") {
          return reply.code(404).send({ code });
        }
        if (
          code === "CONTEXT_REVISION_CHANGED" ||
          code === "CONTEXT_REVISION_PIN_REQUIRED"
        ) {
          return reply.code(409).send({ code });
        }
        throw error;
      }
      workspaceTelemetry.counter("akp.workspace.bootstrap_total", 1, {'''
marker = 'code === "CONTEXT_REVISION_PIN_REQUIRED"'
if marker not in sessions:
    if old not in sessions:
        raise SystemExit("sessions.ts bootstrap execute shape changed")
    sessions = sessions.replace(old, new, 1)
sessions_path.write_text(sessions)


test_path = Path("apps/api/test/context-revision-set.integration.test.ts")
test = test_path.read_text()
# Temporary lateral-branch diagnostic: turn Fastify logging on so an unexpected
# clean-DB 500 exposes the actual PostgreSQL/runtime error in Actions logs.
if 'process.env.NODE_ENV = "test";' in test:
    test = test.replace(
        'process.env.NODE_ENV = "test";',
        'process.env.NODE_ENV = "development";',
        1,
    )
old_test = '''    const staleClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${initial.id}/claims`,'''
new_test = '''    const staleBootstrap = await app.inject({
      method: "POST",
      url: `/v1/sessions/${initial.id}/bootstrap`,
      headers,
      payload: {
        query: "continue against stale pinned context",
        intent: "WORKFLOW_EXECUTION",
      },
    });
    expect(staleBootstrap.statusCode).toBe(409);
    expect(staleBootstrap.json()).toMatchObject({
      code: "CONTEXT_REVISION_CHANGED",
    });

    const staleClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${initial.id}/claims`,'''
if "const staleBootstrap = await app.inject" not in test:
    if old_test not in test:
        raise SystemExit("context revision integration shape changed")
    test = test.replace(old_test, new_test, 1)
test_path.write_text(test)
