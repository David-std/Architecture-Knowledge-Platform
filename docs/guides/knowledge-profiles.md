# Knowledge Profiles Guide

## What this feature is

A Knowledge Profile is a versioned semantic contract for how a vault represents and governs knowledge. It defines knowledge kinds, relation types, lifecycle states, evidence policies, review policies, artifact paths, retrieval constraints, promotion rules, freshness rules and optional connector/model-role constraints.

Profiles shape compiler, review and retrieval behavior. They do not grant runtime authorization.

## When to use it

Use a profile when a domain needs semantics beyond the neutral default, when a schema change must be reviewed before it affects an existing corpus, or when connector/model behavior must be constrained per vault.

Do not use a profile as a place to store secrets, endpoint credentials or user permissions.

## Configuration

The versioned contract is `KnowledgeProfileV1`. Important fields include:

- `profileId`, `version` and `displayName`.
- `knowledgeKinds` and their lifecycle/evidence/review/artifact references.
- `relationTypes`.
- `retrievalPolicy`, including allowed kinds and relation allowlist.
- `promotionPolicy`.
- `freshnessPolicy`.
- optional `connectorPolicy`.
- `modelRoleConstraints`.

Model-role constraints accept `LOCAL_ONLY`, `ORG_APPROVED` or `EXTERNAL_ALLOWED` residency plus structured-output requirements. The operational model endpoint/provider configuration is separate.

Profile artifact roots and templates are validated against traversal, absolute paths and internal `.akp` paths.

## Normal workflow

1. Create a new immutable profile revision.
2. Validate the profile structure and references.
3. Compare it with the active revision to determine compatibility impact.
4. If the change requires reindex, recompile or migration, perform the governed preparation before activation.
5. Activate the validated revision transactionally.
6. Compiler and retrieval paths load the active durable revision and verify that it did not change while an in-flight operation was using it.
7. Supersede or retire older revisions without rewriting their history.

A vault without an explicit durable revision uses the maintained neutral profile behavior.

## Security and governance boundaries

A profile can restrict allowed knowledge kinds, connector access modes, promotion targets and model residency. It cannot grant a principal access to a space, vault or path.

Duplicate model-role constraints for the same role are rejected because they would make effective routing ambiguous.

Generated content must still satisfy the active profile and review policy. A model-emitted kind that the profile does not declare is rejected rather than coerced into another kind.

Profile activation is auditable durable state and uses the same transactional discipline as other governed configuration changes.

## Degraded and offline behavior

Profile-aware compilation fails closed if the active profile revision changes while the provider is in flight. The operation must restart against one revision instead of mixing semantics.

When a profile requires a provider property that the active adapter cannot enforce exactly, the adapter rejects the configuration rather than silently approximating it.

Offline workspace context retains its pinned profile revision as part of the context authority set; stale pins require reconciliation.

## Failure and recovery

Activation is transactional. A database failure during the activation boundary must leave the previous binding and statuses intact.

Backup v4 includes profile revisions and vault bindings. After restore, `pnpm akp doctor --format human` checks active/default profile consistency.

For a breaking profile on a non-empty corpus, use the compatibility/migration workflow and keep the previous active revision until the required derived or canonical changes are ready.

## Example

A software-delivery profile may permit `note` and `procedure` kinds, require evidence locators, require review for promotion and constrain `KNOWLEDGE_COMPILE` to `ORG_APPROVED` residency. A source marked `LOCAL_ONLY` still tightens the effective runtime route further because the most restrictive boundary wins.

## Review-first interoperability

OKF v0.2 import is always a review-first operation. Foreign trust, review status, profile identity and provenance are retained for inspection but never become local authority. Imported kinds, lifecycle states and relations are validated against the active local Knowledge Profile before any review draft is created.

Import rejects traversal, absolute/control-character and reserved management paths, including portable case-collisions between foreign source paths. Aggregate OKF payload size is bounded independently of the HTTP request limit. JSON-LD and GraphML are export formats only in v0.4; the OKF import route does not dereference remote JSON-LD contexts or parse XML entities.

A supported exchange proof is: canonical AKP knowledge -> OKF v0.2 export -> isolated-vault import candidate -> explicit human review action. Identity/provenance/relations remain inspectable across that round trip while local trust stays `UNVERIFIED` until ordinary AKP review/publication policy approves it.

## Limitations

Knowledge Profiles are semantic/governance contracts, not general deployment configuration. They intentionally do not carry API keys, raw endpoint URLs or authorization memberships.

A profile change can identify that migration, reindex or recompile is required, but domain-specific content migration still needs explicit implementation and review.
