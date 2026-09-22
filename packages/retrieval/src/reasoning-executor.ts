import { createHash } from "node:crypto";
import type {
  ReasoningOperator,
  ReasoningPlan as ReasoningPlanValue,
  ReasoningStep,
} from "@akp/contracts";
import {
  reasoningOutputKind,
  reasoningReferencedStepIds,
  validateReasoningPlan,
  type ReasoningOutputKind,
  type ReasoningPlanValidationContext,
  type ReasoningPlanValidationIssue,
} from "./reasoning-plan.js";

export interface ReasoningExecutionValue {
  kind: ReasoningOutputKind;
  refs: string[];
  payload: unknown;
  channel?: string;
  revision?: string;
  tokenUsage?: number;
  cost?: number;
  warnings?: string[];
  /** Optional stable hash supplied by the delegated use case. */
  resultHash?: string;
}

export interface ReasoningBudgetUsage {
  attemptedSteps: number;
  successfulSteps: number;
  failedSteps: number;
  skippedSteps: number;
  tokens: number;
  cost: number;
  wallMs: number;
}

export interface ReasoningStepTrace {
  stepId: string;
  operator: ReasoningOperator;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  executionTarget: ReasoningStep["executionTarget"];
  inputStepIds: string[];
  inputHashes: string[];
  resultRefs: string[];
  resultHash?: string;
  channel?: string;
  revision?: string;
  elapsedMs: number;
  warnings: string[];
  errorCode?: string;
  budgetAfter: ReasoningBudgetUsage;
}

export interface ReasoningExecutionTrace {
  planId: string;
  schemaVersion: 1;
  intent: ReasoningPlanValue["intent"];
  revisionSetHash: string;
  startedAt: string;
  completedAt: string;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  steps: ReasoningStepTrace[];
  warnings: string[];
  budget: ReasoningBudgetUsage;
}

export interface ReasoningOperatorContext {
  plan: ReasoningPlanValue;
  step: ReasoningStep;
  inputs: ReadonlyMap<string, ReasoningExecutionValue>;
  signal: AbortSignal;
  budget: Readonly<ReasoningBudgetUsage>;
}

export type ReasoningOperatorHandler = (
  context: ReasoningOperatorContext,
) => Promise<ReasoningExecutionValue>;

export type ReasoningOperatorPorts = Partial<
  Record<ReasoningOperator, ReasoningOperatorHandler>
>;

export interface ReasoningTraceSink {
  persist(trace: ReasoningExecutionTrace): Promise<void>;
}

export type ReasoningRevisionGuard = () => boolean | Promise<boolean>;

export interface ReasoningExecutorOptions {
  ports: ReasoningOperatorPorts;
  externalPeerPorts?: (peerId: string) => ReasoningOperatorPorts | undefined;
  traceSink?: ReasoningTraceSink;
  revisionGuard?: ReasoningRevisionGuard;
  signal?: AbortSignal;
  now?: () => number;
}

export type ReasoningPlanExecutionResult =
  | {
      status: "REJECTED";
      issues: ReasoningPlanValidationIssue[];
    }
  | {
      status: "SUCCESS" | "PARTIAL" | "FAILED";
      plan: ReasoningPlanValue;
      results: ReadonlyMap<string, ReasoningExecutionValue>;
      trace: ReasoningExecutionTrace;
      tracePersistence: "NOT_REQUESTED" | "PERSISTED" | "FAILED";
    };

export interface ReasoningPlannerPort {
  propose(signal: AbortSignal): Promise<unknown>;
}

