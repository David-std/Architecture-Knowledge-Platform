import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SearchHit } from "@akp/contracts";
import {
  LayeredEvidenceAdmissionPipeline,
  type EvidenceAdmissionDecision,
  type EvidenceAdmissionLayer,
  type EvidenceVerdict,
  type SemanticEvidenceReader,
  type StructuredPropositionQuery,
} from "../packages/retrieval/src/index.js";

const execFile = promisify(execFileCallback);

type Split = "development" | "heldout";
type Language = "en" | "es";
type VerdictKind = EvidenceVerdict["kind"];

interface ExpectedDecision {
  readonly layer: EvidenceAdmissionLayer;
  readonly verdict: VerdictKind;
}

interface PropositionFixture {
  readonly subject: string;
  readonly predicate: string;
  readonly object?: string;
  readonly polarity?: "POSITIVE" | "NEGATIVE";
}

interface HoldoutCase {
  readonly id: string;
  readonly split: Split;
  readonly family: string;
  readonly language: Language;
  readonly query: string;
  readonly passage: string;
  readonly quote: string;
  readonly queryProposition: StructuredPropositionQuery;
  readonly candidateProposition: PropositionFixture;
  readonly expected: ExpectedDecision;
}

interface HoldoutManifest {
  readonly id: string;
  readonly version: number;
  readonly frozenAt: string;
  readonly baselineSha: string;
  readonly description: string;
  readonly policy: {
    readonly blindHoldout: string;
    readonly semanticFallback: string;
    readonly sourceSpans: string;
    readonly runtimeChange: string;
    readonly promotionRule: string;
  };
  readonly developmentFamilies: readonly string[];
  readonly heldoutFamilies: readonly string[];
  readonly cases: readonly HoldoutCase[];
}

interface Observation {
  readonly id: string;
  readonly split: Split;
  readonly family: string;
  readonly language: Language;
  readonly expected: ExpectedDecision;
  readonly actual: ExpectedDecision;
  readonly reason: string;
  readonly passed: boolean;
}

const failClosedSemanticReader: SemanticEvidenceReader = {
  id: "family-disjoint:semantic-disabled",
  async read(): Promise<EvidenceAdmissionDecision> {
    return {
      layer: "SEMANTIC_READER",
      verdict: { kind: "INSUFFICIENT" },
      reason: "FAMILY_DISJOINT_SEMANTIC_READER_DISABLED",
      readerId: "family-disjoint:semantic-disabled",
    };
  },
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function gitHead(): Promise<string> {
  const result = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: process.cwd(),
  });
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("Unable to resolve Git HEAD");
  }
  return value;
}

async function candidateHeadSha(): Promise<string> {
  const explicit = process.env.AKP_STRUCTURED_PROPOSITION_CANDIDATE_SHA?.trim();
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
  return gitHead();
}

function exactUniqueQuote(
  passage: string,
  quote: string,
): { startOffset: number; endOffset: number } {
  const startOffset = passage.indexOf(quote);
  if (
    startOffset < 0 ||
    passage.lastIndexOf(quote) !== startOffset ||
    quote.length === 0
  ) {
    throw new Error("Quote must occur exactly once in passage");
  }
  return { startOffset, endOffset: startOffset + quote.length };
}

function hitFor(testCase: HoldoutCase): SearchHit {
  return {
    documentId: `family-disjoint:${testCase.id}:document`,
    vaultId: "family-disjoint:vault",
    unitId: `family-disjoint:${testCase.id}:unit`,
    unitType: "PARAGRAPH",
    structuralOrder: 1,
    headingPath: ["Structured proposition family-disjoint holdout"],
    document: {
      externalId: `FAMILY-DISJOINT-${testCase.id}`,
      path: `evals/structured-proposition/${testCase.id}.md`,
      title: testCase.id,
      aliases: [],
    },
    revision: "family-disjoint-v1",
    title: testCase.id,
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["structured-proposition-family-disjoint"],
    excerpt: testCase.passage,
    citations: [],
  };
}

