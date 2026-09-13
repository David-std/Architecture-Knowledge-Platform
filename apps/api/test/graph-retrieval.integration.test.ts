import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GraphPathProvenance } from "@akp/contracts";
import { Postgres } from "@akp/postgres";
import { planQuery } from "@akp/retrieval";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;

interface GraphFixture {
  organizationId: string;
  spaceId: string;
  vaultId: string;
  foreignVaultId: string;
  corpusRevision: string;
  documents: Record<string, string>;
}

function graphFixture(): GraphFixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    vaultId: randomUUID(),
    foreignVaultId: randomUUID(),
    corpusRevision: `graph-integration-${randomUUID()}`,
    documents: {
      A: randomUUID(),
      B: randomUUID(),
      C: randomUUID(),
      D: randomUUID(),
      E: randomUUID(),
      S: randomUUID(),
      T: randomUUID(),
      X: randomUUID(),
      Y: randomUUID(),
    },
  };
}

async function seedGraph(db: Postgres, fixture: GraphFixture): Promise<void> {
  await db.pool.query(
    `insert into organizations(id,slug,name)
     values($1,$2,'Graph retrieval integration')`,
    [
      fixture.organizationId,
      `graph-integration-${fixture.organizationId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Graph retrieval space','PRIVATE',$4)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `graph-integration-${fixture.spaceId.slice(0, 8)}`,
      `C:/akp/graph-retrieval/${fixture.spaceId}`,
    ],
  );

  for (const [index, vaultId] of [
    fixture.vaultId,
    fixture.foreignVaultId,
  ].entries()) {
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        `C:/akp/graph-retrieval/${vaultId}`,
        `Graph retrieval vault ${index + 1}`,
        fixture.corpusRevision,
        `graph-integration-${vaultId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `insert into vault_index_revisions(
         space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
         graph_revision,context_pack_revision,status,warnings
       ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
      [fixture.spaceId, vaultId, fixture.corpusRevision],
    );
  }

  const documentMetadata: Array<{
    key: string;
    vaultId: string;
    path: string;
  }> = [
    { key: "A", vaultId: fixture.vaultId, path: "allowed/a.md" },
    { key: "B", vaultId: fixture.vaultId, path: "allowed/b.md" },
    { key: "C", vaultId: fixture.vaultId, path: "allowed/c.md" },
    { key: "D", vaultId: fixture.vaultId, path: "allowed/d.md" },
    { key: "E", vaultId: fixture.vaultId, path: "allowed/e.md" },
    { key: "S", vaultId: fixture.vaultId, path: "private/s.md" },
    { key: "T", vaultId: fixture.vaultId, path: "allowed/t.md" },
    { key: "X", vaultId: fixture.foreignVaultId, path: "allowed/x.md" },
    { key: "Y", vaultId: fixture.foreignVaultId, path: "allowed/y.md" },
  ];
  for (const document of documentMetadata) {
    const externalId = `GRAPH-${document.key}`;
    const body = `Graph integration node ${externalId}`;
    const contentHash = createHash("sha256").update(body).digest("hex");
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,
         trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
         content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',
                $7,$8,$9::jsonb,'{}','concept',$10,$11,'[]'::jsonb)`,
      [
        fixture.documents[document.key],
        fixture.spaceId,
        document.vaultId,
        document.path,
        externalId,
        `Graph node ${document.key}`,
        fixture.corpusRevision,
        body,
        JSON.stringify({ id: externalId, title: `Graph node ${document.key}` }),
        contentHash,
        body.split(/\s+/u).length,
      ],
    );
  }

  const relations: Array<[string, string, string, number]> = [
    ["A", "B", "requires", 1],
    ["B", "C", "validated_by", 1],
    ["C", "D", "requires", 1],
    ["C", "A", "related_to", 1],
    ["A", "E", "requires", 0.1],
    ["E", "D", "supports", 1],
    ["A", "S", "requires", 1],
    ["S", "T", "requires", 1],
    ["A", "X", "requires", 1],
    ["X", "Y", "requires", 1],
  ];
  for (const [from, to, relationType, weight] of relations) {
    await db.pool.query(
      `insert into knowledge_relations(
         space_id,from_document_id,to_document_id,relation_type,weight,provenance
       ) values($1,$2,$3,$4,$5,'graph-retrieval-integration')`,
      [
        fixture.spaceId,
        fixture.documents[from],
        fixture.documents[to],
        relationType,
        weight,
      ],
    );
  }
}

async function cleanupGraph(
  db: Postgres,
  fixture: GraphFixture,
): Promise<void> {
  const vaultIds = [fixture.vaultId, fixture.foreignVaultId];
  await db.pool.query("delete from knowledge_relations where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_documents where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query(
    "delete from vault_index_revisions where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    vaultIds,
  ]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

function searchRequest(fixture: GraphFixture) {
  return {
    query: "GRAPH-A",
    spaceId: fixture.spaceId,
    vaultId: fixture.vaultId,
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED" as const,
    mode: "SOURCE_BACKED" as const,
    limit: 20,
  };
}

describe("recursive graph retrieval PostgreSQL integration", () => {
  it.skipIf(!databaseUrl)(
    "enforces hops, relation policy, cycle/vault/path scope, and provenance",
    async () => {
      if (!databaseUrl) return;
      const fixture = graphFixture();
      const db = new Postgres(databaseUrl);
      try {
        await seedGraph(db, fixture);

        const threeHop = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          plan: planQuery("GRAPH-A", "IMPACT_ANALYSIS", {
            graphConsistent: true,
          }),
          graphPolicy: { directionPolicy: "outgoing" },
          graphScopes: [{ vaultId: fixture.vaultId, pathPrefix: null }],
        });
        const threeHopD = threeHop.find(
          (hit) => hit.documentId === fixture.documents.D,
        );
        expect(threeHopD).toBeDefined();
        expect(threeHopD?.reasons).toContain("graph:bounded-path");
        expect(threeHopD?.graphProvenance?.[0]).toMatchObject({
          channel: "graph",
          seedDocumentId: fixture.documents.A,
          targetDocumentId: fixture.documents.D,
          hops: 3,
        });
        expect(
          GraphPathProvenance.safeParse(threeHopD?.graphProvenance?.[0])
            .success,
        ).toBe(true);
        expect(
          threeHopD?.graphProvenance?.[0]?.path.map((node) => node.document),
        ).toEqual(["GRAPH-A", "GRAPH-B", "GRAPH-C", "GRAPH-D"]);
        expect(threeHopD?.graphProvenance?.[0]?.path).toEqual([
          expect.objectContaining({
            documentId: fixture.documents.A,
            relation: "requires",
            direction: "outgoing",
          }),
          expect.objectContaining({
            documentId: fixture.documents.B,
            relation: "validated_by",
            direction: "outgoing",
          }),
          expect.objectContaining({
            documentId: fixture.documents.C,
            relation: "requires",
            direction: "outgoing",
          }),
          expect.objectContaining({ documentId: fixture.documents.D }),
        ]);
        expect(threeHopD?.graphProvenance?.[0]?.graphScore).toBeCloseTo(
          0.015625,
        );
        expect(threeHopD?.graphProvenance).toHaveLength(2);

        const weighted = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: {
            maxHops: 3,
            directionPolicy: "outgoing",
            relationWeights: { supports: 2 },
          },
        });
        const weightedD = weighted.find(
          (hit) => hit.documentId === fixture.documents.D,
        );
        expect(
          weightedD?.graphProvenance?.[0]?.path.map((node) => node.document),
        ).toEqual(["GRAPH-A", "GRAPH-E", "GRAPH-D"]);
        expect(weightedD?.graphProvenance?.[0]?.graphScore).toBeCloseTo(0.025);

        const noDecay = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: {
            maxHops: 3,
            decay: 1,
            directionPolicy: "outgoing",
          },
        });
        expect(
          noDecay.find((hit) => hit.documentId === fixture.documents.D)
            ?.graphProvenance?.[0]?.graphScore,
        ).toBeCloseTo(1);

        const onePath = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: {
            maxHops: 3,
            maxPathsPerCandidate: 1,
            directionPolicy: "outgoing",
          },
        });
        expect(
          onePath.find((hit) => hit.documentId === fixture.documents.D)
            ?.graphProvenance,
        ).toHaveLength(1);

        const oneCandidate = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: {
            maxHops: 3,
            maxCandidates: 1,
            directionPolicy: "outgoing",
          },
        });
        expect(
          oneCandidate.filter((hit) => (hit.graphProvenance?.length ?? 0) > 0),
        ).toHaveLength(1);

        const oneHop = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: { maxHops: 1, directionPolicy: "outgoing" },
        });
        expect(oneHop.map((hit) => hit.documentId)).toContain(
          fixture.documents.B,
        );
        expect(oneHop.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.D,
        );

        const incoming = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "GRAPH-D" },
          {
            vaultIds: [fixture.vaultId],
            channels: ["exact", "graph"],
            graphPolicy: { maxHops: 3, directionPolicy: "incoming" },
          },
        );
        expect(incoming.map((hit) => hit.documentId)).toContain(
          fixture.documents.A,
        );
        const outgoingFromD = await queryKnowledge(
          db,
          { ...searchRequest(fixture), query: "GRAPH-D" },
          {
            vaultIds: [fixture.vaultId],
            channels: ["exact", "graph"],
            graphPolicy: { maxHops: 3, directionPolicy: "outgoing" },
          },
        );
        expect(outgoingFromD.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.A,
        );

        const forbiddenType = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: {
            maxHops: 3,
            allowedRelationTypes: ["requires"],
            directionPolicy: "outgoing",
          },
        });
        expect(forbiddenType.map((hit) => hit.documentId)).toContain(
          fixture.documents.B,
        );
        expect(forbiddenType.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.C,
        );
        expect(forbiddenType.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.D,
        );

        await db.pool.query(
          "update knowledge_documents set refresh_status='STALE_BLOCKED' where id=$1",
          [fixture.documents.B],
        );
        try {
          const staleBridge = await queryKnowledge(db, searchRequest(fixture), {
            vaultIds: [fixture.vaultId],
            channels: ["exact", "graph"],
            graphPolicy: {
              maxHops: 3,
              allowedRelationTypes: ["requires", "validated_by"],
              directionPolicy: "outgoing",
            },
          });
          expect(staleBridge.map((hit) => hit.documentId)).not.toContain(
            fixture.documents.C,
          );
          expect(staleBridge.map((hit) => hit.documentId)).not.toContain(
            fixture.documents.D,
          );
        } finally {
          await db.pool.query(
            "update knowledge_documents set refresh_status='CURRENT' where id=$1",
            [fixture.documents.B],
          );
        }

        await db.pool.query(
          "update knowledge_documents set lifecycle='ARCHIVED' where id=$1",
          [fixture.documents.B],
        );
        try {
          const archivedBridge = await queryKnowledge(
            db,
            searchRequest(fixture),
            {
              vaultIds: [fixture.vaultId],
              channels: ["exact", "graph"],
              graphPolicy: {
                maxHops: 3,
                allowedRelationTypes: ["requires", "validated_by"],
                directionPolicy: "outgoing",
              },
            },
          );
          expect(archivedBridge.map((hit) => hit.documentId)).not.toContain(
            fixture.documents.C,
          );
          expect(archivedBridge.map((hit) => hit.documentId)).not.toContain(
            fixture.documents.D,
          );
        } finally {
          await db.pool.query(
            "update knowledge_documents set lifecycle='ACTIVE' where id=$1",
            [fixture.documents.B],
          );
        }

        const cycle = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: {
            maxHops: 5,
            maxPathsPerCandidate: 10,
            directionPolicy: "outgoing",
          },
        });
        const cyclePaths = cycle
          .flatMap((hit) => hit.graphProvenance ?? [])
          .flatMap((provenance) =>
            provenance.path.map((node) => node.documentId),
          );
        expect(cyclePaths.length).toBeGreaterThan(0);
        for (const provenance of cycle.flatMap(
          (hit) => hit.graphProvenance ?? [],
        )) {
          const nodeIds = provenance.path.map((node) => node.documentId);
          expect(new Set(nodeIds).size).toBe(nodeIds.length);
          expect(provenance.hops).toBeLessThanOrEqual(3);
        }

        const { vaultId: _seedVaultId, ...federatedBaseRequest } =
          searchRequest(fixture);
        const federated = await queryKnowledge(
          db,
          {
            ...federatedBaseRequest,
            vaultIds: [fixture.vaultId, fixture.foreignVaultId],
            federated: true,
          },
          {
            vaultIds: [fixture.vaultId, fixture.foreignVaultId],
            channels: ["exact", "graph"],
            graphPolicy: { maxHops: 3, directionPolicy: "outgoing" },
            graphScopes: [
              { vaultId: fixture.vaultId, pathPrefix: null },
              { vaultId: fixture.foreignVaultId, pathPrefix: null },
            ],
          },
        );
        expect(federated.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.X,
        );
        expect(federated.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.Y,
        );

        const scoped = await queryKnowledge(db, searchRequest(fixture), {
          vaultIds: [fixture.vaultId],
          channels: ["exact", "graph"],
          graphPolicy: { maxHops: 3, directionPolicy: "outgoing" },
          graphScopes: [
            { vaultId: fixture.vaultId, pathPrefix: null },
            { vaultId: fixture.vaultId, pathPrefix: "allowed" },
          ],
        });
        expect(scoped.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.S,
        );
        expect(scoped.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.T,
        );

        const malformedScope = await queryKnowledge(
          db,
          searchRequest(fixture),
          {
            vaultIds: [fixture.vaultId],
            channels: ["exact", "graph"],
            graphPolicy: { maxHops: 3, directionPolicy: "outgoing" },
            graphScopes: [
              { vaultId: fixture.vaultId, pathPrefix: "../outside" },
            ],
          },
        );
        expect(
          malformedScope.some((hit) => (hit.graphProvenance?.length ?? 0) > 0),
        ).toBe(false);

        const callbackScoped = await queryKnowledge(
          db,
          searchRequest(fixture),
          {
            vaultIds: [fixture.vaultId],
            channels: ["exact", "graph"],
            graphPolicy: { maxHops: 3, directionPolicy: "outgoing" },
            graphScopes: [{ vaultId: fixture.vaultId, pathPrefix: null }],
            pathAuthorizer: (path, vaultId) =>
              vaultId === fixture.vaultId && path.startsWith("allowed/"),
          },
        );
        expect(callbackScoped.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.S,
        );
        expect(callbackScoped.map((hit) => hit.documentId)).not.toContain(
          fixture.documents.T,
        );
        expect(
          callbackScoped
            .flatMap((hit) => hit.graphProvenance ?? [])
            .every((route) =>
              route.path.every((node) => node.document !== "GRAPH-S"),
            ),
        ).toBe(true);

        const callbackWithoutSqlScope = await queryKnowledge(
          db,
          searchRequest(fixture),
          {
            vaultIds: [fixture.vaultId],
            channels: ["exact", "graph"],
            graphPolicy: { maxHops: 3, directionPolicy: "outgoing" },
            pathAuthorizer: (path, vaultId) =>
              vaultId === fixture.vaultId && path.startsWith("allowed/"),
          },
        );
        expect(
          callbackWithoutSqlScope.some(
            (hit) => (hit.graphProvenance?.length ?? 0) > 0,
          ),
        ).toBe(false);
      } finally {
        await cleanupGraph(db, fixture).catch(() => undefined);
        await db.close();
      }
    },
  );
});
