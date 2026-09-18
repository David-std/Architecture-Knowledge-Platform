import { createHash } from "node:crypto";
import type {
  CodeGraphArtifact,
  CodeGraphNode,
  GraphNodeRef,
} from "@akp/contracts";

export type CodeReconciliationRelationship =
  | "MOVED_FROM"
  | "RENAMED_FROM"
  | "MOVED_AND_RENAMED_FROM";

export type CodeReconciliationState = "CANDIDATE" | "AMBIGUOUS";

export type CodeReconciliationBasis =
  | "SAME_SIGNATURE"
  | "SAME_QUALIFIED_NAME"
  | "SAME_NAME"
  | "SAME_CONTENT_HASH"
  | "SAME_POSITION";

export interface CodeReconciliationEndpoint {
  repository: string;
  commitSha: string;
  nodeId: string;
  kind: string;
  path: string;
  name: string;
  qualifiedName?: string;
  signature?: string;
  lineStart?: number;
  lineEnd?: number;
  contentHash?: string;
}

export interface CodeGraphReconciliationCandidate {
  id: string;
  relationship: CodeReconciliationRelationship;
  state: CodeReconciliationState;
  confidence: number;
  basis: CodeReconciliationBasis[];
  from: CodeReconciliationEndpoint;
  to: CodeReconciliationEndpoint;
}

interface CandidateMatch {
  previous: CodeReconciliationEndpoint;
  relationship: CodeReconciliationRelationship;
  basis: CodeReconciliationBasis[];
  score: number;
  confidence: number;
}