export type PlannedReasoningResult<TFallback> =
  | {
      mode: "PLAN";
      result: Exclude<ReasoningPlanExecutionResult, { status: "REJECTED" }>;
    }
  | {
      mode: "DIRECT_FALLBACK";
      reason: "PLANNER_UNAVAILABLE" | "PLAN_INVALID";
      result: TFallback;
    };

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value)
        ? JSON.stringify(value)
        : JSON.stringify(String(value));
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
      return "null";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
    }
    default:
      return JSON.stringify(String(value));
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeCode(error: unknown, fallback: string): string {
  if (
    error instanceof Error &&
    /^[A-Z][A-Z0-9_.:-]{0,159}$/u.test(error.message)
  ) {
    return error.message;
  }
  return fallback;
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function copyBudget(
  budget: ReasoningBudgetUsage,
  now: number,
  startedAt: number,
): ReasoningBudgetUsage {
  return {
    ...budget,
    wallMs: Math.max(0, now - startedAt),
  };
}

function resultDigest(value: ReasoningExecutionValue): string {
  if (value.resultHash && /^[a-f0-9]{64}$/u.test(value.resultHash)) {
    return value.resultHash;
  }
  try {
    return sha256({
      kind: value.kind,
      refs: value.refs,
      channel: value.channel ?? null,
      revision: value.revision ?? null,
      payload: value.payload,
    });
  } catch {
    return sha256({
      kind: value.kind,
      refs: value.refs,
      channel: value.channel ?? null,
      revision: value.revision ?? null,
    });
  }
}

function traceInputHash(value: ReasoningExecutionValue): string {
  return resultDigest(value);
}

async function invokeWithDeadline<T>(
  work: Promise<T>,
  controller: AbortController,
  remainingMs: number,
): Promise<T> {
  if (remainingMs <= 0) {
    controller.abort();
    throw new Error("REASONING_PLAN_WALL_BUDGET_EXCEEDED");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("REASONING_PLAN_WALL_BUDGET_EXCEEDED"));
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function linkedController(parent: AbortSignal | undefined): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, cleanup: () => undefined };
  if (parent.aborted) controller.abort(parent.reason);
  const listener = () => controller.abort(parent.reason);
  parent.addEventListener("abort", listener, { once: true });
  return {
    controller,
    cleanup: () => parent.removeEventListener("abort", listener),
  };
}

async function assertRevisionStable(
  guard: ReasoningRevisionGuard | undefined,
): Promise<void> {
  if (!guard) return;
  try {
    if (await guard()) return;
  } catch {
    // Strict reasoning cannot continue when the revision fence is indeterminate.
  }
  throw new Error("CONTEXT_REVISION_CHANGED");
}

function allInputIds(step: ReasoningStep): string[] {
  return [...new Set([...step.dependsOn, ...reasoningReferencedStepIds(step)])];
}

function finalStatus(
  budget: ReasoningBudgetUsage,
): "SUCCESS" | "PARTIAL" | "FAILED" {
  if (budget.failedSteps === 0 && budget.skippedSteps === 0) return "SUCCESS";
  if (budget.successfulSteps > 0) return "PARTIAL";
  return "FAILED";
}

