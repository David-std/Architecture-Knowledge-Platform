/**
 * S2 test-only validation for independently submitted candidate annotations.
 * Validates sources, exact UTF-16 citations and paired reviewer disagreements.
 * It cannot establish human independence, evidence precision or final FAR.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/u;
const verdicts = new Set([
  "ANSWERS",
  "CONTRADICTS",
  "RELATED_NOT_ANSWERING",
  "INSUFFICIENT",
]);
const columns = [
  "questionKey",
  "query",
  "candidateKey",
  "passage",
  "passageSha256",
  "sourceUnitSha256",
  "verdict",
  "quoteStartOffsetUtf16",
  "quoteEndOffsetUtf16",
  "reviewerNote",
];
function fail(code) {
  throw new Error("S2_ADJUDICATION_" + code);
}
function validSpan(passage, start, end) {
  const split = (index) =>
    index > 0 &&
    index < passage.length &&
    passage.charCodeAt(index - 1) >= 0xd800 &&
    passage.charCodeAt(index - 1) <= 0xdbff &&
    passage.charCodeAt(index) >= 0xdc00 &&
    passage.charCodeAt(index) <= 0xdfff;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= passage.length &&
    !split(start) &&
    !split(end) &&
    passage.slice(start, end).trim().length > 0
  );
}
export function inspectPacket(
  packet,
  expectedCases = 48,
  expectedCandidates = 288,
) {
  if (
    packet?.schemaVersion !== "akp.s2.adjudication-request.v1" ||
    packet.status !== "UNADJUDICATED_PUBLIC_NONBLIND" ||
    packet.sourceOfCandidates !==
      "AUTHORIZED_E5_QUERY_KNOWLEDGE_CANDIDATE_SINK" ||
    packet.quoteOffsetConvention !== "UTF16_OFFSETS_IN_EXACT_PASSAGE" ||
    packet.readerDecisionsMeasured !== false ||
    packet.independentAdjudication !== false ||
    packet.sourceSpansAdmitted !== false ||
    packet.goldLabelsIncluded !== false ||
    packet.deterministicSupportPredictionsIncluded !== false ||
    !/^[a-f0-9]{40}$/u.test(packet.frozenGitBlobSha1 ?? "") ||
    !/^[a-f0-9]{40}$/u.test(packet.branchHeadSha ?? "") ||
    !Array.isArray(packet.cases) ||
    packet.cases.length !== expectedCases
  )
    fail("PACKET_HEADER_INVALID");
  const questions = new Map();
  let count = 0;
  for (const question of packet.cases) {
    if (
      typeof question.query !== "string" ||
      question.questionKey !== hash(question.query) ||
      questions.has(question.questionKey) ||
      !Array.isArray(question.candidates)
    )
      fail("QUESTION_IDENTITY_CHANGED");
    const candidates = new Map();
    for (const item of question.candidates) {
      count += 1;
      if (
        !hex.test(item.candidateKey ?? "") ||
        candidates.has(item.candidateKey) ||
        typeof item.passage !== "string" ||
        !item.passage.trim() ||
        item.passageSha256 !== hash(item.passage) ||
        !hex.test(item.sourceUnitSha256 ?? "") ||
        !Number.isSafeInteger(item.sourceStartOffsetUtf16) ||
        item.sourceStartOffsetUtf16 < 0 ||
        item.sourceEndOffsetUtf16 - item.sourceStartOffsetUtf16 !==
          item.passage.length ||
        item.annotation?.verdict !== null ||
        item.annotation?.quoteStartOffsetUtf16 !== null ||
        item.annotation?.quoteEndOffsetUtf16 !== null
      ) {
        fail("CANDIDATE_SOURCE_OR_LABEL_CHANGED");
      }
      candidates.set(item.candidateKey, item);
    }
    questions.set(question.questionKey, { query: question.query, candidates });
  }
  if (count !== expectedCandidates) fail("CANDIDATE_COUNT_CHANGED");
  return { questions, candidateCount: count };
}
/** Strict RFC-4180 CSV reader, including quoted commas, CRLF and newlines. */
function csvRows(raw) {
  let quoted = false;
  let afterQuote = false;
  let field = "";
  let row = [];
  const rows = [];
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (quoted) {
      if (char === '"' && raw[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
        afterQuote = true;
      } else field += char;
    } else if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      afterQuote = false;
      if (char === ",") continue;
      if (char === "\r" && raw[i + 1] === "\n") i += 1;
      rows.push(row);
      row = [];
    } else if (char === '"' && !field && !afterQuote) {
      quoted = true;
    } else if (char === '"' || afterQuote) fail("CSV_INVALID_QUOTING");
    else field += char;
  }
  if (quoted) fail("CSV_UNCLOSED_QUOTE");
  if (field || row.length) rows.push([...row, field]);
  if (JSON.stringify(rows.shift()) !== JSON.stringify(columns)) {
    fail("CSV_COLUMNS_CHANGED");
  }
  return rows.map((values) => {
    if (values.length !== columns.length) fail("CSV_ROW_WIDTH_CHANGED");
    return Object.fromEntries(columns.map((name, i) => [name, values[i]]));
  });
}
export function inspectAnnotations(packetIndex, raw) {
  const annotations = new Map();
  for (const row of csvRows(raw.replace(/^\uFEFF/u, ""))) {
    const question = packetIndex.questions.get(row.questionKey);
    const candidate = question?.candidates.get(row.candidateKey);
    const key = row.questionKey + ":" + row.candidateKey;
    if (!candidate || annotations.has(key))
      fail("FOREIGN_OR_DUPLICATE_CANDIDATE");
    if (
      row.query !== question.query ||
      row.passage !== candidate.passage ||
      row.passageSha256 !== candidate.passageSha256 ||
      row.sourceUnitSha256 !== candidate.sourceUnitSha256 ||
      !verdicts.has(row.verdict)
    )
      fail("REVIEW_SOURCE_OR_VERDICT_INVALID");
    const hasQuote = row.verdict === "ANSWERS" || row.verdict === "CONTRADICTS";
    let start = null;
    let end = null;
    if (hasQuote) {
      if (
        !/^(0|[1-9]\d*)$/u.test(row.quoteStartOffsetUtf16) ||
        !/^(0|[1-9]\d*)$/u.test(row.quoteEndOffsetUtf16)
      ) {
        fail("ANSWER_QUOTE_NOT_EXACT_SOURCE_SPAN");
      }
      start = Number(row.quoteStartOffsetUtf16);
      end = Number(row.quoteEndOffsetUtf16);
      if (!validSpan(row.passage, start, end)) {
        fail("ANSWER_QUOTE_NOT_EXACT_SOURCE_SPAN");
      }
    } else if (row.quoteStartOffsetUtf16 || row.quoteEndOffsetUtf16) {
      fail("NONANSWER_CANNOT_CLAIM_QUOTE");
    }
    annotations.set(key, { verdict: row.verdict, start, end });
  }
  if (annotations.size !== packetIndex.candidateCount)
    fail("REVIEW_INCOMPLETE");
  return annotations;
}
export function compareAnnotations(a, b) {
  if (a.size !== b.size) fail("REVIEW_SET_MISMATCH");
  let matchingLabels = 0;
  let comparableQuotes = 0;
  let matchingQuotes = 0;
  const disagreements = [];
  for (const [key, left] of a) {
    const right = b.get(key);
    if (!right) fail("REVIEW_SET_MISMATCH");
    if (left.verdict !== right.verdict) {
      disagreements.push({ key, kind: "VERDICT_DISAGREEMENT" });
    } else {
      matchingLabels += 1;
      if (left.start !== null) {
        comparableQuotes += 1;
        if (left.start === right.start && left.end === right.end) {
          matchingQuotes += 1;
        } else disagreements.push({ key, kind: "QUOTE_DISAGREEMENT" });
      }
    }
  }
  return {
    reviewedPairs: a.size,
    matchingLabels,
    labelAgreementRate: matchingLabels / a.size,
    comparableQuotes,
    matchingQuotes,
    quoteAgreementRate: comparableQuotes
      ? matchingQuotes / comparableQuotes
      : null,
    disagreements,
  };
}
function encodeCsv(rows) {
  const quote = (value) =>
    '"' + String(value ?? "").replaceAll('"', '""') + '"';
  return (
    [
      columns.join(","),
      ...rows.map((row) => columns.map((name) => quote(row[name])).join(",")),
    ].join("\r\n") + "\r\n"
  );
}
function selfTest() {
  const query = "Who recorded this?";
  const passage = 'The "record", 😎\nwas archived.';
  const source = {
    candidateKey: hash("candidate"),
    passage,
    passageSha256: hash(passage),
    sourceUnitSha256: hash(passage),
    sourceStartOffsetUtf16: 0,
    sourceEndOffsetUtf16: passage.length,
    annotation: {
      verdict: null,
      quoteStartOffsetUtf16: null,
      quoteEndOffsetUtf16: null,
    },
  };
  const packet = {
    schemaVersion: "akp.s2.adjudication-request.v1",
    status: "UNADJUDICATED_PUBLIC_NONBLIND",
    sourceOfCandidates: "AUTHORIZED_E5_QUERY_KNOWLEDGE_CANDIDATE_SINK",
    quoteOffsetConvention: "UTF16_OFFSETS_IN_EXACT_PASSAGE",
    readerDecisionsMeasured: false,
    independentAdjudication: false,
    sourceSpansAdmitted: false,
    goldLabelsIncluded: false,
    deterministicSupportPredictionsIncluded: false,
    frozenGitBlobSha1: "a".repeat(40),
    branchHeadSha: "b".repeat(40),
    cases: [{ questionKey: hash(query), query, candidates: [source] }],
  };
  const index = inspectPacket(packet, 1, 1);
  const row = {
    questionKey: hash(query),
    query,
    candidateKey: source.candidateKey,
    passage,
    passageSha256: source.passageSha256,
    sourceUnitSha256: source.sourceUnitSha256,
    verdict: "ANSWERS",
    quoteStartOffsetUtf16: String(passage.indexOf("😎")),
    quoteEndOffsetUtf16: String(passage.indexOf("😎") + 2),
    reviewerNote: "test",
  };
  const parsed = inspectAnnotations(index, encodeCsv([row]));
  assert.equal(compareAnnotations(parsed, parsed).matchingQuotes, 1);
  const reject = (test) => assert.throws(test, /S2_ADJUDICATION_/u);
  reject(() => inspectAnnotations(index, encodeCsv([])));
  reject(() => inspectAnnotations(index, encodeCsv([row, row])));
  reject(() =>
    inspectAnnotations(index, encodeCsv([{ ...row, passage: "tampered" }])),
  );
  reject(() => inspectAnnotations(index, encodeCsv([{ ...row, verdict: "" }])));
  reject(() =>
    inspectAnnotations(
      index,
      encodeCsv([
        { ...row, quoteStartOffsetUtf16: String(passage.indexOf("😎") + 1) },
      ]),
    ),
  );
  reject(() =>
    inspectAnnotations(index, encodeCsv([{ ...row, verdict: "INSUFFICIENT" }])),
  );
  reject(() =>
    inspectPacket(
      {
        ...packet,
        cases: [
          {
            ...packet.cases[0],
            candidates: [{ ...source, passageSha256: "0".repeat(64) }],
          },
        ],
      },
      1,
      1,
    ),
  );
  return { mutationCases: 7, status: "PASSED" };
}
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith("--")) fail("ARGUMENT_INVALID");
  if (key === "--self-test" || key === "--inspect-packet") args.set(key, true);
  else {
    if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
      fail("ARGUMENT_VALUE_MISSING");
    }
    args.set(key, process.argv[++i]);
  }
}
if (args.has("--self-test")) {
  process.stdout.write(JSON.stringify(selfTest()) + "\n");
} else {
  if (!args.has("--packet")) fail("PACKET_REQUIRED");
  const bytes = await readFile(path.resolve(args.get("--packet")));
  const packetSha256 = hash(bytes);
  if (
    args.has("--packet-sha256") &&
    args.get("--packet-sha256") !== packetSha256
  ) {
    fail("PACKET_SHA256_MISMATCH");
  }
  const packet = inspectPacket(JSON.parse(bytes.toString("utf8")));
  const reviewerA = args.get("--reviewer-a");
  const reviewerB = args.get("--reviewer-b");
  if (Boolean(reviewerA) !== Boolean(reviewerB)) fail("REVIEW_PAIR_REQUIRED");
  if (reviewerA && !args.has("--packet-sha256")) {
    fail("PINNED_PACKET_SHA256_REQUIRED_FOR_REVIEW");
  }
  const report = {
    schemaVersion: "akp.s2.adjudication-integrity.v1",
    status: reviewerA
      ? "TWO_SUBMISSIONS_VALIDATED_HUMAN_ORIGIN_UNVERIFIED"
      : "UNADJUDICATED_PACKET_VALIDATED",
    packetSha256,
    questionCount: packet.questions.size,
    candidateCount: packet.candidateCount,
    publicCorpusBlind: false,
    reviewerIndependenceVerified: false,
    admissionMeasured: false,
    falseAdmissionRate: null,
    finalAnswersMeasured: false,
    gateAccepted: false,
  };
  if (reviewerA) {
    const idA = args.get("--reviewer-a-id");
    const idB = args.get("--reviewer-b-id");
    if (!idA || !idB || idA === idB) fail("DISTINCT_REVIEWER_IDS_REQUIRED");
    const [bytesA, bytesB] = await Promise.all([
      readFile(path.resolve(reviewerA)),
      readFile(path.resolve(reviewerB)),
    ]);
    report.reviewerSubmission = {
      firstId: idA,
      firstCsvSha256: hash(bytesA),
      secondId: idB,
      secondCsvSha256: hash(bytesB),
    };
    report.agreement = compareAnnotations(
      inspectAnnotations(packet, bytesA.toString("utf8")),
      inspectAnnotations(packet, bytesB.toString("utf8")),
    );
  }
  if (args.has("--output")) {
    const file = path.resolve(args.get("--output"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify(report) + "\n");
}
