from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "packages/compiler/src/contracts.ts",
    "    knowledgeCandidates: z.array(KnowledgeCandidate).max(50),\n    contradictions: z.array(KnowledgeContradiction).max(50),",
    "    knowledgeCandidates: z.array(KnowledgeCandidate).max(50),\n    reviewKinds: z.array(KnowledgeKind).max(50).optional(),\n    contradictions: z.array(KnowledgeContradiction).max(50),",
)

replace_once(
    "packages/compiler/src/grounding.ts",
    '''function effectiveReviewPolicy(\n  input: KnowledgeCompilerInputType,\n  result: KnowledgeCompilerResultType,\n) {\n  const materialCandidateIds = new Set(\n    result.proposedFileChanges.map((change) => change.candidateId),\n  );\n  const kinds = [\n    ...new Set(\n      result.knowledgeCandidates\n        .filter((candidate) =>\n          materialCandidateIds.size\n            ? materialCandidateIds.has(candidate.candidateId)\n            : candidate.proposedAction !== "NO_MATERIAL",\n        )\n        .map((candidate) => candidate.kind),\n    ),\n  ];\n  return effectiveReviewPolicyForKinds(input.knowledgeProfile, kinds);\n}\n''',
    '''export function effectiveReviewKinds(\n  result: KnowledgeCompilerResultType,\n): string[] {\n  const materialCandidateIds = new Set(\n    result.proposedFileChanges.map((change) => change.candidateId),\n  );\n  return [\n    ...new Set(\n      result.knowledgeCandidates\n        .filter((candidate) =>\n          materialCandidateIds.size\n            ? materialCandidateIds.has(candidate.candidateId)\n            : candidate.proposedAction !== "NO_MATERIAL",\n        )\n        .map((candidate) => candidate.kind),\n    ),\n  ];\n}\n\nfunction effectiveReviewPolicy(\n  input: KnowledgeCompilerInputType,\n  result: KnowledgeCompilerResultType,\n) {\n  return effectiveReviewPolicyForKinds(\n    input.knowledgeProfile,\n    effectiveReviewKinds(result),\n  );\n}\n''',
)

replace_once(
    "packages/compiler/src/grounding.ts",
    "    knowledgeCandidates: result.knowledgeCandidates,\n    contradictions: result.contradictions,",
    "    knowledgeCandidates: result.knowledgeCandidates,\n    reviewKinds: effectiveReviewKinds(result),\n    contradictions: result.contradictions,",
)

replace_once(
    "apps/api/src/review-policy.ts",
    '''  const context = asRecord(manifest.reviewContext);\n  const candidates = Array.isArray(context.knowledgeCandidates)\n    ? context.knowledgeCandidates\n    : [];\n''',
    '''  const context = asRecord(manifest.reviewContext);\n  const nested = context.reviewKinds;\n  if (Array.isArray(nested) && nested.length > 0) {\n    return [\n      ...new Set(\n        nested.filter((kind): kind is string => typeof kind === "string"),\n      ),\n    ];\n  }\n  const candidates = Array.isArray(context.knowledgeCandidates)\n    ? context.knowledgeCandidates\n    : [];\n''',
)

