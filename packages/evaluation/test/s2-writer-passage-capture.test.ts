import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  freezeExactWriterRequest,
  sealExactWriterResponse,
  validateExactWriterRequest,
  type WriterProbeInput,
  type FrozenOriginalReference,
} from "../src/s2-writer-passage-capture.js";
const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const doc =
  "---\r\ntitle: evidence\r\n---\r\n## Section\r\nThis answer is in the original. 😀";
const passage = "This answer is in the original.";
const start = doc.indexOf(passage);
const documentKeySha256 = sha("source");
const original: FrozenOriginalReference = {
  documentKeySha256,
  fileSha256: sha(doc),
  fileBytes: new TextEncoder().encode(doc),
  bodyStartUtf16: doc.indexOf("##"),
  bodyEndUtf16: doc.length,
};
const make = (): WriterProbeInput => ({
  question: "What is in the original?",
  language: "en",
  caseKeySha256: sha("en\0What is in the original?"),
  caseManifestSha256: sha("cases"),
  sourceManifestSha256: sha("sources"),
  executedCommitSha: "a".repeat(40),
  sourceFamilySha256: sha("publisher"),
  model: "qwen2.5:7b-instruct",
  modelDigestSha256: sha("model"),
  systemPrompt: "Use the supplied passages only",
  temperature: 0,
  seed: 1317,
  maxTokens: 180,
  passages: [
    {
      id: "SECTION1",
      text: passage,
      original: {
        documentKeySha256,
        fileSha256: sha(doc),
        startUtf16: start,
        endUtf16: start + passage.length,
      },
    },
  ],
});
describe("offline exact writer passage/request freeze", () => {
  it("freezes the exact provider bytes and verifies original file offsets", () => {
    const r = freezeExactWriterRequest(make(), [original]);
    expect(r.frozen.passages).toMatchObject([
      {
        id: "SECTION1",
        source: "ORIGINAL_LITERAL_MATCH",
        textSha256: sha(passage),
      },
    ]);
    expect(r.frozen.allPassagesLiteralOriginalBound).toBe(true);
    expect(validateExactWriterRequest(r.frozen, r.requestBodyBytes)).toBe(true);
    const exact = JSON.parse(Buffer.from(r.requestBodyBytes).toString("utf8"));
    expect(exact.messages[1].content).toContain("[SECTION1] " + passage);
    expect(r.frozen.requestBodySha256).toBe(sha(r.requestBodyBytes));
    const done = sealExactWriterResponse(
      r.frozen,
      r.requestBodyBytes,
      new TextEncoder().encode('{"choices":[]}'),
      20,
    );
    expect(done).toMatchObject({
      gateAccepted: false,
      fullHttpEndToEndP95Measured: false,
      rawResponseSha256: sha('{"choices":[]}'),
      allPassagesLiteralOriginalBound: true,
    });
  });
  it("rejects provider payload mutation after freeze", () => {
    const r = freezeExactWriterRequest(make(), [original]);
    const mutated = new TextEncoder().encode(
      Buffer.from(r.requestBodyBytes).toString("utf8") + " ",
    );
    expect(() => validateExactWriterRequest(r.frozen, mutated)).toThrow(
      "PROVIDER_REQUEST_NOT_FROZEN_BYTES",
    );
  });
  it("does not invent original binding for derived child snippets", () => {
    const x = make();
    x.passages = [
      { id: "SRC1", text: "A retrieval-derived summary", original: null },
    ];
    const r = freezeExactWriterRequest(x, []);
    expect(r.frozen.allPassagesLiteralOriginalBound).toBe(false);
    expect(r.frozen.passages[0]?.source).toBe("UNBOUND_PROJECTION");
    expect(r.frozen.gateAccepted).toBe(false);
  });
  it("rejects nonmatching source bytes, hash and claimed quote", () => {
    const x = make();
    const fake = { ...original, fileSha256: sha("fake") };
    expect(() => freezeExactWriterRequest(x, [fake])).toThrow(
      "ORIGINAL_FILE_HASH_OR_IDENTITY",
    );
    const changed = make();
    changed.passages[0]!.text = "An invented statement";
    expect(() => freezeExactWriterRequest(changed, [original])).toThrow(
      "PASSAGE_NOT_EXACT_ORIGINAL_UTF16",
    );
  });
  it("rejects split UTF-16 surrogate, body-header crossings", () => {
    const x = make(),
      pos = doc.indexOf("😀");
    x.passages[0] = {
      id: "SRC1",
      text: "\ude00",
      original: {
        documentKeySha256,
        fileSha256: sha(doc),
        startUtf16: pos + 1,
        endUtf16: pos + 2,
      },
    };
    expect(() => freezeExactWriterRequest(x, [original])).toThrow(
      "PASSAGE_NOT_EXACT_ORIGINAL_UTF16",
    );
    const y = make();
    y.passages[0]!.original!.startUtf16 = 0;
    expect(() => freezeExactWriterRequest(y, [original])).toThrow(
      "PASSAGE_NOT_EXACT_ORIGINAL_UTF16",
    );
  });
  it("rejects question identity drift and duplicate passage IDs", () => {
    const x = make();
    x.question = "Altered";
    expect(() => freezeExactWriterRequest(x, [original])).toThrow(
      "INVALID_FROZEN_REQUEST",
    );
    const y = make();
    y.passages.push({ ...y.passages[0]! });
    expect(() => freezeExactWriterRequest(y, [original])).toThrow(
      "INVALID_PASSAGE",
    );
  });
});