export async function executeReasoningPlan(
  input: unknown,
  validationContext: ReasoningPlanValidationContext,
  options: ReasoningExecutorOptions,
): Promise<ReasoningPlanExecutionResult> {
  const validated = validateReasoningPlan(input, validationContext);
  if (!validated.ok) {
    return { status: "REJECTED", issues: validated.issues };
  }

  const plan = validated.plan;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const deadlineMs = startedAtMs + plan.budget.maxWallMs;
  const planId = `reasoning:${sha256(plan)}`;
  const revisionSetHash = sha256(plan.revisionSet);
  const results = new Map<string, ReasoningExecutionValue>();
  const resultHashes = new Map<string, string>();
  const traces: ReasoningStepTrace[] = [];
  const warnings: string[] = [];
  const budget: ReasoningBudgetUsage = {
    attemptedSteps: 0,
    successfulSteps: 0,
    failedSteps: 0,
    skippedSteps: 0,
    tokens: 0,
    cost: 0,
    wallMs: 0,
  };
  let haltedByBudget = false;

  for (const step of plan.steps) {
    const stepStartedAt = now();
    const inputStepIds = allInputIds(step);
    const unavailableInputs = inputStepIds.filter((id) => !results.has(id));

    if (haltedByBudget || unavailableInputs.length > 0) {
      budget.skippedSteps += 1;
      const errorCode = haltedByBudget
        ? "REASONING_PLAN_BUDGET_HALTED"
        : "REASONING_PLAN_DEPENDENCY_UNAVAILABLE";
      traces.push({
        stepId: step.id,
        operator: step.operator,
        status: "SKIPPED",
        executionTarget: step.executionTarget,
        inputStepIds,
        inputHashes: inputStepIds
          .map((id) => resultHashes.get(id))
          .filter((hash): hash is string => Boolean(hash)),
        resultRefs: [],
        elapsedMs: Math.max(0, now() - stepStartedAt),
        warnings: [],
        errorCode,
        budgetAfter: copyBudget(budget, now(), startedAtMs),
      });
      continue;
    }

    await assertRevisionStable(options.revisionGuard);

    const targetPorts =
      step.executionTarget.kind === "LOCAL"
        ? options.ports
        : options.externalPeerPorts?.(step.executionTarget.peerId);
    const port = targetPorts?.[step.operator];
    budget.attemptedSteps += 1;
    if (!port) {
      budget.failedSteps += 1;
      traces.push({
        stepId: step.id,
        operator: step.operator,
        status: "FAILED",
        executionTarget: step.executionTarget,
        inputStepIds,
        inputHashes: inputStepIds
          .map((id) => resultHashes.get(id))
          .filter((hash): hash is string => Boolean(hash)),
        resultRefs: [],
        elapsedMs: Math.max(0, now() - stepStartedAt),
        warnings: [],
        errorCode:
          step.executionTarget.kind === "EXTERNAL_PEER" && !targetPorts
            ? "REASONING_EXTERNAL_PEER_EXECUTOR_UNAVAILABLE"
            : "REASONING_OPERATOR_UNAVAILABLE",
        budgetAfter: copyBudget(budget, now(), startedAtMs),
      });
      continue;
    }

    const remainingMs = deadlineMs - now();
    const { controller, cleanup } = linkedController(options.signal);
    const inputs = new Map(
      inputStepIds
        .map((id) => [id, results.get(id)] as const)
        .filter(
          (entry): entry is readonly [string, ReasoningExecutionValue] =>
            entry[1] !== undefined,
        ),
    );

    try {
      if (options.signal?.aborted) {
        throw new Error("REASONING_PLAN_ABORTED");
      }
      const value = await invokeWithDeadline(
        port({
          plan,
          step,
          inputs,
          signal: controller.signal,
          budget: copyBudget(budget, now(), startedAtMs),
        }),
        controller,
        remainingMs,
      );
      await assertRevisionStable(options.revisionGuard);
      const expectedKind = reasoningOutputKind(step.operator);
      if (value.kind !== expectedKind) {
        throw new Error("REASONING_OPERATOR_OUTPUT_KIND_MISMATCH");
      }

      const tokenUsage = finiteNonNegative(value.tokenUsage);
      const cost = finiteNonNegative(value.cost);
      const nextTokens = budget.tokens + tokenUsage;
      const nextCost = budget.cost + cost;
      if (
        (plan.budget.maxTokens !== undefined &&
          nextTokens > plan.budget.maxTokens) ||
        (plan.budget.maxCost !== undefined && nextCost > plan.budget.maxCost)
      ) {
        budget.failedSteps += 1;
        haltedByBudget = true;
        const errorCode =
          plan.budget.maxTokens !== undefined &&
          nextTokens > plan.budget.maxTokens
            ? "REASONING_PLAN_TOKEN_BUDGET_EXCEEDED"
            : "REASONING_PLAN_COST_BUDGET_EXCEEDED";
        traces.push({
          stepId: step.id,
          operator: step.operator,
          status: "FAILED",
          executionTarget: step.executionTarget,
          inputStepIds,
          inputHashes: inputStepIds
            .map((id) => resultHashes.get(id))
            .filter((hash): hash is string => Boolean(hash)),
          resultRefs: [],
          elapsedMs: Math.max(0, now() - stepStartedAt),
          warnings: [...(value.warnings ?? [])],
          errorCode,
          budgetAfter: copyBudget(budget, now(), startedAtMs),
        });
        continue;
      }

      budget.tokens = nextTokens;
      budget.cost = nextCost;
      budget.successfulSteps += 1;
      const digest = resultDigest(value);
      results.set(step.id, value);
      resultHashes.set(step.id, digest);
      traces.push({
        stepId: step.id,
        operator: step.operator,
        status: "SUCCESS",
        executionTarget: step.executionTarget,
        inputStepIds,
        inputHashes: inputStepIds
          .map((id) => resultHashes.get(id))
          .filter((hash): hash is string => Boolean(hash)),
        resultRefs: [...new Set(value.refs)],
        resultHash: digest,
        ...(value.channel ? { channel: value.channel } : {}),
        ...(value.revision ? { revision: value.revision } : {}),
        elapsedMs: Math.max(0, now() - stepStartedAt),
        warnings: [...(value.warnings ?? [])],
        budgetAfter: copyBudget(budget, now(), startedAtMs),
      });
    } catch (error) {
      budget.failedSteps += 1;
      const errorCode = safeCode(error, "REASONING_OPERATOR_FAILED");
      if (errorCode === "CONTEXT_REVISION_CHANGED") {
        controller.abort();
        throw new Error("CONTEXT_REVISION_CHANGED");
      }
      if (
        errorCode === "REASONING_PLAN_WALL_BUDGET_EXCEEDED" ||
        errorCode === "REASONING_PLAN_ABORTED"
      ) {
        haltedByBudget = true;
      }
      traces.push({
        stepId: step.id,
        operator: step.operator,
        status: "FAILED",
        executionTarget: step.executionTarget,
        inputStepIds,
        inputHashes: inputStepIds
          .map((id) => resultHashes.get(id))
          .filter((hash): hash is string => Boolean(hash)),
        resultRefs: [],
        elapsedMs: Math.max(0, now() - stepStartedAt),
        warnings: [],
        errorCode,
        budgetAfter: copyBudget(budget, now(), startedAtMs),
      });
    } finally {
      cleanup();
    }
  }

  const completedAtMs = now();
  budget.wallMs = Math.max(0, completedAtMs - startedAtMs);
  const status = finalStatus(budget);
  const trace: ReasoningExecutionTrace = {
    planId,
    schemaVersion: 1,
    intent: plan.intent,
    revisionSetHash,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    status,
    steps: traces,
    warnings,
    budget: { ...budget },
  };

  let tracePersistence: "NOT_REQUESTED" | "PERSISTED" | "FAILED" =
    "NOT_REQUESTED";
  if (options.traceSink) {
    try {
      await options.traceSink.persist(trace);
      tracePersistence = "PERSISTED";
    } catch {
      tracePersistence = "FAILED";
      trace.warnings.push("REASONING_TRACE_PERSIST_FAILED");
    }
  }

  return {
    status,
    plan,
    results,
    trace,
    tracePersistence,
  };
}

