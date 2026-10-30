import { readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const source = "policies/s2-technique-disposition.json";
const allowed = new Set([
  "RUNTIME_DEFAULT",
  "RUNTIME_OPT_IN",
  "SHADOW_ONLY",
  "EVALUATION_ONLY",
  "REJECTED",
  "REQUIRES_CUTOVER",
  "UNIMPLEMENTED_GATE",
]);
const read = (p) => readFileSync(resolve(root, p), "utf8");
const lookup = (p) => {
  if (
    !/^(apps|packages|docs|scripts|db|policies)\/[a-z0-9_./-]+$/u.test(p) ||
    p.split("/").includes("..") ||
    p.includes("//")
  )
    throw new Error("UNSAFE_INVENTORY_PATH:" + p);
  const path = resolve(root, p);
  if (
    !path.startsWith(root + sep) ||
    !existsSync(path) ||
    !lstatSync(path).isFile()
  )
    throw new Error("S2_INVENTORY_FILE_MISSING:" + p);
  return path;
};
const entries = (config) => [
  ...config.techniques.flatMap((t) =>
    t.files.map((path) => ({
      path,
      section: t.sourceSection,
      disposition: t.disposition,
      id: t.id,
    })),
  ),
  ...config.supplementalModules.map((t) => ({
    path: t.path,
    section: t.sourceSection,
    disposition: t.disposition,
    id: t.path,
  })),
];
const normalized = (p) => p.split(sep).join("/");
const scan = (conf) => {
  const errors = [];
  const fail = (e) => errors.push(e);
  if (
    conf.schemaVersion !== "akp.s2.technique-disposition.v1" ||
    conf.gateStatus !== "OPEN" ||
    !Array.isArray(conf.techniques) ||
    !Array.isArray(conf.supplementalModules)
  )
    fail("INVALID_S2_INVENTORY_SCHEMA_OR_GATE");
  if (errors.length) return { status: "FAILED", errors };
  const ledger = read(conf.sourceLedger);
  const records = entries(conf);
  const tracked = new Set();
  const ids = new Set();
  for (const t of conf.techniques) {
    if (ids.has(t.id)) fail("DUPLICATE_S2_TECHNIQUE:" + t.id);
    ids.add(t.id);
    if (!allowed.has(t.disposition)) fail("INVALID_S2_DISPOSITION:" + t.id);
    if (!t.decision || t.decision.length < 24)
      fail("UNEXPLAINED_S2_DISPOSITION:" + t.id);
    if (
      !Number.isInteger(t.sourceSection) ||
      !new RegExp("^## " + t.sourceSection + "\\. ", "mu").test(ledger)
    )
      fail("MISSING_LEDGER_SECTION:" + t.id + ":" + t.sourceSection);
    if (
      (t.disposition === "REJECTED" ||
        t.disposition === "UNIMPLEMENTED_GATE") &&
      !t.decision
    )
      fail("NONRELEASE_WITHOUT_REASON:" + t.id);
    if (t.flag) {
      const config =
        read("apps/api/src/runtime-config.ts") + read("apps/api/src/server.ts");
      if (!config.includes(t.flag))
        fail("UNWIRED_RUNTIME_FLAG:" + t.id + ":" + t.flag);
    }
  }
  for (const t of conf.supplementalModules) {
    if (!allowed.has(t.disposition))
      fail("INVALID_SUPPLEMENT_DISPOSITION:" + t.path);
    if (!t.decision || t.decision.length < 24)
      fail("UNEXPLAINED_SUPPLEMENT:" + t.path);
    if (
      !Number.isInteger(t.sourceSection) ||
      !new RegExp("^## " + t.sourceSection + "\\. ", "mu").test(ledger)
    )
      fail("MISSING_SUPPLEMENT_LEDGER_SECTION:" + t.path);
  }
  for (const t of records) {
    try {
      lookup(t.path);
    } catch (e) {
      fail(e.message);
    }
    tracked.add(t.path);
  }
  // Every registered S2 production/evaluation module requires explicit
  // disposition, not just an export, filename or unreviewed experimental tag.
  const scanDirs = [
    "apps/api/src",
    "packages/retrieval/src",
    "packages/evaluation/src",
    "scripts",
  ];
  const unclassified = [];
  for (const dir of scanDirs) {
    for (const file of readdirSync(resolve(root, dir))) {
      if (!/^s2-[a-z0-9-]+\.(?:ts|mjs)$/u.test(file)) continue;
      const path = dir + "/" + file;
      if (!tracked.has(path)) unclassified.push(path);
    }
  }
  if (unclassified.length)
    fail("UNCLASSIFIED_S2_MODULES:" + unclassified.join(","));
  // Experimental wiring is NOT release acceptance; a verified disposition
  // manifest can never silently promote S2.
  const counts = {};
  for (const t of conf.techniques)
    counts[t.disposition] = (counts[t.disposition] ?? 0) + 1;
  const supplementCounts = {};
  for (const t of conf.supplementalModules)
    supplementCounts[t.disposition] =
      (supplementCounts[t.disposition] ?? 0) + 1;
  return {
    schemaVersion: "akp.s2.technique-disposition-audit.v1",
    status: errors.length ? "FAILED" : "INVENTORIED_NOT_SEMANTICALLY_ACCEPTED",
    techniqueCount: conf.techniques.length,
    supplementalModuleCount: conf.supplementalModules.length,
    registeredFileCount: tracked.size,
    s2ModuleCount: scanDirs.reduce(
      (n, dir) =>
        n +
        readdirSync(resolve(root, dir)).filter((file) =>
          /^s2-[a-z0-9-]+\.(?:ts|mjs)$/u.test(file),
        ).length,
      0,
    ),
    dispositions: counts,
    supplementalDispositions: supplementCounts,
    unclassifiedModules: unclassified,
    independentSemanticGoldVerified: false,
    fullyIntegratedWriterRuntimeProven: false,
    gateAccepted: false,
    errors,
  };
};
const config = JSON.parse(read(source));
const actual = scan(config);
if (process.argv.includes("--self-test")) {
  const assert = (condition, msg) => {
    if (!condition) throw new Error(msg);
  };
  assert(actual.errors.length === 0, "BASELINE_S2_INVENTORY_INVALID");
  const badDuplicate = structuredClone(config);
  badDuplicate.techniques.push(structuredClone(badDuplicate.techniques[0]));
  assert(
    scan(badDuplicate).errors.some((x) => x.startsWith("DUPLICATE_")),
    "NO_DUPLICATE_GUARD",
  );
  const badPath = structuredClone(config);
  badPath.supplementalModules[0].path =
    "packages/evaluation/src/nonexistent.ts";
  assert(
    scan(badPath).errors.some((x) => x.startsWith("S2_INVENTORY_FILE_MISSING")),
    "NO_MISSING_PATH_GUARD",
  );
  const missingRegistry = structuredClone(config);
  missingRegistry.supplementalModules = [];
  assert(
    scan(missingRegistry).errors.some((x) => x.startsWith("UNCLASSIFIED_")),
    "NO_UNCLASSIFIED_S2_MODULE_GUARD",
  );
  const badFlag = structuredClone(config);
  badFlag.techniques[0].flag = "AKP_S2_NONEXISTENT_PROMOTION";
  assert(
    scan(badFlag).errors.some((x) => x.startsWith("UNWIRED_RUNTIME_FLAG")),
    "NO_UNWIRED_FLAG_GUARD",
  );
}
process.stdout.write(
  JSON.stringify(
    { ...actual, selfTest: process.argv.includes("--self-test") },
    null,
    2,
  ) + "\n",
);
if (actual.errors.length) process.exitCode = 1;
