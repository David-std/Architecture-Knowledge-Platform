/**
 * PREPARATION ONLY: 240 blank external-custodian sourcing seats.
 * Never call models or produce "gold" labels from these blank rows.
 * Completely private output outside Git; append-only final freeze is a
 * DISTINCT event run by an independently authenticated custodian.
 *
 * pnpm exec tsx scripts/s2-prepare-external-review-kit.ts --output-dir ABS_PATH
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--output-dir" ||
  !args[1] ||
  args[1]!.startsWith("--")
)
  throw new Error("S2_EXTERNAL_KIT_OUTPUT_DIR_REQUIRED");
const output = path.resolve(args[1]!);
const repository = path.resolve(import.meta.dirname, "..");
if (
  output === repository ||
  output.startsWith(repository + path.sep) ||
  output === path.parse(output).root
)
  throw new Error("S2_EXTERNAL_KIT_PRIVATE_DIRECTORY_REQUIRED");
const digest = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const csv = (cells: (string | number)[]) =>
  cells.map((x) => '"' + String(x).replaceAll('"', '""') + '"').join(",");
const header = [
  "caseSeat",
  "publisherFamilySeat",
  "language",
  "targetStratum",
  "publisherName",
  "upstreamRepository",
  "sourceRevision40Hex",
  "sourceRelativePath",
  "originalSha256",
  "authorizedVaultScope",
  "sourceLocatorUtf16Start",
  "sourceLocatorUtf16End",
  "question",
  "ownerSuggestedGoldKeepPrivate",
  "externalCustodianSourceSelectionReason",
  "externalCustodianCaseAuthor",
];
const familyCount = 12,
  perFamily = 20,
  perStratum = 5;
const salt = randomBytes(32).toString("hex");
const strata = [
  { lang: "en", kind: "POSITIVE" },
  { lang: "en", kind: "NEGATIVE_ADVERSARIAL" },
  { lang: "es", kind: "POSITIVE" },
  { lang: "es", kind: "NEGATIVE_ADVERSARIAL" },
] as const;
const rows: string[] = [csv(header)];
for (let family = 1; family <= familyCount; family++) {
  const familySeat = "F" + String(family).padStart(2, "0");
  for (const group of strata) {
    for (let n = 0; n < perStratum; n++) {
      const opaque =
        "C" +
        digest(
          salt +
            ":" +
            familySeat +
            ":" +
            group.lang +
            ":" +
            group.kind +
            ":" +
            n,
        ).slice(0, 16);
      rows.push(
        csv([
          opaque,
          familySeat,
          group.lang,
          group.kind,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ]),
      );
    }
  }
}
if (
  rows.length !== familyCount * perFamily + 1 ||
  new Set(rows.slice(1).map((x) => x.split(",")[0])).size !== 240
)
  throw new Error("S2_EXTERNAL_KIT_INTERNAL_COUNT_INVALID");

const protocol = `# S2 external-custodian candidate kit (240 seats)

**STATE: PREPARATION ONLY — zero completed questions, zero model runs, zero external adjudications.**
This is not a signed holdout, independent gold, an S2 acceptance artifact, or permission to activate LAYERED/E5/BGE.

## Division of responsibilities

The external custodian obtains authorization to use original SOURCE and owns the publisher selection, questions, pinned revisions, source bytes and private task labels. **The custodian, not an AI implementer, must establish and attest role and authority out of band.** Model operators receive only question and authorized source scope when a separately sealed test is finally frozen; they must never see the target stratum or gold fields. Reviewer X and reviewer Y receive separately shuffled, label-free packets containing exact original source passage(s), question, vault/path scope, revisions and SHA-256, but no target stratum, intended answer, previous judgments or Writer answer. Reviewer Z adjudicates only genuine disagreements. Avoid naming reviewers with self-generated test identities.

The coordinator-only \`custodian-task-template.csv\` has 240 **BLANK** seats across twelve distinct publisher families (20 each). Each family has five seats in EN-positive, EN-negative, ES-positive and ES-negative. Contradictions, polarity flips, actor swaps, stale time, wrong units and denied paths should be distributed across the negative groups. Do not build every negative by merely changing the ID of a positive; negatives must be checked against the entire authorized corpus for accidental answers.

## Sourcing and sealing

1. The external custodian replaces each seat's blanks with real **approved** independent SOURCE and original revision, including SHA-256, vault/path scope and exact UTF-16 source span; source-publisher and relation families must be disjoint from previously inspected 200 DEV tasks, synthetic 48, 176 owner pilot, MDN, and any development data reused for tuning. Reject duplicates and ambiguous provenance.
2. Inspect real-world sourcing rights, family balance and case quality. The 240-seat target is a design, not proof of independence or sufficient statistical power.
3. Freeze **real completed** source/answerability/atomic-claim manifests, provenance, timestamps and threshold policy **before** running any model or reader. Use an independently authenticated Ed25519 signer and out-of-band SHA-256/key-fingerprint anchors, checked with \`scripts/s2-verify-external-holdout-freeze.ts\`. A hash over this blank template is NOT that freeze.
4. Reuse the implemented \`scripts/s2-prepare-owner-holdout.ts\`, \`packages/evaluation/src/s2-owner-holdout.ts\` and \`scripts/s2-verify-external-holdout-freeze.ts\` as applicable. Do not write a second unverified question/source custody stack.
5. Freeze all Reader, Search/ContextPacket and exact Writer provider requests before opening any hidden labels. Measure actual authenticated HTTP cold/warm p50/p95, no-answer false admission, sufficiently cited truth, positive retention/false abstention, source-unit recall, complete atomic answer correctness, provider errors, real model tokens and source-family uncertainty. Report denominator per language/polarity.
6. Any external reviewer can refuse a case: mark it excluded with a reason **before inference**. Do not silently replace failed cases after scoring. Record conflicts and missing original spans instead of inventing labels.

## Frozen prior gates (do not tune after observing the holdout)

Preserve architecture S2 provisional prior diagnostics: precision >=0.80 with simple Wilson95 lower >=0.70, FAR <=0.10 and no worse than the current deterministic baseline; p95 <=25s; degraded calls <=5%; no regression of final-answer correctness. Confirm design-aware cluster confidence intervals and actual task success. Acceptance authority remains with the project's independent gate.

The \`custodian-task-template.sha256\` in this kit authenticates ONLY the blank preparation template. Source family selection, question content, signer trust, independent human role and final frozen test do not exist yet.
`;
const review = `# Reviewer protocol — blinded SOURCE sufficiency

This blank rubric is sent to X/Y only after an independent custodian has frozen case identities, original source versions, exact excerpt bytes, rights and reference scope. Do not include coordinator target stratum, owner gold, model outputs, previous reviews or other reviewer labels.

For each case, classify EXACTLY one: \`ANSWERABLE_EXPLICIT\`, \`CONTRADICTED\`, \`NOT_ANSWERABLE\`, \`AMBIGUOUS\`. Verify subject, direction, predicate, receiver, negation, temporal applicability, modality, quantities/units, conditions, version and all required answer slots. For positive or contradictory evidence, copy the literal quote and full-original UTF-16 offsets, linked to the approved revision/SHA, not an invented document excerpt. Missing source facts or denied paths must not be accepted just because a model knows an answer. If more than one atomic claim is required, adjudicate each separately.

Report cases that accidentally duplicate previous dev questions or have missing licensing/ACL evidence to the custodian before any blind model run. Record disagreements without exposing prior answers. The third reviewer sees only disputed cases and must independently confirm the full original.
`;
const manifest = {
  schemaVersion: "akp.s2.external-custodian-intake-preparation.v1",
  status: "UNFILLED_COORDINATOR_TEMPLATE_NOT_INDEPENDENT_HOLDOUT",
  targetCount: 240,
  publisherFamilySlots: 12,
  casesPerFamily: 20,
  targetPerStratum: 60,
  strata: {
    en_positive: 60,
    en_negative: 60,
    es_positive: 60,
    es_negative: 60,
  },
  chosenSources: 0,
  submittedQuestions: 0,
  verifiedOriginalSpans: 0,
  independentCustodianExternallyAuthenticated: false,
  reviewerXSubmitted: false,
  reviewerYSubmitted: false,
  modelRuns: 0,
  finalManifestFrozen: false,
  releaseGateAccepted: false,
  templateSha256: digest(rows.join("\n") + "\n"),
};
await mkdir(output, { recursive: false });
const write = async (file: string, text: string) =>
  writeFile(path.join(output, file), text, { flag: "wx" });
await write("custodian-task-template.csv", rows.join("\n") + "\n");
await write("custodian-task-template.sha256", manifest.templateSha256 + "\n");
await write(
  "PREPARATION-MANIFEST.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
await write("README-EXTERNAL-CUSTODIAN.md", protocol);
await write("BLIND-REVIEWER-RUBRIC.md", review);
process.stdout.write(
  JSON.stringify({
    status: manifest.status,
    out: output,
    cases: manifest.targetCount,
    perStratum: manifest.targetPerStratum,
    families: manifest.publisherFamilySlots,
    templateSha256: manifest.templateSha256,
    genuineHoldoutPrepared: false,
    releaseGateAccepted: false,
  }) + "\n",
);
