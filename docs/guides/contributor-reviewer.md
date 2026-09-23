# Contributor and Reviewer Guide

## What this feature is

AKP separates contribution from approval. Contributors can submit sources, compile candidates, create workspace findings or propose governed changes; reviewers inspect evidence, contradictions, policy compliance and Git diffs before canonical publication.

Approved canonical knowledge is managed Markdown in Git. Generated/provider output, workspace findings and connector projections are candidate or operational state until the review lifecycle explicitly publishes them.

## Publication boundary

```text
source / finding / authored draft
             │
             ▼
       candidate change
             │
             ▼
deterministic validation + evidence
             │
             ▼
       isolated Git diff
             │
             ▼
       human/policy review
        │ approve   │ reject/change
        ▼           └───────────────► candidate state
managed Git publication
        │
        ▼
derived projections rebuild/update
```

## When to use it

Use the contribution/review workflow whenever a proposed change should become shared canonical knowledge. Use workspace findings or notes when information is useful for current work but is not yet ready for publication.

Administrative read-only vault import is a separate compatibility boundary and should not be confused with normal proposal authority.

## Configuration

Provision contributors with the minimum permissions they need, commonly source read/write and `knowledge:propose`. Provision reviewers separately with review authority; publication/administration should not be granted to normal agent credentials.

The active Knowledge Profile defines allowed knowledge kinds, lifecycle, evidence and review policy. Proposal paths are constrained by its artifact contracts.

Managed Git author identity is configured through `AKP_GIT_AUTHOR_NAME` and `AKP_GIT_AUTHOR_EMAIL`. The managed repository path is `AKP_MANAGED_REPO`.

## Normal workflow

1. Submit or identify source/evidence.
2. Compile or author a candidate under the active profile.
3. Run validation, contradiction/deduplication and required probes.
4. Create an isolated review draft/worktree.
5. Reviewer inspects evidence, source locators, trust implications, policy requirements and the exact Git diff.
6. Approve, request changes or reject.
7. Publication commits the reviewed content to managed Git and updates durable publication state.
8. Derived indexes update from the published revision; they do not become the publication authority themselves.

Workspace promotion follows the same principle: finding/evidence becomes a promotion request, then review, then managed-Git publication.

## Security and governance boundaries

Candidate content cannot self-assert stronger authority through frontmatter. Attested trust or equivalent authority must come from an external governed authority, not the candidate being reviewed.

Draft paths are normalized and confined to allowed roots. Review worktrees isolate concurrent drafts and optimistic base checks detect stale publication bases.

Human review remains authoritative for canonical publication. Model providers and agent processes do not receive publication authority by producing plausible content.

## Degraded and offline behavior

If an optional compiler/provider is unavailable, source-backed fallback drafts may remain inspectable but are not silently promoted.

Offline workspace drafts can capture findings/notes for later reconciliation, but canonical publication is never performed offline through last-write-wins.

A changed profile/truth/base revision requires revalidation before review proceeds.

## Failure and recovery

If the Git commit succeeds but PostgreSQL finalization fails, use the supported publication reconciliation/compensation path. When attribution is safe, recovery can revert the exact managed commit; ambiguous cases fail closed with a recovery-required state.

Do not manually rewrite review/publication tables or guess the expected Git revision.

Backup/restore includes review/workspace state and managed Git when configured. After recovery, verify revision parity before approving pending drafts.

## Example

A contributor proposes a new retry procedure grounded in two source locators. The reviewer confirms the active profile permits `procedure`, checks that the candidate does not contradict an existing rule, inspects the isolated Git diff and approves. Only the resulting managed-Git publication becomes canonical.

## Limitations

AKP cannot determine organizational correctness beyond the evidence and policies it is given. A passing validator is not a substitute for domain review.

Git and PostgreSQL are coordinated with compensation/reconciliation rather than a distributed transaction.
