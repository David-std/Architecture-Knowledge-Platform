import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1,
} from "@akp/contracts/knowledge-profile";
import { Postgres, registerVault } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const token = `software-delivery-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let vaultId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'P2 software delivery profile integration',$3::jsonb)`,
    [
      adminId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "admin"],
          },
        ],
      }),
    ],
  );
  const vault = await registerVault(
    db,
    {
      vaultKey: `software-delivery-${randomUUID().slice(0, 8)}`,
      name: "Software delivery workspace vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `software-delivery-${randomUUID()}`),
      contentRoots: ["."],
      sourceRoots: [],
      schemaProfile: {},
      evalPack: {
        name: "generic",
        version: "1",
        enabled: true,
        criticalCases: [],
      },
      retrievalConfig: {},
      permissions: {},
      enabled: true,
    },
    { ownerUserId: adminId },
  );
  vaultId = vault.id;
  await db.pool.query(
    "update vaults set current_revision='software-delivery-r1' where id=$1",
    [vaultId],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query(
    "update vaults set active_knowledge_profile_revision_id=null where id=$1",
    [vaultId],
  );
  await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
  await db.pool.query("delete from schema_dry_runs where vault_id=$1", [
    vaultId,
  ]);
  await db.pool.query("delete from vaults where id=$1", [vaultId]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [
    tokenHash,
  ]);
  await db.close();
});

