export const TOOL_ERGONOMICS_ARMS = [
  "EXPERT_TOOLS_ONLY",
  "AKP_CONTEXT_FACADE",
  "FACADE_WITH_INSTRUCTIONS",
] as const;

export type ToolErgonomicsArm = (typeof TOOL_ERGONOMICS_ARMS)[number];

export interface ToolSelectionCall {
  tool: string;
  action: string | null;
}

export interface ToolSelectionExpectation {
  tool: string;
  action?: string | null;
}

export interface ToolSelectionScore {
  callsPerTask: number;
  toolSelectionErrors: number;
  missingExpectedCalls: number;
  unexpectedCalls: number;
  exactSelection: boolean;
}

export interface ToolErgonomicsObservation {
  taskId: string;
  arm: ToolErgonomicsArm;
  callsPerTask: number;
  toolSelectionErrors: number;
  exactSelection: boolean;
  inputTokens: number;
  contextTokens: number;
  providerPromptTokens: number | null;
  providerCompletionTokens: number | null;
  latencyMs: number;
  correctness: number;
  missedConstraints: number;
  unsupportedClaims: number;
  unsupportedClaimRate: number;
  citationPrecision: number;
}

export interface ToolErgonomicsAggregate {
  arm: ToolErgonomicsArm;
  tasks: number;
  meanCallsPerTask: number;
  meanToolSelectionErrors: number;
  exactSelectionRate: number;
  meanInputTokens: number;
  meanContextTokens: number;
  meanProviderPromptTokens: number | null;
  meanProviderCompletionTokens: number | null;
  meanLatencyMs: number;
  meanCorrectness: number;
  meanMissedConstraints: number;
  meanUnsupportedClaims: number;
  meanUnsupportedClaimRate: number;
  meanCitationPrecision: number;
}

function canonicalCall(
  call: ToolSelectionCall | ToolSelectionExpectation,
): string {
  return `${call.tool.trim()}\u001f${call.action?.trim() || ""}`;
}

export function parseToolSelection(
  content: string,
  maxCalls = 3,
): ToolSelectionCall[] {
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10) {
    throw new Error("TOOL_SELECTION_MAX_CALLS_INVALID");
  }
  const calls: ToolSelectionCall[] = [];
  for (const raw of content.trim().split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("CALL:")) {
      throw new Error("TOOL_SELECTION_FORMAT_INVALID");
    }
    if (calls.length >= maxCalls) {
      throw new Error("TOOL_SELECTION_TOO_MANY_CALLS");
    }
    const value = line.slice("CALL:".length).trim();
    const separator = value.indexOf(" || ");
    const tool = (separator < 0 ? value : value.slice(0, separator)).trim();
    const rawAction =
      separator < 0 ? "NONE" : value.slice(separator + 4).trim();
    if (!/^[a-z][a-z0-9_]{1,120}$/u.test(tool)) {
      throw new Error("TOOL_SELECTION_TOOL_INVALID");
    }
    const action =
      rawAction.toUpperCase() === "NONE" ? null : rawAction.toUpperCase();
    if (action !== null && !/^[A-Z][A-Z0-9_]{1,80}$/u.test(action)) {
      throw new Error("TOOL_SELECTION_ACTION_INVALID");
    }
    calls.push({ tool, action });
  }
  if (calls.length === 0) throw new Error("TOOL_SELECTION_EMPTY");
  return calls;
}

export function scoreToolSelection(
  selected: readonly ToolSelectionCall[],
  expected: readonly ToolSelectionExpectation[],
): ToolSelectionScore {
  const selectedKeys = selected.map(canonicalCall);
  const expectedKeys = expected.map(canonicalCall);
  const expectedSet = new Set(expectedKeys);
  const selectedSet = new Set(selectedKeys);

  const unexpectedCalls = selectedKeys.filter(
    (value, index) =>
      !expectedSet.has(value) || selectedKeys.indexOf(value) !== index,
  ).length;
  const missingExpectedCalls = expectedKeys.filter(
    (value) => !selectedSet.has(value),
  ).length;
  const toolSelectionErrors = unexpectedCalls + missingExpectedCalls;
  return {
    callsPerTask: selected.length,
    toolSelectionErrors,
    missingExpectedCalls,
    unexpectedCalls,
    exactSelection: toolSelectionErrors === 0,
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? mean(present) : null;
}

export function aggregateToolErgonomics(
  observations: readonly ToolErgonomicsObservation[],
): ToolErgonomicsAggregate {
  if (observations.length === 0) {
    throw new Error("TOOL_ERGONOMICS_AGGREGATE_EMPTY");
  }
  const arm = observations[0]!.arm;
  if (observations.some((observation) => observation.arm !== arm)) {
    throw new Error("TOOL_ERGONOMICS_AGGREGATE_MIXED_ARMS");
  }
  return {
    arm,
    tasks: observations.length,
    meanCallsPerTask: mean(observations.map((item) => item.callsPerTask)),
    meanToolSelectionErrors: mean(
      observations.map((item) => item.toolSelectionErrors),
    ),
    exactSelectionRate: mean(
      observations.map((item) => Number(item.exactSelection)),
    ),
    meanInputTokens: mean(observations.map((item) => item.inputTokens)),
    meanContextTokens: mean(observations.map((item) => item.contextTokens)),
    meanProviderPromptTokens: meanNullable(
      observations.map((item) => item.providerPromptTokens),
    ),
    meanProviderCompletionTokens: meanNullable(
      observations.map((item) => item.providerCompletionTokens),
    ),
    meanLatencyMs: mean(observations.map((item) => item.latencyMs)),
    meanCorrectness: mean(observations.map((item) => item.correctness)),
    meanMissedConstraints: mean(
      observations.map((item) => item.missedConstraints),
    ),
    meanUnsupportedClaims: mean(
      observations.map((item) => item.unsupportedClaims),
    ),
    meanUnsupportedClaimRate: mean(
      observations.map((item) => item.unsupportedClaimRate),
    ),
    meanCitationPrecision: mean(
      observations.map((item) => item.citationPrecision),
    ),
  };
}
