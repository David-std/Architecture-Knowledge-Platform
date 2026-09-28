import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContextPacket,
  projectContextPacket,
  UNTRUSTED_RETRIEVED_CONTENT_ACTION,
  type PacketCandidateKind,
} from "../src/context-packet.js";

type PlacementCandidate = {
  id: string;
  kind: PacketCandidateKind;
  score: number;
  content?: string;
  contentRepeat?: number;
  mandatory?: boolean;
  conflictGroup?: string;
};

type PlacementRegression = {
  id: string;
  kind: "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS";
  requiredActions: string[];
  candidates: PlacementCandidate[];
};

type RegressionPack = {
  cases: Array<Record<string, unknown>>;
};

type RankedBudgetCandidate = {
  id: string;
  kind: PacketCandidateKind;
  score: number;
  retrievalRank: number;
  content: string;
  contentRepeat: number;
};

type RankedBudgetRegression = {
  id: string;
  kind: "QUERY_SUPPORTED_CONTEXT_BUDGET";
  query: string;
  budgets: number[];
  candidates: RankedBudgetCandidate[];
  mandatoryOverlay: {
    id: string;
    kind: PacketCandidateKind;
    score: number;
    content: string;
    contentRepeat: number;
    mandatory: true;
  };
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "context-correctness-regressions.json",
);

async function loadPlacementRegression(): Promise<PlacementRegression> {
  const pack = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as RegressionPack;
  const candidate = pack.cases.find(
    (item) => item.kind === "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS",
  );
  if (!candidate) {
    throw new Error("Missing context placement regression case.");
  }
  return candidate as unknown as PlacementRegression;
}

async function loadRankedBudgetRegression(): Promise<RankedBudgetRegression> {
  const pack = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as RegressionPack;
  const candidate = pack.cases.find(
    (item) => item.kind === "QUERY_SUPPORTED_CONTEXT_BUDGET",
  );
  if (!candidate) {
    throw new Error("Missing query-supported context budget regression case.");
  }
  return candidate as unknown as RankedBudgetRegression;
}

function paddedContent(value: string, minimumCharacters: number): string {
  if (value.length >= minimumCharacters) return value;
  return `${value} ${"x".repeat(minimumCharacters - value.length - 1)}`;
}

function documentId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

