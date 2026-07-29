export type CodeEvidenceTier =
  | "NO_SIGNAL"
  | "AI_CANDIDATE"
  | "STATICALLY_LINKED"
  | "RUNTIME_COVERED"
  | "DYNAMICALLY_PROVEN";

export interface CodeLocator {
  repository: string;
  commit: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface CodeEvidence {
  id: string;
  tier: CodeEvidenceTier;
  behavior: string;
  locator: CodeLocator;
  relatedTests: CodeLocator[];
  generatedBy: "DETERMINISTIC" | "AI_CANDIDATE";
  metadata: Record<string, unknown>;
}

export interface ProjectAdapter {
  scan(input: {
    repositoryPath: string;
    commit: string;
    changedSince?: string;
  }): Promise<CodeEvidence[]>;
}

export function maySupportVerifiedClaim(evidence: CodeEvidence): boolean {
  return (
    evidence.generatedBy === "DETERMINISTIC" &&
    ["STATICALLY_LINKED", "RUNTIME_COVERED", "DYNAMICALLY_PROVEN"].includes(evidence.tier)
  );
}
