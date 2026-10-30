import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import { parseKnowledgeUnits } from "@akp/retrieval";
import type { SearchHit } from "@akp/contracts";
import { resolveSectionCandidatesShadow } from "../src/section-candidate-shadow.js";

const databaseUrl = process.env.DATABASE_URL;

describe("SECTION parent source binding against PostgreSQL", () => {
  it.skipIf(!databaseUrl)(
    "keeps exact parent identity and refuses stale revisions, path denials and tampered source bytes",
    async () => {
      const db = new Postgres(databaseUrl!);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const documentId = randomUUID();
      const parentId = randomUUID();
      const childId = randomUUID();
      const revision = `section-shadow-${randomUUID()}`;
      const path = `managed/section-shadow-${documentId}.md`;
      const raw =
        "# Operational policy\r\n\r\nEvery change requires review.\r\n\r\nPublication requires human approval.";
      const units = parseKnowledgeUnits("Operational policy", raw);
      const section = units.find((unit) => unit.unitType === "SECTION");
      const child = units.find(
        (unit) => unit.parentUnitKey === section?.unitKey,
      );
      expect(section).toBeDefined();
      expect(child).toBeDefined();

      const query = async (sql: string, params: unknown[]) =>
        db.pool.query(sql, params);

      try {
        await query(
          "insert into organizations(id,slug,name) values($1,$2,'SECTION Shadow')",
          [organizationId, `section-${organizationId}`],
        );
        await query(
          `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
            values($1,$2,$3,'SECTION Shadow','PRIVATE',$4)`,
          [
            spaceId,
            organizationId,
            `section-${spaceId}`,
            `C:/akp/section-shadow/${spaceId}`,
          ],
        );
        await query(
          `insert into vaults(id,space_id,canonical_path,name,read_only,
             current_revision,vault_key,local_path,visibility,enabled)
           values($1,$2,$3,'SECTION Shadow',true,$4,$5,$3,'PRIVATE',true)`,
          [
            vaultId,
            spaceId,
            `C:/akp/section-shadow/${vaultId}`,
            revision,
            `section-${vaultId}`,
          ],
        );
        await query(
          `insert into knowledge_documents(
             id,space_id,vault_id,path,external_id,title,type,lifecycle,
             trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
             content_hash,token_estimate,raw_links
           ) values($1,$2,$3,$4,$5,'Operational policy','rule','ACTIVE',
             'HUMAN_REVIEWED',$6,$7,'{}'::jsonb,'{}','concept',$8,50,'[]'::jsonb)`,
          [
            documentId,
            spaceId,
            vaultId,
            path,
            `SECTION-${documentId}`,
            revision,
            raw,
            "a".repeat(64),
          ],
        );
        for (const [id, unit, parentUnitId] of [
          [parentId, section!, null],
          [childId, child!, parentId],
        ] as const) {
          await query(
            `insert into knowledge_units(
               id,document_id,space_id,vault_id,unit_key,unit_type,
               heading_path,body,content_hash,corpus_revision,lifecycle,
               trust_tier,source_ids,token_estimate,parent_unit_id,
               document_revision,permissions,locator,structural_order,
               container_only,embedding_eligible
             ) values(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE','HUMAN_REVIEWED',
               '{}',$11,$12,$10,'{}'::jsonb,$13::jsonb,$14,$15,$16)`,
            [
              id,
              documentId,
              spaceId,
              vaultId,
              unit.unitKey,
              unit.unitType,
              unit.headingPath,
              unit.body,
              unit.contentHash,
              revision,
              unit.tokenEstimate,
              parentUnitId,
              JSON.stringify(unit.locator),
              unit.structuralOrder,
              unit.containerOnly,
              unit.embeddingEligible,
            ],
          );
        }
        const hit: SearchHit = {
          documentId,
          vaultId,
          unitId: childId,
          unitType: child!.unitType,
          parentUnitId: parentId,
          parentUnitType: "SECTION",
          document: { externalId: null, path, title: "Operational policy" },
          revision,
          title: "Operational policy",
          type: "rule",
          trust: "HUMAN_REVIEWED",
          lifecycle: "ACTIVE",
          refreshStatus: "CURRENT",
          score: 1,
          reasons: [],
          excerpt: child!.body,
          citations: [],
        };
        const scope = {
          spaceId,
          vaultIds: [vaultId],
          authorizedChildHits: [hit],
          pathAuthorizer: (candidatePath: string, targetVault: string) =>
            candidatePath === path && targetVault === vaultId,
          sourceReadAuthorizer: () => true,
        };

        const valid = await resolveSectionCandidatesShadow(db, scope);
        expect(valid).toHaveLength(1);
        expect(valid[0]?.sectionUnitId).toBe(parentId);
        expect(valid[0]?.body).toBe(section!.body);
        expect(valid[0]?.sourceStartUtf16).toBe(section!.locator.startChar);
        expect(valid[0]?.sourceEndUtf16).toBe(section!.locator.endChar);
        expect(
          await resolveSectionCandidatesShadow(db, {
            ...scope,
            pathAuthorizer: () => false,
          }),
        ).toEqual([]);

        await query(
          "update knowledge_documents set body_cache=$2 where id=$1",
          [documentId, raw + "\r\nFalsified footer"],
        );
        expect(await resolveSectionCandidatesShadow(db, scope)).toEqual([]);
        await query(
          "update knowledge_documents set body_cache=$2,current_revision=$3 where id=$1",
          [documentId, raw, `stale-${revision}`],
        );
        expect(await resolveSectionCandidatesShadow(db, scope)).toEqual([]);
      } finally {
        await query("delete from knowledge_units where document_id=$1", [
          documentId,
        ]).catch(() => undefined);
        await query("delete from knowledge_documents where id=$1", [
          documentId,
        ]).catch(() => undefined);
        await query("delete from vaults where id=$1", [vaultId]).catch(
          () => undefined,
        );
        await query("delete from spaces where id=$1", [spaceId]).catch(
          () => undefined,
        );
        await query("delete from organizations where id=$1", [
          organizationId,
        ]).catch(() => undefined);
        await db.close();
      }
    },
  );
});
