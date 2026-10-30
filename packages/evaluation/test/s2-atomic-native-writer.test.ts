import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  freezeS2AtomicNativeWriter,
  observeS2AtomicNativeWriter,
} from "../src/s2-atomic-native-writer.js";
const sha = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const source =
  "ARCHIVE: Elian Sora approved the fixed order on 2024-05-01.\n" +
  "ARCHIVE: The next order is pending review.\n";
const sample = "Elian Sora approved the fixed order on 2024-05-01.";
const start = source.indexOf(sample);
const key = sha("document-vault-revision");
const question = "Who approved the fixed order?";
const fixture = () =>
  freezeS2AtomicNativeWriter({
    case: {
      caseKeySha256: sha("en\0" + question),
      caseManifestSha256: sha("manifest"),
      sourceManifestSha256: sha("sources"),
      executedCommitSha: "a".repeat(40),
      sourceFamilySha256: sha("publisher"),
      language: "en",
      question,
      model: "qwen2.5:7b-instruct",
      modelDigestSha256: sha("model"),
      systemPrompt: "Only report verified source claims.",
      temperature: 0,
      seed: 27,
      maxTokens: 256,
      passages: [
        {
          id: "SECTION1",
          text: sample,
          original: {
            documentKeySha256: key,
            fileSha256: sha(source),
            startUtf16: start,
            endUtf16: start + sample.length,
          },
        },
      ],
    },
    originals: [
      {
        documentKeySha256: key,
        fileSha256: sha(source),
        fileBytes: Buffer.from(source),
        bodyStartUtf16: 0,
        bodyEndUtf16: source.length,
      },
    ],
    contextTokens: 8192,
    maxOutputTokens: 384,
    disableThinking: true,
  });
const response = (
  payload: unknown,
  opts: {
    done?: boolean;
    reason?: string;
    prompt?: number;
    outerContent?: string;
  } = {},
) =>
  Buffer.from(
    JSON.stringify({
      model: "qwen2.5:7b-instruct",
      done: opts.done ?? true,
      done_reason: opts.reason ?? "stop",
      prompt_eval_count: opts.prompt ?? 220,
      eval_count: 42,
      message: {
        role: "assistant",
        content: opts.outerContent ?? JSON.stringify(payload),
      },
    }),
  );
