import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attributeS2VerbatimQuote } from "../src/s2-exact-quote-attribution.js";
import {
  buildS2PairedQuoteEvidenceTokenFormat,
  freezeS2QuoteEvidenceOptions,
  resolveS2QuoteEvidenceToken,
} from "../src/s2-quote-evidence-choice.js";

const dir = path.resolve(
  import.meta.dirname,
  "../../../evals/fixtures/s2-source-bound-relation-dev",
);
interface Case {
  id: string;
  family: string;
  language: "en" | "es";
  sourceId: string;
  sourceText: string;
  question: string;
  proposedAnswer: string;
  claim: string;
}
interface Label {
  id: string;
  label: "EXPLICIT_SUPPORT" | "NOT_ANSWERABLE";
  expectedAnswer: string | null;
  sourceFamily: string;
  language: string;
}
async function dataset() {
  const c = JSON.parse(
    await readFile(path.join(dir, "cases.json"), "utf8"),
  ) as {
    schemaVersion: string;
    syntheticFictionalSources: boolean;
    independentAdjudication: boolean;
    cases: Case[];
  };
  const g = JSON.parse(
    await readFile(path.join(dir, "dev-labels.json"), "utf8"),
  ) as {
    schemaVersion: string;
    independentlyAdjudicated: boolean;
    labels: Label[];
  };
  return { c, g };
}
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
describe("S2 novel EN/ES synthetic relationship DEV fixture (not independent gold)", () => {
  it("freezes eight distinct fact families, two case types and balanced languages", async () => {
    const { c, g } = await dataset();
    expect(c.schemaVersion).toBe("akp.s2.relation-dev-cases.v1");
    expect(g.schemaVersion).toBe("akp.s2.relation-dev-labels.v1");
    expect(c.syntheticFictionalSources).toBe(true);
    expect(c.independentAdjudication).toBe(false);
    expect(g.independentlyAdjudicated).toBe(false);
    expect(c.cases).toHaveLength(16);
    expect(g.labels).toHaveLength(16);
    expect(new Set(c.cases.map((x) => x.id)).size).toBe(16);
    expect(new Set(g.labels.map((x) => x.id)).size).toBe(16);
    for (const language of ["en", "es"]) {
      expect(c.cases.filter((x) => x.language === language)).toHaveLength(8);
      expect(
        g.labels.filter(
          (x) => x.language === language && x.label === "EXPLICIT_SUPPORT",
        ),
      ).toHaveLength(4);
      expect(
        g.labels.filter(
          (x) => x.language === language && x.label === "NOT_ANSWERABLE",
        ),
      ).toHaveLength(4);
    }
    const families = new Set(c.cases.map((x) => x.family));
    expect(families.size).toBe(8);
    for (const family of families) {
      const rows = c.cases.filter((x) => x.family === family);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((x) => x.sourceText)).size).toBe(1);
      expect(new Set(rows.map((x) => x.language)).size).toBe(1);
      expect(rows.filter((x) => x.id.includes("-P"))).toHaveLength(1);
      expect(rows.filter((x) => x.id.includes("-N"))).toHaveLength(1);
    }
    for (const row of c.cases) {
      const gold = g.labels.find((x) => x.id === row.id);
      expect(gold).toMatchObject({
        sourceFamily: row.family,
        language: row.language,
      });
      expect(gold?.label).toBe(
        row.id.includes("-P") ? "EXPLICIT_SUPPORT" : "NOT_ANSWERABLE",
      );
      expect(gold?.expectedAnswer).toBe(
        row.id.includes("-P") ? row.proposedAnswer : null,
      );
    }
  });
  it("binds every original to its own UTF-8 SHA and exact UTF-16 range, without fuzzy quote repair", async () => {
    const { c } = await dataset();
    for (const row of c.cases) {
      const exactUtf8Bytes = Buffer.from(row.sourceText, "utf8");
      const original = {
        assignedSourceId: row.sourceId,
        sourceSha256: sha(exactUtf8Bytes),
        exactUtf8Bytes,
        bodyStartUtf16: 0,
        bodyEndUtf16: row.sourceText.length,
      };
      const claim = {
        answerText: row.claim,
        evidenceQuote: row.sourceText,
        sourceId: row.sourceId,
        abstained: false,
      };
      expect(attributeS2VerbatimQuote(claim, [original])).toMatchObject({
        status: "VERBATIM_UNIQUE_SOURCE_BOUND",
        startUtf16: 0,
        endUtf16: row.sourceText.length,
        semanticEntailmentVerified: false,
        releaseGateAccepted: false,
      });
      expect(
        attributeS2VerbatimQuote(claim, [
          { ...original, sourceSha256: "0".repeat(64) },
        ]).status,
      ).toBe("REJECTED");
      expect(
        attributeS2VerbatimQuote(
          { ...claim, evidenceQuote: row.sourceText + " unsupported" },
          [original],
        ).status,
      ).toBe("REJECTED");
    }
  });
  it("requires literal pre-frozen decision and citation tokens, not invented evidence", async () => {
    const { c } = await dataset();
    for (const row of c.cases) {
      const frozen = freezeS2QuoteEvidenceOptions(row.sourceText);
      const schema = buildS2PairedQuoteEvidenceTokenFormat(
        row.sourceText,
        frozen,
      );
      expect(schema.properties.questionToken.enum).toContain("SUPPORTS@Q1");
      expect(
        resolveS2QuoteEvidenceToken(row.sourceText, frozen, "SUPPORTS@Q1"),
      ).toMatchObject({
        decision: "SUPPORTS",
        evidenceSpan: { startUtf16: 0, endUtf16: row.sourceText.length },
      });
      expect(
        resolveS2QuoteEvidenceToken(row.sourceText, frozen, "SUPPORTS@Q999")
          .decision,
      ).toBe("INSUFFICIENT");
      expect(
        resolveS2QuoteEvidenceToken(row.sourceText, frozen, "INSUFFICIENT@Q1")
          .decision,
      ).toBe("INSUFFICIENT");
      expect(frozen.productionAdmission).toBe(false);
    }
  });
  it("registers separately eight genuinely missing-attribute queries before inference", async () => {
    const { c } = await dataset();
    const data = JSON.parse(
      await readFile(path.join(dir, "absent-writer.json"), "utf8"),
    ) as {
      schemaVersion: string;
      authorPreparedNotIndependent: boolean;
      reusesRelationDevSourceFamilies: boolean;
      cases: {
        id: string;
        sourceCaseId: string;
        question: string;
        language: string;
        expected: string;
      }[];
    };
    expect(data.schemaVersion).toBe("akp.s2.dev-absent-writer-cases.v1");
    expect(data.authorPreparedNotIndependent).toBe(true);
    expect(data.reusesRelationDevSourceFamilies).toBe(true);
    expect(data.cases).toHaveLength(8);
    expect(new Set(data.cases.map((x) => x.id)).size).toBe(8);
    expect(new Set(data.cases.map((x) => x.sourceCaseId)).size).toBe(8);
    const families = new Set<string>();
    for (const row of data.cases) {
      const source = c.cases.find((x) => x.id === row.sourceCaseId);
      expect(source).toBeDefined();
      expect(row.language).toBe(source?.language);
      expect(row.question).not.toBe(source?.question);
      expect(row.expected).toBe("NO_EXPLICIT_ANSWER_IN_AUTHORIZED_EXCERPT");
      families.add(source!.family);
    }
    expect(families.size).toBe(8);
    expect(data.cases.filter((x) => x.language === "en")).toHaveLength(4);
    expect(data.cases.filter((x) => x.language === "es")).toHaveLength(4);
  });
});