replace_once(
    "packages/compiler/test/profile-policy-enforcement.test.ts",
    '''  it("keeps human review mandatory even when a profile is more permissive", () => {\n    const profile = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);\n    profile.reviewPolicies["neutral-review"]!.required = false;\n    profile.reviewPolicies["neutral-review"]!.minimumApprovals = 0;\n    profile.reviewPolicies["neutral-review"]!.allowedRoles = ["CURATOR"];\n    const input = inputFor(profile, "UNVERIFIED");\n    const plan = resultToCompilationPlan(input, resultFor(input, "note"));\n    expect(plan.reviewContext?.reviewPolicy).toMatchObject({\n      required: true,\n      minimumApprovals: 1,\n      allowedRoles: ["CURATOR"],\n      profileSource: "DURABLE_REVISION",\n      profileRevisionId: REVISION_ID,\n      profileId: "neutral-notes",\n    });\n  });\n});\n''',
    '''  it("keeps human review mandatory even when a profile is more permissive", () => {\n    const profile = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);\n    profile.reviewPolicies["neutral-review"]!.required = false;\n    profile.reviewPolicies["neutral-review"]!.minimumApprovals = 0;\n    profile.reviewPolicies["neutral-review"]!.allowedRoles = ["CURATOR"];\n    const input = inputFor(profile, "UNVERIFIED");\n    const plan = resultToCompilationPlan(input, resultFor(input, "note"));\n    expect(plan.reviewContext?.reviewPolicy).toMatchObject({\n      required: true,\n      minimumApprovals: 1,\n      allowedRoles: ["CURATOR"],\n      profileSource: "DURABLE_REVISION",\n      profileRevisionId: REVISION_ID,\n      profileId: "neutral-notes",\n    });\n  });\n\n  it("snapshots only the kinds that materially produced the review policy", () => {\n    const profile = structuredClone(NEUTRAL_KNOWLEDGE_PROFILE_V1);\n    profile.reviewPolicies["procedure-review"] = {\n      required: true,\n      minimumApprovals: 2,\n      allowedRoles: ["ARCHITECT"],\n    };\n    profile.knowledgeKinds.procedure!.reviewPolicy = "procedure-review";\n    const input = inputFor(profile, "MACHINE_SUPPORTED");\n    const result = resultFor(input, "note");\n    result.knowledgeCandidates.push({\n      candidateId: "orphan-procedure",\n      kind: "procedure",\n      statement: "Document the cache invalidation procedure for operators.",\n      scope: "Operational cache maintenance.",\n      evidenceIds: [EVIDENCE_ID],\n      confidence: 0.8,\n      proposedAction: "CREATE",\n    });\n\n    const plan = resultToCompilationPlan(input, result);\n    expect(plan.reviewContext?.knowledgeCandidates.map((candidate) => candidate.kind)).toEqual([\n      "note",\n      "procedure",\n    ]);\n    expect(plan.reviewContext?.reviewKinds).toEqual(["note"]);\n    expect(plan.reviewContext?.reviewPolicy).toMatchObject({\n      minimumApprovals: 1,\n      allowedRoles: NEUTRAL_KNOWLEDGE_PROFILE_V1.reviewPolicies["neutral-review"]!.allowedRoles,\n    });\n  });\n});\n''',
)

replace_once(
    "apps/api/test/review-policy.integration.test.ts",
    '''import { Postgres, grantVaultMembership } from "@akp/postgres";\n''',
    '''import { Postgres, grantVaultMembership } from "@akp/postgres";\nimport { reviewPolicyState } from "../src/review-policy.js";\n''',
)

replace_once(
    "apps/api/test/review-policy.integration.test.ts",
    '''  it("rejects a direct proposal kind not declared by the durable profile", async () => {\n    const response = await propose("rule");\n    expect(response.statusCode).toBe(422);\n    expect(response.json()).toMatchObject({\n      code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",\n      kind: "rule",\n    });\n  });\n});\n''',
    '''  it("rejects a direct proposal kind not declared by the durable profile", async () => {\n    const response = await propose("rule");\n    expect(response.statusCode).toBe(422);\n    expect(response.json()).toMatchObject({\n      code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",\n      kind: "rule",\n    });\n  });\n\n  it("revalidates a compiler review with the exact material kind snapshot", () => {\n    const state = reviewPolicyState({\n      impact_manifest: {\n        reviewContext: {\n          reviewKinds: ["note"],\n          knowledgeCandidates: [{ kind: "note" }, { kind: "procedure" }],\n          reviewPolicy: {\n            required: true,\n            minimumApprovals: 2,\n            allowedRoles: ["REVIEWER"],\n            profileSource: "DURABLE_REVISION",\n            profileRevisionId: activeProfileRevisionId,\n            profileHash: "a".repeat(64),\n            profileId: "neutral-notes",\n            profileVersion: "1.0.1-review-policy",\n          },\n        },\n      },\n    });\n    expect(state.kinds).toEqual(["note"]);\n  });\n});\n''',
)
