import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import { Postgres, PostgresTemporalTruthStore } from "@akp/postgres";
import { evaluateGovernedTemporalPropositionShadow } from "../src/governed-proposition-shadow.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("governed proposition shadow admission", () => {
  it("resolves current authorized temporal evidence without affecting production admission", async () => {
    if (!databaseUrl) return;
    const db = new Postgres(databaseUrl);
    const store = new PostgresTemporalTruthStore(db);

    const organizationId = randomUUID();
    const spaceId = randomUUID();
    const vaultId = randomUUID();
    const sourceId = randomUUID();
    const artifactId = randomUUID();
    const documentId = randomUUID();
    const evidenceId = randomUUID();
    const sourceHash = "a".repeat(64);
    const excerpt = "Administrative access requires MFA.";
    const body = ["# Administrative access", excerpt].join("\n");
    const documentHash = createHash("sha256").update(body).digest("hex");
    const evidenceHash = createHash("sha256").update(excerpt).digest("hex");

    try {
      await db.pool.query(
        `insert into organizations(id,slug,name)
         values($1,$2,'Governed proposition shadow')`,
        [organizationId, "governed-shadow-" + organizationId.slice(0, 8)],
      );
      await db.pool.query(
        `insert into spaces(
           id,organization_id,slug,name,visibility,knowledge_repo_path
         ) values($1,$2,$3,'Governed shadow space','PRIVATE',$4)`,
        [
          spaceId,
          organizationId,
          "governed-shadow-" + spaceId.slice(0, 8),
          "/tmp/governed-shadow-" + spaceId,
        ],
      );
      await db.pool.query(
        `insert into vaults(
           id,space_id,canonical_path,name,read_only,current_revision,
           vault_key,local_path,visibility,enabled
         ) values($1,$2,$3,'Governed shadow vault',true,'shadow:r1',$4,$3,'PRIVATE',true)`,
        [
          vaultId,
          spaceId,
          "/tmp/governed-shadow-vault-" + vaultId,
          "shadow-" + vaultId.slice(0, 8),
        ],
      );
      await db.pool.query(
        `insert into sources(
           id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
           object_key,status,metadata
         ) values($1,$2,$3,'Admin policy',$4,'text/markdown',$5,$6,$7,'ACTIVE','{}'::jsonb)`,
        [
          sourceId,
          spaceId,
          vaultId,
          "https://example.test/admin-policy",
          sourceHash,
          body.length,
          "shadow/admin-policy.md",
        ],
      );
      await db.pool.query(
        `insert into source_artifacts(
           id,source_id,kind,object_key,source_hash,extractor,extractor_version,
           quality,metadata
         ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
        [artifactId, sourceId, "shadow/admin-policy.json", sourceHash],
      );
      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,
           trust_tier,current_revision,body_cache,frontmatter,layer,
           content_hash,token_estimate,raw_links
         ) values($1,$2,$3,'security/admin.md','ADMIN-POLICY','{}',
                  'Admin policy','concept','ACTIVE','HUMAN_REVIEWED',
                  'shadow:r1',$4,'{}'::jsonb,'concept',$5,10,'[]'::jsonb)`,
        [documentId, spaceId, vaultId, body, documentHash],
      );
      await db.pool.query(
        `insert into evidence(
           id,space_id,vault_id,source_id,artifact_id,locator,content_hash,
           excerpt,review_status
         ) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'REVIEWED')`,
        [
          evidenceId,
          spaceId,
          vaultId,
          sourceId,
          artifactId,
          JSON.stringify({ path: "security/admin.md", paragraph: 1 }),
          evidenceHash,
          excerpt,
        ],
      );
      await db.pool.query(
        `insert into document_evidence(document_id,evidence_id,relation_type)
         values($1,$2,'supported_by')`,
        [documentId, evidenceId],
      );

      const support = await store.createSupportSet({
        spaceId,
        vaultId,
        evidenceIds: [evidenceId],
      });
      await store.recordFact({
        spaceId,
        vaultId,
        scopeId: "security:admin",
        authorizationPath: "security/admin.md",
        subjectRef: "policy:admin-access",
        predicate: "requires_mfa",
        object: { required: true },
        validFrom: "2025-01-01T00:00:00.000Z",
        supportSetId: support.id,
      });

      const hit: SearchHit = {
        documentId,
        vaultId,
        document: {
          externalId: "ADMIN-POLICY",
          path: "security/admin.md",
          title: "Admin policy",
          aliases: [],
        },
        revision: "shadow:r1",
        title: "Admin policy",
        type: "concept",
        trust: "HUMAN_REVIEWED",
        lifecycle: "ACTIVE",
        refreshStatus: "CURRENT",
        score: 1,
        reasons: ["shadow-fixture"],
        excerpt,
        citations: [],
      };

      const query = "Does administrative access require MFA?";
      const queryProposition = {
        subject: "policy:admin-access",
        predicate: "requires_mfa",
        object: '{"required":true}',
        polarity: "POSITIVE" as const,
      };

      const allowed = await evaluateGovernedTemporalPropositionShadow(db, {
        spaceId,
        hit,
        query,
        queryProposition,
        authorizationPathPrefixes: ["security"],
        validAt: "2026-01-01T00:00:00.000Z",
      });
      expect(allowed).toMatchObject({
        evaluatedFacts: 1,
        projectedFacts: 1,
        resolvedCandidates: 1,
      });
      expect(allowed.decisions).toHaveLength(1);
      expect(allowed.decisions[0]?.decision).toMatchObject({
        layer: "STRUCTURED_PROPOSITION",
        verdict: { kind: "ANSWERS" },
      });

      const denied = await evaluateGovernedTemporalPropositionShadow(db, {
        spaceId,
        hit,
        query,
        queryProposition,
        authorizationPathPrefixes: ["finance"],
        validAt: "2026-01-01T00:00:00.000Z",
      });
      expect(denied).toEqual({
        evaluatedFacts: 0,
        projectedFacts: 0,
        resolvedCandidates: 0,
        decisions: [],
      });

      const ambiguous = await evaluateGovernedTemporalPropositionShadow(db, {
        spaceId,
        hit: { ...hit, excerpt: excerpt + " " + excerpt },
        query,
        queryProposition,
        authorizationPathPrefixes: ["security"],
        validAt: "2026-01-01T00:00:00.000Z",
      });
      expect(ambiguous).toMatchObject({
        evaluatedFacts: 1,
        projectedFacts: 1,
        resolvedCandidates: 0,
        decisions: [],
      });
    } finally {
      await db.pool.query("update vaults set enabled=false where id=$1", [
        vaultId,
      ]);
      await db.close();
    }
  });
});