function validateManifest(manifest: HoldoutManifest): {
  familyDisjoint: boolean;
  developmentFamilies: string[];
  heldoutFamilies: string[];
} {
  const developmentFamilies = [...new Set(manifest.developmentFamilies)];
  const heldoutFamilies = [...new Set(manifest.heldoutFamilies)];
  const overlap = developmentFamilies.filter((family) =>
    heldoutFamilies.includes(family),
  );
  if (overlap.length > 0) {
    throw new Error(`Family overlap detected: ${overlap.join(", ")}`);
  }

  const declared = {
    development: new Set(developmentFamilies),
    heldout: new Set(heldoutFamilies),
  };
  for (const testCase of manifest.cases) {
    if (!declared[testCase.split].has(testCase.family)) {
      throw new Error(
        `Case ${testCase.id} uses undeclared ${testCase.split} family ${testCase.family}`,
      );
    }
  }
  for (const split of ["development", "heldout"] as const) {
    const languages = new Set(
      manifest.cases
        .filter((testCase) => testCase.split === split)
        .map((testCase) => testCase.language),
    );
    if (!languages.has("en") || !languages.has("es")) {
      throw new Error(`${split} must contain both EN and ES cases`);
    }
  }

  return {
    familyDisjoint: true,
    developmentFamilies,
    heldoutFamilies,
  };
}

function summarize(observations: readonly Observation[], split: Split) {
  const selected = observations.filter((row) => row.split === split);
  const passed = selected.filter((row) => row.passed).length;
  const byFamily = Object.fromEntries(
    [...new Set(selected.map((row) => row.family))].map((family) => {
      const rows = selected.filter((row) => row.family === family);
      return [
        family,
        {
          cases: rows.length,
          passed: rows.filter((row) => row.passed).length,
          strictAccuracy:
            rows.length === 0
              ? null
              : rows.filter((row) => row.passed).length / rows.length,
        },
      ];
    }),
  );
  return {
    cases: selected.length,
    passed,
    strictAccuracy: selected.length === 0 ? null : passed / selected.length,
    byFamily,
    observations: selected,
  };
}

async function main(): Promise<void> {
  const manifestPath = path.resolve(
    process.env.AKP_STRUCTURED_PROPOSITION_HOLDOUT_MANIFEST ??
      "evals/generic/structured-proposition-family-disjoint/manifest.json",
  );
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as HoldoutManifest;
  const audit = validateManifest(manifest);

  const pipeline = new LayeredEvidenceAdmissionPipeline({
    semanticReader: failClosedSemanticReader,
  });
  const observations: Observation[] = [];

  for (const testCase of manifest.cases) {
    const quote = exactUniqueQuote(testCase.passage, testCase.quote);
    const decision = await pipeline.evaluate({
      query: testCase.query,
      hit: hitFor(testCase),
      queryProposition: testCase.queryProposition,
      candidateProposition: {
        ...testCase.candidateProposition,
        quote,
      },
    });
    const actual: ExpectedDecision = {
      layer: decision.layer,
      verdict: decision.verdict.kind,
    };
    observations.push({
      id: testCase.id,
      split: testCase.split,
      family: testCase.family,
      language: testCase.language,
      expected: testCase.expected,
      actual,
      reason: decision.reason,
      passed:
        actual.layer === testCase.expected.layer &&
        actual.verdict === testCase.expected.verdict,
    });
  }

  const development = summarize(observations, "development");
  const heldout = summarize(observations, "heldout");
  const allCasesPass =
    development.strictAccuracy === 1 && heldout.strictAccuracy === 1;
  const outcome =
    audit.familyDisjoint && allCasesPass ? "PROMOTE" : "REJECT";
  const candidateSha = await candidateHeadSha();
  const config = {
    matcher: "ExactStructuredPropositionMatcher",
    guard: "StructuralEvidenceGuard",
    semanticReader: failClosedSemanticReader.id,
    queryExtraction: "EXPLICIT_PREDECLARED_PROPOSITION",
    sourceSpan: "EXACT_UNIQUE_QUOTE",
  };

  const report = {
    schemaVersion: "akp.structured-proposition-family-disjoint.v1",
    generatedAt: new Date().toISOString(),
    outcome,
    experiment: {
      hypothesis:
        "Exact structured proposition matching generalizes to unseen abstract comparison families without semantic fallback.",
      failureStage: "EVIDENCE_ADMISSION",
      baselineSha: manifest.baselineSha,
      candidateSha,
      datasetVersion: manifest.version,
      datasetHash: sha256(raw),
      configurationHash: sha256(JSON.stringify(config)),
      singleIndependentVariable:
        "fresh family-disjoint evaluation dataset; runtime behavior unchanged",
      primaryMetric: "heldout strict accuracy",
      guardrails: [
        "development strict accuracy",
        "exact source-bound quote",
        "semantic fallback disabled",
        "EN/ES present in both splits",
        "development/heldout family sets disjoint",
      ],
      promotionRule: manifest.policy.promotionRule,
    },
    audit,
    configuration: config,
    development,
    heldout,
  };

  const output = path.resolve(
    process.env.AKP_STRUCTURED_PROPOSITION_HOLDOUT_REPORT ??
      "reports/ci/structured-proposition-family-disjoint.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (outcome !== "PROMOTE") process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.stack ?? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 1;
});
