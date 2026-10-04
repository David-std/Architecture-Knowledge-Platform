import type {
  TemporalFactView,
  TruthSupportSet,
} from "@akp/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalTemporalFactObject,
  projectSupportedTemporalFact,
  resolveTemporalFactPropositionForCandidate,
  type GovernedPropositionEvidence,
} from "../src/proposition-projection.js";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const VAULT_ID = "22222222-2222-4222-8222-222222222222";
const SUPPORT_ID = "33333333-3333-4333-8333-333333333333";
const FACT_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_A = "55555555-5555-4555-8555-555555555555";
const EVIDENCE_B = "66666666-6666-4666-8666-666666666666";

function fact(
  override: Partial<TemporalFactView> = {},
): TemporalFactView {
  return {
    id: FACT_ID,
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
    scopeId: "security:access",
    authorizationPath: "security/access.md",
    subjectRef: "policy:admin-access",
    predicate: "requires_mfa",
    object: {
      required: true,
      channel: "security key",
      levels: [2, 1],
    },
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    recordedAt: "2026-01-02T00:00:00.000Z",
    sourceEpisodeId: null,
    supportSetId: SUPPORT_ID,
    lifecycle: "ACTIVE",
    truthRevisionHash: "a".repeat(64),
    truthRevisionSeq: 7,
    supportState: "SUPPORTED",
    truthState: "SUPPORTED_CURRENT",
    queryRevisionHash: "a".repeat(64),
    queryRevisionSeq: 7,
    ...override,
  };
}

function support(
  override: Partial<TruthSupportSet> = {},
): TruthSupportSet {
  return {
    schemaVersion: 1,
    id: SUPPORT_ID,
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
    state: "SUPPORTED",
    factIds: [],
    evidenceIds: [EVIDENCE_B, EVIDENCE_A],
    sourceArtifactIds: [],
    sourceRevisionHashes: [],
    sourceEpisodeIds: [],
    alternativeSupportGroups: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    ...override,
  };
}

function evidence(
  id: string,
  excerpt: string,
  override: Partial<GovernedPropositionEvidence> = {},
): GovernedPropositionEvidence {
  return {
    id,
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
    sourceId: "77777777-7777-4777-8777-777777777777",
    artifactId: "88888888-8888-4888-8888-888888888888",
    locator: {
      kind: "markdown",
      path: "10-sources/security.md",
      startLine: 4,
      endLine: 4,
      contentHash: "b".repeat(64),
    },
    contentHash: "c".repeat(64),
    excerpt,
    ...override,
  };
}

