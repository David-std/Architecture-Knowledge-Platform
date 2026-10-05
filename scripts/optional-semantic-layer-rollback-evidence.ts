import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SearchHit } from "@akp/contracts";
import {
  DETERMINISTIC_LEXICAL_RERANKER,
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  rerankSearchHitsSafely,
  type QueryConditionedEvidenceVerifier,
  type SearchHitReranker,
} from "@akp/retrieval";
import {
  EVIDENCE_VERIFIER_DEGRADED_WARNING,
  evidenceVerifierDegradationWarnings,
} from "../apps/api/src/routes/search.js";

const manifestPath = path.resolve(
  "evals/generic/optional-semantic-layer-rollback/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_OPTIONAL_SEMANTIC_ROLLBACK_REPORT ??
    "reports/ci/optional-semantic-layer-rollback.json",
);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hit(): SearchHit {
  return {
    documentId: "11111111-1111-4111-8111-000000000001",
    vaultId: "22222222-2222-4222-8222-000000000001",
    unitId: "33333333-3333-4333-8333-000000000001",
    unitType: "PARAGRAPH",
    document: {
      externalId: "nexo-integration",
      path: "docs/nexo-integration.md",
      title: "NEXO integration",
    },
    revision: "revision-1",
    title: "NEXO integration",
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 0.91,
    reasons: ["vector:test"],
    fusionContributions: [
      {
        channel: "vector",
        rank: 1,
        channelWeight: 1,
        rawScore: 0.91,
        reason: "vector:test",
      },
    ],
    excerpt: "NEXO can use QARO for delivery.",
    citations: [],
  };
}

const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw) as {
  schemaVersion: string;
  frozen: boolean;
  baselineSha: string;
  defaults: {
    evidenceVerifierWiredByDefault: boolean;
    rerankerWiredByDefault: boolean;
    providerDefaultsChanged: boolean;
  };
  promotionRule: {
    outcome: string;
    requireAllInvariants: boolean;
    runtimeSemanticChangeAllowed: boolean;
  };
};

if (
  manifest.schemaVersion !== "akp.optional-semantic-layer-rollback.v1" ||
  manifest.frozen !== true ||
  manifest.baselineSha !== "5b3c64733e521064f99e5dd3669298324f2e00d9" ||
  manifest.defaults.evidenceVerifierWiredByDefault !== false ||
  manifest.defaults.rerankerWiredByDefault !== false ||
  manifest.defaults.providerDefaultsChanged !== false ||
  manifest.promotionRule.runtimeSemanticChangeAllowed !== false
) {
  throw new Error("OPTIONAL_SEMANTIC_ROLLBACK_MANIFEST_DRIFT");
}

const query = "Can NEXO use QARO?";
const baselineHit = hit();
const baseline = assessRetrievalAnswerability([baselineHit], query);
let verifierCalls = 0;
const verifier: QueryConditionedEvidenceVerifier = {
  id: "synthetic-unavailable-verifier",
  async verify() {
    verifierCalls += 1;
    throw new Error(
      "https://secret-verifier.local/api timeout token=do-not-leak",
    );
  },
};

const shadow = await assessRetrievalAnswerabilityWithVerifier(
  [baselineHit],
  query,
  verifier,
  { mode: "SHADOW", maxCandidates: 1, maxConcurrency: 1 },
);
const enforced = await assessRetrievalAnswerabilityWithVerifier(
  [baselineHit],
  query,
  verifier,
  { mode: "ENFORCE", maxCandidates: 1, maxConcurrency: 1 },
);
const rolledBack = assessRetrievalAnswerability([baselineHit], query);

const reranker: SearchHitReranker = {
  id: DETERMINISTIC_LEXICAL_RERANKER,
  score() {
    throw new Error(
      "https://secret-reranker.local/api timeout token=rerank-secret",
    );
  },
};
const rerankFallback = rerankSearchHitsSafely(query, [baselineHit], reranker);

const baselineShape = {
  supported: baseline.supported,
  reason: baseline.reason,
  supportedDocumentIds: baseline.supportedDocumentIds,
  supportedCandidateKeys: baseline.supportedCandidateKeys,
};
const shadowShape = {
  supported: shadow.supported,
  reason: shadow.reason,
  supportedDocumentIds: shadow.supportedDocumentIds,
  supportedCandidateKeys: shadow.supportedCandidateKeys,
};
const rollbackShape = {
  supported: rolledBack.supported,
  reason: rolledBack.reason,
  supportedDocumentIds: rolledBack.supportedDocumentIds,
  supportedCandidateKeys: rolledBack.supportedCandidateKeys,
};

