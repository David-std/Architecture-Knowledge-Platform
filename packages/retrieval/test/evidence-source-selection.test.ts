import { beforeAll, describe, expect, it } from "vitest";
import { ReaderEvidenceVerifier } from "../src/evidence-reader.js";
import {
  loadEvidenceAdmissionPack,
  evaluateEvidenceAdmission,
  type EvidenceAdmissionCase,
} from "../../../scripts/evidence-admission-pack.js";
import {
  parseSourceSelection,
  sourceSelectionCorpusHash,
  validateSourceSelectionShards,
  type SourceSelectionShard,
} from "../scripts/evidence-source-selection-contract.js";

const reply = (first: unknown, last: unknown) =>
  JSON.stringify({ verdict: "ANSWERS", source_start: first, source_end: last });
describe("source coordinates remain separate from evidence admission", () => {
  it("slices continuous source lines without rewriting Unicode or punctuation", () => {
    const body =
      "Ignored.\nRésumé 🧭: 3.5; qualifying phrase.\nSecond line.\nIgnored again.";
    expect(parseSourceSelection(reply(2, 3), body)).toEqual({
      answers: true,
      quote: "Résumé 🧭: 3.5; qualifying phrase.\nSecond line.",
    });
  });
  it.each([
    ["1", 1],
    [1.2, 2],
    [0, 1],
    [2, 1],
    [1, 3],
    [null, null],
  ])("rejects malformed or nonexistent coordinates %s..%s", (first, last) => {
    expect(() => parseSourceSelection(reply(first, last), "one\ntwo")).toThrow(
      "EVIDENCE_READER_SELECTION_INVALID",
    );
  });
  it("does not turn unrelated or absent evidence into an answer", () => {
    expect(
      parseSourceSelection(
        '{"verdict":"RELATED_NOT_ANSWERING","source_start":1,"source_end":1}',
        "one",
      ),
    ).toEqual({ answers: false, quote: "" });
    expect(() => parseSourceSelection('{"verdict":"invented"}', "one")).toThrow(
      "EVIDENCE_READER_REPLY_INVALID",
    );
  });
  it("retains ambiguity and hidden-source guards after coordinate selection", async () => {
    const verifier = new ReaderEvidenceVerifier({
      reader: {
        id: "fixture",
        judge: async (input) => parseSourceSelection(reply(1, 1), input.body),
      },
    });
    const input = {
      query: "What does the source state?",
      candidateKey: "fixture",
      title: "Fixture",
      documentType: "claim",
      unitType: "PARAGRAPH" as const,
      parentUnitType: null,
      passage: "The release is approved.\nThe release is approved.",
    };
    expect((await verifier.verify(input)).reason).toBe(
      "READER_QUOTE_NOT_IN_PASSAGE",
    );
    expect(
      (
        await verifier.verify({
          ...input,
          passage: "Visible before <!-- hidden assertion --> visible after.",
        })
      ).reason,
    ).toBe("READER_QUOTE_NOT_IN_PASSAGE");
  });
  it("maps the selected normalized table row to the original source row", async () => {
    const passage = "| Item | Limit |\n| --- | --- |\n| A | 3 |\n| B | 7 |";
    const verifier = new ReaderEvidenceVerifier({
      reader: {
        id: "fixture",
        judge: async (input) => parseSourceSelection(reply(2, 2), input.body),
      },
    });
    const result = await verifier.verify({
      query: "What is the limit for B?",
      candidateKey: "fixture",
      title: "Limits",
      passage,
      unitType: "TABLE",
      parentUnitType: null,
      documentType: "claim",
    });
    expect(
      passage.slice(
        result.evidenceSpan!.startOffset,
        result.evidenceSpan!.endOffset,
      ),
    ).toBe("B | 7");
  });
});

