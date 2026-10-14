import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Postgres } from "@akp/postgres";
import {
  scoreS2SpanObservations,
  type S2SpanFixture,
  type S2SpanObservation,
} from "@akp/evaluation";
import { queryKnowledge } from "../src/routes/search.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.AKP_S2_SPAN_BASELINE === "1";
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const datasetPath = path.resolve(
  import.meta.dirname,
  "../../../evals/registered/s2-source-span-holdout.json",
);
const datasetBytes = readFileSync(datasetPath);
const frozenBlobSha1 = "a61a24df46c0351115cd09e079ae0d8383033082";
const dataset = JSON.parse(datasetBytes.toString("utf8")) as S2SpanFixture;

interface Fixture {
  organizationId: string;
  spaceId: string;
  revision: string;
  vaultIds: Map<string, string>;
  unitIds: Map<string, string>;
}
function makeFixture(): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    revision: "s2-source-units-" + randomUUID(),
    vaultIds: new Map(
      dataset.sourceDocuments.map((source) => [source.id, randomUUID()]),
    ),
    unitIds: new Map(
      dataset.sourceDocuments.flatMap((source) =>
        source.units.map((unit) => [unit.id, randomUUID()] as const),
      ),
    ),
  };
}
async function seed(db: Postgres, f: Fixture): Promise<void> {
  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      f.organizationId,
      "s2-baseline-" + f.organizationId.slice(0, 8),
      "Disposable synthetic S2 baseline",
    ],
  );
  await db.pool.query(
    "insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path) " +
      "values($1,$2,$3,'S2 baseline','PRIVATE',$4)",
    [
      f.spaceId,
      f.organizationId,
      "s2-baseline-" + f.spaceId.slice(0, 8),
      "test/s2/" + f.spaceId,
    ],
  );
  for (const source of dataset.sourceDocuments) {
    const vaultId = f.vaultIds.get(source.id)!;
    const documentId = randomUUID();
    const body = source.units.map((unit) => unit.text).join("\n\n");
    const title = "S2 source " + source.domain;
    const sourcePath = "s2/" + source.id + ".md";
    await db.pool.query(
      "insert into vaults(id,space_id,canonical_path,name,read_only," +
        "current_revision,vault_key,local_path,visibility,enabled) " +
        "values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)",
      [
        vaultId,
        f.spaceId,
        "test/s2/" + vaultId,
        title,
        f.revision,
        "s2-" + vaultId.slice(0, 8),
      ],
    );
    await db.pool.query(
      "insert into vault_index_revisions(space_id,vault_id,corpus_revision," +
        "lexical_revision,vector_revision,graph_revision,context_pack_revision," +
        "status,warnings) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)",
      [f.spaceId, vaultId, f.revision],
    );
    await db.pool.query(
      "insert into knowledge_documents(id,space_id,vault_id,path,external_id," +
        "title,type,lifecycle,trust_tier,current_revision,body_cache," +
        "frontmatter,aliases,layer,content_hash,token_estimate,raw_links) " +
        "values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED'," +
        "$7,$8,$9::jsonb,'{}','concept',$10,$11,'[]'::jsonb)",
      [
        documentId,
        f.spaceId,
        vaultId,
        sourcePath,
        source.id,
        title,
        f.revision,
        body,
        JSON.stringify({
          id: source.id,
          title,
          synthetic_approval_for_isolated_fixture: true,
        }),
        digest(body),
        Math.max(1, body.split(/\s+/u).length),
      ],
    );
    for (const [index, unit] of source.units.entries()) {
      await db.pool.query(
        "insert into knowledge_units(id,document_id,space_id,vault_id," +
          "unit_key,unit_type,heading_path,body,content_hash,corpus_revision," +
          "document_revision,lifecycle,trust_tier,source_ids,token_estimate," +
          "parent_unit_id,permissions,locator,structural_order,container_only," +
          "embedding_eligible) values($1,$2,$3,$4,$5,'PARAGRAPH',$6,$7,$8," +
          "$9,$9,'ACTIVE','HUMAN_REVIEWED','{}',$10,null,'{}'::jsonb," +
          "$11::jsonb,$12,false,true)",
        [
          f.unitIds.get(unit.id),
          documentId,
          f.spaceId,
          vaultId,
          unit.id,
          [title],
          unit.text,
          digest(unit.text),
          f.revision,
          Math.max(1, unit.text.split(/\s+/u).length),
          JSON.stringify({ sourcePath, logicalUnitId: unit.id }),
          index + 1,
        ],
      );
    }
  }
}
async function cleanup(db: Postgres, f: Fixture): Promise<void> {
  const vaultIds = [...f.vaultIds.values()];
  await db.pool.query(
    "delete from knowledge_units where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query(
    "delete from knowledge_documents where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query(
    "delete from vault_index_revisions where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    vaultIds,
  ]);
  await db.pool.query("delete from spaces where id=$1", [f.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    f.organizationId,
  ]);
}
describe("S2 frozen holdout on real PostgreSQL retrieval", () => {
  it.skipIf(!databaseUrl || !enabled)(
    "measures scoped exact+lexical source-unit recall without implying admission quality",
    async () => {
      const blob = createHash("sha1")
        .update("blob " + datasetBytes.byteLength + "\0")
        .update(datasetBytes)
        .digest("hex");
      expect(blob).toBe(frozenBlobSha1);
      expect(dataset.sourceDocuments).toHaveLength(4);
      expect(dataset.cases).toHaveLength(48);
      const db = new Postgres(databaseUrl!);
      const f = makeFixture();
      const logicalByUuid = new Map(
        [...f.unitIds].map(([key, value]) => [value, key]),
      );
      const observations: S2SpanObservation[] = [];
      const caseDiagnostics = [];
      const controlDiagnostics: Array<{
        query: string;
        sourceId: string;
        returnedHits: number;
      }> = [];
      try {
        await seed(db, f);
        // A zero-recall result is not interpretable unless the fixture is
        // demonstrably queryable using known positive exact/lexical probes.
        for (const control of [
          { sourceId: "marine-beacon", query: "marine-beacon" },
          { sourceId: "marine-beacon", query: "battery" },
          { sourceId: "optical-observatory", query: "camera" },
        ]) {
          const vaultId = f.vaultIds.get(control.sourceId)!;
          const hits = await queryKnowledge(
            db,
            {
              query: control.query,
              spaceId: f.spaceId,
              vaultId,
              vaultIds: [],
              federated: false,
              types: [],
              minimumTrust: "MACHINE_SUPPORTED",
              mode: "SOURCE_BACKED",
              limit: 10,
            },
            { vaultIds: [vaultId], channels: ["exact", "lexical"] },
          );
          expect(
            hits.length,
            "S2 fixture positive control failed: " + control.query,
          ).toBeGreaterThan(0);
          expect(hits.every((hit) => hit.vaultId === vaultId)).toBe(true);
          controlDiagnostics.push({
            sourceId: control.sourceId,
            query: control.query,
            returnedHits: hits.length,
          });
        }
        for (const q of dataset.cases) {
          const vaultId = f.vaultIds.get(q.sourceId)!;
          const warnings: string[] = [];
          let candidatePoolSize = 0;
          const started = performance.now();
          const hits = await queryKnowledge(
            db,
            {
              query: q.query,
              spaceId: f.spaceId,
              vaultId,
              vaultIds: [],
              federated: false,
              types: [],
              minimumTrust: "MACHINE_SUPPORTED",
              mode: "SOURCE_BACKED",
              limit: 10,
            },
            {
              vaultIds: [vaultId],
              channels: ["exact", "lexical"],
              warningSink: warnings,
              answerabilityCandidateSink: (candidates) => {
                candidatePoolSize = candidates.length;
              },
            },
          );
          const elapsedMs = performance.now() - started;
          expect(hits.every((hit) => hit.vaultId === vaultId)).toBe(true);
          const rankedUnitIds = hits
            .map((hit) => logicalByUuid.get(hit.unitId ?? ""))
            .filter((value): value is string => Boolean(value));
          const goldUnits = new Set(q.gold.map((item) => item.unitId));
          const rank = rankedUnitIds.findIndex((unitId) =>
            goldUnits.has(unitId),
          );
          observations.push({
            caseId: q.id,
            rankedUnitIds,
            admitted: [],
            admissionMeasured: false,
            elapsedMs,
            degraded: warnings.some((warning) =>
              /(?:ERROR|UNAVAILABLE|TIMEOUT|DEGRADED)/u.test(warning),
            ),
          });
          caseDiagnostics.push({
            caseId: q.id,
            sourceId: q.sourceId,
            candidatePoolSize,
            returnedHits: hits.length,
            unmappedHits: hits.length - rankedUnitIds.length,
            firstGoldUnitRank: rank < 0 ? null : rank + 1,
            warnings,
          });
        }
        const score = scoreS2SpanObservations(dataset, observations);
        expect(score.observedCases).toBe(48);
        expect(score.positiveObserved).toBe(24);
        expect(score.negativeObserved).toBe(24);
        expect(score.admissionObservedCases).toBe(0);
        expect(score.falseAdmissionRate).toBeNull();
        expect(score.exactGoldQuoteCoverage).toBeNull();
        expect(score.finalAnswerCorrectRate).toBeNull();
        expect(score.meanExactInputTokens).toBeNull();
        const output = path.resolve(
          import.meta.dirname,
          "../../../reports/ci/s2-postgres-retrieval-baseline.json",
        );
        const report = {
          schemaVersion: "akp.s2.postgres-retrieval-baseline.v1",
          evidenceLevel: "LIVE_POSTGRES_SCOPED_SQL_ON_SYNTHETIC_PROJECTION",
          headGitSha: process.env.AKP_S2_BRANCH_HEAD_SHA ?? "LOCAL_UNPINNED",
          workflowCheckoutGitSha: process.env.GITHUB_SHA ?? "LOCAL_UNPINNED",
          frozenGitBlobSha1: blob,
          sourceSha256: Object.fromEntries(
            dataset.sourceDocuments.map((source) => [
              source.id,
              digest(
                source.units
                  .map((unit) => unit.id + "\n" + unit.text)
                  .join("\n\n"),
              ),
            ]),
          ),
          method: "CONTROLLED_EXACT_LEXICAL_ONLY",
          queryFunction: "apps/api/src/routes/search.ts#queryKnowledge",
          scope: "ONE_FROZEN_SOURCE_VAULT_PER_QUERY",
          fixture: "DIRECT_SYNTHETIC_APPROVED_PROJECTION_NOT_RAW_INGEST",
          independentAdjudication: false,
          semanticAdmissionMeasured: false,
          finalAnswerMeasured: false,
          exactModelTokensMeasured: false,
          gateAccepted: false,
          fixturePositiveControls: controlDiagnostics,
          score,
          caseDiagnostics,
        };
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log(
          "S2_POSTGRES_BASELINE " +
            JSON.stringify({
              observed: score.observedCases,
              recallAt10: score.recallAt10,
              falseAdmissionRate: null,
              gateAccepted: false,
            }),
        );
      } finally {
        try {
          await cleanup(db, f);
        } finally {
          await db.close();
        }
      }
    },
    360_000,
  );
});