const serializedSemantic = JSON.stringify({ shadow, enforced });
const serializedRerank = JSON.stringify(rerankFallback);
const gates = {
  baselineSupported: baseline.supported === true,
  shadowPreservesBaseline:
    JSON.stringify(shadowShape) === JSON.stringify(baselineShape),
  shadowWarningStable:
    JSON.stringify(evidenceVerifierDegradationWarnings(shadow)) ===
    JSON.stringify([EVIDENCE_VERIFIER_DEGRADED_WARNING]),
  enforceFailsClosed:
    enforced.supported === false &&
    enforced.supportedCandidateKeys.length === 0 &&
    enforced.candidateSignals.some(
      (signal) =>
        signal.passageSupport.reason === "QUERY_CONDITIONED_VERIFIER_ERROR",
    ),
  enforceWarningStable:
    JSON.stringify(evidenceVerifierDegradationWarnings(enforced)) ===
    JSON.stringify([EVIDENCE_VERIFIER_DEGRADED_WARNING]),
  rollbackExactlyRestoresBaseline:
    JSON.stringify(rollbackShape) === JSON.stringify(baselineShape) &&
    evidenceVerifierDegradationWarnings(rolledBack).length === 0,
  noVerifierStatePersisted: verifierCalls === 2,
  verifierSecretsSanitized:
    !serializedSemantic.includes("secret-verifier") &&
    !serializedSemantic.includes("do-not-leak"),
  rerankerPreservesAuthorizedBaseline:
    rerankFallback.hits.length === 1 &&
    rerankFallback.hits[0]?.documentId === baselineHit.documentId &&
    rerankFallback.hits[0]?.score === baselineHit.score,
  rerankerWarningStable:
    rerankFallback.warning === "RERANKER_FALLBACK:PROVIDER_ERROR",
  rerankerSecretsSanitized:
    !serializedRerank.includes("secret-reranker") &&
    !serializedRerank.includes("rerank-secret"),
  providerDefaultsRemainDisabled:
    manifest.defaults.evidenceVerifierWiredByDefault === false &&
    manifest.defaults.rerankerWiredByDefault === false &&
    manifest.defaults.providerDefaultsChanged === false,
};

const outcome = Object.values(gates).every(Boolean)
  ? "PROMOTE_RESILIENCE_OBSERVABILITY"
  : "REJECT_RESILIENCE_CONTRACT";

const report = {
  schemaVersion: manifest.schemaVersion,
  generatedAt: new Date().toISOString(),
  baselineSha: manifest.baselineSha,
  manifestHash: hash(manifestRaw),
  outcome,
  providerDefaultsChanged: false,
  runtimeSemanticChange: false,
  observations: {
    baseline: baselineShape,
    shadow: {
      ...shadowShape,
      warnings: evidenceVerifierDegradationWarnings(shadow),
      verifierDecision:
        shadow.candidateSignals[0]?.queryConditionedEvidence?.decision ?? null,
    },
    enforced: {
      supported: enforced.supported,
      reason: enforced.reason,
      supportedCandidateKeys: enforced.supportedCandidateKeys,
      warnings: evidenceVerifierDegradationWarnings(enforced),
      verifierDecision:
        enforced.candidateSignals[0]?.queryConditionedEvidence?.decision ??
        null,
    },
    rollback: rollbackShape,
    reranker: {
      warning: rerankFallback.warning ?? null,
      documentIds: rerankFallback.hits.map((row) => row.documentId),
      scores: rerankFallback.hits.map((row) => row.score),
    },
  },
  gates,
  claimBoundary: [
    "This report proves optional semantic-layer degradation observability and rollback semantics only.",
    "SHADOW verifier failure preserves the deterministic baseline.",
    "ENFORCE verifier failure remains fail-closed.",
    "No verifier or reranker is enabled by default.",
    "No retrieval ranking or admission-quality promotion is claimed.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (outcome !== manifest.promotionRule.outcome) {
  process.exitCode = 1;
}