describe("paired measurement provenance", () => {
  let cases: EvidenceAdmissionCase[];
  let original: SourceSelectionShard[];
  beforeAll(async () => {
    cases = (await loadEvidenceAdmissionPack(["development"])).cases.slice(
      0,
      2,
    );
    original = await Promise.all(
      cases.map(async (entry, shardIndex) => {
        const rows = await evaluateEvidenceAdmission([entry], async () => []);
        const stats = {
          calls: 1,
          timeMs: 10,
          providerErrors: 0,
          parseErrors: 0,
          invalidSelections: 0,
        };
        return {
          schemaVersion: 2,
          benchmark: "EVIDENCE_SOURCE_SELECTION_AB",
          split: "development",
          shardIndex,
          shardCount: 2,
          model: { revision: "fixture-pin" },
          measurement: {
            corpusHash: sourceSelectionCorpusHash(cases),
            runtimeHash: "b".repeat(64),
            configurationHash: "c".repeat(64),
          },
          cases: 1,
          arms: {
            "quote-v4": {
              rows: structuredClone(rows),
              traces: [],
              stats: { ...stats },
            },
            "source-selection-v1": {
              rows: structuredClone(rows),
              traces: [],
              stats: { ...stats },
            },
          },
        } as SourceSelectionShard;
      }),
    );
  });
  it("accepts a complete paired run", () =>
    expect(() => validateSourceSelectionShards(original, cases)).not.toThrow());
  it.each(["model", "corpusHash", "runtimeHash", "configurationHash"] as const)(
    "rejects mixed %s provenance",
    (key) => {
      const reports = structuredClone(original);
      if (key === "model") reports[1]!.model = { revision: "other-pin" };
      else reports[1]!.measurement[key] = "d".repeat(64);
      expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
        "SOURCE_SELECTION_PROVENANCE_MISMATCH",
      );
    },
  );
  it("rejects a shared stale source pool even when questions and labels agree", () => {
    const reports = structuredClone(original);
    for (const report of reports)
      report.measurement.corpusHash = "e".repeat(64);
    expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
      "SOURCE_SELECTION_CORPUS_MISMATCH",
    );
  });
  it("rejects missing and repeated shard identities", () => {
    expect(() =>
      validateSourceSelectionShards(original.slice(0, 1), cases),
    ).toThrow("SOURCE_SELECTION_SHARDS_INCOMPLETE");
    const reports = structuredClone(original);
    reports[1]!.shardIndex = 0;
    expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
      "SOURCE_SELECTION_SHARD_INVALID",
    );
  });
  it("rejects an unpaired question even when the total count agrees", () => {
    const reports = structuredClone(original);
    reports[0]!.arms["source-selection-v1"].rows = structuredClone(
      reports[1]!.arms["quote-v4"].rows,
    );
    expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
      "SOURCE_SELECTION_PAIRING_INVALID",
    );
  });
  it("rejects a duplicate question across otherwise distinct shards", () => {
    const reports = structuredClone(original);
    for (const arm of ["quote-v4", "source-selection-v1"] as const)
      reports[1]!.arms[arm].rows = structuredClone(reports[0]!.arms[arm].rows);
    expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
      "SOURCE_SELECTION_QUESTIONS_INCOMPLETE",
    );
  });
  it("rejects changed labels, inflated correctness and unavailable units", () => {
    for (const alteration of [
      "query",
      "correctness",
      "unknown-unit",
    ] as const) {
      const reports = structuredClone(original);
      const row = reports[0]!.arms["quote-v4"].rows[0]!;
      if (alteration === "query") row.query = "different question";
      if (alteration === "correctness") row.goldAdmitted = !row.goldAdmitted;
      if (alteration === "unknown-unit") row.admitted = ["not-in-pool"];
      expect(() => validateSourceSelectionShards(reports, cases)).toThrow();
    }
  });
  it("rejects infrastructure failure and invalid latency", () => {
    const reports = structuredClone(original);
    reports[0]!.arms["quote-v4"].stats.providerErrors = 1;
    expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
      "SOURCE_SELECTION_PROVIDER_ERROR",
    );
    reports[0]!.arms["quote-v4"].stats.providerErrors = 0;
    reports[0]!.arms["quote-v4"].rows[0]!.latencyMs = NaN;
    expect(() => validateSourceSelectionShards(reports, cases)).toThrow(
      "SOURCE_SELECTION_QUESTION_MISMATCH",
    );
  });
});

describe("frozen evidence-alignment audit", () => {
  type AuditEntry = {
    questionId: string;
    family: string;
    citations: Array<{ unit: string; quote: string }>;
  };
  type AuditDefinition = {
    version: number;
    frozenAt: string;
    development: AuditEntry[];
    independent: AuditEntry[];
  };

  it("keeps abstract families disjoint and binds every gold unit to one exact source span", async () => {
    const loaded = await loadEvidenceAdmissionPack();
    const audit = (
      loaded.manifest as unknown as { alignmentAudit?: AuditDefinition }
    ).alignmentAudit;
    expect(audit).toBeDefined();
    expect(audit).toMatchObject({ version: 1, frozenAt: "2026-10-02" });

    const definition = audit!;
    expect(definition.development).toHaveLength(8);
    expect(definition.independent).toHaveLength(10);

    const developmentFamilies = new Set(
      definition.development.map((entry) => entry.family),
    );
    const independentFamilies = new Set(
      definition.independent.map((entry) => entry.family),
    );
    expect([...developmentFamilies].sort()).toEqual(
      [
        "DIRECT_BOOLEAN",
        "DIRECT_CONDITION",
        "DIRECT_ENTITY",
        "DIRECT_VALUE",
      ].sort(),
    );
    expect([...independentFamilies].sort()).toEqual(
      [
        "COMPOUND_SCOPE",
        "RELATION_DIRECTION",
        "SUBJECT_BINDING",
        "TEMPORAL_SLOT_BINDING",
      ].sort(),
    );
    expect(
      [...developmentFamilies].filter((family) =>
        independentFamilies.has(family),
      ),
    ).toEqual([]);

    const cases = new Map(
      loaded.cases.map((entry) => [entry.question.id, entry]),
    );
    const seen = new Set<string>();
    const validate = (
      entries: readonly AuditEntry[],
      expectedSplit: "development" | "heldout",
    ) => {
      for (const item of entries) {
        expect(seen.has(item.questionId)).toBe(false);
        seen.add(item.questionId);
        const entry = cases.get(item.questionId);
        expect(entry?.domain.split).toBe(expectedSplit);
        expect(
          [...new Set(item.citations.map((citation) => citation.unit))].sort(),
        ).toEqual([...entry!.question.gold].sort());
        expect(item.citations).toHaveLength(entry!.question.gold.length);

        for (const citation of item.citations) {
          const unit = entry!.domain.units.find(
            (candidate) => candidate.id === citation.unit,
          );
          expect(unit).toBeDefined();
          const start = unit!.text.indexOf(citation.quote);
          expect(start).toBeGreaterThanOrEqual(0);
          expect(unit!.text.indexOf(citation.quote, start + 1)).toBe(-1);
        }
      }
    };

    validate(definition.development, "development");
    validate(definition.independent, "heldout");

    const independentCases = definition.independent.map((item) =>
      cases.get(item.questionId)!,
    );
    expect(
      independentCases.filter((entry) => entry.question.gold.length > 0),
    ).toHaveLength(4);
    expect(
      independentCases.filter((entry) => entry.question.gold.length === 0),
    ).toHaveLength(6);
  });
});
