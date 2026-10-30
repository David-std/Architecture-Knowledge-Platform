import { createHash } from "node:crypto";
import { prepareS2PreInferenceBlindReview } from "../src/s2-preinference-blind-review.js";
import { describe, expect, it } from "vitest";
import {
  parseS2ExternalIntakeCsv,
  preflightS2IndependentIntake,
  type ExternalSourceFile,
} from "../src/s2-independent-intake.js";
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const UTF = (s: string) => Buffer.from(s, "utf8");
const hdr = [
  "caseSeat",
  "publisherFamilySeat",
  "language",
  "targetStratum",
  "publisherName",
  "upstreamRepository",
  "sourceRevision40Hex",
  "sourceRelativePath",
  "originalSha256",
  "authorizedVaultScope",
  "sourceLocatorUtf16Start",
  "sourceLocatorUtf16End",
  "question",
  "ownerSuggestedGoldKeepPrivate",
  "externalCustodianSourceSelectionReason",
  "externalCustodianCaseAuthor",
];
const csv = (rows: string[][]) =>
  UTF(
    rows
      .map((row) =>
        row.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","),
      )
      .join("\n") + "\n",
  );
const fixture = () => {
  const template = [hdr],
    filled = [hdr];
  const files: ExternalSourceFile[] = [];
  const deny = ["development-publisher", "calibration-publisher"];
  for (let f = 1; f <= 12; f++) {
    const seat = "F" + String(f).padStart(2, "0");
    const source =
      "Independent synthetic source " +
      seat +
      " says that \u{1f525} unit " +
      seat +
      " was approved after audit.";
    files.push({
      familySeat: seat,
      relativePath: "source-" + seat + ".md",
      rawBytes: UTF(source),
    });
    for (const lang of ["en", "es"] as const) {
      for (const polarity of ["POSITIVE", "NEGATIVE_ADVERSARIAL"] as const) {
        for (let n = 0; n < 5; n++) {
          const id = "C" + seat + lang + polarity.slice(0, 3) + n;
          const line = [
            id,
            seat,
            lang,
            polarity,
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
          ];
          template.push(line);
          filled.push([
            ...line.slice(0, 4),
            "new-family-" + seat.toLowerCase(),
            "external" + seat.toLowerCase() + "/reference",
            "a".repeat(40),
            "source-" + seat + ".md",
            sha(UTF(source)),
            "vault:" + seat,
            "0",
            String(source.length),
            lang === "en"
              ? "Who approved item " +
                seat +
                " case " +
                sha(id).slice(0, 8) +
                "?"
              : "¿Quién aprobó el elemento " +
                seat +
                " caso " +
                sha(id).slice(0, 8) +
                "?",
            "",
            "Independent selection for pilot only",
            "authorized-external-custodian-pending",
          ]);
        }
      }
    }
  }
  return {
    templateBytes: csv(template),
    filledBytes: csv(filled),
    files,
    deny,
  };
};
const run = (fixtureData = fixture()) =>
  preflightS2IndependentIntake({
    templateBytes: fixtureData.templateBytes,
    templateSha256: sha(fixtureData.templateBytes),
    filledBytes: fixtureData.filledBytes,
    filledSha256: sha(fixtureData.filledBytes),
    sourceFiles: fixtureData.files,
    excludedDevelopmentPublisherFamilies: fixtureData.deny,
  });
