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
const frozenBlobSha1 = "a61a24df46c0351115cd09e079ae0d8383033082";
const frozenFixture = path.resolve(
  import.meta.dirname,
  "../evals/registered/s2-source-span-holdout.json",
);
const gitBlob = (bytes) =>
  createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");

/**
 * The reviewer packet can be internally self-consistent yet fabricated.
 * Bind every quoted UTF-16 passage, candidate key and source digest to the
 * immutable, independently loaded public source corpus before accepting any
 * reviewer CSV. This does not inspect author gold labels or judge sufficiency.
 */
export function inspectFrozenSourceBinding(
  packet,
  fixtureBytes,
  expectedBlobSha1 = frozenBlobSha1,
) {
  const actualBlobSha1 = gitBlob(fixtureBytes);
  if (
    actualBlobSha1 !== expectedBlobSha1 ||
    packet.frozenGitBlobSha1 !== actualBlobSha1
  ) {
    fail("FROZEN_SOURCE_BLOB_MISMATCH");
  }
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  if (
    fixture.schemaVersion !== "akp.s2.source-span-holdout.v1" ||
    !Array.isArray(fixture.sourceDocuments) ||
    !Array.isArray(fixture.cases) ||
    packet.fixtureProjection !==
      "SYNTHETIC_APPROVED_TEST_ROWS_NOT_RAW_INGEST" ||
    packet.candidateOrder !== "SORTED_BY_STABLE_KEY_NOT_RETRIEVAL_RANK"
  ) {
    fail("FROZEN_SOURCE_SCHEMA_OR_PROJECTION_CHANGED");
  }
  const sources = new Map();
  const allUnits = new Set();
  for (const source of fixture.sourceDocuments) {
    if (
      typeof source.id !== "string" ||
      sources.has(source.id) ||
      !Array.isArray(source.units)
    ) {
      fail("FROZEN_SOURCE_IDENTITY_CHANGED");
    }
    const unitsByDigest = new Map();
    for (const unit of source.units) {
      if (
        typeof unit.id !== "string" ||
        typeof unit.text !== "string" ||
        allUnits.has(unit.id)
      ) {
        fail("FROZEN_SOURCE_UNIT_IDENTITY_CHANGED");
      }
      allUnits.add(unit.id);
      const digest = hash(unit.text);
      if (unitsByDigest.has(digest))
        fail("FROZEN_SOURCE_DUPLICATE_UNIT_DIGEST");
      unitsByDigest.set(digest, unit);
    }
    const digest = hash(
      source.units.map((unit) => unit.id + "\n" + unit.text).join("\n\n"),
    );
    if (packet.sourceSha256?.[source.id] !== digest)
      fail("FROZEN_SOURCE_DOCUMENT_HASH_MISMATCH");
    sources.set(source.id, { unitsByDigest, count: source.units.length });
  }
  if (
    Object.keys(packet.sourceSha256 ?? {}).length !== sources.size ||
    fixture.cases.length !== packet.cases.length
  ) {
    fail("FROZEN_SOURCE_COUNTS_CHANGED");
  }
  const expectedQuestions = new Map();
  for (const question of fixture.cases) {
    const key = hash(question.query);
    if (expectedQuestions.has(key)) fail("FROZEN_SOURCE_DUPLICATE_QUESTION");
    expectedQuestions.set(key, question);
  }
  const seen = new Set();
  let verifiedCandidates = 0;
  for (const question of packet.cases) {
    const frozen = expectedQuestions.get(question.questionKey);
    if (
      !frozen ||
      seen.has(question.questionKey) ||
      frozen.query !== question.query ||
      !sources.has(frozen.sourceId)
    ) {
      fail("FROZEN_SOURCE_QUESTION_CHANGED");
    }
    seen.add(question.questionKey);
    const source = sources.get(frozen.sourceId);
    const usedUnits = new Set();
    if (question.candidates.length !== source.count)
      fail("FROZEN_SOURCE_CANDIDATE_COUNT_CHANGED");
    for (const candidate of question.candidates) {
      const unit = source.unitsByDigest.get(candidate.sourceUnitSha256);
      if (!unit || usedUnits.has(unit.id))
        fail("FROZEN_SOURCE_CANDIDATE_UNIT_CHANGED");
      usedUnits.add(unit.id);
      if (
        candidate.candidateKey !==
          hash(question.query + "\0" + frozen.sourceId + "\0" + unit.id) ||
        unit.text.slice(
          candidate.sourceStartOffsetUtf16,
          candidate.sourceEndOffsetUtf16,
        ) !== candidate.passage
      ) {
        fail("FROZEN_SOURCE_PASSAGE_OR_OFFSET_CHANGED");
      }
      verifiedCandidates += 1;
    }
  }
  if (seen.size !== expectedQuestions.size)
    fail("FROZEN_SOURCE_QUESTION_SET_CHANGED");
  return {
    status: "FROZEN_SOURCE_BOUND_NOT_SEMANTIC_ADJUDICATION",
    frozenGitBlobSha1: actualBlobSha1,
    questionCount: seen.size,
    sourceBoundCandidates: verifiedCandidates,
  };
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
export function inspectAnnotations(packetIndex, raw, expectedKeys = null) {
  const annotations = new Map();
  for (const row of csvRows(raw.replace(/^\uFEFF/u, ""))) {
    const question = packetIndex.questions.get(row.questionKey);
    const candidate = question?.candidates.get(row.candidateKey);
    const key = row.questionKey + ":" + row.candidateKey;
    if (!candidate || annotations.has(key))
      fail("FOREIGN_OR_DUPLICATE_CANDIDATE");
    if (expectedKeys && !expectedKeys.has(key))
      fail("DISPUTE_RESOLUTION_NOT_REQUESTED");
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
  if (annotations.size !== (expectedKeys?.size ?? packetIndex.candidateCount))
    fail(expectedKeys ? "DISPUTE_RESOLUTION_INCOMPLETE" : "REVIEW_INCOMPLETE");
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
export function disputeTemplateRows(packetIndex, disagreements) {
  return disagreements.map(({ key }) => {
    const [questionKey, candidateKey] = key.split(":");
    const question = packetIndex.questions.get(questionKey);
    const candidate = question?.candidates.get(candidateKey);
    if (!candidate) fail("DISPUTE_SOURCE_IDENTITY_INVALID");
    return {
      questionKey,
      query: question.query,
      candidateKey,
      passage: candidate.passage,
      passageSha256: candidate.passageSha256,
      sourceUnitSha256: candidate.sourceUnitSha256,
      verdict: "",
      quoteStartOffsetUtf16: "",
      quoteEndOffsetUtf16: "",
      reviewerNote: "",
    };
  });
}
function assertSafeOutputPath(output, sourcePaths) {
  const target = path.resolve(output);
  if (sourcePaths.some((source) => source && path.resolve(source) === target))
    fail("OUTPUT_OVERWRITES_SOURCE_OR_SUBMISSION");
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
  // A pair of identical internally consistent hashes cannot establish that
  // a passage came from the frozen source unit. Exercise source binding with
  // a tiny independent fixture, then mutate each provenance dimension.
  const syntheticSourceId = "self-test-source";
  const syntheticUnitId = "self-test-unit";
  const syntheticFixture = {
    schemaVersion: "akp.s2.source-span-holdout.v1",
    sourceDocuments: [
      {
        id: syntheticSourceId,
        units: [{ id: syntheticUnitId, text: passage }],
      },
    ],
    cases: [{ query, sourceId: syntheticSourceId }],
  };
  const syntheticFixtureBytes = Buffer.from(
    JSON.stringify(syntheticFixture),
    "utf8",
  );
  const syntheticBlob = gitBlob(syntheticFixtureBytes);
  const validBoundCandidate = {
    ...source,
    candidateKey: hash(
      query + "\0" + syntheticSourceId + "\0" + syntheticUnitId,
    ),
  };
  const boundPacket = {
    ...packet,
    frozenGitBlobSha1: syntheticBlob,
    sourceSha256: {
      [syntheticSourceId]: hash(syntheticUnitId + "\n" + passage),
    },
    fixtureProjection: "SYNTHETIC_APPROVED_TEST_ROWS_NOT_RAW_INGEST",
    candidateOrder: "SORTED_BY_STABLE_KEY_NOT_RETRIEVAL_RANK",
    cases: [
      {
        questionKey: hash(query),
        query,
        candidates: [validBoundCandidate],
      },
    ],
  };
  inspectPacket(boundPacket, 1, 1);
  assert.equal(
    inspectFrozenSourceBinding(
      boundPacket,
      syntheticFixtureBytes,
      syntheticBlob,
    ).sourceBoundCandidates,
    1,
  );
  const mutateBound = (change) => {
    const changed = structuredClone(boundPacket);
    change(changed);
    inspectPacket(changed, 1, 1);
    reject(() =>
      inspectFrozenSourceBinding(changed, syntheticFixtureBytes, syntheticBlob),
    );
  };
  mutateBound((changed) => {
    const candidate = changed.cases[0].candidates[0];
    candidate.passage += " forged";
    candidate.passageSha256 = hash(candidate.passage);
    candidate.sourceEndOffsetUtf16 += " forged".length;
  });
  mutateBound((changed) => {
    changed.cases[0].candidates[0].sourceUnitSha256 = hash("other unit");
  });
  mutateBound((changed) => {
    changed.cases[0].candidates[0].candidateKey = hash("other candidate");
  });
  mutateBound((changed) => {
    changed.cases[0].candidates[0].sourceStartOffsetUtf16 = 1;
    changed.cases[0].candidates[0].sourceEndOffsetUtf16 = passage.length + 1;
  });
  mutateBound((changed) => {
    changed.sourceSha256[syntheticSourceId] = hash("other source");
  });
  mutateBound((changed) => {
    changed.candidateOrder = "RETRIEVAL_RANK";
  });
  const differentQuote = inspectAnnotations(
    index,
    encodeCsv([
      { ...row, quoteStartOffsetUtf16: "0", quoteEndOffsetUtf16: "3" },
    ]),
  );
  const disagreement = compareAnnotations(parsed, differentQuote);
  assert.equal(disagreement.disagreements[0]?.kind, "QUOTE_DISAGREEMENT");
  const disputeRows = disputeTemplateRows(index, disagreement.disagreements);
  assert.equal(disputeRows.length, 1);
  assert.equal(disputeRows[0].verdict, "");
  assert.equal(disputeRows[0].passage, passage);
  const disputedKeys = new Set(disagreement.disagreements.map((d) => d.key));
  assert.equal(
    inspectAnnotations(index, encodeCsv([row]), disputedKeys).size,
    1,
  );
  reject(() => inspectAnnotations(index, encodeCsv([]), disputedKeys));
  reject(() =>
    inspectAnnotations(index, encodeCsv([row]), new Set(["other:dispute"])),
  );
  reject(() =>
    inspectAnnotations(
      index,
      encodeCsv([{ ...row, passage: "forged" }]),
      disputedKeys,
    ),
  );
  reject(() => assertSafeOutputPath("reviewer-a.csv", ["reviewer-a.csv"]));
  return {
    mutationCases: 17,
    sourceBindingMutationCases: 6,
    disputeResolutionMutationCases: 3,
    status: "PASSED",
  };
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
  const packetData = JSON.parse(bytes.toString("utf8"));
  const packet = inspectPacket(packetData);
  const sourceBinding = inspectFrozenSourceBinding(
    packetData,
    await readFile(frozenFixture),
  );
  const reviewerA = args.get("--reviewer-a");
  const reviewerB = args.get("--reviewer-b");
  const disputeOutput = args.get("--disputes-output");
  const resolutionPath = args.get("--resolution");
  const adjudicatorId = args.get("--adjudicator-id");
  if (Boolean(reviewerA) !== Boolean(reviewerB)) fail("REVIEW_PAIR_REQUIRED");
  if (!reviewerA && (disputeOutput || resolutionPath || adjudicatorId))
    fail("REVIEW_PAIR_REQUIRED_FOR_DISPUTES");
  if (Boolean(resolutionPath) !== Boolean(adjudicatorId))
    fail("THIRD_ADJUDICATOR_ID_AND_FILE_REQUIRED");
  if (reviewerA && !args.has("--packet-sha256")) {
    fail("PINNED_PACKET_SHA256_REQUIRED_FOR_REVIEW");
  }
  const report = {
    schemaVersion: "akp.s2.adjudication-integrity.v1",
    status: reviewerA
      ? "TWO_SUBMISSIONS_VALIDATED_HUMAN_ORIGIN_UNVERIFIED"
      : "UNADJUDICATED_PACKET_VALIDATED",
    packetSha256,
    sourceBinding,
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
    const first = inspectAnnotations(packet, bytesA.toString("utf8"));
    const second = inspectAnnotations(packet, bytesB.toString("utf8"));
    report.agreement = compareAnnotations(first, second);
    const disputes = report.agreement.disagreements;
    report.disputeResolution = {
      status: disputes.length
        ? "UNRESOLVED_PENDING_THIRD_REVIEW"
        : "NO_DISAGREEMENTS_HUMAN_ORIGIN_UNVERIFIED",
      disputedPairs: disputes.length,
      thirdSubmissionValidated: false,
      independentHumanOriginVerified: false,
    };
    if (disputeOutput) {
      assertSafeOutputPath(disputeOutput, [
        args.get("--packet"),
        reviewerA,
        reviewerB,
        resolutionPath,
        args.get("--output"),
      ]);
      const csv = encodeCsv(disputeTemplateRows(packet, disputes));
      const file = path.resolve(disputeOutput);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, csv, "utf8");
      report.disputeTemplate = {
        sha256: hash(csv),
        rowCount: disputes.length,
        containsReviewerVerdicts: false,
        containsGoldLabels: false,
      };
    }
    if (resolutionPath) {
      if (!disputes.length) fail("THIRD_REVIEW_NOT_NEEDED");
      if (
        adjudicatorId === idA ||
        adjudicatorId === idB ||
        !adjudicatorId.trim()
      )
        fail("DISTINCT_THIRD_ADJUDICATOR_REQUIRED");
      const bytesThird = await readFile(path.resolve(resolutionPath));
      const disputedKeys = new Set(disputes.map((item) => item.key));
      const third = inspectAnnotations(
        packet,
        bytesThird.toString("utf8"),
        disputedKeys,
      );
      report.disputeResolution = {
        status: "THIRD_SUBMISSION_VALIDATED_HUMAN_ORIGIN_UNVERIFIED",
        disputedPairs: disputes.length,
        resolvedPairCount: third.size,
        thirdSubmissionValidated: true,
        thirdReviewerId: adjudicatorId,
        thirdCsvSha256: hash(bytesThird),
        independentHumanOriginVerified: false,
      };
    }
  }
  if (args.has("--output")) {
    assertSafeOutputPath(args.get("--output"), [
      args.get("--packet"),
      reviewerA,
      reviewerB,
      resolutionPath,
      disputeOutput,
    ]);
    const file = path.resolve(args.get("--output"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify(report) + "\n");
}
