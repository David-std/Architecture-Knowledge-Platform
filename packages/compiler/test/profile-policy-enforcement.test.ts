import { describe, expect, it } from "vitest";
import {
  KnowledgeCompilerInput,
  deriveKnowledgePath,
  deriveProfileKnowledgePath,
  durableCompilerKnowledgeProfileContext,
  knowledgeProfileHash,
  normalizeKnowledgeCompilerResult,
  resultToCompilationPlan,
} from "../src/index.js";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
} from "@akp/contracts/knowledge-profile";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
const SPACE_ID = "44444444-4444-4444-8444-444444444444";
const VAULT_ID = "55555555-5555-4555-8555-555555555555";
const REVISION_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);
const STATEMENT =
  "Invalidate stale cache entries after the authoritative revision changes.";

function locator() {
  return {
    kind: "paragraph" as const,
    source_hash: SOURCE_HASH,
    path: `source:${SOURCE_ID}`,
    paragraph: 1,
    heading_path: ["Guidance"],
  };
}

function durableContext(profile: unknown) {
  const parsed = KnowledgeProfileV1.parse(profile);
  return durableCompilerKnowledgeProfileContext({
    revisionId: REVISION_ID,
    profileHash: knowledgeProfileHash(parsed),
    profile: parsed,
  });
}

function inputFor(
  profile: unknown,
  trust: "UNVERIFIED" | "MACHINE_SUPPORTED" = "MACHINE_SUPPORTED",
) {
  const parsedProfile = KnowledgeProfileV1.parse(profile);
  return KnowledgeCompilerInput.parse({
    source: {
      sourceId: SOURCE_ID,
      sourceArtifactId: ARTIFACT_ID,
      sha256: SOURCE_HASH,
      title: "Cache guidance",
      mediaType: "text/markdown",
    },
    documentArtifact: {
      source_id: SOURCE_ID,
      source_hash: SOURCE_HASH,
      media_type: "text/markdown",
      extractor: "fixture",
      extractor_version: "1",
      locators: [locator()],
    },
    evidence: [
      {
        id: EVIDENCE_ID,
        sourceArtifactId: ARTIFACT_ID,
        locator: locator(),
        excerpt: STATEMENT,
        excerptHash: EXCERPT_HASH,
        trust,
      },
    ],
    existingCandidates: [],
    knowledgeProfile: durableContext(parsedProfile),
    schemaProfile: { compiledRoot: "legacy-generated" },
    policy: {
      reviewRequired: true,
      allowDirectPublication: false,
      allowedKnowledgeKinds: Object.keys(parsedProfile.knowledgeKinds),
    },
    corpusRevision: "corpus-profile-policy",
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
  });
}

function resultFor(input: ReturnType<typeof inputFor>, kind: string) {
  const candidateId = "candidate-1";
  const path = deriveProfileKnowledgePath({
    title: STATEMENT,
    kind,
    candidateId,
    knowledgeProfile: input.knowledgeProfile,
    schemaProfile: input.schemaProfile,
  });
  return {
    identity: {
      classification: "DISTINCT" as const,
      candidates: [],
      reason: "Distinct grounded guidance.",
    },
    evidenceCandidates: [
      {
        sourceArtifactId: ARTIFACT_ID,
        locator: locator(),
        excerptHash: EXCERPT_HASH,
      },
    ],
    knowledgeCandidates: [
      {
        candidateId,
        kind,
        statement: STATEMENT,
        scope: "Revision-addressed caches.",
        evidenceIds: [EVIDENCE_ID],
        confidence: 0.9,
        proposedAction: "CREATE" as const,
      },
    ],
    contradictions: [],
    proposedFileChanges: [
      {
        candidateId,
        path,
        operation: "CREATE" as const,
        content: `---\nid: CACHE-1\ntype: ${kind}\nstatus: draft\n---\n\n${STATEMENT}\n`,
        reasons: ["Grounded in source evidence."],
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    impactedDocumentIds: [],
    probes: [
      {
        question: "Is the proposal grounded?",
        criticality: "CRITICAL" as const,
        evidenceIds: [EVIDENCE_ID],
      },
    ],
    warnings: [],
    summary: "One review-required proposal.",
  };
}

describe("KnowledgeProfile runtime policy enforcement", () => {
  it("keeps the default profile artifact placement byte-compatible with the legacy compiledRoot rule", () => {
    const context = durableContext(DEFAULT_KNOWLEDGE_PROFILE_V1);
    const schemaProfile = { compiledRoot: "custom-generated" };
    expect(
      deriveProfileKnowledgePath({
        title: STATEMENT,
        kind: "rule",
        candidateId: "candidate-1",
        knowledgeProfile: context,
        schemaProfile,
      }),
    ).toBe(
      deriveKnowledgePath({
        title: STATEMENT,
        kind: "rule",
        schemaProfile,
      }),
    );
  });

  it("uses a durable non-default profile artifact contract instead of legacy compiledRoot", () => {
    const input = inputFor(NEUTRAL_KNOWLEDGE_PROFILE_V1, "UNVERIFIED");
    const result = resultFor(input, "note");
    expect(result.proposedFileChanges[0]?.path).toBe(
      "knowledge/note/candidate-1.md",
    );
    expect(() => normalizeKnowledgeCompilerResult(input, result)).not.toThrow();

    const legacyPath = structuredClone(result);
    legacyPath.proposedFileChanges[0]!.path = deriveKnowledgePath({
      title: STATEMENT,
      kind: "note",
      schemaProfile: input.schemaProfile,
    });
    expect(() => normalizeKnowledgeCompilerResult(input, legacyPath)).toThrow(
      /CREATE_PATH_NOT_RUNTIME_DERIVED/,
    );
  });

  it("fails closed when a kind requires more evidence references than the model supplied", () => {
    const profile = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);
    profile.evidencePolicies["optional-evidence"]!.minimumEvidence = 2;
    const input = inputFor(profile, "UNVERIFIED");
    expect(() =>
      normalizeKnowledgeCompilerResult(input, resultFor(input, "note")),
    ).toThrow(/COMPILER_EVIDENCE_POLICY_MINIMUM_NOT_MET:candidate-1/);
  });

  it("fails closed when evidence trust is below the active profile minimum", () => {
    const input = inputFor(NEUTRAL_KNOWLEDGE_PROFILE_V1, "UNVERIFIED");
    expect(() =>
      normalizeKnowledgeCompilerResult(input, resultFor(input, "procedure")),
    ).toThrow(/COMPILER_EVIDENCE_POLICY_TRUST_NOT_MET:candidate-1/);
  });

  it("keeps human review mandatory even when a profile is more permissive", () => {
    const profile = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);
    profile.reviewPolicies["neutral-review"]!.required = false;
    profile.reviewPolicies["neutral-review"]!.minimumApprovals = 0;
    profile.reviewPolicies["neutral-review"]!.allowedRoles = ["CURATOR"];
    const input = inputFor(profile, "UNVERIFIED");
    const plan = resultToCompilationPlan(input, resultFor(input, "note"));
    expect(plan.reviewContext?.reviewPolicy).toMatchObject({
      required: true,
      minimumApprovals: 1,
      allowedRoles: ["CURATOR"],
      profileSource: "DURABLE_REVISION",
      profileRevisionId: REVISION_ID,
      profileId: "neutral-notes",
    });
  });
});
