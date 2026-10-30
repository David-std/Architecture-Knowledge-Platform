/**
 * Authorized OFFLINE S2 audit. Both inputs stay local; output contains no
 * query, vault, excerpt, quote or source bytes. This is not a gold scorer.
 *
 * pnpm exec tsx scripts/s2-rebind-admission-shadow.ts \
 *   --observations /secure/s2-admissions.json \
 *   --sources /secure/s2-authorized-source-snapshot.json \
 *   --output /secure/s2-rebound-report.json
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  rebindS2AdmissionToSource,
  type S2AuthorizedSourceSnapshot,
} from "../apps/api/src/s2-source-rebind.js";
import type { S2AdmissionShadowObservation } from "../apps/api/src/s2-admission-shadow.js";

interface AdmissionRun {
  schemaVersion: "akp.s2.observed-admission-run.v1";
  runId: string;
  executedCommitSha: string;
  observations: S2AdmissionShadowObservation[];
}

interface AuthorizedSnapshotBatch {
  schemaVersion: "akp.s2.authorized-snapshot-batch.v1";
  runId: string;
  /** Must be externally pinned and audited, NOT manufactured by this script. */
  frozenSourceManifestSha256: string;
  snapshots: S2AuthorizedSourceSnapshot[];
}

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`S2_REBIND_MISSING_${name.slice(2).toUpperCase()}`);
  return value;
}

const sha256 = (raw: Buffer): string =>
  createHash("sha256").update(raw).digest("hex");
const observationBytes = await readFile(path.resolve(flag("--observations")));
const sourceBytes = await readFile(path.resolve(flag("--sources")));
const target = path.resolve(flag("--output"));
const run = JSON.parse(observationBytes.toString("utf8")) as AdmissionRun;
const sources = JSON.parse(
  sourceBytes.toString("utf8"),
) as AuthorizedSnapshotBatch;
if (
  run.schemaVersion !== "akp.s2.observed-admission-run.v1" ||
  sources.schemaVersion !== "akp.s2.authorized-snapshot-batch.v1" ||
  !/^[A-Za-z0-9_-]{8,100}$/u.test(run.runId ?? "") ||
  run.runId !== sources.runId ||
  !/^[a-f0-9]{40}$/u.test(run.executedCommitSha ?? "") ||
  !/^[a-f0-9]{64}$/u.test(sources.frozenSourceManifestSha256 ?? "") ||
  !Array.isArray(run.observations) ||
  run.observations.length === 0 ||
  !Array.isArray(sources.snapshots)
) {
  throw new Error("S2_REBIND_BATCH_PROVENANCE_OR_SCHEMA_INVALID");
}

// Snapshot identity is a query+scope pair. A search/context observation may
// share the same snapshot, but ambiguous or unreferenced snapshots are errors.
const snapshotIdentity = (querySha256: string, scopeSha256: string) =>
  `${querySha256}:${scopeSha256}`;
const hashedQuery = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const byIdentity = new Map<string, S2AuthorizedSourceSnapshot>();
for (const snapshot of sources.snapshots) {
  const key = snapshotIdentity(
    hashedQuery(snapshot.query),
    hashedQuery([...snapshot.authorizedVaultIds].sort().join("\0")),
  );
  if (byIdentity.has(key)) throw new Error("S2_REBIND_DUPLICATE_SNAPSHOT");
  byIdentity.set(key, snapshot);
}
const used = new Set<string>();
const results = run.observations.map((observation) => {
  const key = snapshotIdentity(
    observation.querySha256,
    observation.scopeSha256,
  );
  const snapshot = byIdentity.get(key);
  if (!snapshot) throw new Error("S2_REBIND_MISSING_AUTHORIZED_SNAPSHOT");
  used.add(key);
  return rebindS2AdmissionToSource(observation, snapshot);
});
if (used.size !== byIdentity.size)
  throw new Error("S2_REBIND_UNUSED_AUTHORIZED_SNAPSHOT");
const output = {
  schemaVersion: "akp.s2.rebound-admission-report.v1",
  status: "SOURCE_BYTES_CHECKED_SEMANTIC_SUFFICIENCY_NOT_MEASURED",
  runId: run.runId,
  executedCommitSha: run.executedCommitSha,
  frozenSourceManifestSha256: sources.frozenSourceManifestSha256,
  observationFileSha256: sha256(observationBytes),
  sourceSnapshotFileSha256: sha256(sourceBytes),
  observationCount: results.length,
  admittedCount: results.reduce((sum, item) => sum + item.admittedCount, 0),
  sourceReboundSpanCount: results.reduce(
    (sum, item) => sum + item.admittedWithSourceReboundSpan,
    0,
  ),
  admittedWithoutSourceReboundSpan: results.reduce(
    (sum, item) => sum + item.admittedWithoutSourceReboundSpan,
    0,
  ),
  observations: results,
  sourceProvenanceExternallyVerified: false,
  goldLabelsUsed: false,
  semanticPrecisionMeasured: false,
  falseAdmissionRate: null,
  finalAnswersMeasured: false,
  fullRequestP95Ms: null,
  gateAccepted: false,
};
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(output, null, 2) + "\n", "utf8");
process.stdout.write(
  JSON.stringify({
    report: target,
    observations: output.observationCount,
    admitted: output.admittedCount,
    sourceReboundSpans: output.sourceReboundSpanCount,
    gateAccepted: false,
  }) + "\n",
);
