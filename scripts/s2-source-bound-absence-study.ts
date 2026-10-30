/**
 * Eight source-family-reused questions with no explicit answer in the original
 * excerpt. Offline shadow writer study, not production HTTP, FAR or a human gold.
 * Run --freeze then --capture then --score. Raw provider bytes are immutable.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { attributeS2VerbatimQuote } from "../packages/evaluation/src/s2-exact-quote-attribution.js";
const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "evals/fixtures/s2-source-bound-relation-dev");
const dest = path.join(
  root,
  ".work/s2-public-source-diverse-20261022/RUN-S2-WRITER-NO-ANSWER-20261024",
);
const raw = path.join(dest, "RAW");
const model = "qwen2.5:7b-instruct";
const sha = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
interface SourceCase {
  id: string;
  language: string;
  family: string;
  sourceId: string;
  sourceText: string;
  question: string;
}
interface AbsentCase {
  id: string;
  sourceCaseId: string;
  language: string;
  question: string;
  expected: string;
}
type Item = {
  id: string;
  source: SourceCase;
  question: string;
  language: string;
};
const bytes = async (n: string) => readFile(path.join(dir, n));
const resultPath = (n: string) => path.join(dest, n);
function makeOriginal(c: SourceCase) {
  const exactUtf8Bytes = Buffer.from(c.sourceText, "utf8");
  return {
    assignedSourceId: c.sourceId,
    sourceSha256: sha(exactUtf8Bytes),
    exactUtf8Bytes,
    bodyStartUtf16: 0,
    bodyEndUtf16: c.sourceText.length,
  };
}
async function fixture() {
  const [a, b] = await Promise.all([
    bytes("cases.json"),
    bytes("absent-writer.json"),
  ]);
  const refs = JSON.parse(a.toString()) as { cases: SourceCase[] };
  const design = JSON.parse(b.toString()) as {
    schemaVersion: string;
    authorPreparedNotIndependent: boolean;
    cases: AbsentCase[];
  };
  if (
    design.schemaVersion !== "akp.s2.dev-absent-writer-cases.v1" ||
    design.authorPreparedNotIndependent !== true ||
    design.cases.length !== 8 ||
    new Set(design.cases.map((x) => x.id)).size !== 8
  )
    throw Error("ABSENCE_DESIGN_INVALID");
  const cases: Item[] = design.cases.map((x) => {
    const source = refs.cases.find((s) => s.id === x.sourceCaseId);
    if (
      !source ||
      x.language !== source.language ||
      x.expected !== "NO_EXPLICIT_ANSWER_IN_AUTHORIZED_EXCERPT" ||
      !x.question.trim() ||
      x.question.length > 2048
    )
      throw Error("ABSENCE_SOURCE_IDENTITY_INVALID");
    return { id: x.id, source, question: x.question, language: x.language };
  });
  if (
    new Set(cases.map((x) => x.source.family)).size !== 8 ||
    cases.filter((x) => x.language === "en").length !== 4 ||
    cases.filter((x) => x.language === "es").length !== 4
  )
    throw Error("ABSENCE_FAMILY_OR_LANGUAGE_UNBALANCED");
  return { cases, sourceSha256: sha(a), designSha256: sha(b) };
}
function request(c: Item) {
  return {
    model,
    stream: false,
    options: { temperature: 0, num_predict: 130 },
    format: {
      type: "object",
      additionalProperties: false,
      required: ["abstained", "answerText", "evidenceToken"],
      properties: {
        abstained: { type: "boolean" },
        answerText: { type: "string" },
        evidenceToken: { type: "string", enum: ["NONE", "Q1"] },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Answer only from the given authorized source. If the exact question is not explicitly answerable, abstain=true, answerText='', evidenceToken='NONE'. If explicitly answerable, abstained=false, answerText=the shortest sufficient answer in the question's language, evidenceToken='Q1'. Do not add unsupported details. Your selected Q1 is an evidence proposal, not proof of correctness. Output only JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          originalQuestion: c.question,
          verifiedSourceId: c.source.sourceId,
          verifiedSourceSha256: makeOriginal(c.source).sourceSha256,
          sourceExcerptQ1: c.source.sourceText,
        }),
      },
    ],
  };
}
async function modelDigest() {
  const d = (await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json())) as { models: { name: string; digest: string }[] };
  const s = d.models.find((x) => x.name === model)?.digest;
  if (!s || !/^[0-9a-f]{64}$/u.test(s)) throw Error("MODEL_NOT_PINNED");
  return s;
}
async function precheck() {
  const f = await fixture();
  const plan = JSON.parse(
    (await readFile(resultPath("PRECAPTURE.json"))).toString(),
  ) as {
    schemaVersion: string;
    sourceSha256: string;
    designSha256: string;
    modelDigest: string;
    jobs: {
      id: string;
      sha256: string;
      sourceSha256: string;
      questionSha256: string;
    }[];
  };
  if (
    plan.schemaVersion !== "akp.s2.absent-writer-precapture.v1" ||
    plan.jobs.length !== 8 ||
    plan.sourceSha256 !== f.sourceSha256 ||
    plan.designSha256 !== f.designSha256
  )
    throw Error("ABSENCE_PREREG_CHANGED");
  for (const c of f.cases) {
    const j = plan.jobs.find((x) => x.id === c.id);
    const b = await readFile(path.join(raw, c.id + ".request"));
    if (
      !j ||
      j.sha256 !== sha(b) ||
      j.sourceSha256 !== makeOriginal(c.source).sourceSha256 ||
      j.questionSha256 !== sha(c.question) ||
      b.toString() !== JSON.stringify(request(c))
    )
      throw Error("ABSENCE_REQUEST_OR_SOURCE_DRIFT");
  }
  return {
    ...f,
    plan,
    preSha256: sha(await readFile(resultPath("PRECAPTURE.json"))),
  };
}
async function freeze() {
  const f = await fixture();
  const digest = await modelDigest();
  await mkdir(dest, { recursive: false });
  await mkdir(raw, { recursive: false });
  const jobs = f.cases.map((c) => {
    const b = Buffer.from(JSON.stringify(request(c)));
    return {
      id: c.id,
      sha256: sha(b),
      sourceSha256: makeOriginal(c.source).sourceSha256,
      questionSha256: sha(c.question),
    };
  });
  const manifest = {
    schemaVersion: "akp.s2.absent-writer-precapture.v1",
    sourceSha256: f.sourceSha256,
    designSha256: f.designSha256,
    model,
    modelDigest: digest,
    jobs,
    designerAuthoredGoldNotIndependent: true,
    sourcesReusedFromRelationDev: true,
    productionAdmission: false,
  };
  const b = Buffer.from(json(manifest));
  await writeFile(resultPath("PRECAPTURE.json"), b, { flag: "wx" });
  for (const c of f.cases)
    await writeFile(
      path.join(raw, c.id + ".request"),
      JSON.stringify(request(c)),
      { flag: "wx" },
    );
  console.log(
    "ABSENCE_FROZEN " +
      JSON.stringify({ jobs: jobs.length, precaptureSha256: sha(b) }),
  );
}
async function capture() {
  const { cases, plan, preSha256 } = await precheck();
  if ((await modelDigest()) !== plan.modelDigest)
    throw Error("ABSENCE_MODEL_DRIFT");
  const rows = [];
  for (const [i, c] of cases.entries()) {
    const b = await readFile(path.join(raw, c.id + ".request"));
    let status = 0,
      body: Buffer;
    const start = performance.now();
    try {
      const response = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: b,
        signal: AbortSignal.timeout(180000),
      });
      status = response.status;
      body = Buffer.from(await response.arrayBuffer());
    } catch (e) {
      body = Buffer.from(JSON.stringify({ clientError: String(e) }));
    }
    await writeFile(path.join(raw, c.id + ".response"), body, { flag: "wx" });
    let providerComplete = false;
    try {
      const env = JSON.parse(body.toString());
      providerComplete =
        status === 200 &&
        env.done === true &&
        env.done_reason === "stop" &&
        typeof env.message?.content === "string";
    } catch {}
    const row = {
      id: c.id,
      httpStatus: status,
      providerComplete,
      requestSha256: sha(b),
      responseSha256: sha(body),
      elapsedMs: Math.round(performance.now() - start),
    };
    rows.push(row);
    console.log(
      "ABSENCE_CAPTURE " +
        (i + 1) +
        "/8 " +
        c.id +
        " completed=" +
        providerComplete,
    );
  }
  const b = Buffer.from(
    json({
      schemaVersion: "akp.s2.absent-writer-unscored.v1",
      preSha256,
      rawFrozen: true,
      independentAdjudication: false,
      rows,
    }),
  );
  await writeFile(resultPath("UNSCORED_COMPLETE.json"), b, { flag: "wx" });
  console.log(
    "ABSENCE_UNSCORED " +
      JSON.stringify({
        sha256: sha(b),
        providerComplete: rows.filter((x) => x.providerComplete).length,
      }),
  );
}

async function score(verifyExisting = false) {
  const { cases, preSha256 } = await precheck();
  const resultBytes = await readFile(resultPath("UNSCORED_COMPLETE.json"));
  const run = JSON.parse(resultBytes.toString()) as {
    schemaVersion: string;
    preSha256: string;
    rawFrozen: boolean;
    rows: {
      id: string;
      providerComplete: boolean;
      responseSha256: string;
      requestSha256: string;
      elapsedMs: number;
    }[];
  };
  if (
    run.schemaVersion !== "akp.s2.absent-writer-unscored.v1" ||
    run.preSha256 !== preSha256 ||
    run.rawFrozen !== true ||
    run.rows?.length !== 8
  )
    throw Error("ABSENCE_UNSCORED_NOT_COMPLETE");
  const details: Array<{
    language: string;
    consistent: boolean;
    abstained: boolean | null;
    nonAbstainingSourceBoundProposal: boolean;
    [key: string]: unknown;
  }> = [];
  for (const c of cases) {
    const r = run.rows.find((x) => x.id === c.id);
    if (
      !r ||
      sha(await readFile(path.join(raw, c.id + ".request"))) !== r.requestSha256
    )
      throw Error("ABSENCE_SOURCE_REQUEST_CHANGED");
    const b = await readFile(path.join(raw, c.id + ".response"));
    if (sha(b) !== r.responseSha256) throw Error("ABSENCE_RESPONSE_SHA_DRIFT");
    let value: unknown = null;
    try {
      const x = JSON.parse(b.toString());
      if (r.providerComplete) value = JSON.parse(x.message.content);
    } catch {}
    const valid =
      typeof value === "object" && value !== null && !Array.isArray(value);
    const output = valid ? (value as Record<string, unknown>) : {};
    const structurallyValid =
      valid &&
      Object.keys(output).sort().join(",") ===
        "abstained,answerText,evidenceToken" &&
      typeof output.abstained === "boolean" &&
      typeof output.answerText === "string" &&
      ["Q1", "NONE"].includes(String(output.evidenceToken));
    const abstained = structurallyValid ? output.abstained === true : null;
    const answer = structurallyValid ? String(output.answerText) : null;
    const consistent =
      structurallyValid &&
      ((abstained === true &&
        answer === "" &&
        output.evidenceToken === "NONE") ||
        (abstained === false &&
          answer !== null &&
          answer.length > 0 &&
          answer.length <= 2048 &&
          answer.trim() === answer &&
          output.evidenceToken === "Q1"));
    const attribution =
      consistent && abstained === false
        ? attributeS2VerbatimQuote(
            {
              abstained: false,
              answerText: answer!,
              evidenceQuote: c.source.sourceText,
              sourceId: c.source.sourceId,
            },
            [makeOriginal(c.source)],
          )
        : null;
    const bound = attribution?.status === "VERBATIM_UNIQUE_SOURCE_BOUND";
    details.push({
      id: c.id,
      language: c.language,
      family: c.source.family,
      sourceSha256: makeOriginal(c.source).sourceSha256,
      providerResponseSha256: r.responseSha256,
      questionSha256: sha(c.question),
      consistent,
      abstained,
      answerText: answer,
      originalSourceBound: bound ?? false,
      nonAbstainingSourceBoundProposal:
        consistent && abstained === false && bound,
      independentlyAdjudicated: false,
      finalAnswerFARNotMeasured: true,
      productionAdmission: false,
    });
  }
  const summary = {
    all: {
      cases: 8,
      explicitAbstentions: details.filter(
        (x) => x.consistent && x.abstained === true,
      ).length,
      nonAbstainingSourceBoundProposals: details.filter(
        (x) => x.nonAbstainingSourceBoundProposal,
      ).length,
      malformedOrInconsistent: details.filter((x) => !x.consistent).length,
    },
    byLanguage: Object.fromEntries(
      ["en", "es"].map((lang) => {
        const d = details.filter((x) => x.language === lang);
        return [
          lang,
          {
            cases: d.length,
            explicitAbstentions: d.filter(
              (x) => x.consistent && x.abstained === true,
            ).length,
            nonAbstainingProposals: d.filter(
              (x) => x.nonAbstainingSourceBoundProposal,
            ).length,
          },
        ];
      }),
    ),
  };
  const report = {
    schemaVersion: "akp.s2.absent-writer-postrun-dev.v1",
    preSha256,
    unscoredSha256: sha(resultBytes),
    sourceFamilyReusedFromEarlierDev: true,
    developerPreparedAbsenceLabelsNotIndependent: true,
    allEightQuestionsIntendedToBeUnansweredByGivenSource: true,
    notAuthenticatedHttpEndpoint: true,
    noIndependentFullAnswerAdjudication: true,
    productionAdmission: false,
    releaseGateAccepted: false,
    summary,
    details,
  };
  const b = Buffer.from(json(report));
  const reportPath = resultPath("PRIVATE_DEV_SCORE.json");
  if (verifyExisting) {
    const stored = await readFile(reportPath);
    if (!stored.equals(b))
      throw Error("IMMUTABLE_ABSENCE_SCORE_REPLAY_CHANGED");
  } else {
    await writeFile(reportPath, b, { flag: "wx" });
  }
  console.log(
    "ABSENCE_DEV_SCORE " +
      JSON.stringify({
        sha256: sha(b),
        summary,
        notProductionFAR: true,
        independentAdjudication: false,
      }),
  );
}
const mode = process.argv[2];
if (mode === "--freeze") await freeze();
else if (mode === "--capture") await capture();
else if (mode === "--score") await score();
else if (mode === "--verify") await score(true);
else throw Error("ABSENCE_STUDY_REQUIRES_FREEZE_CAPTURE_SCORE");
