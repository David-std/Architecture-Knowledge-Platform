import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildS2NativeWriterSchema,
  freezeNativeStructuredWriter,
  observeNativeStructuredWriter,
  type NativeWriterBuild,
} from "../src/s2-native-structured-writer.js";
const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const text =
  "---\ntitle: Synthetic\n---\n## Facts\nA sable clock rings twice. 😀";
const src = "A sable clock rings twice.";
const start = text.indexOf(src);
const key = sha("synthetic-source");
function fixture() {
  const question = "When does the sable clock ring?";
  const caseData = {
    caseKeySha256: sha("en\0" + question),
    caseManifestSha256: sha("cases"),
    sourceManifestSha256: sha("source-manifest"),
    sourceFamilySha256: sha("family"),
    executedCommitSha: "a".repeat(40),
    language: "en" as const,
    question,
    model: "qwen2.5:7b-instruct",
    modelDigestSha256: sha("digest"),
    systemPrompt: "Use only source. Respond in JSON.",
    temperature: 0 as const,
    seed: 1317,
    maxTokens: 150,
    passages: [
      {
        id: "SRC1",
        text: src,
        original: {
          documentKeySha256: key,
          fileSha256: sha(text),
          startUtf16: start,
          endUtf16: start + src.length,
        },
      },
    ],
  };
  const originals = [
    {
      documentKeySha256: key,
      fileSha256: sha(text),
      fileBytes: Buffer.from(text),
      bodyStartUtf16: text.indexOf("##"),
      bodyEndUtf16: text.length,
    },
  ];
  return { caseData, originals };
}
const make = () => {
  const f = fixture();
  return freezeNativeStructuredWriter({
    case: f.caseData,
    originals: f.originals,
    contextTokens: 4096,
    maxOutputTokens: 512,
  });
};
function response(
  answer: unknown,
  options: {
    reason?: string;
    prompt?: number;
    eval?: number;
    done?: boolean;
  } = {},
) {
  return Buffer.from(
    JSON.stringify({
      model: "qwen2.5:7b-instruct",
      message: { role: "assistant", content: JSON.stringify(answer) },
      done: options.done ?? true,
      done_reason: options.reason ?? "stop",
      prompt_eval_count: options.prompt ?? 180,
      eval_count: options.eval ?? 40,
    }),
  );
}
const run = (build: NativeWriterBuild, answer: unknown, options = {}) =>
  observeNativeStructuredWriter(
    build.freeze,
    build.requestBytes,
    response(answer, options),
  );
