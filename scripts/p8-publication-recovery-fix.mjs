import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`P8.3 fix anchor missing: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`P8.3 fix anchor ambiguous: ${label}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

const file = "apps/api/src/routes/reviews.ts";
let source = await readFile(file, "utf8");
source = replaceOnce(
  source,
  `import {\n  assertManagedRepositoryBoundary,\n  repositoryPublicationKey,\n} from "../projections.js";`,
  `import {\n  assertManagedRepositoryBoundary,\n  repositoryPublicationKey,\n  synchronizeManagedPaths,\n  type ManagedChange,\n} from "../projections.js";`,
  "restore rollback projection imports",
);
source = replaceOnce(
  source,
  `type AppendTarget = Parameters<AppendHelper>[0];\n`,
  `type AppendTarget = Parameters<AppendHelper>[0];\ntype PublicationClient = Exclude<AppendTarget, Postgres>;\n`,
  "transaction client type",
);
source = replaceOnce(
  source,
  `interface PublicationLifecycle {`,
  `/** Reconcile changed Git paths only for rollback compensation. Publication\n * success and crash recovery use the durable outbox instead. */\nasync function indexMergedChanges(\n  db: Postgres,\n  review: Record<string, unknown>,\n  revision: string,\n): Promise<void> {\n  const manifest = review.impact_manifest as {\n    sourceId?: string;\n    proposedChanges?: Array<{ path: string; operation?: "CREATE" | "UPDATE" }>;\n  };\n  const changes: ManagedChange[] = (manifest.proposedChanges ?? []).map(\n    (change) => ({\n      path: change.path,\n      ...(change.operation ? { operation: change.operation } : {}),\n    }),\n  );\n  const vaultId = String(review.vault_id ?? "");\n  if (!vaultId) throw new Error("REVIEW_VAULT_SCOPE_REQUIRED");\n  const store = new GitKnowledgeStore(repositoryPath());\n  await synchronizeManagedPaths(db, store, {\n    spaceId: String(review.space_id),\n    vaultId,\n    revision,\n    changes,\n    ...(typeof manifest.sourceId === "string"\n      ? { sourceId: manifest.sourceId }\n      : {}),\n  });\n}\n\ninterface PublicationLifecycle {`,
  "restore rollback compensation helper",
);
source = replaceOnce(
  source,
  `async function finalizePublicationTransaction(\n  client: AppendTarget,`,
  `async function finalizePublicationTransaction(\n  client: PublicationClient,`,
  "narrow publication client",
);
source = replaceOnce(
  source,
  `          const recoveryStatus = compensationSucceeded\n            ? "CHANGES_REQUESTED"\n            : "PUBLICATION_RECOVERY_REQUIRED";\n          await db.pool.query(\n            \`\n            update reviews\n               set status=$2,\n                   merged_commit=case when $2='CHANGES_REQUESTED' then null else merged_commit end,\n                   base_commit=case\n                     when $2='CHANGES_REQUESTED' and $4 is not null then $4\n                     else base_commit\n                   end,\n                   decision_by=case when $2='CHANGES_REQUESTED' then null else decision_by end,\n                   decision_at=case when $2='CHANGES_REQUESTED' then null else decision_at end,\n                   decision_reason=$3,updated_at=now()\n             where id=$1 and status='PUBLISHING'\n            \`,\n            [\n              request.params.id,\n              recoveryStatus,\n              "Publication failed; inspect the Error Book before retrying.",\n              compensatingRevision,\n            ],\n          );`,
  `          if (compensationSucceeded) {\n            await db.pool.query(\n              \`\n              update reviews\n                 set status='CHANGES_REQUESTED',merged_commit=null,\n                     base_commit=coalesce($2,base_commit),\n                     decision_by=null,decision_at=null,\n                     decision_reason=$3,updated_at=now()\n               where id=$1 and status='PUBLISHING'\n              \`,\n              [\n                request.params.id,\n                compensatingRevision,\n                "Publication failed safely; retry from the compensated Git revision.",\n              ],\n            );\n          } else {\n            await db.pool.query(\n              \`\n              update reviews\n                 set status='PUBLICATION_RECOVERY_REQUIRED',\n                     decision_reason=$2,updated_at=now()\n               where id=$1 and status='PUBLISHING'\n              \`,\n              [\n                request.params.id,\n                "Publication state is ambiguous; manual reconciliation is required.",\n              ],\n            );\n          }`,
  "explicit publication recovery transition",
);
await writeFile(file, source, "utf8");
console.log("P8.3 publication recovery fixes applied");
