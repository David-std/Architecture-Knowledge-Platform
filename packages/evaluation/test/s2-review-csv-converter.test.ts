import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const script = fileURLToPath(
  new URL(
    "../../../scripts/s2-convert-prospective-source-review-csv.mjs",
    import.meta.url,
  ),
);
const row = (xs: string[]) =>
  xs.map((x) => '"' + x.replaceAll('"', '""') + '"').join(",");
const heads = [
  "reviewCaseKey",
  "idioma",
  "pregunta",
  "sourceKeySha256",
  "verdict_COPIAR_VALOR_DE_RUBRICA",
  "respuesta_si_positiva",
  "cita_literal_SOURCE",
  "inicio_UTF16_si_se_conoce",
  "fin_UTF16_si_se_conoce",
  "corpus_completo_examinado_TRUE_FALSE",
  "notas_revisor",
];
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "akp-s2-csv-review-"));
  const source =
    "The 🔥 authorization revision is 12. The rest of the corpus does not mention a date.";
  const sourceKey = sha("source identity");
  const cases = Array.from({ length: 240 }, (_, i) => ({
    reviewCaseKey: sha("case-" + i),
    language: i % 2 === 0 ? "en" : "es",
    question: "Who approved bounded review " + i + "?",
    sourceKeySha256: sourceKey,
    sourceAnswerability: null,
    reviewerAnswer: null,
    supportingQuoteSpans: [],
    wholeAuthorizedCorpusAbsenceChecked: null,
    reviewerNotes: null,
  }));
  const packet = {
    schemaVersion: "akp.s2.preinference-original-source-review.v1",
    reviewer: "X",
    frozenIntakeSha256: sha("frozen intake"),
    sourceDocs: [
      {
        sourceKeySha256: sourceKey,
        originalSha256: sha(source),
        originalText: source,
        upstreamRepository: "independent/example",
        revision40Hex: "a".repeat(40),
        relativePath: "README.md",
        authorizedVaultScope: "vault",
      },
    ],
    cases,
    expectedGoldIncluded: false,
    modelOutputsIncluded: false,
    reviewerIdentityAuthenticated: false,
    wholeAuthorizedCorpusAbsenceProven: false,
    independentGoldAdjudicated: false,
    releaseGateAccepted: false,
  };
  const pBytes = JSON.stringify(packet) + "\n";
  writeFileSync(path.join(dir, "SOURCE-ONLY-reviewer-X.json"), pBytes);
  writeFileSync(
    path.join(dir, "SOURCE-ONLY-reviewer-X.sha256"),
    sha(pBytes) + "\n",
  );
  const lines = [
    row(heads),
    ...cases.map((c, i) => {
      const isPositive = i === 0;
      return row([
        c.reviewCaseKey,
        c.language,
        c.question,
        c.sourceKeySha256,
        isPositive ? "ANSWERABLE_EXPLICIT" : "NOT_ANSWERABLE",
        isPositive ? "The authorization revision is 12." : "",
        isPositive ? "authorization revision is 12" : "",
        isPositive ? "7" : "",
        isPositive ? "35" : "",
        "TRUE",
        isPositive
          ? "Whole corpus examined; SOURCE cited."
          : "All authorized sources checked; no explicit answer.",
      ]);
    }),
  ];
  const file = path.join(dir, "completed.csv");
  writeFileSync(file, "\uFEFF" + lines.join("\r\n") + "\r\n");
  const run = () =>
    spawnSync(process.execPath, [script, "X", file], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20000,
    });
  return { dir, file, run };
}
describe("S2 reviewer CSV column means corpus examined, not source absence for all verdicts", () => {
  it("converts true-attested positive to absence=false while retaining true on negatives", () => {
    const f = fixture();
    try {
      const result = f.run();
      expect(result.status).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        originalCsvSha256: string;
        releaseGateAccepted: boolean;
      };
      expect(receipt.originalCsvSha256).toBe(sha(readFileSync(f.file)));
      expect(receipt.releaseGateAccepted).toBe(false);
      const submission = JSON.parse(
        readFileSync(path.join(f.dir, "SUBMISSION-REVIEWER-X.json"), "utf8"),
      ) as { cases: { wholeAuthorizedCorpusAbsenceChecked: boolean }[] };
      expect(submission.cases).toHaveLength(240);
      expect(submission.cases[0]!.wholeAuthorizedCorpusAbsenceChecked).toBe(
        false,
      );
      expect(submission.cases[1]!.wholeAuthorizedCorpusAbsenceChecked).toBe(
        true,
      );
      expect(f.run().status).not.toBe(0); // Exclusive writes; no overwriting review custody.
    } finally {
      rmSync(f.dir, { force: true, recursive: true });
    }
  });
  it("rejects a missing source quote or false whole-corpus declaration for a negative", () => {
    const f = fixture();
    try {
      const full = readFileSync(f.file, "utf8");
      writeFileSync(
        f.file,
        full.replace('"authorization revision is 12"', '""'),
      );
      expect(f.run().status).not.toBe(0);
      writeFileSync(
        f.file,
        full.replace(
          '"TRUE","All authorized sources checked; no explicit answer."',
          '"FALSE","All authorized sources checked; no explicit answer."',
        ),
      );
      expect(f.run().status).not.toBe(0);
    } finally {
      rmSync(f.dir, { force: true, recursive: true });
    }
  });
});