const run = (payload: unknown, opts: Parameters<typeof response>[1] = {}) => {
  const frozen = fixture();
  return observeS2AtomicNativeWriter(
    frozen.freeze,
    frozen.requestBytes,
    response(payload, opts),
  );
};
describe("S2 provider-generated atomic Writer strict original-SOURCE custody", () => {
  it("freezes exact source spans and SECTION citations without implicit admission", () => {
    const f = fixture();
    const request = JSON.parse(Buffer.from(f.requestBytes).toString("utf8"));
    expect(request.format.required).toEqual([
      "answerText",
      "statements",
      "abstained",
    ]);
    expect(
      request.format.properties.statements.items.properties.citationId.enum,
    ).toEqual(["SECTION1"]);
    expect(request.think).toBe(false);
    expect(f.freeze.exactSourcePassages).toMatchObject([
      {
        sourceOriginalBound: true,
        originalSourceSha256: sha(source),
      },
    ]);
    expect(f.freeze.releaseGateAccepted).toBe(false);
  });
  it("covers one exact statement and retains offsets", () => {
    expect(
      run({
        answerText: sample,
        statements: [{ text: sample, citationId: "SECTION1" }],
        abstained: false,
      }),
    ).toMatchObject({
      status: "STRUCTURALLY_VALID",
      reason: "EXACT_CLAIM_COVERAGE_AND_IDS",
      statements: [
        {
          text: sample,
          startUtf16: 0,
          endUtf16: sample.length,
          citationId: "SECTION1",
        },
      ],
      allClaimsSemanticallyVerified: false,
    });
  });
  it("covers multiple statements with exact UTF-16 offsets, retaining citation identity", () => {
    const a = "Elian Sora approved the fixed order. ";
    const b = "The next order is pending review.";
    expect(
      run({
        answerText: a + b,
        statements: [
          { text: a, citationId: "SECTION1" },
          { text: b, citationId: "SECTION1" },
        ],
        abstained: false,
      }),
    ).toMatchObject({
      status: "STRUCTURALLY_VALID",
      statements: [
        { startUtf16: 0, endUtf16: a.length },
        { startUtf16: a.length, endUtf16: a.length + b.length },
      ],
    });
  });
  it("accepts an exact empty abstention", () => {
    expect(
      run({ answerText: "", statements: [], abstained: true }),
    ).toMatchObject({
      status: "STRUCTURALLY_VALID",
      reason: "EXACT_ABSTENTION",
      abstained: true,
    });
  });
  it.each([
    [
      {
        answerText: sample,
        statements: [{ text: sample, citationId: "SECTION9" }],
        abstained: false,
      },
      "CLAIM_GAP_OR_UNAUTHORIZED_CITATION",
    ],
    [
      {
        answerText: sample,
        statements: [{ text: sample.slice(0, -1), citationId: "SECTION1" }],
        abstained: false,
      },
      "INCOMPLETE_ANSWER_COVERAGE",
    ],
    [
      {
        answerText: sample,
        statements: [{ text: sample + " BAD", citationId: "SECTION1" }],
        abstained: false,
      },
      "CLAIM_GAP_OR_UNAUTHORIZED_CITATION",
    ],
    [
      { answerText: sample, statements: [], abstained: false },
      "EMPTY_AFFIRMATIVE_ANSWER",
    ],
    [
      {
        answerText: "",
        statements: [{ text: "hidden", citationId: "SECTION1" }],
        abstained: true,
      },
      "ABSTENTION_WITH_HIDDEN_CLAIMS",
    ],
    [
      {
        answerText: sample,
        statements: [{ text: sample, citationId: "SECTION1" }],
        abstained: false,
        extra: "unsafe",
      },
      "MODEL_SCHEMA_INVALID",
    ],
    [
      {
        answerText: sample,
        statements: [{ text: sample, citationId: "SECTION1", extra: true }],
        abstained: false,
      },
      "CLAIM_GAP_OR_UNAUTHORIZED_CITATION",
    ],
    [
      { answerText: "", statements: [], abstained: false },
      "EMPTY_AFFIRMATIVE_ANSWER",
    ],
  ] as const)(
    "withholds invalid or unaccounted answer (%s)",
    (payload, reason) => {
      expect(run(payload)).toMatchObject({ status: "REJECTED", reason });
    },
  );
  it("rejects truncated generation, even when body contains valid JSON", () => {
    expect(
      run(
        { answerText: "", statements: [], abstained: true },
        { reason: "length" },
      ),
    ).toMatchObject({
      status: "REJECTED",
      reason: "PROVIDER_NOT_FULLY_COMPLETED",
    });
  });
  it("rejects context capacity risk independently of JSON syntax", () => {
    expect(
      run(
        { answerText: "", statements: [], abstained: true },
        { prompt: 8000 },
      ),
    ).toMatchObject({ status: "REJECTED", reason: "CONTEXT_TRUNCATION_RISK" });
  });
  it("rejects incomplete JSON provider content", () => {
    expect(run(null, { outerContent: '{"answerText":' })).toMatchObject({
      status: "REJECTED",
      reason: "OUTPUT_NOT_JSON",
    });
  });
  it("rejects tampered exact provider request bytes", () => {
    const f = fixture();
    expect(() =>
      observeS2AtomicNativeWriter(
        f.freeze,
        Buffer.from(f.requestBytes).subarray(1),
        response({ answerText: "", statements: [], abstained: true }),
      ),
    ).toThrow("S2_ATOMIC_WRITER_REQUEST_CHANGED_AFTER_FREEZE");
  });
  it("refuses unbound passage rather than papering over missing original bytes", () => {
    expect(() =>
      freezeS2AtomicNativeWriter({
        case: {
          caseKeySha256: sha("en\0" + question),
          caseManifestSha256: sha("manifest"),
          sourceManifestSha256: sha("sources"),
          executedCommitSha: "a".repeat(40),
          sourceFamilySha256: sha("publisher"),
          language: "en",
          question,
          model: "qwen2.5:7b-instruct",
          modelDigestSha256: sha("model"),
          systemPrompt: "Only source",
          temperature: 0,
          seed: 27,
          maxTokens: 256,
          passages: [{ id: "SECTION1", text: sample, original: null }],
        },
        originals: [],
        contextTokens: 8192,
        maxOutputTokens: 384,
      }),
    ).toThrow("S2_ATOMIC_WRITER_NO_EXACT_ORIGINAL_PASSAGES");
  });
});
