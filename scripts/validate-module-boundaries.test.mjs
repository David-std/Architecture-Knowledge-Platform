import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readRepositoryManifests,
  validateModuleGraph,
} from "./validate-module-boundaries.mjs";

const mod = (name, location, dependencies = {}) => ({
  name,
  location,
  dependencies,
  devDependencies: {},
  optionalDependencies: {},
});

test("current repository respects declared module boundaries", () => {
  const result = validateModuleGraph(readRepositoryManifests());
  assert.deepEqual(result.errors, []);
  assert.ok(result.moduleCount >= 20);
});

test("prevents infra imports from pure domain, retrieval and application", () => {
  const input = [
    mod("@akp/domain", "packages/domain", { "@akp/postgres": "*" }),
    mod("@akp/postgres", "packages/postgres"),
  ];
  assert.ok(
    validateModuleGraph(input).errors.includes(
      "CORE_BOUNDARY_VIOLATION:@akp/domain:@akp/postgres",
    ),
  );
});

test("prevents package imports of application containers", () => {
  const result = validateModuleGraph([
    mod("@akp/worker", "apps/worker"),
    mod("@akp/object-store", "packages/object-store", { "@akp/worker": "*" }),
  ]);
  assert.ok(
    result.errors.includes("LIBRARY_IMPORTS_APP:@akp/object-store:@akp/worker"),
  );
});

test("rejects missing internal targets and cycles", () => {
  const result = validateModuleGraph([
    mod("@akp/audit-export", "packages/audit-export", {
      "@akp/indexing": "*",
      "@akp/missing": "*",
    }),
    mod("@akp/indexing", "packages/indexing", { "@akp/audit-export": "*" }),
  ]);
  assert.ok(
    result.errors.some((x) => x.startsWith("MODULE_DEPENDENCY_CYCLE:")),
  );
  assert.ok(
    result.errors.includes(
      "MODULE_DEPENDENCY_NOT_FOUND:@akp/audit-export:@akp/missing",
    ),
  );
});

test("allows deliberate acyclic pure dependencies", () => {
  const result = validateModuleGraph([
    mod("@akp/contracts", "packages/contracts"),
    mod("@akp/domain", "packages/domain"),
    mod("@akp/application", "packages/application", {
      "@akp/contracts": "*",
      "@akp/domain": "*",
    }),
  ]);
  assert.deepEqual(result.errors, []);
});
