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
          JSON.stringify({
            kind: "source",
            source_hash: sourceHash,
            path: "security/admin.md",
            heading_path: [],
          }),
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

      const evaluateBoundEvidence = () =>
        evaluateGovernedTemporalPropositionShadow(db, {
          spaceId,
          hit,
          query,
          queryProposition,
          authorizationPathPrefixes: ["security"],
          validAt: "2026-01-01T00:00:00.000Z",
        });

      // A quoted excerpt does not imply a supporting document relation.
      // Replacing the only supporting edge with a conflicting edge must
      // prevent the fact from acquiring any eligible source quote.
      await db.pool.query(
        `update document_evidence
            set relation_type='contradicts'
          where document_id=$1 and evidence_id=$2`,
        [documentId, evidenceId],
      );
      expect((await evaluateBoundEvidence()).evaluatedFacts).toBe(0);
      await db.pool.query(
        `update document_evidence
            set relation_type='supported_by'
          where document_id=$1 and evidence_id=$2`,
        [documentId, evidenceId],
      );

      // A source no longer in its active state is not current evidence,
      // even if the excerpt still exists in a reviewed document.
      await db.pool.query("update sources set status='WITHDRAWN' where id=$1", [
        sourceId,
      ]);
      expect((await evaluateBoundEvidence()).evaluatedFacts).toBe(0);
      await db.pool.query("update sources set status='ACTIVE' where id=$1", [
        sourceId,
      ]);

      // A source artifact with the wrong source revision cannot justify the
      // reviewed fact, irrespective of document text and proposition roles.
      await db.pool.query(
        "update source_artifacts set source_hash=$2 where id=$1",
        [artifactId, "b".repeat(64)],
      );
      expect((await evaluateBoundEvidence()).evaluatedFacts).toBe(0);
      await db.pool.query(
        "update source_artifacts set source_hash=$2 where id=$1",
        [artifactId, sourceHash],
      );
      expect((await evaluateBoundEvidence()).decisions).toHaveLength(1);

      // The SOURCE locator must agree with the active raw-source revision.
      await db.pool.query(
        `update evidence
            set locator=jsonb_set(locator,'{source_hash}',to_jsonb($2::text))
          where id=$1`,
        [evidenceId, "b".repeat(64)],
      );
      expect((await evaluateBoundEvidence()).evaluatedFacts).toBe(0);
      await db.pool.query(
        `update evidence
            set locator=jsonb_set(locator,'{source_hash}',to_jsonb($2::text))
          where id=$1`,
        [evidenceId, sourceHash],
      );
      await db.pool.query(
        "update evidence set locator=locator-'source_hash' where id=$1",
        [evidenceId],
      );
      expect((await evaluateBoundEvidence()).evaluatedFacts).toBe(0);
      await db.pool.query(
        `update evidence
            set locator=jsonb_set(locator,'{source_hash}',to_jsonb($2::text))
          where id=$1`,
        [evidenceId, sourceHash],
      );

      // A persisted fragment whose UTF-8 bytes no longer match its digest
      // cannot become a proposition even when its original text can be found.
      await db.pool.query("update evidence set content_hash=$2 where id=$1", [
        evidenceId,
        "b".repeat(64),
      ]);
      const corruptedDigest = await evaluateBoundEvidence();
      expect(corruptedDigest).toMatchObject({
        evaluatedFacts: 1,
        projectedFacts: 0,
        decisions: [],
      });
      await db.pool.query("update evidence set content_hash=$2 where id=$1", [
        evidenceId,
        evidenceHash,
      ]);
      await db.pool.query("update evidence set excerpt=$2 where id=$1", [
        evidenceId,
        excerpt + " tampered",
      ]);
      expect((await evaluateBoundEvidence()).projectedFacts).toBe(0);
      await db.pool.query("update evidence set excerpt=$2 where id=$1", [
        evidenceId,
        excerpt,
      ]);
      expect((await evaluateBoundEvidence()).decisions).toHaveLength(1);

      const missingPolarity = await evaluateGovernedTemporalPropositionShadow(
        db,
        {
          spaceId,
          hit,
          query,
          queryProposition: {
            subject: queryProposition.subject,
            predicate: queryProposition.predicate,
            object: queryProposition.object,
          },
          authorizationPathPrefixes: ["security"],
        },
      );
      expect(missingPolarity.evaluatedFacts).toBe(0);
      const unprovenCondition = await evaluateGovernedTemporalPropositionShadow(
        db,
        {
          spaceId,
          hit,
          query,
          queryProposition: {
            ...queryProposition,
            conditions: ["only during the maintenance window"],
          },
          authorizationPathPrefixes: ["security"],
        },
      );
      expect(unprovenCondition.evaluatedFacts).toBe(0);

      const staleRevision = await evaluateGovernedTemporalPropositionShadow(
        db,
        {
          spaceId,
          hit: { ...hit, revision: "shadow:old" },
          query,
          queryProposition,
          authorizationPathPrefixes: ["security"],
        },
      );
      expect(staleRevision.decisions).toEqual([]);
      expect(staleRevision.evaluatedFacts).toBe(0);

      const differentPath = await evaluateGovernedTemporalPropositionShadow(
        db,
        {
          spaceId,
          hit: {
            ...hit,
            document: { ...hit.document, path: "security/other.md" },
          },
          query,
          queryProposition,
          authorizationPathPrefixes: ["security"],
        },
      );
      expect(differentPath.evaluatedFacts).toBe(0);

      // A token can read the fact authorization path but cannot use a
      // search hit whose actual document falls outside its path scope.
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
