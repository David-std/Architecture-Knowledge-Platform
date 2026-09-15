from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


def insert_before_last(path: str, marker: str, insertion: str) -> None:
    file = Path(path)
    text = file.read_text()
    index = text.rfind(marker)
    if index < 0:
        raise SystemExit(f"{path}: final marker not found: {marker!r}")
    if insertion.strip() in text:
        raise SystemExit(f"{path}: insertion already present")
    file.write_text(text[:index] + insertion + text[index:])


WORKER_SOURCE = "apps/worker/src/compilation-stage.ts"
WORKER_TEST = "apps/worker/test/knowledge-profile-compilation.test.ts"
POSTGRES_TEST = "packages/postgres/test/knowledge-profile-activation.integration.test.ts"

replace_once(
    WORKER_SOURCE,
    "function evidenceTrustFromStatus(\n",
    '''function assertCompilerProfileBindingUnchanged(\n  before: CompilerKnowledgeProfileContext,\n  after: CompilerKnowledgeProfileContext,\n): void {\n  if (\n    before.source !== after.source ||\n    before.revisionId !== after.revisionId ||\n    before.profileHash !== after.profileHash\n  ) {\n    throw new Error("CONTEXT_REVISION_CHANGED");\n  }\n}\n\nfunction evidenceTrustFromStatus(\n''',
)

replace_once(
    WORKER_SOURCE,
    '''  );\n  return {\n    plan: await validateCompilationPlan(compiled.plan, "GENERATIVE"),''',
    '''  );\n  const currentVault = await loadVaultContext(db, input.spaceId, vaultId);\n  assertCompilerProfileBindingUnchanged(\n    vault.knowledgeProfile,\n    currentVault.knowledgeProfile,\n  );\n  return {\n    plan: await validateCompilationPlan(compiled.plan, "GENERATIVE"),''',
)

replace_once(
    WORKER_TEST,
    'const PROFILE_REVISION_ID = "77777777-7777-4777-8777-777777777777";\n',
    'const PROFILE_REVISION_ID = "77777777-7777-4777-8777-777777777777";\nconst SECOND_PROFILE_REVISION_ID = "88888888-8888-4888-8888-888888888888";\n',
)

old_db_helper = '''function dbWithNeutralProfile() {\n  const canonicalProfile = canonicalKnowledgeProfileJson(\n    NEUTRAL_KNOWLEDGE_PROFILE_V1,\n  );\n  const query = vi\n    .fn()\n    .mockResolvedValueOnce({\n      rows: [\n        {\n          schema_profile: {},\n          current_revision: "managed:neutral-1",\n          active_profile_revision_id: PROFILE_REVISION_ID,\n          profile_revision_id: PROFILE_REVISION_ID,\n          profile_hash: knowledgeProfileHash(NEUTRAL_KNOWLEDGE_PROFILE_V1),\n          canonical_profile: canonicalProfile,\n        },\n      ],\n    })\n    .mockResolvedValueOnce({\n      rows: [\n        {\n          id: EVIDENCE_ID,\n          locator: locator(),\n          content_hash: EXCERPT_HASH,\n          excerpt: EXCERPT,\n        },\n      ],\n    })\n    .mockResolvedValueOnce({ rows: [] });\n  return {\n    db: { pool: { query } } as unknown as Postgres,\n    query,\n  };\n}\n'''

new_db_helper = '''function neutralProfileRow(revisionId = PROFILE_REVISION_ID) {\n  return {\n    schema_profile: {},\n    current_revision: "managed:neutral-1",\n    active_profile_revision_id: revisionId,\n    profile_revision_id: revisionId,\n    profile_hash: knowledgeProfileHash(NEUTRAL_KNOWLEDGE_PROFILE_V1),\n    canonical_profile: canonicalKnowledgeProfileJson(NEUTRAL_KNOWLEDGE_PROFILE_V1),\n  };\n}\n\nfunction dbWithNeutralProfile(\n  postCompileRevisionId = PROFILE_REVISION_ID,\n) {\n  const query = vi\n    .fn()\n    .mockResolvedValueOnce({ rows: [neutralProfileRow()] })\n    .mockResolvedValueOnce({\n      rows: [\n        {\n          id: EVIDENCE_ID,\n          locator: locator(),\n          content_hash: EXCERPT_HASH,\n          excerpt: EXCERPT,\n        },\n      ],\n    })\n    .mockResolvedValueOnce({ rows: [] })\n    .mockResolvedValueOnce({ rows: [neutralProfileRow(postCompileRevisionId)] });\n  return {\n    db: { pool: { query } } as unknown as Postgres,\n    query,\n  };\n}\n'''
replace_once(WORKER_TEST, old_db_helper, new_db_helper)

replace_once(
    WORKER_TEST,
    'function configuredCompiler(kind: "note" | "rule") {\n',
    'function configuredCompiler(\n  kind: "note" | "rule",\n  beforeReturn?: () => Promise<void> | void,\n) {\n',
)
replace_once(
    WORKER_TEST,
    '  const compile = vi.fn(async () => ({\n',
    '  const compile = vi.fn(async () => {\n    await beforeReturn?.();\n    return {\n',
)
replace_once(
    WORKER_TEST,
    '    summary: "One grounded proposal for review.",\n  }));\n  return {\n',
    '    summary: "One grounded proposal for review.",\n    };\n  });\n  return {\n',
)