describe("S2 prospective pre-inference external 240-seat intake", () => {
  it("accepts exactly 240 *structurally complete* synthetic cases without claiming independent truth", () => {
    const x = run();
    expect(x).toMatchObject({
      status: "STRUCTURALLY_COMPLETE_UNADJUDICATED_NOT_FROZEN",
      seatCount: 240,
      familyCount: 12,
      sourceCount: 12,
      sourceOriginalByteHashesVerified: true,
      independentReviewerGoldAdjudicated: false,
      independentCustodianAuthenticated: false,
      freezeSignatureVerified: false,
      releaseGateAccepted: false,
    });
    expect(Object.values(x.counts)).toEqual([60, 60, 60, 60]);
  });
  it("rejects the genuinely BLANK 240-seat template as a holdout", () => {
    const f = fixture();
    f.filledBytes = f.templateBytes;
    expect(() => run(f)).toThrow(/UNFILLED_SOURCE_OR_QUESTION/);
  });
  it("rejects changed template SHA, family and answerability seats", () => {
    const f = fixture();
    expect(() =>
      preflightS2IndependentIntake({
        templateBytes: f.templateBytes,
        templateSha256: sha("fake"),
        filledBytes: f.filledBytes,
        filledSha256: sha(f.filledBytes),
        sourceFiles: f.files,
        excludedDevelopmentPublisherFamilies: f.deny,
      }),
    ).toThrow(/UNPINNED_BYTES/);
    const orig = f.filledBytes.toString("utf8");
    f.filledBytes = UTF(orig.replace('"POSITIVE"', '"NEGATIVE_ADVERSARIAL"'));
    expect(() => run(f)).toThrow(/SEAT_OR_STRATUM_CHANGED/);
  });
  it("rejects changed raw original source and source scope", () => {
    const f = fixture();
    f.files[0]!.rawBytes = UTF("forged and incorrect SOURCE bytes");
    expect(() => run(f)).toThrow(/ORIGINAL_SOURCE_HASH_MISMATCH/);
  });
  it("blocks known development publisher family reuse", () => {
    const f = fixture();
    f.deny.push("new-family-f01");
    expect(() => run(f)).toThrow(/SOURCE_SCOPE_OR_PROVENANCE_INVALID/);
  });
  it("cannot hide a blocked development publisher behind a fresh display alias", () => {
    const f = fixture();
    f.deny.push("EXTERNALF01");
    expect(() => run(f)).toThrow(/DEVELOPMENT_UPSTREAM_OWNER_REUSED/);
  });
  it("rejects two family seats pointing at the same upstream repository owner", () => {
    const f = fixture();
    f.filledBytes = UTF(
      f.filledBytes
        .toString("utf8")
        .replaceAll('"externalf02/reference"', '"externalf01/other-repo"'),
    );
    expect(() => run(f)).toThrow(/UPSTREAM_OWNER_SHARED_ACROSS_FAMILIES/);
  });
  it("cannot claim two independently sourced families by reusing identical original bytes", () => {
    const f = fixture();
    const oldSha = sha(f.files[1]!.rawBytes);
    const sameSha = sha(f.files[0]!.rawBytes);
    f.files[1]!.rawBytes = f.files[0]!.rawBytes;
    f.filledBytes = UTF(
      f.filledBytes.toString("utf8").replaceAll(oldSha, sameSha),
    );
    expect(() => run(f)).toThrow(/ORIGINAL_SOURCE_REUSED_ACROSS_FAMILIES/);
  });
  it("rejects normalized duplicate questions and a prefilled blind template", () => {
    const f = fixture();
    const q = (n: number) =>
      "Who approved item F01 case " + sha("CF01enPOS" + n).slice(0, 8) + "?";
    f.filledBytes = UTF(
      f.filledBytes
        .toString("utf8")
        .replace('"' + q(1) + '"', '"' + q(0).toUpperCase() + '"'),
    );
    expect(() => run(f)).toThrow(/QUESTION_DUPLICATE/);
    const f2 = fixture();
    const templateText = f2.templateBytes.toString("utf8");
    const before = '"CF01enPOS0","F01","en","POSITIVE","",""';
    expect(templateText).toContain(before);
    f2.templateBytes = UTF(
      templateText.replace(
        before,
        '"CF01enPOS0","F01","en","POSITIVE","leaked-answer",""',
      ),
    );
    expect(() => run(f2)).toThrow(/TEMPLATE_NOT_BLANK/);
  });
  it("rejects incomplete and duplicate cases and fake language", () => {
    const f = fixture();
    const s = f.filledBytes.toString("utf8");
    f.filledBytes = UTF(
      s.replace('"authorized-external-custodian-pending"', '""'),
    );
    expect(() => run(f)).toThrow(/UNFILLED_SOURCE_OR_QUESTION/);
    expect(() =>
      parseS2ExternalIntakeCsv(UTF("not,the,right,header\n")),
    ).toThrow(/CSV_HEADER/);
  });
  it("accepts RFC quoted commas/newlines but rejects malformed or expanded CSV", () => {
    const f = fixture();
    const s = f.filledBytes.toString("utf8");
    const modified = s.replace(
      '"Independent selection for pilot only"',
      '"Independent selection, with\na second line for audit only"',
    );
    f.filledBytes = UTF(modified);
    expect(run(f).seatCount).toBe(240);
    expect(() =>
      parseS2ExternalIntakeCsv(UTF('"unterminated,quote')),
    ).toThrow();
  });
});

