import { createHash } from "node:crypto";

export interface AgentInstructionBundleManifest {
  schemaVersion: 1;
  platformVersion: string;
  contextApiVersion: string;
  generatedAt: string;
  sha256: string;
  capabilities: string[];
}

export interface AgentInstructionBundle {
  manifest: AgentInstructionBundleManifest;
  rules: string[];
  lifecycle: string[];
}

export type AgentInstructionIntegrityMode = "WARN" | "STRICT";

export interface AgentInstructionIntegrityResult {
  valid: boolean;
  computedSha256: string;
  claimedSha256: string;
  expectedSha256: string | null;
  warnings: string[];
}

const AGENT_RULES = [
  "Bootstrap or search AKP before making an architectural decision.",
  "Run impact analysis before a broad refactor or change that may affect dependent knowledge or code.",
  "Approved knowledge and durable task or workspace memory are different authority classes.",
  "A captured finding is not published truth.",
  "Cite evidence or source-backed context when making factual architectural claims.",
  "Explicitly promote durable findings through governed review when they should become canonical knowledge.",
  "Respect context revision warnings and do not continue as if stale pinned context were current.",
] as const;

const AGENT_LIFECYCLE = [
  "BOOTSTRAP",
  "WORK",
  "TARGETED_RETRIEVAL",
  "IMPACT_CHECK",
  "CAPTURE_OR_HANDOFF",
  "OPTIONAL_PROMOTION",
  "FINISH_WORK_CONTEXT",
] as const;

const CAPABILITIES = [
  "AKP_CONTEXT_FACADE",
  "EXPERT_MCP_TOOLS",
  "REVISION_PINNED_BOOTSTRAP",
  "SOURCE_BACKED_CONTEXT",
  "CODE_GRAPH",
  "TEMPORAL_TRUTH",
  "WORKSPACE_CAPTURE",
  "GOVERNED_PROMOTION",
] as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function instructionContent(bundle: AgentInstructionBundle) {
  return {
    schemaVersion: bundle.manifest.schemaVersion,
    platformVersion: bundle.manifest.platformVersion,
    contextApiVersion: bundle.manifest.contextApiVersion,
    capabilities: bundle.manifest.capabilities,
    rules: bundle.rules,
    lifecycle: bundle.lifecycle,
  };
}

export function computeAgentInstructionBundleSha256(
  bundle: AgentInstructionBundle,
): string {
  return createHash("sha256")
    .update(canonicalJson(instructionContent(bundle)))
    .digest("hex");
}

export function verifyAgentInstructionBundle(
  bundle: AgentInstructionBundle,
  options: {
    expectedSha256?: string;
    mode?: AgentInstructionIntegrityMode;
  } = {},
): AgentInstructionIntegrityResult {
  const mode = options.mode ?? "STRICT";
  const expectedSha256 = options.expectedSha256?.trim().toLowerCase() ?? null;
  if (expectedSha256 !== null && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("AGENT_INSTRUCTION_EXPECTED_DIGEST_INVALID");
  }

  const computedSha256 = computeAgentInstructionBundleSha256(bundle);
  const claimedSha256 = bundle.manifest.sha256.toLowerCase();
  const warnings: string[] = [];

  if (claimedSha256 !== computedSha256) {
    warnings.push("AGENT_INSTRUCTION_BUNDLE_HASH_MISMATCH");
  }
  if (expectedSha256 !== null && expectedSha256 !== computedSha256) {
    warnings.push("AGENT_INSTRUCTION_EXPECTED_DIGEST_MISMATCH");
  }

  if (mode === "STRICT" && warnings.length > 0) {
    throw new Error(warnings[0]);
  }

  return {
    valid: warnings.length === 0,
    computedSha256,
    claimedSha256,
    expectedSha256,
    warnings,
  };
}

export function createAgentInstructionBundle(
  generatedAt = new Date().toISOString(),
): AgentInstructionBundle {
  const bundle: AgentInstructionBundle = {
    manifest: {
      schemaVersion: 1,
      platformVersion: "0.4.0",
      contextApiVersion: "v1",
      generatedAt,
      sha256: "",
      capabilities: [...CAPABILITIES],
    },
    rules: [...AGENT_RULES],
    lifecycle: [...AGENT_LIFECYCLE],
  };
  bundle.manifest.sha256 = computeAgentInstructionBundleSha256(bundle);
  return bundle;
}

export const AGENT_INSTRUCTION_BUNDLE = createAgentInstructionBundle();
export const AGENT_INSTRUCTION_RESOURCE_URI = `akp://instructions/agent/v1/${AGENT_INSTRUCTION_BUNDLE.manifest.sha256}`;
