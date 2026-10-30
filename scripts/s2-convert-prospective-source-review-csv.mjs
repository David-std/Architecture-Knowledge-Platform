/**
 * Run locally after an independent human fills the received reviewer CSV.
 * node scripts/s2-convert-prospective-source-review-csv.mjs X /private/reviewer-completed.csv
 * Must be run INSIDE the reviewer directory that contains the frozen packet.
 * Does not invent answers or accept missing human decisions.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const [who, file] = process.argv.slice(2);
if (!["X", "Y"].includes(who) || !file)
  throw Error("REVIEW_CSV_USAGE_X_OR_Y_AND_FILE_REQUIRED");
const repoRoot = path.resolve(import.meta.dirname, "..").toLowerCase();
const cwd = path.resolve(process.cwd()).toLowerCase();
if (cwd === repoRoot || cwd.startsWith(repoRoot + path.sep))
  throw Error("S2_REVIEW_PRIVATE_WORKING_DIRECTORY_REQUIRED");
const name = "SOURCE-ONLY-reviewer-" + who + ".json";
const packetBytes = await readFile(name);
const pin = (
  await readFile("SOURCE-ONLY-reviewer-" + who + ".sha256", "utf8")
).trim();
if (sha(packetBytes) !== pin) throw Error("REVIEW_PACKET_SHA_MISMATCH");
const packet = JSON.parse(packetBytes.toString("utf8"));
const csvBytes = await readFile(file);
if (csvBytes.length < 100 || csvBytes.length > 2_000_000)
  throw Error("S2_REVIEW_CSV_SIZE");
const chars = new TextDecoder("utf8", { fatal: true })
  .decode(csvBytes)
  .replace(/^\ufeff/, "");
const csv = (s) => {
  const rows = [];
  let r = [],
    value = "",
    quoted = false,
    closed = false;
  const flush = () => {
    r.push(value);
    value = "";
    closed = false;
  };
  const row = () => {
    if (r.length) {
      rows.push(r);
      r = [];
    }
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
    } else if (c === '"') {
      if (value !== "" || closed) throw Error("INVALID_QUOTE");
      quoted = true;
    } else if (c === ",") flush();
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      flush();
      row();
    } else {
      if (closed) throw Error("TRAILING_DATA_AFTER_QUOTE");
      value += c;
    }
  }
  if (quoted) throw Error("UNCLOSED_CSV_QUOTE");
  if (r.length || value || closed) {
    flush();
    row();
  }
  return rows;
};
const rows = csv(chars);
const expected = [
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
if (
  JSON.stringify(rows.shift()) !== JSON.stringify(expected) ||
  rows.length !== 240 ||
  rows.some((r) => r.length !== 11)
)
  throw Error("CSV_240_HEADERS_OR_COLUMN_COUNT_INVALID");
const byCase = new Map(packet.cases.map((c) => [c.reviewCaseKey, c]));
const bySource = new Map(packet.sourceDocs.map((s) => [s.sourceKeySha256, s]));
const seen = new Set();
const decisions = [];
for (const raw of rows) {
  const [
    key,
    lang,
    q,
    sourceKey,
    verdict,
    answer,
    quote,
    startText,
    endText,
    whole,
    notes,
  ] = raw;
  const c = byCase.get(key);
  if (
    !c ||
    seen.has(key) ||
    c.language !== lang ||
    c.question !== q ||
    c.sourceKeySha256 !== sourceKey
  )
    throw Error("CASE_OR_SOURCE_IDENTITY_CHANGED");
  seen.add(key);
  if (
    ![
      "ANSWERABLE_EXPLICIT",
      "NOT_ANSWERABLE",
      "AMBIGUOUS",
      "CONTRADICTED",
    ].includes(verdict)
  )
    throw Error("REVIEWER_DECISION_MISSING_OR_INVALID");
  if (!["TRUE", "FALSE"].includes(whole))
    throw Error("WHOLE_CORPUS_FIELD_MISSING");
  // CSV describes whole corpus examined; the internal field is absence checked.
  // Positive, ambiguous and contradicted responses NEVER assert source absence.
  const corpusExamined = whole === "TRUE";
  const checked = verdict === "NOT_ANSWERABLE" && corpusExamined;
  let spans = [];
  if (verdict === "ANSWERABLE_EXPLICIT") {
    if (!answer?.trim() || !quote || checked)
      throw Error("POSITIVE_REQUIRES_ANSWER_QUOTE_NO_ABSENCE");
    const original = bySource.get(sourceKey)?.originalText;
    if (!original) throw Error("RAW_ORIGINAL_MISSING");
    let start, end;
    if (startText !== "" || endText !== "") {
      start = Number(startText);
      end = Number(endText);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        original.slice(start, end) !== quote
      )
        throw Error("SOURCE_UTF16_EXPLICIT_SPAN_INVALID");
    } else {
      start = original.indexOf(quote);
      if (start < 0 || original.indexOf(quote, start + 1) >= 0)
        throw Error("QUOTE_NOT_FOUND_OR_AMBIGUOUS_REPORT_EXACT_UTF16_OFFSETS");
      end = start + quote.length;
    }
    spans = [
      {
        sourceKeySha256: sourceKey,
        startUtf16: start,
        endUtf16: end,
        exactText: quote,
      },
    ];
  } else if (verdict === "NOT_ANSWERABLE") {
    if (answer || quote || !checked)
      throw Error("NEGATIVE_REQUIRES_FULL_CORPUS_REVIEW_NO_CITATION");
  } else if (!notes?.trim() || checked)
    throw Error("NONBINARY_EXPLANATION_REQUIRED");
  decisions.push({
    reviewCaseKey: key,
    sourceAnswerability: verdict,
    reviewerAnswer: answer || null,
    supportingQuoteSpans: spans,
    wholeAuthorizedCorpusAbsenceChecked: checked,
    reviewerNotes: notes || null,
  });
}
if (seen.size !== 240) throw Error("INCOMPLETE_SUBMISSION");
const result = Buffer.from(
  JSON.stringify(
    {
      schemaVersion: "akp.s2.preinference-review-submission.v1",
      reviewer: who,
      packetSha256: pin,
      cases: decisions,
    },
    null,
    2,
  ) + "\n",
);
const target = "SUBMISSION-REVIEWER-" + who + ".json";
await writeFile(target, result, { flag: "wx", mode: 0o600 });
await writeFile(target + ".sha256", sha(result) + "\n", {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  JSON.stringify({
    reviewer: who,
    cases: decisions.length,
    originalCsvSha256: sha(csvBytes),
    submissionSha256: sha(result),
    independentReviewerIdentityAuthenticatedByThisTool: false,
    releaseGateAccepted: false,
  }) + "\n",
);
