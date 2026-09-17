from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "apps/api/src/auth.ts",
    '''      `select p.id,p.kind,p.parent_principal_id,p.session_id,p.vault_id,p.allowed_actions,
              p.policy_revision,p.state
         from principals p
        where p.id=coalesce(
          $1::uuid,
          (select id from principals where kind='HUMAN' and user_id=$2 limit 1)
        )
        limit 1`,
''',
    '''      `select p.id,p.kind,p.parent_principal_id,p.session_id,p.vault_id,p.allowed_actions,
              p.policy_revision,p.state,parent.state parent_state
         from principals p
         left join principals parent on parent.id=p.parent_principal_id
        where p.id=coalesce(
          $1::uuid,
          (select id from principals where kind='HUMAN' and user_id=$2 limit 1)
        )
        limit 1`,
''',
)

replace_once(
    "apps/api/src/auth.ts",
    '''    if (!principal || principal.state !== "ACTIVE") {
      await reply.code(401).send({ code: "INVALID_TOKEN" });
      return;
    }
''',
    '''    // Derived principals never outlive their authority root. Checking only the
    // child state would let an issued AGENT_PROCESS continue after its parent
    // human principal was revoked. Fail closed as an invalid credential when
    // the recorded parent is missing or no longer active.
    if (
      !principal ||
      principal.state !== "ACTIVE" ||
      (principal.parent_principal_id && principal.parent_state !== "ACTIVE")
    ) {
      await reply.code(401).send({ code: "INVALID_TOKEN" });
      return;
    }
''',
)

replace_once(
    "apps/api/test/principal-auth.integration.test.ts",
    '''    expect(afterRevocation.statusCode).toBe(401);
    expect(afterRevocation.json()).toMatchObject({ code: "INVALID_TOKEN" });
''',
    '''    expect(afterRevocation.statusCode).toBe(401);
    expect(afterRevocation.json()).toMatchObject({ code: "INVALID_TOKEN" });

    const siblingIssued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/agent-processes`,
      headers: humanHeaders,
      payload: {
        label: "Parent revocation child",
        allowedActions: ["workspace:read", "knowledge:read"],
      },
    });
    expect(siblingIssued.statusCode).toBe(201);
    const siblingCredential = siblingIssued.json() as {
      token: string;
      principal: { id: string };
    };

    // Revoke only the HUMAN authority root. The child row intentionally remains
    // ACTIVE so this proves authentication follows the parent edge rather than
    // relying on a cascade that may be delayed or absent.
    await db.pool.query(
      `update principals
          set state='REVOKED',revoked_at=now(),policy_revision=policy_revision+1
        where id=$1 and kind='HUMAN'`,
      [humanPrincipal.rows[0]?.id],
    );
    const childState = await db.pool.query<{ state: string }>(
      "select state from principals where id=$1",
      [siblingCredential.principal.id],
    );
    expect(childState.rows[0]?.state).toBe("ACTIVE");

    const afterParentRevocation = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: { authorization: `Bearer ${siblingCredential.token}` },
    });
    expect(afterParentRevocation.statusCode).toBe(401);
    expect(afterParentRevocation.json()).toMatchObject({
      code: "INVALID_TOKEN",
    });
''',
)
