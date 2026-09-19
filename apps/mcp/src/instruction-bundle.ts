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

export function createAgentInstructionBundle(
  generatedAt = new Date().toISOString(),
): AgentInstructionBundle {
  const payload = {
    schemaVersion: 1 as const,
    platformVersion: "0.4.0",
    contextApiVersion: "v1",
    generatedAt,
    capabilities: [...CAPABILITIES],
    rules: [...AGENT_RULES],
    lifecycle: [...AGENT_LIFECYCLE],
  };
  const sha256 = createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex");
  return {
    manifest: {
      schemaVersion: payload.schemaVersion,
      platformVersion: payload.platformVersion,
      contextApiVersion: payload.contextApiVersion,
      generatedAt: payload.generatedAt,
      sha256,
      capabilities: payload.capabilities,
    },
    rules: payload.rules,
    lifecycle: payload.lifecycle,
  };
}

export const AGENT_INSTRUCTION_BUNDLE = createAgentInstructionBundle();
export const AGENT_INSTRUCTION_RESOURCE_URI =
  `akp://instructions/agent/v1/${AGENT_INSTRUCTION_BUNDLE.manifest.sha256}`;
