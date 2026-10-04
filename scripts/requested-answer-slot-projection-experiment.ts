import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { projectRequestedAnswerSlot } from "../packages/retrieval/src/index.js";

interface ExpectedProjection {
  role: "SUBJECT" | "OBJECT" | "RELATION_VALUE" | "LOCATION";
  relationAnchor: string;
  boundArgumentAnchors: string[];
}

interface CaseFixture {
  id: string;
  family: string;
  language: "EN" | "ES";
  query: string;
  expected: ExpectedProjection | null;
}

interface Manifest {
  schemaVersion: string;
  frozen: boolean;
  baselineSha: string;
  splits: {
    development: CaseFixture[];
    heldout: CaseFixture[];
  };
  protocol: {
    developmentFamilies: string[];
    heldoutFamilies: string[];
    familyDisjoint: boolean;
    noTuningAfterHeldout: boolean;
  };
  promotionRule: {
    developmentStrictAccuracy: number;
    heldoutStrictAccuracyAtLeast: number;
    unsupportedFalseProjectionRate: number;
    relationAnchorAccuracyAtLeast: number;
    boundArgumentExactAccuracyAtLeast: number;
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function candidateHeadSha(): Promise<string> {
  const explicit = process.env.AKP_REQUESTED_SLOT_CANDIDATE_SHA?.trim();
  if (explicit) return explicit;
  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (eventPath) {
    const event = JSON.parse(await readFile(eventPath, "utf8")) as {
      pull_request?: { head?: { sha?: unknown } };
    };
    const value = event.pull_request?.head?.sha;
    if (typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)) {
      return value;
    }
  }
  const fallback = process.env.GITHUB_SHA?.trim();
  if (fallback && /^[0-9a-f]{40}$/u.test(fallback)) return fallback;
  throw new Error("Unable to resolve candidate HEAD SHA");
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function evaluateCase(fixture: CaseFixture) {
  const actual = projectRequestedAnswerSlot(fixture.query);
  const expected = fixture.expected;
  const unsupported = expected === null;
  const projected = actual !== null;
  const roleCorrect = expected !== null && actual?.role === expected.role;
  const relationAnchorCorrect =
    expected !== null && actual?.relationAnchor === expected.relationAnchor;
  const boundArgumentsCorrect =
    expected !== null &&
    actual !== null &&
    sameArray(actual.boundArgumentAnchors, expected.boundArgumentAnchors);
  const languageCorrect =
    expected !== null && actual?.language === fixture.language;
  const strictCorrect = unsupported
    ? actual === null
    : Boolean(
        roleCorrect &&
        relationAnchorCorrect &&
        boundArgumentsCorrect &&
        languageCorrect,
      );
  return {
    id: fixture.id,
    family: fixture.family,
    language: fixture.language,
    query: fixture.query,
    expected,
    actual,
    unsupported,
    projected,
    roleCorrect,
    relationAnchorCorrect,
    boundArgumentsCorrect,
    languageCorrect,
    strictCorrect,
  };
}

function fraction(values: readonly boolean[]): number {
  if (values.length === 0) return 1;
  return values.filter(Boolean).length / values.length;
}

function summarize(rows: ReturnType<typeof evaluateCase>[]) {
  const supported = rows.filter((row) => !row.unsupported);
  const unsupported = rows.filter((row) => row.unsupported);
  return {
    cases: rows.length,
    supportedCases: supported.length,
    unsupportedCases: unsupported.length,
    strictAccuracy: fraction(rows.map((row) => row.strictCorrect)),
    roleAccuracy: fraction(supported.map((row) => row.roleCorrect)),
    relationAnchorAccuracy: fraction(
      supported.map((row) => row.relationAnchorCorrect),
    ),
    boundArgumentExactAccuracy: fraction(
      supported.map((row) => row.boundArgumentsCorrect),
    ),
    languageAccuracy: fraction(supported.map((row) => row.languageCorrect)),
    unsupportedFalseProjectionRate:
      unsupported.length === 0
        ? 0
        : unsupported.filter((row) => row.projected).length /
          unsupported.length,
    rows,
  };
}

async function main(): Promise<void> {
  const manifestPath = path.resolve(
    process.env.AKP_REQUESTED_SLOT_MANIFEST ??
      "evals/generic/requested-answer-slot/manifest.json",
  );
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as Manifest;
  if (!manifest.frozen || !manifest.protocol.familyDisjoint) {
    throw new Error(
      "requested-answer-slot manifest must be frozen and family-disjoint",
    );
  }
  const developmentFamilies = new Set(manifest.protocol.developmentFamilies);
  const heldoutFamilies = new Set(manifest.protocol.heldoutFamilies);
  if ([...developmentFamilies].some((family) => heldoutFamilies.has(family))) {
    throw new Error("development and heldout families must be disjoint");
  }

  const development = summarize(manifest.splits.development.map(evaluateCase));
  const heldout = summarize(manifest.splits.heldout.map(evaluateCase));
  const rules = manifest.promotionRule;
  const gates = {
    developmentStrictAccuracy:
      development.strictAccuracy >= rules.developmentStrictAccuracy,
    heldoutStrictAccuracy:
      heldout.strictAccuracy >= rules.heldoutStrictAccuracyAtLeast,
    unsupportedFalseProjectionRate:
      heldout.unsupportedFalseProjectionRate <=
      rules.unsupportedFalseProjectionRate,
    relationAnchorAccuracy:
      heldout.relationAnchorAccuracy >= rules.relationAnchorAccuracyAtLeast,
    boundArgumentExactAccuracy:
      heldout.boundArgumentExactAccuracy >=
      rules.boundArgumentExactAccuracyAtLeast,
  };

  const report = {
    schemaVersion: "akp.requested-answer-slot-experiment.v1",
    generatedAt: new Date().toISOString(),
    outcome: Object.values(gates).every(Boolean)
      ? "PROMOTE_TO_SHADOW_QUERY_MODEL"
      : "REJECT",
    promotionScope: "query-representation-shadow-only",
    productionBehaviorChanged: false,
    admissionBehaviorChanged: false,
    baselineSha: manifest.baselineSha,
    candidateSha: await candidateHeadSha(),
    datasetHash: sha256(manifestRaw),
    singleIndependentVariable:
      "surface-grammar RequestedAnswerSlot projection for bounded open-slot questions",
    protocol: manifest.protocol,
    gates,
    development,
    heldout,
    claimBoundary: [
      "Projection quality only; this report does not grant evidence support.",
      "No runtime support-verifier, admission threshold, semantic vocabulary or provider default changes.",
      "A PROMOTE result only permits a later shadow experiment that consumes the projection.",
    ],
  };

  const output = path.resolve(
    process.env.AKP_REQUESTED_SLOT_REPORT ??
      "reports/ci/requested-answer-slot-projection.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? (error.stack ?? error.message) : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
