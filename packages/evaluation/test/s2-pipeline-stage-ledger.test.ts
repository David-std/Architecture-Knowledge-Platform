import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  S2_PIPELINE_STAGES,
  scoreS2PipelineStageLedger,
  type S2CapturedPipelineCase,
  type S2FrozenPipelineManifest,
  type S2PipelineStageRun,
} from "../src/s2-pipeline-stage-ledger.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const revision = "a".repeat(40);
const manifest: S2FrozenPipelineManifest = {
  schemaVersion: "akp.s2.pipeline-stage-manifest.v1",
  executedCommitSha: revision,
  sourceManifestSha256: hash("source-snapshot"),
  cases: [
    {
      questionKeySha256: hash("explicit-no"),
      sourceFamilySha256: hash("family-a"),
      language: "en",
      gold: "EXPLICIT_REFUTATION",
    },
    {
      questionKeySha256: hash("missing"),
      sourceFamilySha256: hash("family-b"),
      language: "es",
      gold: "NOT_ANSWERABLE",
    },
    {
      questionKeySha256: hash("conflict"),
      sourceFamilySha256: hash("family-c"),
      language: "en",
      gold: "CONFLICTING_EVIDENCE",
    },
    {
      questionKeySha256: hash("explicit-yes"),
      sourceFamilySha256: hash("family-a"),
      language: "es",
      gold: "EXPLICIT_SUPPORT",
    },
  ],
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const pinned = hash(manifestBytes.toString("utf8"));
const passed = () =>
  Object.fromEntries(
    S2_PIPELINE_STAGES.map((name) => [name, "PASSED"]),
  ) as S2CapturedPipelineCase["stages"];
const result = (
  index: number,
  disposition: S2CapturedPipelineCase["disposition"] = "WITHHELD",
): S2CapturedPipelineCase => ({
  questionKeySha256: manifest.cases[index]!.questionKeySha256,
  stages: passed(),
  disposition,
  responseSha256: hash("actual-http-payload-" + index),
  citationReceiptSha256:
    disposition === "ANSWERED" ? hash("source-receipt-" + index) : null,
  durationMs: (index + 1) * 50,
});
const run = (): S2PipelineStageRun => ({
  schemaVersion: "akp.s2.pipeline-stage-run.v1",
  executedCommitSha: revision,
  sourceManifestSha256: manifest.sourceManifestSha256,
  mode: "SHADOW_ONLY",
  cases: [result(0, "ANSWERED"), result(1), result(2), result(3, "ANSWERED")],
});
const score = (capture = run(), bytes = manifestBytes, pin = pinned) =>
  scoreS2PipelineStageLedger({
    manifestBytes: bytes,
    externallyPinnedManifestSha256: pin,
    run: capture,
  });
describe("whole-pipeline shadow ledger", () => {
  it("counts explicit refutation as answerable, not as a no-answer negative", () => {
    const output = score();
    expect(output.explicitAnswerable).toBe(2);
    expect(output.explicitlyAnswered).toBe(2);
    expect(output.negativeCaseCount).toBe(2);
    expect(output.negativeFalseAdmissions).toBe(0);
    expect(output.observedNegativeFalseAdmissionRate).toBe(0);
    expect(output.negativeFalseAdmissionUpper95).toBeGreaterThan(0.5);
    expect(output.p95RequestMs).toBe(200);
    expect(output.labels.CONFLICTING_EVIDENCE).toBe(1);
    expect(output.independentGoldAuthenticated).toBe(false);
    expect(output.rawResponseBytesReplayed).toBe(false);
    expect(output.completeAnswerCorrectness).toBeNull();
    expect(output.gateAccepted).toBe(false);
  });
  it("counts a conflict answered as a false admission on the frozen denominator", () => {
    const capture = run();
    const changed = capture.cases.map((x, i) =>
      i === 2 ? result(2, "ANSWERED") : x,
    );
    const output = score({ ...capture, cases: changed });
    expect(output.negativeFalseAdmissions).toBe(1);
    expect(output.negativeCaseCount).toBe(2);
    expect(output.observedNegativeFalseAdmissionRate).toBe(0.5);
    expect(output.gateAccepted).toBe(false);
  });
  it("rejects missing cases, duplicates, reordered source identities and drift", () => {
    const capture = run();
    expect(() => score({ ...capture, cases: capture.cases.slice(1) })).toThrow(
      /RUN_IDENTITY_OR_SHAPE_INVALID/,
    );
    expect(() =>
      score({
        ...capture,
        cases: [result(0), result(0), result(2), result(3)],
      }),
    ).toThrow(/MISSING_DUPLICATE_OR_UNEXPECTED_CASE/);
    expect(() =>
      score({ ...capture, executedCommitSha: "b".repeat(40) }),
    ).toThrow(/RUN_IDENTITY_OR_SHAPE_INVALID/);
    expect(() => score(capture, manifestBytes, hash("wrong pin"))).toThrow(
      /MANIFEST_PIN_MISMATCH/,
    );
  });
  it("refuses an answered result that skipped any verification stage", () => {
    const capture = run();
    const changed = capture.cases.map((row, i) =>
      i === 0
        ? {
            ...row,
            stages: { ...row.stages, AUTHORIZATION: "NOT_RUN" as const },
          }
        : row,
    );
    expect(() => score({ ...capture, cases: changed })).toThrow(
      /ANSWER_WITH_MISSING_STAGE_OR_CITATION/,
    );
  });
  it("refuses unsupported attribution claims and stale receipt metadata", () => {
    const capture = run();
    expect(() =>
      score({
        ...capture,
        cases: capture.cases.map((row, i) =>
          i === 0 ? { ...row, citationReceiptSha256: null } : row,
        ),
      }),
    ).toThrow(/ANSWER_WITH_MISSING_STAGE_OR_CITATION/);
    expect(() =>
      score({
        ...capture,
        cases: capture.cases.map((row, i) =>
          i === 1
            ? { ...row, citationReceiptSha256: hash("not-an-answer") }
            : row,
        ),
      }),
    ).toThrow(/WITHHELD_WITH_CITATION_RECEIPT/);
  });
  it("prevents manifest rewriting, malformed labels and a negative-free sample", () => {
    const rewritten = Buffer.from(
      JSON.stringify({
        ...manifest,
        cases: manifest.cases.map((x, i) =>
          i === 1 ? { ...x, gold: "EXPLICIT_SUPPORT" } : x,
        ),
      }),
    );
    expect(() => score(run(), rewritten)).toThrow(/MANIFEST_PIN_MISMATCH/);
    const noNegatives = Buffer.from(
      JSON.stringify({
        ...manifest,
        cases: manifest.cases.map((x) => ({ ...x, gold: "EXPLICIT_SUPPORT" })),
      }),
    );
    expect(() =>
      score(run(), noNegatives, hash(noNegatives.toString("utf8"))),
    ).toThrow(/MANIFEST_CASES_NOT_DISJOINT_OR_NO_NEGATIVES/);
  });
});