export async function executeWithReasoningPlanner<TFallback>(input: {
  planner?: ReasoningPlannerPort;
  fallback: (
    reason: "PLANNER_UNAVAILABLE" | "PLAN_INVALID",
  ) => Promise<TFallback>;
  validationContext: ReasoningPlanValidationContext;
  executor: ReasoningExecutorOptions;
}): Promise<PlannedReasoningResult<TFallback>> {
  if (!input.planner) {
    return {
      mode: "DIRECT_FALLBACK",
      reason: "PLANNER_UNAVAILABLE",
      result: await input.fallback("PLANNER_UNAVAILABLE"),
    };
  }

  const linked = linkedController(input.executor.signal);
  try {
    let proposed: unknown;
    try {
      proposed = await input.planner.propose(linked.controller.signal);
    } catch {
      return {
        mode: "DIRECT_FALLBACK",
        reason: "PLANNER_UNAVAILABLE",
        result: await input.fallback("PLANNER_UNAVAILABLE"),
      };
    }

    const executed = await executeReasoningPlan(
      proposed,
      input.validationContext,
      input.executor,
    );
    if (executed.status === "REJECTED") {
      return {
        mode: "DIRECT_FALLBACK",
        reason: "PLAN_INVALID",
        result: await input.fallback("PLAN_INVALID"),
      };
    }
    return { mode: "PLAN", result: executed };
  } finally {
    linked.cleanup();
  }
}
