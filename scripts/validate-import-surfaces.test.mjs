import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moduleSpecifierReferences,
  validateImportSurfaces,
  readImportSurfaces,
} from "./validate-import-surfaces.mjs";

const modules = [
  { name: "@akp/retrieval", exports: { ".": "./dist/index.js" } },
  {
    name: "@akp/contracts",
    exports: {
      ".": "./dist/index.js",
      "./knowledge-profile": "./dist/knowledge-profile.js",
    },
  },
];

test("real project exposes no undeclared deep or cross-package production imports", () => {
  const result = readImportSurfaces();
  assert.deepEqual(result.errors, []);
  assert.ok(result.fileCount > 100);
});

test("TypeScript parser sees exports and dynamic imports without scanning comments", () => {
  const references = moduleSpecifierReferences(
    "packages/retrieval/src/feature.ts",
    [
      '// import x from "@akp/contracts/bad";',
      'export { thing } from "@akp/contracts/knowledge-profile";',
      'const run = () => import("@akp/retrieval/internal");',
      'const value = require("./ok.js");',
    ].join("\n"),
  );
  assert.deepEqual(
    references.map((r) => r.specifier),
    ["@akp/contracts/knowledge-profile", "@akp/retrieval/internal", "./ok.js"],
  );
});

test("rejects subpath not explicitly exported by target package", () => {
  const errors = validateImportSurfaces(
    [
      {
        file: "apps/api/src/search.ts",
        line: 3,
        specifier: "@akp/retrieval/src/rrf",
      },
    ],
    modules,
  );
  assert.deepEqual(errors, [
    "UNDECLARED_PACKAGE_SUBPATH:apps/api/src/search.ts:3:@akp/retrieval/src/rrf",
  ]);
});

test("allows explicitly exported package entry points", () => {
  assert.deepEqual(
    validateImportSurfaces(
      [
        {
          file: "apps/api/src/search.ts",
          line: 1,
          specifier: "@akp/retrieval",
        },
        {
          file: "apps/api/src/search.ts",
          line: 2,
          specifier: "@akp/contracts/knowledge-profile",
        },
      ],
      modules,
    ),
    [],
  );
});

test("rejects relative imports between production modules, not within one module", () => {
  const errors = validateImportSurfaces(
    [
      {
        file: "apps/api/src/feature.ts",
        line: 1,
        specifier: "../../../packages/retrieval/src/rrf.js",
      },
      {
        file: "apps/api/src/feature.ts",
        line: 2,
        specifier: "../routes/search.js",
      },
    ],
    modules,
  );
  assert.deepEqual(errors, [
    "CROSS_PACKAGE_RELATIVE_IMPORT:apps/api/src/feature.ts:1:../../../packages/retrieval/src/rrf.js",
  ]);
});

test("rejects references to undeclared internal packages", () => {
  assert.deepEqual(
    validateImportSurfaces(
      [{ file: "apps/api/src/feature.ts", line: 9, specifier: "@akp/unknown" }],
      modules,
    ),
    ["UNKNOWN_INTERNAL_PACKAGE:apps/api/src/feature.ts:9:@akp/unknown"],
  );
});