worker_race_test = '''\n\n  it("rejects a compilation when the active profile revision changes while the provider is in flight", async () => {\n    const { db, query } = dbWithNeutralProfile(SECOND_PROFILE_REVISION_ID);\n    let signalProviderEntered!: () => void;\n    let releaseProvider!: () => void;\n    const providerEntered = new Promise<void>((resolve) => {\n      signalProviderEntered = resolve;\n    });\n    const providerRelease = new Promise<void>((resolve) => {\n      releaseProvider = resolve;\n    });\n    const { configured, compile } = configuredCompiler("note", async () => {\n      signalProviderEntered();\n      await providerRelease;\n    });\n\n    const pending = buildCompilationStage(db, stageInput(), configured);\n    await providerEntered;\n    releaseProvider();\n\n    await expect(pending).rejects.toThrow("CONTEXT_REVISION_CHANGED");\n    expect(compile).toHaveBeenCalledOnce();\n    expect(query).toHaveBeenCalledTimes(4);\n  });\n'''
insert_before_last(WORKER_TEST, "\n});\n", worker_race_test)

postgres_race_test = '''\n\n  it.skipIf(!databaseUrl)(\n    "serializes concurrent successor activation without split brain",\n    async () => {\n      if (!databaseUrl) return;\n      const db = new Postgres(databaseUrl);\n      const vaultId = await createVault(db);\n      try {\n        const baseline = await draftAndValidate(\n          db,\n          vaultId,\n          DEFAULT_KNOWLEDGE_PROFILE_V1,\n          "NON_BREAKING",\n        );\n        await activateKnowledgeProfile(db, {\n          spaceId,\n          vaultId,\n          revisionId: baseline.draft.id,\n          dryRunId: baseline.dryRunId,\n          expectedProfileHash: baseline.material.profileHash,\n          expectedCorpusRevision: "activation-r1",\n          actorId,\n          traceId: "activation-concurrent-baseline",\n        });\n\n        const successorA = await draftAndValidate(\n          db,\n          vaultId,\n          {\n            ...DEFAULT_KNOWLEDGE_PROFILE_V1,\n            version: "0.4-concurrent-a",\n            displayName: "AKP v0.4 concurrent successor A",\n          },\n          "NON_BREAKING",\n          baseline.draft.id,\n        );\n        const successorB = await draftAndValidate(\n          db,\n          vaultId,\n          {\n            ...DEFAULT_KNOWLEDGE_PROFILE_V1,\n            version: "0.4-concurrent-b",\n            displayName: "AKP v0.4 concurrent successor B",\n          },\n          "NON_BREAKING",\n          baseline.draft.id,\n        );\n\n        const attempts = await Promise.allSettled([\n          activateKnowledgeProfile(db, {\n            spaceId,\n            vaultId,\n            revisionId: successorA.draft.id,\n            dryRunId: successorA.dryRunId,\n            expectedProfileHash: successorA.material.profileHash,\n            expectedCorpusRevision: "activation-r1",\n            actorId,\n            traceId: "activation-concurrent-a",\n          }),\n          activateKnowledgeProfile(db, {\n            spaceId,\n            vaultId,\n            revisionId: successorB.draft.id,\n            dryRunId: successorB.dryRunId,\n            expectedProfileHash: successorB.material.profileHash,\n            expectedCorpusRevision: "activation-r1",\n            actorId,\n            traceId: "activation-concurrent-b",\n          }),\n        ]);\n        const fulfilled = attempts.filter(\n          (attempt): attempt is PromiseFulfilledResult<\n            Awaited<ReturnType<typeof activateKnowledgeProfile>>\n          > => attempt.status === "fulfilled",\n        );\n        const rejected = attempts.filter(\n          (attempt): attempt is PromiseRejectedResult =>\n            attempt.status === "rejected",\n        );\n        expect(fulfilled).toHaveLength(1);\n        expect(rejected).toHaveLength(1);\n\n        const winnerId = fulfilled[0]!.value.revision.id;\n        const loserId =\n          winnerId === successorA.draft.id\n            ? successorB.draft.id\n            : successorA.draft.id;\n        const binding = await db.pool.query<{\n          active_knowledge_profile_revision_id: string | null;\n        }>(\n          "select active_knowledge_profile_revision_id from vaults where id=$1",\n          [vaultId],\n        );\n        expect(binding.rows[0]?.active_knowledge_profile_revision_id).toBe(\n          winnerId,\n        );\n\n        const statuses = await db.pool.query<{ id: string; status: string }>(\n          `\n          select id,status from knowledge_profile_revisions\n           where id = any($1::uuid[])\n          `,\n          [[baseline.draft.id, successorA.draft.id, successorB.draft.id]],\n        );\n        const statusById = new Map(\n          statuses.rows.map((row) => [row.id, row.status]),\n        );\n        expect(statusById.get(baseline.draft.id)).toBe("SUPERSEDED");\n        expect(statusById.get(winnerId)).toBe("ACTIVE");\n        expect(statusById.get(loserId)).toBe("VALIDATED");\n        expect(\n          [successorA.draft.id, successorB.draft.id].filter(\n            (id) => statusById.get(id) === "ACTIVE",\n          ),\n        ).toHaveLength(1);\n\n        const auditCount = await db.pool.query<{ count: string }>(\n          `\n          select count(*)::text count from audit_events\n           where vault_id=$1 and action='schema.profile_activate'\n          `,\n          [vaultId],\n        );\n        expect(Number(auditCount.rows[0]?.count ?? 0)).toBe(2);\n      } finally {\n        await db.pool.query(\n          "update vaults set active_knowledge_profile_revision_id=null where id=$1",\n          [vaultId],\n        );\n        await db.pool.query("delete from audit_events where vault_id=$1", [\n          vaultId,\n        ]);\n        await db.pool.query("delete from schema_dry_runs where vault_id=$1", [\n          vaultId,\n        ]);\n        await db.pool.query("delete from vaults where id=$1", [vaultId]);\n        await db.close();\n      }\n    },\n  );\n'''
insert_before_last(POSTGRES_TEST, "\n});\n", postgres_race_test)
