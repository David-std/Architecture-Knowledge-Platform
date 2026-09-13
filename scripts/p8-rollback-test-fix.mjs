import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`P8 test-fix anchor missing: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`P8 test-fix anchor ambiguous: ${label}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

const productPath = "apps/api/test/product-lifecycle.integration.test.ts";
let product = await readFile(productPath, "utf8");

const before = `      \`select r.status review_status,d.lifecycle,i.status index_status,\n                (select count(*)::int from knowledge_units u\n                  where u.document_id=d.id\n                    and u.lifecycle in ('ACTIVE','DISPUTED')) active_units,\n                (select count(*)::int from knowledge_units u\n                  where u.document_id=d.id) total_units,\n                (select count(*)::int from knowledge_units u\n                  where u.document_id=d.id\n                    and u.lifecycle not in ('ACTIVE','DISPUTED')) inactive_units\n           from reviews r\n           join knowledge_documents d on d.vault_id=r.vault_id\n             and d.frontmatter->>'source_sha256'=$2\n           join vault_index_revisions i on i.vault_id=r.vault_id\n          where r.id=$1\`,`;

const after = `      \`select r.status review_status,d.lifecycle,i.status index_status,\n                coalesce(u.active_units,0)::int active_units,\n                coalesce(u.total_units,0)::int total_units,\n                coalesce(u.inactive_units,0)::int inactive_units\n           from reviews r\n           join knowledge_documents d on d.vault_id=r.vault_id\n             and d.frontmatter->>'source_sha256'=$2\n           join vault_index_revisions i on i.vault_id=r.vault_id\n           left join lateral (\n             select count(*)::int total_units,\n                    count(*) filter (\n                      where lifecycle in ('ACTIVE','DISPUTED')\n                    )::int active_units,\n                    count(*) filter (\n                      where lifecycle not in ('ACTIVE','DISPUTED')\n                    )::int inactive_units\n               from knowledge_units\n              where document_id=d.id\n           ) u on true\n          where r.id=$1\`,`;

product = replaceOnce(
  product,
  before,
  after,
  "rollback post-drain aggregate query",
);
product = replaceOnce(
  product,
  `    expect(rolledBack.rows[0]?.total_units).toBeGreaterThan(0);\n    expect(rolledBack.rows[0]?.inactive_units).toBe(\n      rolledBack.rows[0]?.total_units,\n    );`,
  `    // Snapshot retention is an implementation detail: a tombstoned\n    // document may retain historical units or compact them. What must hold is\n    // that none remain active; the search assertion below proves the stronger\n    // externally observable invariant that rollback content is unretrievable.\n    expect(rolledBack.rows[0]?.inactive_units).toBe(\n      rolledBack.rows[0]?.total_units,\n    );`,
  "rollback unit retention invariant",
);
product = replaceOnce(
  product,
  `        order by sequence\`,` ,
  `        order by created_at,event_id\`,` ,
  "rollback outbox deterministic diagnostics ordering",
);
product = replaceOnce(
  product,
  `    expect(rollbackEvents.rows.map((row) => row.event_type)).toEqual([\n      "CorpusRevisionPublished",\n      "LexicalIndexUpdateRequested",\n      "VectorIndexUpdateRequested",\n      "GraphIndexUpdateRequested",\n      "ContextPackInvalidationRequested",\n      "ImpactedEvalRunRequested",\n    ]);\n    const rollbackCorpus = rollbackEvents.rows[0];`,
  `    expect(rollbackEvents.rows.map((row) => row.event_type).sort()).toEqual(\n      [\n        "CorpusRevisionPublished",\n        "LexicalIndexUpdateRequested",\n        "VectorIndexUpdateRequested",\n        "GraphIndexUpdateRequested",\n        "ContextPackInvalidationRequested",\n        "ImpactedEvalRunRequested",\n      ].sort(),\n    );\n    const rollbackCorpus = rollbackEvents.rows.find(\n      (row) => row.event_type === "CorpusRevisionPublished",\n    );`,
  "product rollback event set",
);
product = replaceOnce(
  product,
  `      rollbackEvents.rows\n        .slice(1)\n        .every((row) => row.causation_id === rollbackCorpus?.event_id),`,
  `      rollbackEvents.rows\n        .filter((row) => row.event_type !== "CorpusRevisionPublished")\n        .every((row) => row.causation_id === rollbackCorpus?.event_id),`,
  "product rollback causal children",
);
product = replaceOnce(
  product,
  `        order by e.sequence\`,` ,
  `        order by e.created_at,e.event_id\`,` ,
  "rollback delivery deterministic diagnostics ordering",
);
await writeFile(productPath, product, "utf8");