describe("first-party software delivery workspace profile", () => {
  it("activates through the governed path and becomes the vault's authority", async () => {
    const dryRunResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: {
        spaceId,
        vaultId,
        profile: SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1,
      },
    });
    expect(dryRunResponse.statusCode).toBe(200);
    const dryRun = dryRunResponse.json<{
      id: string;
      profileRevisionId: string;
      profileRevisionStatus: string;
      candidateHash: string;
      compatibilityClass: string;
      corpusRevision: string;
    }>();
    // Moving to a differently-identified profile is never a mere revision, so
    // the classifier refuses to call it non-breaking.
    expect(dryRun.profileRevisionStatus).toBe("REVIEW_REQUIRED");

    const payload = {
      spaceId,
      vaultId,
      profileRevisionId: dryRun.profileRevisionId,
      dryRunId: dryRun.id,
      expectedProfileHash: dryRun.candidateHash,
      expectedCorpusRevision: dryRun.corpusRevision,
    };

    // Activation is the wrong operation and says so, rather than quietly
    // rebinding the vault to a new profile identity.
    const activation = await app.inject({
      method: "POST",
      url: "/v1/schema/activate",
      headers,
      payload,
    });
    expect(activation.statusCode).toBe(409);
    expect(activation.json()).toMatchObject({
      code: "PROFILE_REVIEW_REQUIRED",
    });

    const adoption = await app.inject({
      method: "POST",
      url: "/v1/schema/adopt",
      headers,
      payload,
    });
    expect(adoption.statusCode).toBe(200);
    expect(adoption.json()).toMatchObject({
      status: "ACTIVE",
      profileId: "software-delivery",
      version: "0.4.0",
      previousProfileId: null,
    });

    // The profile is not merely stored: the vault now points at it, so
    // retrieval, compilation and review read this profile rather than the
    // v0.3 default.
    const bound = await db.pool.query<{
      profile_id: string;
      version: string;
      status: string;
    }>(
      `select r.profile_id,r.version,r.status
         from vaults v
         join knowledge_profile_revisions r
           on r.id=v.active_knowledge_profile_revision_id
        where v.id=$1`,
      [vaultId],
    );
    expect(bound.rows[0]).toMatchObject({
      profile_id: "software-delivery",
      version: "0.4.0",
      status: "ACTIVE",
    });
  });

  it("refuses an adoption that would reinterpret knowledge the corpus already holds", async () => {
    // A rule the team already compiled. The neutral profile has no `rule`
    // kind, so adopting it would leave this document describing itself with a
    // kind its own profile does not define.
    const documentId = randomUUID();
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,
         token_estimate,raw_links
       ) values($1,$2,$3,$4,'ADOPT-GUARD-1','Token rotation rule','rule',
         'ACTIVE','HUMAN_REVIEWED','adopt-guard:1',$5,'{}'::jsonb,
         '{}'::text[],'knowledge',$6,64,'[]'::jsonb)`,
      [
        documentId,
        spaceId,
        vaultId,
        "20-knowledge/generated/rule/token-rotation.md",
        "Rotate tokens on privilege change.",
        createHash("sha256").update(documentId).digest("hex"),
      ],
    );
    // The corpus fingerprint is part of the decision, so refresh the revision
    // the same way a real write would.
    await db.pool.query(
      "update vaults set current_revision='software-delivery-r2' where id=$1",
      [vaultId],
    );

    try {
      const dryRunResponse = await app.inject({
        method: "POST",
        url: "/v1/schema/dry-run",
        headers,
        payload: {
          spaceId,
          vaultId,
          profile: NEUTRAL_KNOWLEDGE_PROFILE_V1,
        },
      });
      expect(dryRunResponse.statusCode).toBe(200);
      const dryRun = dryRunResponse.json<{
        id: string;
        profileRevisionId: string;
        candidateHash: string;
        corpusRevision: string;
      }>();

      const refused = await app.inject({
        method: "POST",
        url: "/v1/schema/adopt",
        headers,
        payload: {
          spaceId,
          vaultId,
          profileRevisionId: dryRun.profileRevisionId,
          dryRunId: dryRun.id,
          expectedProfileHash: dryRun.candidateHash,
          expectedCorpusRevision: dryRun.corpusRevision,
        },
      });
      expect(refused.statusCode).toBe(409);
      const body = refused.json() as {
        code: string;
        blockers: Array<{ code: string; path: string; usageCount: number }>;
      };
      expect(body.code).toBe("KNOWLEDGE_PROFILE_ADOPTION_WOULD_REINTERPRET");
      // "Unsafe" without naming what would break is not actionable, so the
      // refusal carries the kind and how many documents use it.
      expect(body.blockers.length).toBeGreaterThan(0);
      expect(body.blockers).toContainEqual(
        expect.objectContaining({
          path: "knowledgeKinds.rule",
          usageCount: 1,
        }),
      );
      for (const blocker of body.blockers) {
        expect(blocker.usageCount).toBeGreaterThan(0);
      }

      // The refusal changed nothing: the vault still runs the profile it
      // adopted earlier in this suite.
      const bound = await db.pool.query<{ profile_id: string }>(
        `select r.profile_id
           from vaults v
           join knowledge_profile_revisions r
             on r.id=v.active_knowledge_profile_revision_id
          where v.id=$1`,
        [vaultId],
      );
      expect(bound.rows[0]?.profile_id).toBe("software-delivery");
    } finally {
      await db.pool.query("delete from knowledge_documents where id=$1", [
        documentId,
      ]);
    }
  });

  it("replaces an already-active profile rather than colliding with it", async () => {
    // The first case adopted software-delivery onto a vault with no active
    // profile. Adopting again, over a live binding, is the case that exercises
    // the one-active-revision-per-vault invariant.
    const dryRunResponse = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: {
        spaceId,
        vaultId,
        profile: { ...NEUTRAL_KNOWLEDGE_PROFILE_V1, version: "1.0.0-readopt" },
      },
    });
    expect(dryRunResponse.statusCode).toBe(200);
    const dryRun = dryRunResponse.json<{
      id: string;
      profileRevisionId: string;
      candidateHash: string;
      corpusRevision: string;
    }>();

    const adoption = await app.inject({
      method: "POST",
      url: "/v1/schema/adopt",
      headers,
      payload: {
        spaceId,
        vaultId,
        profileRevisionId: dryRun.profileRevisionId,
        dryRunId: dryRun.id,
        expectedProfileHash: dryRun.candidateHash,
        expectedCorpusRevision: dryRun.corpusRevision,
      },
    });
    expect(adoption.statusCode).toBe(200);
    expect(adoption.json()).toMatchObject({
      status: "ACTIVE",
      profileId: "neutral-notes",
      previousProfileId: "software-delivery",
    });

    // Exactly one revision is ACTIVE, and it is the adopted one. The outgoing
    // profile is superseded, not deleted, so the change stays auditable.
    const revisions = await db.pool.query<{
      profile_id: string;
      status: string;
    }>(
      `select profile_id,status from knowledge_profile_revisions
        where vault_id=$1 and status in ('ACTIVE','SUPERSEDED')
        order by status`,
      [vaultId],
    );
    const active = revisions.rows.filter((row) => row.status === "ACTIVE");
    expect(active).toHaveLength(1);
    expect(active[0]?.profile_id).toBe("neutral-notes");
    expect(
      revisions.rows.some(
        (row) =>
          row.status === "SUPERSEDED" && row.profile_id === "software-delivery",
      ),
    ).toBe(true);

    const audited = await db.pool.query<{ count: number }>(
      `select count(*)::int count from audit_events
        where action='schema.profile_adopt' and vault_id=$1`,
      [vaultId],
    );
    expect(audited.rows[0]?.count).toBeGreaterThanOrEqual(2);
  });

  it("keeps publication human even for a profile an agent helped draft", () => {
    const profile = SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1;

    // No review policy admits a non-human principal. An agent may draft and
    // propose; approval is not a role it can hold.
    for (const [name, policy] of Object.entries(profile.reviewPolicies)) {
      expect(policy.required, `${name} must require review`).toBe(true);
      expect(policy.minimumApprovals).toBeGreaterThanOrEqual(1);
      expect(policy.allowedRoles).not.toContain("AGENT_PROCESS");
      expect(policy.allowedRoles).not.toContain("CONTRIBUTOR");
    }

    // Architecture decisions are consultative, so one approver is not enough.
    expect(
      profile.reviewPolicies["human-decision-review"]?.minimumApprovals,
    ).toBe(2);
    expect(profile.knowledgeKinds["architecture-decision"]?.reviewPolicy).toBe(
      "human-decision-review",
    );

    // Every kind is reviewed and grounded; none opts out.
    for (const [kind, definition] of Object.entries(profile.knowledgeKinds)) {
      const review = profile.reviewPolicies[definition.reviewPolicy];
      expect(review?.required, `${kind} must be reviewed`).toBe(true);
      const evidence = profile.evidencePolicies[definition.evidencePolicy];
      expect(evidence?.minimumEvidence ?? 0).toBeGreaterThanOrEqual(1);
      expect(evidence?.requireSourceLocator).toBe(true);
    }

    // Reaching ACTIVE is publication, and publication always costs evidence
    // plus a human reviewer, from every state that can reach it.
    const lifecycle = profile.lifecycles["delivery-flow"];
    const toActive = (lifecycle?.transitions ?? []).filter(
      (transition) => transition.to === "ACTIVE",
    );
    expect(toActive.length).toBeGreaterThan(0);
    for (const transition of toActive) {
      expect(transition.requiredEvidence).toBe(true);
      expect(transition.requiredReview).toBe(true);
      expect(transition.allowedActors).not.toContain("AGENT_PROCESS");
      expect(transition.allowedActors).not.toContain("CONTRIBUTOR");
    }

    // Promotion never skips review, whatever scope it targets.
    expect(profile.promotionPolicy.reviewRequired).toBe(true);
    expect(profile.promotionPolicy.allowedTargetScopes).not.toContain(
      "EXTERNAL_FEDERATED",
    );
  });

  it("models delivery knowledge without taking over a system of record", () => {
    const kinds = Object.keys(
      SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1.knowledgeKinds,
    );

    // Tickets, pull requests, builds and deployments stay in the systems that
    // own them. Declaring them here would make each one a reviewed Markdown
    // artifact in managed Git and quietly replace the source of truth.
    for (const workObject of [
      "work-item",
      "issue",
      "pull-request",
      "build",
      "deployment",
      "incident",
      "commit",
    ]) {
      expect(kinds).not.toContain(workObject);
    }

    // A provenance draft is not a knowledge kind, and this profile must not be
    // the place that quietly turns one into canonical knowledge.
    expect(kinds).not.toContain("source-summary");

    // What it does model is the knowledge a delivery organization compiles,
    // on top of every v0.3 kind rather than instead of them: adopting this
    // profile must not silently drop a corpus a team already compiled.
    expect(kinds).toEqual(
      expect.arrayContaining([
        "architecture-decision",
        "architecture-rule",
        "service-contract",
        "runbook",
        "incident-retrospective",
      ]),
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "claim",
        "decision",
        "rule",
        "workflow",
        "concept",
        "example",
        "counterexample",
      ]),
    );

    // A decision records the fields teams report as missing in practice, as
    // profile-enforced structure rather than an optional template section.
    const decision =
      SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1.knowledgeKinds[
        "architecture-decision"
      ];
    for (const field of [
      "question",
      "drivers",
      "alternatives",
      "consequences",
      "decisionAuthority",
    ]) {
      expect(decision?.fields?.[field]?.required, `${field} is required`).toBe(
        true,
      );
    }
  });

  it("retrieves the constraints a delivery question is unsafe without", () => {
    const policy = SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1.retrievalPolicy;

    // Answering "how do I do this" without the rules that bind it is the
    // failure mode, so those kinds are retrieved whether or not they rank.
    expect(policy.mandatoryKindsByIntent.WORKFLOW_EXECUTION).toEqual(
      expect.arrayContaining(["architecture-rule", "runbook"]),
    );
    expect(policy.mandatoryKindsByIntent.IMPACT_ANALYSIS).toEqual(
      expect.arrayContaining(["architecture-decision", "architecture-rule"]),
    );
    expect(policy.mandatoryKindsByIntent.PROJECT_CODE).toEqual(
      expect.arrayContaining(["architecture-rule", "service-contract"]),
    );

    // Contradiction and supersession stay retrievable, so a superseded
    // decision can be surfaced as superseded rather than silently dropped.
    expect(policy.relationAllowlist).toEqual(
      expect.arrayContaining(["supersedes", "contradicts"]),
    );

    // A connector that cannot reproduce the source's permissions is not
    // treated as equivalent to one that can.
    expect(
      SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1.connectorPolicy
        ?.requirePermissionFidelity,
    ).toBe(true);
    expect(
      SOFTWARE_DELIVERY_KNOWLEDGE_PROFILE_V1.connectorPolicy
        ?.allowedAccessModes,
    ).not.toContain("HYBRID_CACHE");
  });
});
