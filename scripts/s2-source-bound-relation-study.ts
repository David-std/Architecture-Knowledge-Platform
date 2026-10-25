/**
 * Shadow-only source-bound question/claim relationship study.
 * Stages: --freeze (no model or gold reads), --capture (pinned Ollama),
 * --score (ONLY after complete, SHA-checked raw captures).
 * Developer-authored fictional DEV labels are not independent adjudication.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessS2QuoteSemantics } from "../packages/evaluation/src/s2-semantic-evidence.js";
import { createS2PairedSemanticPorts } from "../packages/evaluation/src/s2-paired-semantic-probe.js";
import { attributeS2VerbatimQuote } from "../packages/evaluation/src/s2-exact-quote-attribution.js";
import {
  freezeS2QuoteEvidenceOptions,
  buildS2PairedQuoteEvidenceTokenFormat,
  resolveS2QuoteEvidenceToken,
} from "../packages/evaluation/src/s2-quote-evidence-choice.js";
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const repo = path.resolve(import.meta.dirname, "..");
const datasetDir = path.join(
  repo,
  "evals/fixtures/s2-source-bound-relation-dev",
);
const runDir = path.join(
  repo,
  ".work/s2-public-source-diverse-20261022/RUN-S2-RELATION-FAMILY-DISJOINT-20261024",
);
const rawDir = path.join(runDir, "RAW");
type Case = {
  id: string;
  family: string;
  language: "en" | "es";
  sourceId: string;
  sourceText: string;
  question: string;
  proposedAnswer: string;
  claim: string;
};
type Manifest = {
  schemaVersion: string;
  cases: Case[];
  syntheticFictionalSources: boolean;
  developerAuthoredFixture: boolean;
};
type Job = {
  id: string;
  caseId: string;
  model: string;
  kind: "RELATION" | "WRITER";
  requestSha256: string;
  filename: string;
};
const models = ["qwen2.5:7b-instruct", "gemma3:4b"] as const;
const dimensions = [
  "subject",
  "predicate",
  "direction",
  "polarity",
  "modality",
  "temporal",
  "conditions",
  "answerRole",
] as const;
const dimensionSchema = {
  type: "string",
  enum: ["ALIGNED", "CONFLICT", "UNKNOWN"],
} as const;
const simple = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const original = (c: Case) => {
  const exactUtf8Bytes = Buffer.from(c.sourceText, "utf8");
  return {
    assignedSourceId: c.sourceId,
    sourceSha256: sha(exactUtf8Bytes),
    exactUtf8Bytes,
    bodyStartUtf16: 0,
    bodyEndUtf16: c.sourceText.length,
  };
};
const quoteFormat = (c: Case) => {
  const frozen = freezeS2QuoteEvidenceOptions(c.sourceText);
  return buildS2PairedQuoteEvidenceTokenFormat(c.sourceText, frozen);
};
const relationRequest = (c: Case, model: string) => {
  const quote = quoteFormat(c);
  const allowed = quote.properties.questionToken.enum;
  return {
    model,
    stream: false,
    options: { temperature: 0, num_predict: 220 },
    format: {
      type: "object",
      additionalProperties: false,
      required: ["questionToken", "claimToken", ...dimensions],
      properties: {
        questionToken: { type: "string", enum: allowed },
        claimToken: { type: "string", enum: allowed },
        ...Object.fromEntries(dimensions.map((x) => [x, dimensionSchema])),
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Assess ONLY the exact source excerpt against the complete user question, proposed answer and declarative claim. Return questionToken and claimToken from their frozen enums (SUPPORTS@Q1, CONTRADICTS@Q1, INSUFFICIENT@NONE). Check subject, predicate, direction, polarity, modality (may vs must), temporal scope, conditions and requested answer role independently. Use CONFLICT for a changed relation or condition, UNKNOWN for unestablished details; ALIGNED only for supported details. Do not infer what the source does not explicitly establish. A question is not a factual proposition and cannot be contradicted as a question. No evidence may be invented. Output only valid JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          originalQuestion: c.question,
          proposedAnswer: c.proposedAnswer,
          completeDeclarativeClaim: c.claim,
          verifiedSourceId: c.sourceId,
          verifiedSourceSha256: original(c).sourceSha256,
          exactSourceQuote: c.sourceText,
        }),
      },
    ],
  };
};
const writerRequest = (c: Case) => ({
  model: models[0],
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
        verifiedSourceId: c.sourceId,
        verifiedSourceSha256: original(c).sourceSha256,
        sourceExcerptQ1: c.sourceText,
      }),
    },
  ],
});
async function inputs() {
  const [bytes] = await Promise.all([
    readFile(path.join(datasetDir, "cases.json")),
  ]);
  const m = JSON.parse(bytes.toString("utf8")) as Manifest;
  if (
    m.schemaVersion !== "akp.s2.relation-dev-cases.v1" ||
    m.developerAuthoredFixture !== true ||
    m.syntheticFictionalSources !== true ||
    m.cases?.length !== 16
  )
    throw Error("DEV_CASES_INVALID");
  const ids = new Set<string>();
  const families = new Set<string>();
  for (const c of m.cases) {
    if (
      !c ||
      ids.has(c.id) ||
      !c.id ||
      !["en", "es"].includes(c.language) ||
      !c.family ||
      !c.question ||
      !c.proposedAnswer ||
      !c.claim ||
      !c.sourceText ||
      c.sourceText.length < 50 ||
      c.sourceText.length > 1400
    )
      throw Error("DEV_CASE_INVALID_OR_DUPLICATE");
    ids.add(c.id);
    families.add(c.family);
    freezeS2QuoteEvidenceOptions(c.sourceText);
  }
  if (
    families.size !== 8 ||
    m.cases.filter((c) => c.language === "en").length !== 8 ||
    m.cases.filter((c) => c.language === "es").length !== 8
  )
    throw Error("DEV_BALANCE_INVALID");
  return { cases: m.cases, bytes };
}
const readJson = async (filename: string) =>
  JSON.parse((await readFile(path.join(runDir, filename))).toString("utf8"));

async function freeze() {
  const { cases, bytes } = await inputs();
  // The label file is byte-hashed for an immutable commitment; it is NOT parsed
  // until --score after every raw model response has been durably frozen.
  const labelBytes = await readFile(path.join(datasetDir, "dev-labels.json"));
  const tags = (await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json())) as { models: { name: string; digest: string }[] };
  const modelDigests = Object.fromEntries(
    models.map((m) => {
      const match = tags.models.find((x) => x.name === m);
      if (!match || !/^[a-f0-9]{64}$/u.test(match.digest))
        throw Error("OLLAMA_MODEL_DIGEST_NOT_PINNED_" + m);
      return [m, match.digest];
    }),
  );
  const jobs: Job[] = [];
  const writes: { filename: string; bytes: Buffer }[] = [];
  for (const c of cases) {
    for (const [i, model] of models.entries()) {
      const filename = c.id + "-" + (i === 0 ? "qwen" : "gemma") + "-REL";
      const requestBytes = Buffer.from(
        JSON.stringify(relationRequest(c, model)),
        "utf8",
      );
      jobs.push({
        id: filename,
        caseId: c.id,
        model,
        kind: "RELATION",
        requestSha256: sha(requestBytes),
        filename,
      });
      writes.push({ filename, bytes: requestBytes });
    }
    const filename = c.id + "-qwen-WRITER";
    const requestBytes = Buffer.from(JSON.stringify(writerRequest(c)), "utf8");
    jobs.push({
      id: filename,
      caseId: c.id,
      model: models[0],
      kind: "WRITER",
      requestSha256: sha(requestBytes),
      filename,
    });
    writes.push({ filename, bytes: requestBytes });
  }
  if (jobs.length !== 48) throw Error("EXPECTED_48_FROZEN_REQUESTS");
  await mkdir(runDir, { recursive: false });
  await mkdir(rawDir, { recursive: false });
  const plan = {
    schemaVersion: "akp.s2.source-bound-relation-dev-precapture.v1",
    executedCommitSha:
      process.env.AKP_S2_EXPERIMENT_BASE_SHA ??
      "3f587776a1f1771ea6b76d6ffb86ec74b2a6c399",
    casesSha256: sha(bytes),
    devLabelsSha256: sha(labelBytes),
    labelsParsedBeforeCapture: false,
    sourceAuthenticationProductionReplayed: false,
    developerAuthoredGoldNotIndependent: true,
    experimentalOnly: true,
    syntheticFictionalSources: true,
    modelDigests,
    sourceFrames: cases.map((c) => ({
      id: c.id,
      sourceId: c.sourceId,
      sourceSha256: original(c).sourceSha256,
      sourceStartUtf16: 0,
      sourceEndUtf16: c.sourceText.length,
      questionSha256: sha(c.question),
      claimSha256: sha(c.claim),
    })),
    jobs,
    roleDimensions: [...dimensions],
    requestCount: jobs.length,
    releaseGateAccepted: false,
  };
  const manifestBytes = Buffer.from(json(plan), "utf8");
  await writeFile(path.join(runDir, "PRECAPTURE.json"), manifestBytes, {
    flag: "wx",
  });
  for (const w of writes)
    await writeFile(path.join(rawDir, w.filename + ".request"), w.bytes, {
      flag: "wx",
    });
  console.log(
    "S2_RELATION_FROZEN " +
      JSON.stringify({
        cases: cases.length,
        jobs: jobs.length,
        preCaptureSha256: sha(manifestBytes),
        labelsSha256: sha(labelBytes),
      }),
  );
}
async function checkFrozen() {
  const { cases, bytes } = await inputs();
  const plan = (await readJson("PRECAPTURE.json")) as {
    schemaVersion: string;
    casesSha256: string;
    devLabelsSha256: string;
    modelDigests: Record<string, string>;
    jobs: Job[];
    requestCount: number;
    sourceFrames: {
      id: string;
      sourceSha256: string;
      claimSha256: string;
      questionSha256: string;
    }[];
  };
  if (
    plan.schemaVersion !== "akp.s2.source-bound-relation-dev-precapture.v1" ||
    sha(bytes) !== plan.casesSha256 ||
    plan.requestCount !== 48 ||
    plan.jobs?.length !== 48 ||
    plan.sourceFrames?.length !== 16
  )
    throw Error("SOURCE_OR_FREEZE_DRIFT");
  const labelBytes = await readFile(path.join(datasetDir, "dev-labels.json"));
  if (sha(labelBytes) !== plan.devLabelsSha256)
    throw Error("DEV_LABELS_CHANGED_SINCE_PRECAPTURE");
  for (const c of cases) {
    const f = plan.sourceFrames.find((x) => x.id === c.id);
    if (
      !f ||
      f.sourceSha256 !== original(c).sourceSha256 ||
      f.questionSha256 !== sha(c.question) ||
      f.claimSha256 !== sha(c.claim)
    )
      throw Error("ORIGINAL_SOURCE_FRAME_CHANGED");
  }
  for (const j of plan.jobs) {
    const b = await readFile(path.join(rawDir, j.filename + ".request"));
    const c = cases.find((x) => x.id === j.caseId);
    if (
      !c ||
      sha(b) !== j.requestSha256 ||
      JSON.stringify(
        j.kind === "RELATION" ? relationRequest(c, j.model) : writerRequest(c),
      ) !== b.toString("utf8")
    )
      throw Error("REQUEST_SHA_OR_BYTES_CHANGED_" + j.id);
  }
  return {
    cases,
    plan,
    preCaptureSha256: sha(await readFile(path.join(runDir, "PRECAPTURE.json"))),
  };
}
async function capture() {
  const { plan, preCaptureSha256 } = await checkFrozen();
  const tags = (await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(10000),
  }).then((x) => x.json())) as { models: { name: string; digest: string }[] };
  for (const [model, digest] of Object.entries(plan.modelDigests))
    if (tags.models.find((x) => x.name === model)?.digest !== digest)
      throw Error("MODEL_DIGEST_DRIFT");
  const rows = [];
  for (const [i, j] of plan.jobs.entries()) {
    const requestBytes = await readFile(
      path.join(rawDir, j.filename + ".request"),
    );
    let body: Buffer,
      status = 0;
    const start = performance.now();
    try {
      const response = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBytes,
        signal: AbortSignal.timeout(180000),
      });
      status = response.status;
      body = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      body = Buffer.from(JSON.stringify({ clientError: String(err) }), "utf8");
    }
    const elapsedMs = Math.round(performance.now() - start);
    await writeFile(path.join(rawDir, j.filename + ".response"), body, {
      flag: "wx",
    });
    let providerComplete = false;
    try {
      const x = JSON.parse(body.toString("utf8"));
      providerComplete =
        status === 200 &&
        x.done === true &&
        x.done_reason === "stop" &&
        typeof x.message?.content === "string";
    } catch {}
    rows.push({
      id: j.id,
      model: j.model,
      kind: j.kind,
      caseId: j.caseId,
      requestSha256: j.requestSha256,
      responseSha256: sha(body),
      httpStatus: status,
      providerComplete,
      elapsedMs,
    });
    console.log(
      "S2_RELATION_" +
        (i + 1) +
        "/" +
        plan.jobs.length +
        " " +
        j.id +
        " completed=" +
        providerComplete +
        " elapsedMs=" +
        elapsedMs,
    );
  }
  const out = Buffer.from(
    json({
      schemaVersion: "akp.s2.source-bound-relation-unscored.v1",
      preCaptureSha256,
      requestCount: plan.jobs.length,
      allProviderBytesFrozen: true,
      labelsParsed: false,
      adjudicationIndependent: false,
      productionAdmission: false,
      rows,
    }),
    "utf8",
  );
  await writeFile(path.join(runDir, "UNSCORED_COMPLETE.json"), out, {
    flag: "wx",
  });
  console.log(
    "S2_RELATION_UNSCORED " +
      JSON.stringify({
        rows: rows.length,
        completed: rows.filter((x) => x.providerComplete).length,
        unscoredSha256: sha(out),
      }),
  );
}

async function score(verifyExisting = false) {
  const { cases, plan, preCaptureSha256 } = await checkFrozen();
  const resultBytes = await readFile(
    path.join(runDir, "UNSCORED_COMPLETE.json"),
  );
  const run = JSON.parse(resultBytes.toString("utf8")) as {
    schemaVersion: string;
    preCaptureSha256: string;
    requestCount: number;
    allProviderBytesFrozen: boolean;
    rows: {
      id: string;
      responseSha256: string;
      requestSha256: string;
      providerComplete: boolean;
      elapsedMs: number;
    }[];
  };
  if (
    run.schemaVersion !== "akp.s2.source-bound-relation-unscored.v1" ||
    run.preCaptureSha256 !== preCaptureSha256 ||
    run.requestCount !== 48 ||
    run.allProviderBytesFrozen !== true ||
    run.rows?.length !== 48
  )
    throw Error("UNSCORED_PROVIDER_RUN_INCOMPLETE");
  const responses = new Map<string, unknown>();
  for (const j of plan.jobs) {
    const row = run.rows.find((x) => x.id === j.id);
    if (!row || row.requestSha256 !== j.requestSha256)
      throw Error("FROZEN_JOB_NOT_RECORDED");
    const b = await readFile(path.join(rawDir, j.filename + ".response"));
    if (sha(b) !== row.responseSha256)
      throw Error("RAW_PROVIDER_RESPONSE_DRIFT_" + j.id);
    let value: unknown = null;
    try {
      const env = JSON.parse(b.toString("utf8"));
      if (row.providerComplete && typeof env?.message?.content === "string")
        value = JSON.parse(env.message.content);
    } catch {}
    responses.set(j.id, value);
  }
  // Only now, after every request and response is verified, inspect labels.
  const gold = JSON.parse(
    (await readFile(path.join(datasetDir, "dev-labels.json"))).toString("utf8"),
  ) as {
    schemaVersion: string;
    independentlyAdjudicated: boolean;
    labels: {
      id: string;
      label: string;
      expectedAnswer: string | null;
      sourceFamily: string;
      language: string;
    }[];
  };
  if (
    gold.schemaVersion !== "akp.s2.relation-dev-labels.v1" ||
    gold.independentlyAdjudicated !== false ||
    gold.labels?.length !== 16 ||
    new Set(gold.labels.map((x) => x.id)).size !== 16
  )
    throw Error("UNTRUSTED_DEV_LABELS");
  const byGold = new Map(gold.labels.map((x) => [x.id, x]));
  for (const c of cases)
    if (
      !byGold.has(c.id) ||
      byGold.get(c.id)?.sourceFamily !== c.family ||
      byGold.get(c.id)?.language !== c.language
    )
      throw Error("GOLD_CASE_IDENTITY_DRIFT");
  const observations: Array<{
    gold: string;
    model: string;
    language: string;
    f3Supports: boolean;
    auditedCandidate: boolean;
    schemaValid: boolean;
    [key: string]: unknown;
  }> = [];
  for (const c of cases) {
    const orig = original(c),
      frozen = freezeS2QuoteEvidenceOptions(c.sourceText);
    for (const model of models) {
      const kind = model === models[0] ? "qwen" : "gemma";
      const id = c.id + "-" + kind + "-REL";
      const response = responses.get(id);
      const exactKeys = ["questionToken", "claimToken", ...dimensions]
        .sort()
        .join(",");
      const valid =
        simple(response) &&
        Object.keys(response).sort().join(",") === exactKeys &&
        dimensions.every((d) =>
          ["ALIGNED", "CONFLICT", "UNKNOWN"].includes(String(response[d])),
        );
      const question = resolveS2QuoteEvidenceToken(
        c.sourceText,
        frozen,
        valid ? response.questionToken : null,
      );
      const claim = resolveS2QuoteEvidenceToken(
        c.sourceText,
        frozen,
        valid ? response.claimToken : null,
      );
      const ports = createS2PairedSemanticPorts({
        id: "relation-dev@" + model + ":" + plan.modelDigests[model],
        verify: async (input) => {
          if (
            input.originalQuestion !== c.question ||
            input.answerClaim !== c.claim ||
            input.exactQuote !== c.sourceText ||
            input.verifiedSourceSha256 !== orig.sourceSha256 ||
            input.verifiedSourceId !== c.sourceId
          )
            throw Error("BOUND_READER_INPUT_CHANGED");
          return { questionRelevance: question, claimEntailment: claim };
        },
      });
      const f3 = await assessS2QuoteSemantics(
        c.question,
        {
          answerText: c.claim,
          evidenceQuote: c.sourceText,
          sourceId: c.sourceId,
          abstained: false,
        },
        [orig],
        {
          questionRelevanceProbe: ports.questionRelevanceProbe,
          claimEntailmentProbe: ports.claimEntailmentProbe,
          inspectClaimWhenQuestionUncertain: true,
        },
      );
      ports.clear();
      const f3Supports = f3.status === "SUPPORTED_CANDIDATE";
      const relationAllAligned =
        valid && dimensions.every((d) => response[d] === "ALIGNED");
      const auditedCandidate = f3Supports && relationAllAligned;
      const label = byGold.get(c.id)!;
      observations.push({
        id: c.id,
        family: c.family,
        language: c.language,
        model,
        gold: label.label,
        sourceSha256: orig.sourceSha256,
        questionSha256: sha(c.question),
        claimSha256: sha(c.claim),
        providerResponseSha256: run.rows.find((x) => x.id === id)
          ?.responseSha256,
        schemaValid: valid,
        dimensions: valid
          ? Object.fromEntries(dimensions.map((d) => [d, response[d]]))
          : null,
        quoteBound: f3.attribution.status === "VERBATIM_UNIQUE_SOURCE_BOUND",
        f3Status: f3.status,
        questionDecision: question.decision,
        claimDecision: claim.decision,
        f3Supports,
        relationAllAligned,
        auditedCandidate,
        candidateSemanticsIndependentlyVerified: false,
        productionAdmission: false,
      });
    }
  }
  const writers = cases.map((c) => {
    const id = c.id + "-qwen-WRITER";
    const response = responses.get(id);
    const label = byGold.get(c.id)!;
    const shape =
      simple(response) &&
      Object.keys(response).sort().join(",") ===
        "abstained,answerText,evidenceToken" &&
      typeof response.abstained === "boolean" &&
      typeof response.answerText === "string" &&
      ["NONE", "Q1"].includes(String(response.evidenceToken));
    const abstained = shape ? response.abstained : null;
    const answerText = shape ? String(response.answerText) : null;
    const consistent =
      shape &&
      ((abstained === true &&
        answerText === "" &&
        response.evidenceToken === "NONE") ||
        (abstained === false &&
          answerText!.trim().length > 0 &&
          answerText!.length <= 2048 &&
          response.evidenceToken === "Q1"));
    const attribution =
      consistent && abstained === false
        ? attributeS2VerbatimQuote(
            {
              abstained: false,
              answerText: answerText!,
              sourceId: c.sourceId,
              evidenceQuote: c.sourceText,
            },
            [original(c)],
          )
        : null;
    const sourceBound = attribution?.status === "VERBATIM_UNIQUE_SOURCE_BOUND";
    const emitted = consistent && abstained === false && sourceBound;
    const expected = label.expectedAnswer;
    const lexicalAnswerAnchor =
      emitted && expected !== null
        ? answerText!.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
        : false;
    return {
      id: c.id,
      family: c.family,
      language: c.language,
      gold: label.label,
      writerModel: models[0],
      rawResponseSha256: run.rows.find((x) => x.id === id)?.responseSha256,
      structuredAndConsistent: consistent,
      abstained,
      sourceBound: sourceBound ?? false,
      answerText,
      sourceAttributedWriterProposalEmitted: emitted,
      lexicalAnswerAnchor,
      wholeAnswerIndependentlyAdjudicated: false,
      actualHttpEndpointAnswerNotRun: true,
      productionAdmission: false,
    };
  });
  const metric = (subset: typeof observations) => {
    const pos = subset.filter((x) => x.gold === "EXPLICIT_SUPPORT");
    const neg = subset.filter((x) => x.gold === "NOT_ANSWERABLE");
    return {
      positives: pos.length,
      negatives: neg.length,
      f3PositiveProposals: pos.filter((x) => x.f3Supports).length,
      f3FalseSupportProposals: neg.filter((x) => x.f3Supports).length,
      relationPositiveProposals: pos.filter((x) => x.auditedCandidate).length,
      relationFalseSupportProposals: neg.filter((x) => x.auditedCandidate)
        .length,
      positiveProposalsWithheld: pos.filter((x) => !x.auditedCandidate).length,
      structurallyInvalid: subset.filter((x) => !x.schemaValid).length,
    };
  };
  const durations = run.rows.map((x) => x.elapsedMs).sort((a, b) => a - b);
  const writerPos = writers.filter((x) => x.gold === "EXPLICIT_SUPPORT");
  const writerNeg = writers.filter((x) => x.gold === "NOT_ANSWERABLE");
  const result = {
    schemaVersion: "akp.s2.relation-dev-postrun-score.v1",
    preCaptureSha256,
    unscoredSha256: sha(resultBytes),
    devLabelsSha256: plan.devLabelsSha256,
    syntheticFictionalSources: true,
    developerAuthoredGoldNotIndependent: true,
    sourceFamilyDisjointFromPriorE5XquadByDesignOnly: true,
    labelsInspectedAfterCompleteFrozenCaptures: true,
    fullClaimIndependentTruthNotCertified: true,
    zeroProductionAdmission: true,
    noRuntimeGateChange: true,
    totalProviderCalls: run.rows.length,
    providerComplete: run.rows.filter((x) => x.providerComplete).length,
    localOllamaRequestP95Ms: durations[Math.ceil(0.95 * durations.length) - 1],
    localOllamaNotAuthenticatedHttpEndpoint: true,
    metrics: {
      all: metric(observations),
      byModel: Object.fromEntries(
        models.map((m) => [
          m,
          metric(observations.filter((x) => x.model === m)),
        ]),
      ),
      byLanguage: Object.fromEntries(
        ["en", "es"].map((lang) => [
          lang,
          metric(observations.filter((x) => x.language === lang)),
        ]),
      ),
    },
    writerMetrics: {
      positives: writerPos.length,
      negatives: writerNeg.length,
      positiveSourceBoundEmissions: writerPos.filter(
        (x) => x.sourceAttributedWriterProposalEmitted,
      ).length,
      positiveLexicalAnchors: writerPos.filter((x) => x.lexicalAnswerAnchor)
        .length,
      positiveUnanchoredOrWithheld: writerPos.filter(
        (x) => !x.lexicalAnswerAnchor,
      ).length,
      negativeSourceBoundEmissions: writerNeg.filter(
        (x) => x.sourceAttributedWriterProposalEmitted,
      ).length,
      negativeExplicitAbstentions: writerNeg.filter(
        (x) => x.structuredAndConsistent && x.abstained === true,
      ).length,
      invalidOrUnsupportedWriterShapes: writers.filter(
        (x) => !x.structuredAndConsistent,
      ).length,
      finalAnswerFARNotEstablished: true,
    },
    observations,
    writers,
  };
  const reportBytes = Buffer.from(json(result), "utf8");
  const reportPath = path.join(runDir, "PRIVATE_DEV_POSTRUN_SCORE.json");
  if (verifyExisting) {
    const stored = await readFile(reportPath);
    if (!stored.equals(reportBytes))
      throw Error("IMMUTABLE_DEV_SCORE_REPLAY_CHANGED");
  } else {
    await writeFile(reportPath, reportBytes, { flag: "wx" });
  }
  console.log(
    "S2_RELATION_DEV_SCORED " +
      JSON.stringify({
        sha256: sha(reportBytes),
        byModel: result.metrics.byModel,
        byLanguage: result.metrics.byLanguage,
        writer: result.writerMetrics,
        localOllamaP95Ms: result.localOllamaRequestP95Ms,
        independentAdjudication: false,
        realHttpFinalAnswerMeasured: false,
      }),
  );
}
const mode = process.argv[2];
if (mode === "--freeze") await freeze();
else if (mode === "--capture") await capture();
else if (mode === "--score") await score();
else if (mode === "--verify") await score(true);
else throw Error("S2_RELATION_EXPLICIT_FREEZE_CAPTURE_SCORE_REQUIRED");
