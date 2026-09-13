import { readFile, writeFile } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`P8 delete materializer anchor missing: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`P8 delete materializer anchor ambiguous: ${label}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

const indexingPath = "packages/indexing/src/index.ts";
let indexing = await readFile(indexingPath, "utf8");
indexing = replaceOnce(
  indexing,
  `export interface ManagedChange {\n  path: string;\n  operation?: "CREATE" | "UPDATE";\n}`,
  `export interface ManagedChange {\n  path: string;\n  operation?: "CREATE" | "UPDATE" | "DELETE";\n}`,
  "managed change delete contract",
);
indexing = replaceOnce(
  indexing,
  `      const managedPath = normalizeManagedPath(change.path);\n      const raw = await readManagedFile(store, options.revision, managedPath);`,
  `      const managedPath = normalizeManagedPath(change.path);\n      // A durable tombstone is authoritative. Do not rehydrate a deleted\n      // path merely because a physical compatibility layout still exposes\n      // bytes at the same name. CREATE/UPDATE continue to derive state from\n      // the canonical Git revision.\n      const raw =\n        change.operation === "DELETE"\n          ? null\n          : await readManagedFile(store, options.revision, managedPath);`,
  "force explicit delete tombstone",
);
await writeFile(indexingPath, indexing, "utf8");

const handlersPath = "apps/worker/src/event-handlers.ts";
let handlers = await readFile(handlersPath, "utf8");
handlers = replaceOnce(
  handlers,
  `    fallbackOperation?: "CREATE" | "UPDATE",`,
  `    fallbackOperation?: ManagedChange["operation"],`,
  "managed change operation type",
);
handlers = replaceOnce(
  handlers,
  `        // Publication payloads carry changedPaths and tombstones separately.\n        // A deleted path may therefore appear twice; retain the stronger\n        // UPDATE operation so downstream documents are invalidated rather\n        // than silently treated as an operation-less upsert.\n        if (fallbackOperation === "UPDATE") {\n          changes[existing] = {\n            path: normalized,\n            operation: fallbackOperation,\n          };\n        }`,
  `        // Publication payloads carry changedPaths and tombstones separately.\n        // A deleted path may therefore appear twice; DELETE is authoritative\n        // and must never be weakened back into an upsert. UPDATE remains\n        // stronger than an operation-less changed path.\n        const currentOperation = changes[existing]?.operation;\n        if (\n          fallbackOperation === "DELETE" ||\n          (fallbackOperation === "UPDATE" && currentOperation !== "DELETE")\n        ) {\n          changes[existing] = {\n            path: normalized,\n            operation: fallbackOperation,\n          };\n        }`,
  "tombstone duplicate precedence",
);
handlers = replaceOnce(
  handlers,
  `      candidate.operation === "CREATE" || candidate.operation === "UPDATE"\n        ? candidate.operation\n        : fallbackOperation;`,
  `      candidate.operation === "CREATE" ||\n      candidate.operation === "UPDATE" ||\n      candidate.operation === "DELETE"\n        ? candidate.operation\n        : fallbackOperation;`,
  "parse delete operation",
);
handlers = replaceOnce(
  handlers,
  `    if (existing !== undefined) {\n      if (operation === "UPDATE") {\n        changes[existing] = { path: normalized, operation };\n      }\n      return;\n    }`,
  `    if (existing !== undefined) {\n      const currentOperation = changes[existing]?.operation;\n      if (\n        operation === "DELETE" ||\n        (operation === "UPDATE" && currentOperation !== "DELETE")\n      ) {\n        changes[existing] = { path: normalized, operation };\n      }\n      return;\n    }`,
  "object delete precedence",
);
handlers = replaceOnce(
  handlers,
  `      addChange(tombstone, "UPDATE");`,
  `      addChange(tombstone, "DELETE");`,
  "map tombstone to delete",
);
await writeFile(handlersPath, handlers, "utf8");

const handlersTestPath = "apps/worker/test/event-handlers.test.ts";
let handlersTest = await readFile(handlersTestPath, "utf8");
handlersTest = replaceOnce(
  handlersTest,
  `    ).toEqual([{ path: "removed.md", operation: "UPDATE" }]);`,
  `    ).toEqual([{ path: "removed.md", operation: "DELETE" }]);`,
  "expect explicit delete tombstone",
);
await writeFile(handlersTestPath, handlersTest, "utf8");

console.log("P8 explicit delete/tombstone semantics materialized");