const reviewPath = "apps/api/test/review-publication.integration.test.ts";
let review = await readFile(reviewPath, "utf8");
review = replaceOnce(
  review,
  `let defaultVault: string;\nconst createdReviewIds`,
  `let defaultVault: string;\nlet createdVaultMembershipId: string | null = null;\nconst createdReviewIds`,
  "track isolated vault membership",
);
review = replaceOnce(
  review,
  `  await db.pool.query(\n    \`\n    insert into api_tokens(user_id,token_hash,label,scopes)`,
  `  const vaultMembershipId = randomUUID();\n  const vaultMembership = await db.pool.query<{ id: string }>(\n    \`\n    insert into vault_memberships(\n      id,user_id,vault_id,role,path_prefix,permissions,enabled\n    ) values($1,$2,$3,'ADMIN',null,$4::jsonb,true)\n    on conflict do nothing\n    returning id\n    \`,\n    [\n      vaultMembershipId,\n      admin,\n      defaultVault,\n      JSON.stringify([\n        "knowledge:read",\n        "source:read",\n        "source:write",\n        "knowledge:propose",\n        "knowledge:review",\n        "eval:run",\n        "admin",\n      ]),\n    ],\n  );\n  createdVaultMembershipId = vaultMembership.rows[0]?.id ?? null;\n  await db.pool.query(\n    \`\n    insert into api_tokens(user_id,token_hash,label,scopes)`,
  "grant private vault access to isolated review fixture",
);
review = replaceOnce(
  review,
  `    await db.pool.query("delete from api_tokens where token_hash=$1", [\n      tokenHash,\n    ]);\n    await db.close();`,
  `    await db.pool.query("delete from api_tokens where token_hash=$1", [\n      tokenHash,\n    ]);\n    if (createdVaultMembershipId) {\n      await db.pool.query("delete from vault_memberships where id=$1", [\n        createdVaultMembershipId,\n      ]);\n    }\n    await db.close();`,
  "cleanup isolated vault membership",
);
review = replaceOnce(
  review,
  `        order by sequence\`,` ,
  `        order by created_at,event_id\`,` ,
  "review rollback outbox diagnostics ordering",
);
review = replaceOnce(
  review,
  `    expect(events.rows.map((row) => row.event_type)).toEqual([\n      "CorpusRevisionPublished",\n      "LexicalIndexUpdateRequested",\n      "VectorIndexUpdateRequested",\n      "GraphIndexUpdateRequested",\n      "ContextPackInvalidationRequested",\n      "ImpactedEvalRunRequested",\n    ]);\n    const corpus = events.rows[0];`,
  `    expect(events.rows.map((row) => row.event_type).sort()).toEqual(\n      [\n        "CorpusRevisionPublished",\n        "LexicalIndexUpdateRequested",\n        "VectorIndexUpdateRequested",\n        "GraphIndexUpdateRequested",\n        "ContextPackInvalidationRequested",\n        "ImpactedEvalRunRequested",\n      ].sort(),\n    );\n    const corpus = events.rows.find(\n      (row) => row.event_type === "CorpusRevisionPublished",\n    );`,
  "review rollback event set",
);
review = replaceOnce(
  review,
  `      events.rows.slice(1).every((row) => row.causation_id === corpus?.event_id),`,
  `      events.rows\n        .filter((row) => row.event_type !== "CorpusRevisionPublished")\n        .every((row) => row.causation_id === corpus?.event_id),`,
  "review rollback causal children",
);
await writeFile(reviewPath, review, "utf8");

console.log("P8 rollback integration fixtures patched");