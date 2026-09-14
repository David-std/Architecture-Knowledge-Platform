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
await writeFile(file, source, "utf8");

const testFile = "apps/api/test/review-publication.integration.test.ts";
let test = await readFile(testFile, "utf8");
test = replaceOnce(
  test,
  `    expect(failed.statusCode).toBe(500);\n    expect(failed.json()).toMatchObject({ code: "PUBLICATION_FAILED" });`,
  `    console.error("P8_RECOVERY_DIAG_DB_FAILURE", failed.body);\n    expect(failed.statusCode).toBe(500);\n    expect(failed.json()).toMatchObject({ code: "PUBLICATION_FAILED" });`,
  "db failure response diagnostics",
);
test = replaceOnce(
  test,
  `    expect(response.statusCode).toBe(409);\n    expect(response.json()).toMatchObject({ code: "PUBLICATION_CONFLICT" });`,
  `    console.error("P8_RECOVERY_DIAG_MAIN_MOVED", response.body);\n    expect(response.statusCode).toBe(409);\n    expect(response.json()).toMatchObject({ code: "PUBLICATION_CONFLICT" });`,
  "main moved response diagnostics",
);
test = replaceOnce(
  test,
  `      expect(response.statusCode).toBe(409);\n      expect(response.json()).toEqual({ code: "PUBLICATION_CONFLICT" });`,
  `      console.error("P8_RECOVERY_DIAG_DRAFT_MOVED", response.body);\n      expect(response.statusCode).toBe(409);\n      expect(response.json()).toEqual({ code: "PUBLICATION_CONFLICT" });`,
  "draft moved response diagnostics",
);
await writeFile(testFile, test, "utf8");
console.log("P8.3 publication recovery compile fix and diagnostics applied");