describe("registered ContextPacket correctness", () => {
  it("keeps query-supported rank ahead of generic document kind under tight budgets", async () => {
    const regression = await loadRankedBudgetRegression();
    const rankedCandidates = regression.candidates.map((candidate, index) => ({
      hit: {
        documentId: documentId(index + 20),
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: "ranked-context-budget",
        title: candidate.id,
        type: "benchmark",
        document: {
          externalId: `context:${candidate.id}`,
          path: `benchmarks/${candidate.id}.md`,
          title: candidate.id,
        },
        trust: "HUMAN_REVIEWED" as const,
        lifecycle: "ACTIVE" as const,
        score: candidate.score,
        reasons: ["registered-context-budget"],
        excerpt: candidate.content,
        citations: [`source:${candidate.id}`],
      },
      content: paddedContent(candidate.content, candidate.contentRepeat),
      kind: candidate.kind,
      retrievalRank: candidate.retrievalRank,
    }));
    const directId = rankedCandidates[0]?.hit.documentId;
    if (!directId) throw new Error("Ranked context fixture has no candidate.");

    for (const maxTokens of regression.budgets) {
      const packet = buildContextPacket({
        request: {
          query: regression.query,
          spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          vaultIds: [],
          federated: false,
          types: [],
          minimumTrust: "MACHINE_SUPPORTED",
          mode: "SOURCE_BACKED",
          limit: 20,
        },
        intent: "CONCEPTUAL",
        corpusRevision: "ranked-context-budget",
        maxTokens,
        candidates: rankedCandidates,
      });

      expect(packet.sections[0]).toMatchObject({
        documentId: directId,
        retrievalRank: 1,
      });
      expect(
        packet.sections.some((section) => section.documentId === directId),
      ).toBe(true);
      expect(packet.budget.serializedTokens).toBeLessThanOrEqual(maxTokens);
    }

    const mandatory = regression.mandatoryOverlay;
    const constrained = buildContextPacket({
      request: {
        query: regression.query,
        spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 20,
      },
      intent: "CONCEPTUAL",
      corpusRevision: "ranked-context-budget",
      maxTokens: regression.budgets[0] ?? 1_500,
      candidates: [
        {
          hit: {
            ...rankedCandidates[0]!.hit,
            documentId: documentId(30),
            title: mandatory.id,
            score: mandatory.score,
          },
          content: paddedContent(mandatory.content, mandatory.contentRepeat),
          kind: mandatory.kind,
          mandatory: true,
        },
        ...rankedCandidates,
      ],
    });

    expect(constrained.sections[0]?.kind).toBe("rule");
    expect(
      constrained.sections.some((section) => section.documentId === directId),
    ).toBe(false);
    expect(constrained.status).toBe("DEGRADED");
    expect(constrained.gaps).toContainEqual(
      expect.stringContaining(
        "Highest-ranked query-supported material omitted:",
      ),
    );
    expect(constrained.continuations.length).toBeGreaterThan(0);
  });

  it("retains mandatory actions while prioritizing rules and truncating oversized evidence", async () => {
    const regression = await loadPlacementRegression();
    const candidates = regression.candidates.map((candidate, index) => ({
      hit: {
        documentId: documentId(index),
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        revision: "context-placement",
        title: candidate.id,
        type: "benchmark",
        document: {
          externalId: `context:${candidate.id}`,
          path: `benchmarks/${candidate.id}.md`,
          title: candidate.id,
        },
        trust: "HUMAN_REVIEWED" as const,
        lifecycle: "ACTIVE" as const,
        score: candidate.score,
        reasons: ["context-placement"],
        excerpt: candidate.content ?? "oversized evidence",
        citations: [`source:${candidate.id}`],
      },
      content:
        candidate.content ?? "x".repeat(candidate.contentRepeat ?? 12_000),
      kind: candidate.kind,
      ...(candidate.mandatory ? { mandatory: true } : {}),
    }));

    const conflictGroups = new Map<string, string[]>();
    regression.candidates.forEach((candidate, index) => {
      if (!candidate.conflictGroup) return;
      const ids = conflictGroups.get(candidate.conflictGroup) ?? [];
      ids.push(documentId(index));
      conflictGroups.set(candidate.conflictGroup, ids);
    });
    const materialConflicts = [...conflictGroups.entries()].map(
      ([id, documentIds]) => ({ id, documentIds }),
    );
    const continuationSections: string[][] = [];

    const packet = buildContextPacket({
      request: {
        query: "apply the authorized architecture rule",
        spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vaultIds: [],
        federated: false,
        types: [],
        minimumTrust: "MACHINE_SUPPORTED",
        mode: "SOURCE_BACKED",
        limit: 20,
      },
      intent: "WORKFLOW_EXECUTION",
      corpusRevision: "context-placement",
      maxTokens: 2_000,
      requiredActions: regression.requiredActions,
      conflicts: ["transport-policy (OPEN)"],
      materialConflicts,
      continuationSink: (payload) => {
        continuationSections.push(
          payload.sections.map((section) => section.title),
        );
      },
      candidates,
    });

    expect(packet.sections[0]?.kind).toBe("rule");
    expect(packet.sections[0]?.title).toBe("governance-rule");
    expect(
      packet.sections.some((section) => section.title === "oversized-source"),
    ).toBe(false);
    expect(packet.continuations.length).toBeGreaterThan(0);
    expect(packet.conflicts).toContain("transport-policy (OPEN)");
    const selectedTitles = new Set(
      packet.sections.map((section) => section.title),
    );
    expect(selectedTitles.has("conflict-current")).toBe(true);
    expect(selectedTitles.has("conflict-peer")).toBe(true);
    expect(continuationSections.flat().includes("continuation-detail")).toBe(
      true,
    );

    expect(
      packet.requiredActions.slice(0, regression.requiredActions.length),
    ).toEqual(regression.requiredActions);
    expect(packet.requiredActions).toContain(
      UNTRUSTED_RETRIEVED_CONTENT_ACTION,
    );
    for (const action of regression.requiredActions) {
      expect(
        packet.sections.some((section) => section.content.includes(action)),
      ).toBe(false);
    }

    const compact = projectContextPacket(packet, { maxTokens: 4_000 });
    expect(compact.requiredActions).toEqual(packet.requiredActions);
    expect(
      compact.requiredActions.slice(0, regression.requiredActions.length),
    ).toEqual(regression.requiredActions);
  });
});