function optionalString(
  value: unknown,
  maximum: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

function previousEndpoint(
  node: GraphNodeRef,
): CodeReconciliationEndpoint | null {
  if (node.identity.graphDomain !== "CODE") return null;
  const payload = node.payload;
  const repository = optionalString(payload.repository, 2048);
  const commitSha = optionalString(payload.commitSha, 40);
  const path = optionalString(payload.path, 4096);
  const name = optionalString(payload.name, 1024);
  if (
    !repository ||
    !commitSha ||
    !/^[a-f0-9]{40}$/i.test(commitSha) ||
    !path ||
    !name
  ) {
    return null;
  }
  return {
    repository,
    commitSha: commitSha.toLowerCase(),
    nodeId:
      optionalString(payload.codeNodeId, 256) ??
      node.identity.canonicalKey,
    kind: optionalString(payload.kind, 120) ?? node.identity.kind,
    path,
    name,
    ...(optionalString(payload.qualifiedName, 2048)
      ? { qualifiedName: optionalString(payload.qualifiedName, 2048) }
      : {}),
    ...(optionalString(payload.signature, 4096)
      ? { signature: optionalString(payload.signature, 4096) }
      : {}),
    ...(optionalPositiveInteger(payload.lineStart)
      ? { lineStart: optionalPositiveInteger(payload.lineStart) }
      : {}),
    ...(optionalPositiveInteger(payload.lineEnd)
      ? { lineEnd: optionalPositiveInteger(payload.lineEnd) }
      : {}),
    ...(typeof payload.contentHash === "string" &&
    /^[a-f0-9]{64}$/i.test(payload.contentHash)
      ? { contentHash: payload.contentHash.toLowerCase() }
      : {}),
  };
}

function currentEndpoint(
  artifact: CodeGraphArtifact,
  node: CodeGraphNode,
): CodeReconciliationEndpoint {
  return {
    repository: artifact.repository,
    commitSha: artifact.commitSha.toLowerCase(),
    nodeId: node.id,
    kind: node.kind,
    path: node.path,
    name: node.name,
    ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
    ...(node.signature ? { signature: node.signature } : {}),
    ...(node.lineStart !== undefined ? { lineStart: node.lineStart } : {}),
    ...(node.lineEnd !== undefined ? { lineEnd: node.lineEnd } : {}),
    ...(node.contentHash ? { contentHash: node.contentHash.toLowerCase() } : {}),
  };
}

function evaluateMatch(
  previous: CodeReconciliationEndpoint,
  current: CodeReconciliationEndpoint,
): CandidateMatch | null {
  if (
    previous.repository !== current.repository ||
    previous.commitSha === current.commitSha ||
    previous.kind !== current.kind
  ) {
    return null;
  }

  const pathChanged = previous.path !== current.path;
  const nameChanged = previous.name !== current.name;
  const qualifiedChanged =
    previous.qualifiedName !== undefined &&
    current.qualifiedName !== undefined &&
    previous.qualifiedName !== current.qualifiedName;
  if (!pathChanged && !nameChanged && !qualifiedChanged) return null;

  const sameSignature =
    previous.signature !== undefined &&
    current.signature !== undefined &&
    previous.signature === current.signature;
  const sameQualifiedName =
    previous.qualifiedName !== undefined &&
    current.qualifiedName !== undefined &&
    previous.qualifiedName === current.qualifiedName;
  const sameName = previous.name === current.name;
  const sameContentHash =
    previous.contentHash !== undefined &&
    current.contentHash !== undefined &&
    previous.contentHash === current.contentHash;
  const samePosition =
    previous.lineStart !== undefined &&
    current.lineStart !== undefined &&
    previous.lineStart === current.lineStart &&
    (previous.lineEnd === undefined ||
      current.lineEnd === undefined ||
      previous.lineEnd === current.lineEnd);

  if (pathChanged && !(sameSignature || sameQualifiedName || sameName)) {
    return null;
  }
  if (!pathChanged && (nameChanged || qualifiedChanged) && !sameSignature && !samePosition) {
    return null;
  }

  const basis: CodeReconciliationBasis[] = [];
  if (sameSignature) basis.push("SAME_SIGNATURE");
  if (sameQualifiedName) basis.push("SAME_QUALIFIED_NAME");
  if (sameName) basis.push("SAME_NAME");
  if (sameContentHash) basis.push("SAME_CONTENT_HASH");
  if (samePosition) basis.push("SAME_POSITION");

  const score =
    (sameSignature ? 100 : 0) +
    (sameQualifiedName ? 80 : 0) +
    (sameName ? 50 : 0) +
    (sameContentHash ? 40 : 0) +
    (samePosition ? 20 : 0);

  const relationship: CodeReconciliationRelationship =
    pathChanged && nameChanged
      ? "MOVED_AND_RENAMED_FROM"
      : pathChanged
        ? "MOVED_FROM"
        : "RENAMED_FROM";
  const confidence = Math.min(
    0.98,
    sameSignature && sameContentHash
      ? 0.98
      : sameQualifiedName && sameContentHash
        ? 0.94
        : sameName && sameContentHash
          ? 0.9
          : sameSignature
            ? 0.84
            : sameQualifiedName
              ? 0.78
              : sameName
                ? 0.64
                : 0.45,
  );
  return { previous, relationship, basis, score, confidence };
}

function candidateId(
  relationship: CodeReconciliationRelationship,
  previous: CodeReconciliationEndpoint,
  current: CodeReconciliationEndpoint,
): string {
  return (
    "CODE-RECON-" +
    createHash("sha256")
      .update(
        [
          relationship,
          previous.repository,
          previous.commitSha,
          previous.nodeId,
          current.repository,
          current.commitSha,
          current.nodeId,
        ].join("\0"),
      )
      .digest("hex")
      .slice(0, 32)
      .toUpperCase()
  );
}

export function reconcileCodeGraphCandidates(
  previousNodes: readonly GraphNodeRef[],
  currentArtifact: CodeGraphArtifact,
  limit = 128,
): CodeGraphReconciliationCandidate[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) {
    throw new Error("CODE_RECONCILIATION_LIMIT_INVALID");
  }
  const previous = previousNodes
    .map(previousEndpoint)
    .filter(
      (value): value is CodeReconciliationEndpoint => value !== null,
    )
    .sort((left, right) =>
      [
        left.repository,
        left.commitSha,
        left.path,
        left.kind,
        left.nodeId,
      ]
        .join("|")
        .localeCompare(
          [
            right.repository,
            right.commitSha,
            right.path,
            right.kind,
            right.nodeId,
          ].join("|"),
        ),
    );

  const candidates: CodeGraphReconciliationCandidate[] = [];
  for (const node of [...currentArtifact.nodes].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const current = currentEndpoint(currentArtifact, node);
    const matches = previous
      .map((oldNode) => evaluateMatch(oldNode, current))
      .filter((value): value is CandidateMatch => value !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.previous.path.localeCompare(right.previous.path) ||
          left.previous.nodeId.localeCompare(right.previous.nodeId),
      );
    const bestScore = matches[0]?.score;
    if (bestScore === undefined) continue;
    const best = matches.filter((match) => match.score === bestScore);
    const state: CodeReconciliationState =
      best.length === 1 ? "CANDIDATE" : "AMBIGUOUS";
    for (const match of best) {
      candidates.push({
        id: candidateId(match.relationship, match.previous, current),
        relationship: match.relationship,
        state,
        confidence: match.confidence,
        basis: match.basis,
        from: match.previous,
        to: current,
      });
      if (candidates.length >= limit) {
        return candidates.sort((left, right) => left.id.localeCompare(right.id));
      }
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}