describe("S2 native structured writer fail-closed", () => {
  it("freezes schema-constrained /api/chat request and explicit num_ctx", () => {
    const b = make();
    const r = JSON.parse(Buffer.from(b.requestBytes).toString());
    expect(r.stream).toBe(false);
    expect(r.format).toMatchObject({
      type: "object",
      required: ["answerText", "citations", "abstained"],
      additionalProperties: false,
    });
    expect(r.options).toMatchObject({
      temperature: 0,
      seed: 1317,
      num_ctx: 4096,
      num_predict: 512,
    });
    expect(r.messages[1].content).toContain('"sourceId":"SRC1"');
    expect(r.format.properties.citations.items.enum).toEqual(["SRC1"]);
    expect(r.messages[1].content).toContain('citations=["SRC1"]');
    expect(r.messages[1].content).toContain(src);
    expect(b.freeze.sourcePassages).toMatchObject([
      { source: "ORIGINAL_LITERAL_MATCH" },
    ]);
    expect(b.freeze.fullContextConfirmedByProvider).toBe(false);
  });
  it("freezes Qwen-family explicit no-thinking request without changing the default contract", () => {
    const baseline = make();
    const f = fixture();
    const withoutThinking = freezeNativeStructuredWriter({
      case: f.caseData,
      originals: f.originals,
      contextTokens: 4096,
      maxOutputTokens: 512,
      disableThinking: true,
    });
    const parsedBase = JSON.parse(
      Buffer.from(baseline.requestBytes).toString("utf8"),
    );
    const parsedDisabled = JSON.parse(
      Buffer.from(withoutThinking.requestBytes).toString("utf8"),
    );
    expect(parsedBase.think).toBeUndefined();
    expect(parsedDisabled.think).toBe(false);
    expect(withoutThinking.freeze.exactRequestSha256).not.toBe(
      baseline.freeze.exactRequestSha256,
    );
    expect(withoutThinking.freeze.sourcePassages).toEqual(
      baseline.freeze.sourcePassages,
    );
    expect(
      run(withoutThinking, {
        answerText: "Twice.",
        citations: ["SRC1"],
        abstained: false,
      }).status,
    ).toBe("STRUCTURALLY_VALID");
  });
  it("restricts citation JSON enum to exactly the frozen source IDs", () => {
    expect(
      buildS2NativeWriterSchema(["SRC1", "SECTION2"]).properties.citations.items
        .enum,
    ).toEqual(["SRC1", "SECTION2"]);
    expect(() => buildS2NativeWriterSchema(["SRC1", "SRC1"])).toThrow();
    expect(() => buildS2NativeWriterSchema(["[SRC1]"])).toThrow();
    expect(() => buildS2NativeWriterSchema([])).toThrow();
  });
  it("accepts structural answer with known citation ID, no semantic certification", () => {
    const b = make();
    const o = run(b, {
      answerText: "Twice.",
      citations: ["SRC1"],
      abstained: false,
    });
    expect(o).toMatchObject({
      status: "STRUCTURALLY_VALID",
      answerText: "Twice.",
      citations: ["SRC1"],
      abstained: false,
      promptTokens: 180,
      modelCitationSemanticsVerified: false,
      gateAccepted: false,
    });
  });
  it("accepts empty abstention, but not inconsistent abstention", () => {
    const b = make();
    expect(
      run(b, { answerText: "", citations: [], abstained: true }).status,
    ).toBe("STRUCTURALLY_VALID");
    expect(
      run(b, { answerText: "found", citations: [], abstained: true }).reason,
    ).toBe("ABSTENTION_AND_EVIDENCE_CONFLICT");
    expect(
      run(b, { answerText: "", citations: [], abstained: false }).reason,
    ).toBe("ABSTENTION_AND_EVIDENCE_CONFLICT");
  });
  it("rejects unrelated JSON schema, hallucinated and duplicate citations", () => {
    const b = make();
    expect(run(b, { summary: "some text" }).reason).toBe(
      "MODEL_OUTPUT_SCHEMA_INVALID",
    );
    expect(
      run(b, { answerText: "yes", citations: ["SRC99"], abstained: false })
        .reason,
    ).toBe("CITATION_ID_NOT_IN_SENT_SOURCE");
    expect(
      run(b, {
        answerText: "yes",
        citations: ["SRC1", "SRC1"],
        abstained: false,
      }).reason,
    ).toBe("MODEL_OUTPUT_SCHEMA_INVALID");
  });
  it("rejects incomplete provider response and exhausted context", () => {
    const b = make();
    expect(
      run(
        b,
        { answerText: "yes", citations: ["SRC1"], abstained: false },
        { reason: "length" },
      ).reason,
    ).toBe("PROVIDER_STOP_NOT_COMPLETE");
    expect(
      run(
        b,
        { answerText: "yes", citations: ["SRC1"], abstained: false },
        { prompt: 3900 },
      ).reason,
    ).toBe("MODEL_CONTEXT_CAPACITY_RISK");
  });
  it("rejects modified provider request even if JSON otherwise valid", () => {
    const b = make();
    expect(() =>
      observeNativeStructuredWriter(
        b.freeze,
        Buffer.concat([b.requestBytes, Buffer.from("\n")]),
        response({ answerText: "", citations: [], abstained: true }),
      ),
    ).toThrow("REQUEST_CHANGED_AFTER_FREEZE");
  });
  it("requires source hash bound and a preflight context budget", () => {
    const f = fixture();
    f.caseData.passages[0]!.text = "unrelated";
    expect(() =>
      freezeNativeStructuredWriter({
        case: f.caseData,
        originals: f.originals,
        contextTokens: 4096,
        maxOutputTokens: 512,
      }),
    ).toThrow("PASSAGE_NOT_EXACT_ORIGINAL_UTF16");
    const g = fixture();
    g.caseData.passages[0]!.text = "other ".repeat(3200);
    g.caseData.passages[0]!.original = null as never;
    expect(() =>
      freezeNativeStructuredWriter({
        case: g.caseData,
        originals: g.originals,
        contextTokens: 4096,
        maxOutputTokens: 512,
      }),
    ).toThrow("PROMPT_TOO_LARGE_FOR_CONSERVATIVE_HEURISTIC");
  });
});
