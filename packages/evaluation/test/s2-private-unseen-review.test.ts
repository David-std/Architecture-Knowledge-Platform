import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildS2PrivateUnseenReviewKit } from "../src/s2-private-unseen-review.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const source = "Mara approved release R-41 after the inspection.";
const digest = sha(source);
const sample = (
  question: string,
  language: "en" | "es" = "en",
  abstained = false,
) => {
  const answer = abstained ? "" : "Mara approved release R-41.";
  return {
    schemaVersion: "akp.s2.private-shadow-review-sample.v1",
    caseSha256: sha(language + "\0" + question),
    packetSha256: sha("private-packet:" + question),
    language,
    question,
    passages: [
      {
        citationId: "SECTION1",
        sourceText: source,
        originalSourceSha256: digest,
        originalSourceText: source,
        startUtf16: 0,
        endUtf16: source.length,
      },
    ],
    writer: {
      answerText: answer,
      abstained,
      statements: abstained ? [] : [{ text: answer, citationId: "SECTION1" }],
      requestSha256: sha("req:" + question),
      responseSha256: sha("response:" + question),
      modelDigestSha256: sha("qwen2.5:7b-instruct"),
      providerMs: 12.35,
    },
    review: {
      sourceAnswerability: null,
      claimFaithfulness: null,
      abstentionJustified: null,
      independentReviewerIdentityVerified: false,
      semanticGoldVerified: false,
      releaseGateAccepted: false,
    },
  };
};
const salt = sha("local-private-blinding-not-a-reviewer-signature");
describe("S2 private unseen-question packets", () => {
  it("freezes distinct blinded X/Y original-source review without leaking Writer outputs", () => {
    const a = sample("Who approved release R-41?");
    const b = sample("¿Quién aprobó R-41?", "es");
    const kit = buildS2PrivateUnseenReviewKit({
      samples: [a, b],
      shuffleSalt: salt,
    });
    expect(kit.receipt).toMatchObject({
      questionCount: 2,
      sourceCount: 1,
      independentReviewReceived: false,
      releaseGateAccepted: false,
    });
    expect(kit.packets.map((p) => p.assignment)).toEqual(["X", "Y"]);
    for (const p of kit.packets) {
      expect(p.sourceDocs).toEqual([
        { sourceKeySha256: digest, originalText: source },
      ]);
      expect(p.cases).toHaveLength(2);
      expect(p.writerOutputsIncluded).toBe(false);
      expect(
        p.cases.every(
          (c) => c.answerability === null && c.quoteSpans.length === 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(p)).not.toContain("Mara approved release R-41.");
    }
    expect(kit.privateWriterAnswers).toHaveLength(2);
    expect(kit.privateWriterAnswers[0]).toMatchObject({
      writerAnswer: "Mara approved release R-41.",
      semanticGoldVerified: false,
    });
    expect(kit).toEqual(
      buildS2PrivateUnseenReviewKit({
        samples: [a, b],
        shuffleSalt: salt,
      }),
    );
  });
  it("allows a captured abstention but leaves every source truth label unset", () => {
    const kit = buildS2PrivateUnseenReviewKit({
      samples: [sample("Was it approved before the inspection?", "en", true)],
      shuffleSalt: salt,
    });
    expect(kit.privateWriterAnswers[0]).toMatchObject({
      writerAnswer: "",
      abstained: true,
      statements: [],
    });
    expect(kit.packets[0].cases[0]?.answerability).toBe(null);
  });
  it.each([
    [
      "source changed",
      (x: ReturnType<typeof sample>) => {
        x.passages[0]!.originalSourceText += " OTHER";
      },
    ],
    [
      "UTF-16 span forged",
      (x: ReturnType<typeof sample>) => {
        x.passages[0]!.endUtf16 -= 1;
      },
    ],
    [
      "wrong request hash",
      (x: ReturnType<typeof sample>) => {
        x.caseSha256 = sha("forged");
      },
    ],
    [
      "unreviewed claim",
      (x: ReturnType<typeof sample>) => {
        x.writer.statements = [{ text: "Other", citationId: "SECTION1" }];
      },
    ],
    [
      "citation fabricated",
      (x: ReturnType<typeof sample>) => {
        x.writer.statements = [
          { text: "Mara approved release R-41.", citationId: "SECTION9" },
        ];
      },
    ],
    [
      "review marked accepted",
      (x: ReturnType<typeof sample>) => {
        x.review.releaseGateAccepted = true;
      },
    ],
  ])("fails closed on %s", (_name, alter) => {
    const x = sample("Who approved release R-41?");
    alter(x);
    expect(() =>
      buildS2PrivateUnseenReviewKit({ samples: [x], shuffleSalt: salt }),
    ).toThrow(/S2_PRIVATE_REVIEW_/);
  });
  it("rejects duplicate cases and uncommitted shuffle salt", () => {
    const a = sample("Who approved release R-41?");
    expect(() =>
      buildS2PrivateUnseenReviewKit({ samples: [a, a], shuffleSalt: salt }),
    ).toThrow();
    expect(() =>
      buildS2PrivateUnseenReviewKit({ samples: [a], shuffleSalt: "test" }),
    ).toThrow();
  });
});