describe("S2 pre-inference external source-only review, never post-model gold", () => {
  const build = (salt = "f".repeat(64)) => {
    const f = fixture();
    return prepareS2PreInferenceBlindReview({
      templateBytes: f.templateBytes,
      templateSha256: sha(f.templateBytes),
      filledBytes: f.filledBytes,
      filledSha256: sha(f.filledBytes),
      sourceFiles: f.files,
      excludedDevelopmentPublisherFamilies: f.deny,
      reviewerShuffleSalt: salt,
    });
  };
  it("prepares 240 source-only randomized X/Y packets and a separate private coordinator map", () => {
    const x = build();
    expect(x.status).toBe("PREINFERENCE_BLIND_PACKETS_UNREVIEWED");
    expect(x.privateSourceCount).toBe(12);
    for (const key of ["X", "Y"] as const) {
      const p = x.packets[key];
      expect(p.cases).toHaveLength(240);
      expect(p.sourceDocs).toHaveLength(12);
      expect(p).toMatchObject({
        expectedGoldIncluded: false,
        modelOutputsIncluded: false,
        independentGoldAdjudicated: false,
        releaseGateAccepted: false,
        reviewerIdentityAuthenticated: false,
        wholeAuthorizedCorpusAbsenceProven: false,
      });
      expect(
        p.cases.every(
          (c) =>
            c.sourceAnswerability === null &&
            c.reviewerAnswer === null &&
            c.wholeAuthorizedCorpusAbsenceChecked === null &&
            c.supportingQuoteSpans.length === 0,
        ),
      ).toBe(true);
      const text = JSON.stringify(p);
      for (const forbidden of [
        "targetStratum",
        "caseSeat",
        "ownerSuggestedGoldKeepPrivate",
        "externalCustodianCaseAuthor",
        "POSITIVE",
        "NEGATIVE_ADVERSARIAL",
        "coordinatorOnly",
      ])
        expect(text).not.toContain(forbidden);
    }
    expect(x.coordinatorOnly.cases).toHaveLength(240);
    expect(
      x.coordinatorOnly.cases.some((c) => c.targetStratum === "POSITIVE"),
    ).toBe(true);
    expect(x.packets.X.cases.map((c) => c.reviewCaseKey).sort()).toEqual(
      x.packets.Y.cases.map((c) => c.reviewCaseKey).sort(),
    );
    expect(x.packets.X.cases.map((c) => c.reviewCaseKey)).not.toEqual(
      x.packets.Y.cases.map((c) => c.reviewCaseKey),
    );
  });
  it("rejects unpinned rows and public or malformed shuffle key", () => {
    expect(() => build("bad-salt")).toThrow(/PRIVATE_SALT_REQUIRED/);
    const f = fixture();
    f.filledBytes = UTF(
      f.filledBytes.toString("utf8").replace('"approved"', '"changed"'),
    );
    expect(() =>
      prepareS2PreInferenceBlindReview({
        templateBytes: f.templateBytes,
        templateSha256: sha(f.templateBytes),
        filledBytes: f.filledBytes,
        filledSha256: sha("tampered"),
        sourceFiles: f.files,
        excludedDevelopmentPublisherFamilies: f.deny,
        reviewerShuffleSalt: "a".repeat(64),
      }),
    ).toThrow(/UNPINNED_BYTES/);
  });
  it("source-only review refuses a still-blank 240-seat template", () => {
    const f = fixture();
    f.filledBytes = f.templateBytes;
    expect(() =>
      prepareS2PreInferenceBlindReview({
        templateBytes: f.templateBytes,
        templateSha256: sha(f.templateBytes),
        filledBytes: f.filledBytes,
        filledSha256: sha(f.filledBytes),
        sourceFiles: f.files,
        excludedDevelopmentPublisherFamilies: f.deny,
        reviewerShuffleSalt: "a".repeat(64),
      }),
    ).toThrow(/UNFILLED_SOURCE_OR_QUESTION/);
  });
});