describe("temporal fact proposition projection", () => {
  it("projects only governed current truth with deterministic object and evidence identity", () => {
    const projected = projectSupportedTemporalFact({
      fact: fact(),
      supportSet: support(),
      evidence: [
        evidence(EVIDENCE_B, "Secondary evidence"),
        evidence(EVIDENCE_A, "MFA is required for admin access."),
      ],
    });

    expect(projected).not.toBeNull();
    expect(projected).toMatchObject({
      sourceFactId: FACT_ID,
      kind: "CLAIM",
      subjectRefs: ["policy:admin-access"],
      predicate: "requires_mfa",
      objectRefs: [
        '{"channel":"security key","levels":[2,1],"required":true}',
      ],
      derivation: "TEMPORAL_TRUTH",
      revision: "a".repeat(64),
      supportSetId: SUPPORT_ID,
    });
    expect(projected?.evidenceRefs.map((entry) => entry.id)).toEqual([
      EVIDENCE_A,
      EVIDENCE_B,
    ]);
  });

  it("canonicalizes JSON identity without interpreting object field names", () => {
    expect(
      canonicalTemporalFactObject({
        z: false,
        a: { beta: " value ", alpha: 2 },
      }),
    ).toBe('{"a":{"alpha":2,"beta":"value"},"z":false}');
    expect(canonicalTemporalFactObject(" value ")).toBe('"value"');
    expect(canonicalTemporalFactObject(Number.NaN)).toBeNull();
  });

  it.each([
    ["disputed lifecycle", { lifecycle: "DISPUTED" } as Partial<TemporalFactView>],
    [
      "disputed support",
      { supportState: "DISPUTED" } as Partial<TemporalFactView>,
    ],
    [
      "historical truth",
      { truthState: "HISTORICAL" } as Partial<TemporalFactView>,
    ],
  ])("rejects %s", (_name, override) => {
    expect(
      projectSupportedTemporalFact({
        fact: fact(override),
        supportSet: support(),
        evidence: [
          evidence(EVIDENCE_A, "A"),
          evidence(EVIDENCE_B, "B"),
        ],
      }),
    ).toBeNull();
  });

  it("rejects mixed or alternative support because active evidence authority is ambiguous", () => {
    expect(
      projectSupportedTemporalFact({
        fact: fact(),
        supportSet: support({
          sourceEpisodeIds: ["99999999-9999-4999-8999-999999999999"],
        }),
        evidence: [
          evidence(EVIDENCE_A, "A"),
          evidence(EVIDENCE_B, "B"),
        ],
      }),
    ).toBeNull();

    expect(
      projectSupportedTemporalFact({
        fact: fact(),
        supportSet: support({
          alternativeSupportGroups: [[`evidence:${EVIDENCE_A}`]],
        }),
        evidence: [
          evidence(EVIDENCE_A, "A"),
          evidence(EVIDENCE_B, "B"),
        ],
      }),
    ).toBeNull();
  });

  it("rejects missing, duplicate and cross-vault evidence", () => {
    expect(
      projectSupportedTemporalFact({
        fact: fact(),
        supportSet: support(),
        evidence: [evidence(EVIDENCE_A, "A")],
      }),
    ).toBeNull();

    expect(
      projectSupportedTemporalFact({
        fact: fact(),
        supportSet: support(),
        evidence: [
          evidence(EVIDENCE_A, "A"),
          evidence(EVIDENCE_A, "A again"),
          evidence(EVIDENCE_B, "B"),
        ],
      }),
    ).toBeNull();

    expect(
      projectSupportedTemporalFact({
        fact: fact(),
        supportSet: support(),
        evidence: [
          evidence(EVIDENCE_A, "A", {
            vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
          evidence(EVIDENCE_B, "B"),
        ],
      }),
    ).toBeNull();
  });

  it("resolves an exact proposition span only with authorized evidence identity", () => {
    const excerpt = "MFA is required for admin access.";
    const projected = projectSupportedTemporalFact({
      fact: fact(),
      supportSet: support({ evidenceIds: [EVIDENCE_A] }),
      evidence: [evidence(EVIDENCE_A, excerpt)],
    });
    expect(projected).not.toBeNull();
    if (!projected) return;

    const passage = `Prefix. ${excerpt} Suffix.`;
    const resolved = resolveTemporalFactPropositionForCandidate(
      projected,
      { vaultId: VAULT_ID, excerpt: passage },
      [EVIDENCE_A],
    );
    expect(resolved).toEqual({
      evidenceId: EVIDENCE_A,
      proposition: {
        subject: "policy:admin-access",
        predicate: "requires_mfa",
        object: '{"channel":"security key","levels":[2,1],"required":true}',
        polarity: "POSITIVE",
        quote: {
          startOffset: "Prefix. ".length,
          endOffset: "Prefix. ".length + excerpt.length,
        },
      },
    });

    expect(
      resolveTemporalFactPropositionForCandidate(
        projected,
        { vaultId: VAULT_ID, excerpt: passage },
        [],
      ),
    ).toBeNull();
    expect(
      resolveTemporalFactPropositionForCandidate(
        projected,
        { vaultId: VAULT_ID, excerpt: passage },
        [EVIDENCE_B],
      ),
    ).toBeNull();
  });

  it("fails closed when the source excerpt is absent, repeated or from another vault", () => {
    const excerpt = "MFA is required for admin access.";
    const projected = projectSupportedTemporalFact({
      fact: fact(),
      supportSet: support({ evidenceIds: [EVIDENCE_A] }),
      evidence: [evidence(EVIDENCE_A, excerpt)],
    });
    expect(projected).not.toBeNull();
    if (!projected) return;

    expect(
      resolveTemporalFactPropositionForCandidate(
        projected,
        { vaultId: VAULT_ID, excerpt: "Different evidence." },
        [EVIDENCE_A],
      ),
    ).toBeNull();
    expect(
      resolveTemporalFactPropositionForCandidate(
        projected,
        { vaultId: VAULT_ID, excerpt: `${excerpt}\n${excerpt}` },
        [EVIDENCE_A],
      ),
    ).toBeNull();
    expect(
      resolveTemporalFactPropositionForCandidate(
        projected,
        {
          vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          excerpt,
        },
        [EVIDENCE_A],
      ),
    ).toBeNull();
  });
});
