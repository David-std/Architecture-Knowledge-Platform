# AKP PR #38 — S2 continuity checkpoint (2026-10-17, America/Bogota)

## Verified parent state

- Repository: `David-std/Architecture-Knowledge-Platform`, draft PR #38,
  `chore/retrieval-generality-policy` -> `develop`.
- Parent commit: `95b691059f4eaa4e2a52d2ad278985340f5da511`.
  At inspection, PR was OPEN, DRAFT, unmerged, and 14 required workflows were
  successful on this parent SHA. Optional workflow dispatches marked `skipped`
  must not be counted as successful executions.
- S0/S1 closed. **S2 OPEN**; E5 shadow; S3-S5 blocked. No release/merge or
  provider-default promotion is authorized.

## Official reviewer adjudication CLI: executed, no labels committed

The external handoff `AKP_PR38_HANDOFF_FINAL_S2_2026-10-17.zip` was extracted
locally. The official, repo-sourced Node.js CLI was run on the exact original
packet, both 288-row submissions and the 155-row dispute-only submission:

```sh
node scripts/validate-s2-adjudications.mjs --self-test
node scripts/validate-s2-adjudications.mjs \
  --packet "$HANDOFF/01_entradas/paquete-congelado-fd2645f7.json" \
  --packet-sha256 fd2645f75713389d89492128027bb02a618b2a383774341d6d4fd74deb8d1daa \
  --reviewer-a "$HANDOFF/01_entradas/revisor-a-original-288.csv" \
  --reviewer-a-id reviewer-a \
  --reviewer-b "$HANDOFF/01_entradas/revisor-b-original-288.csv" \
  --reviewer-b-id reviewer-b \
  --resolution "$HANDOFF/03_resultados/s2-tercera-revision-155.csv" \
  --adjudicator-id reviewer-c \
  --output "$HANDOFF/../official-third-validation.json"
```

`HANDOFF` denotes the fully extracted ZIP root; the path is deliberately
external to the repo. The CLI self-test passed **17 mutation cases**, including
six frozen-source binding mutations. The official adjudication output was:

| Field                                 | Verified value                                       |
| ------------------------------------- | ---------------------------------------------------- |
| `sourceBinding.sourceBoundCandidates` | 288/288                                              |
| `agreement.reviewedPairs`             | 288                                                  |
| `agreement.matchingLabels`            | 143                                                  |
| `agreement.disagreements.length`      | 155                                                  |
| `disputeResolution.resolvedPairCount` | 155/155                                              |
| `disputeResolution.status`            | `THIRD_SUBMISSION_VALIDATED_HUMAN_ORIGIN_UNVERIFIED` |
| `reviewerIndependenceVerified`        | `false`                                              |
| `admissionMeasured` / `gateAccepted`  | `false` / `false`                                    |
| `falseAdmissionRate`                  | `null`                                               |

Official JSON output SHA-256:
`d1a6759be7c07e3e46de84eaf9a09d1bf05ba2ffccb01ac52cbba93f5329ca2d`.

The handoff's reproduction script recreated all five derived files byte for
byte, compared with `cmp`. The **three consensus controls were not passed to
`--resolution`**, because only the actual disputes belong there. The external
adjudicated reference remains 24 ANSWERS, 33 RELATED_NOT_ANSWERING, 231
INSUFFICIENT and 0 CONTRADICTS, with 130 initial consensuses, 155 dispute
resolutions and three separately corrected post-hoc controls. These labels
remain external and have **not** been imported as runtime input or as an
independent accuracy benchmark.

## New code (instrumentation, not quality evidence)

- `apps/api/src/s2-admission-shadow.ts` builds redacted records from the
  application **after** it has made its real candidate admission decision.
  It separates actual admitted candidates from shadow verifier diagnostics,
  checks excerpt-relative UTF-16 offsets/surrogate boundaries, hashes source
  and query identities, and redacts non-code free-form reader reasons.
- Both `/v1/search` and `/v1/context` can notify an explicitly injected,
  best-effort sink; `buildServer` exposes that opt-in dependency. Missing or
  failing observers cannot change results, and no sink is registered by
  default. This is not a new reader or an admission policy change.
- Added focused tests for exact quote hashes, shadow/active policy separation,
  invalid offsets, unscoped candidate rejection, reason redaction and
  observer failure isolation. Added a **draft**, not-yet-frozen independent
  postcalibration protocol. No new holdout claims or model calls are implied.

## Local verification of this change

- `pnpm --filter @akp/api typecheck` and `build`: PASS.
- API unit suite: **97/97 PASS**, including the new shadow tests.
- `pnpm docs:validate`: PASS; `pnpm hygiene:validate`: PASS after
  mechanically regenerating the file classification for added files.
- `pnpm retrieval:generality:validate`: PASS; `pnpm boundaries`: PASS.
- Formatter/diff validation: PASS. The local dependency install used pinned
  lockfile and an offline `--ignore-scripts` retry because ONNX Runtime's
  NuGet binary host could not resolve; no local real-model test is claimed.

**Remote same-SHA CI must be checked on the new commit independently.** Passing
these local checks does not demonstrate reader semantic precision or acceptance.

## Remaining S2 work (do not infer results)

1. Freeze genuinely independent EN/ES holdout sources/questions and their
   preregistered evaluator rubric **before** measuring; require separate
   blind adjudication with provenance and source cluster analysis.
2. Inject `s2AdmissionShadowSink` into an authorized run of the actual
   configured semantic reader. Persist observations securely and rebind
   excerpt-relative quotes to immutable source bytes and ACL/revision.
3. Measure task-level grounded final answers, justified abstentions, FAR,
   precision and intervals by language/source cluster; distinguish full
   request p95 from admission-only timing and report provider errors.
4. Perform paired Obsidian/manual, full/compact ContextPacket and fixed-reader
   comparisons with exact pinned model tokens and no use of gold in readers.
5. Audit every provisional gate independently before proposing S2 closure.
   Keep PR OPEN/DRAFT, E5 shadow, S3-S5 blocked and **NO MERGE**.
