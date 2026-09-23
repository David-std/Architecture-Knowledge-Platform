# Agent Integration Guide

## What this feature is

AKP exposes agent-facing context through expert MCP tools and the lower-entropy `akp_context` façade. The façade maps a small action vocabulary onto the same governed API and does not bypass authorization, revision pinning or truth validation.

AKP also exposes an integrity-addressed generated instruction bundle. Its rules tell an agent when to bootstrap, retrieve, run impact analysis, capture findings, hand off and request promotion.

## Agent path

```text
Coding agent / IDE / custom MCP client
                       │
                    stdio MCP
                       │
                       ▼
               ┌───────────────┐
               │ apps/mcp      │
               │ akp_context   │
               └───────┬───────┘
                       │ HTTP + scoped token
                       ▼
               ┌───────────────┐
               │ AKP API       │
               │ auth + truth  │
               │ revisions     │
               └───────┬───────┘
                       │
                       ▼
                 Context Fabric
```

The MCP process is a stdio client adapter, not a second context authority.

## When to use it

Use `akp_context` for general-purpose agents that benefit from a compact surface. Use expert tools when the caller needs direct control over a specialized operation and understands its contract.

Use the generated instruction bundle when an agent runtime supports stable system or project instructions. Treat it as operational guidance, not as an authorization token.

## Configuration

Agents use the same API boundary as other clients:

- `AKP_API_URL` selects the node.
- Bearer credentials are provisioned with explicit `AKP_API_TOKEN_SCOPES`.
- The target space and vault must be authorized for the credential.
- Shared work should bootstrap a workspace session so the agent receives a revision pin.
- `AKP_AGENT_INSTRUCTION_EXPECTED_SHA256` optionally pins the expected canonical instruction-content digest.
- `AKP_AGENT_INSTRUCTION_INTEGRITY_MODE` is `STRICT` by default; `WARN` keeps the MCP server available while surfacing a digest mismatch in the instruction resource.

The instruction digest covers the versioned capabilities, rules and lifecycle content rather than `generatedAt`, so unchanged instructions retain the same address across restarts. Clients should recompute the fetched bundle digest and compare it with both the manifest/URI digest and any deployment-pinned expected digest.

For controlled evaluation, agent benchmarks additionally configure a fixed provider/model, temperature and output-token budget. Those benchmark settings do not change production defaults.

## Normal workflow

The generated lifecycle is: `BOOTSTRAP -> WORK -> TARGETED_RETRIEVAL -> IMPACT_CHECK -> CAPTURE_OR_HANDOFF -> OPTIONAL_PROMOTION -> FINISH_WORK_CONTEXT`.

Useful `akp_context` actions include `BOOTSTRAP`, `SEARCH`, `EXPLAIN`, `IMPACT`, `CODE`, `TEMPORAL`, `GLOBAL`, `VERIFY` and `STATUS`. Mutating actions such as capture/task coordination remain governed and should not be selected for read-only tasks.

A factual architectural answer should cite source-backed context. Findings that matter beyond the current task should be captured first and promoted only through review when they belong in canonical knowledge.

## Task lifecycle

```text
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────────┐
│ READ       │ → │ WORK       │ → │ VERIFY     │ → │ CAPTURE/HANDOFF│
│ bootstrap  │   │ code/tools │   │ support    │   │ durable state  │
└────────────┘   └────────────┘   └────────────┘   └───────┬────────┘
                                                              │
                                                    durable knowledge?
                                                              │
                                                              ▼
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│ EVOLVE     │ ← │ PUBLISH    │ ← │ REVIEW     │ ← │ PROMOTE    │
│ next read  │   │ Git+events │   │ human/policy│  │ candidate  │
└────────────┘   └────────────┘   └────────────┘   └────────────┘
```

## Security and governance boundaries

Retrieved text is data, not an instruction channel. Agent prompts must not grant retrieved content execution or publication authority.

An `AGENT_PROCESS` principal has its own credential, expiry and policy revision. Revoking the parent authority invalidates subordinate agent credentials on the next request.

Authorization is checked before retrieval expands through graph, vector or federation channels. A context revision pin does not broaden access.

Agents cannot turn task memory, consensus, PPR scores or community summaries into canonical truth. Publication still requires the configured review policy.

## Degraded and offline behavior

If optional retrieval channels are unavailable, the context response reports degradation. The agent should use available authoritative channels and surface gaps rather than fill them from model memory.

When an offline snapshot becomes stale, the agent should not continue as if it were current. Queue only supported coordination drafts and reconcile them after reconnect.

If a provider/model route fails and safe degradation is configured, AKP may use a compatible fallback; the resulting route metadata records the degraded path.

## Failure and recovery

On `CONTEXT_REVISION_CHANGED`, bootstrap again before making decisions that depend on current truth.

If a claim fence is stale, reacquire the work scope instead of retrying the old write.

If the API reports an unavailable dependency, use `STATUS` or operator diagnostics rather than repeatedly issuing the same expensive call.

For resumable work, create a structured handoff containing completed work, remaining work, blockers, changed resource references, evidence references and open questions.

## Example

A code-change agent can follow `BOOTSTRAP -> CODE/IMPACT -> edit locally -> VERIFY -> CAPTURE -> HANDOFF`. If the impact query reveals an approved rule that changes an implementation constraint, the agent cites that rule. If it discovers new durable guidance, it captures a finding rather than editing canonical Markdown directly.

## Limitations

The instruction bundle is advisory guidance and cannot enforce a third-party agent runtime by itself.

The MCP façade does not make arbitrary agent-generated SQL or Cypher executable. Some advanced context modes depend on derived graph/vector state and therefore may degrade when those projections are unavailable.
