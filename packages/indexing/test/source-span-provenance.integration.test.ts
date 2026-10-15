import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres } from "@akp/postgres";
import { incrementalIndex } from "../src/index.js";

const databaseUrl = process.env.AKP_SOURCE_SPAN_DATABASE_URL;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeProjection(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
}

describe("persisted Markdown source-span provenance", () => {
  it.skipIf(!databaseUrl)(
    "keeps raw body_cache spans and frame metadata through indexing",
    async () => {
      if (!databaseUrl) return;
      const db = new Postgres(databaseUrl);
      const repositoryPath = await mkdtemp(
        path.join(os.tmpdir(), "akp-source-span-"),
      );
      const store = new GitKnowledgeStore(repositoryPath);
      const organizationId = randomUUID();
      const spaceId = randomUUID();
      const vaultId = randomUUID();
      const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
      process.env.AKP_VECTOR_ENABLED = "false";
      try {
        await db.pool.query(
          `insert into organizations(id,slug,name) values($1,$2,$3)`,
          [
            organizationId,
            `idx-span-${organizationId.slice(0, 8)}`,
            "Source span integration",
          ],
        );
        await db.pool.query(
          `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
           values($1,$2,$3,$4,'PRIVATE',$5)`,
          [
            spaceId,
            organizationId,
            `idx-span-${spaceId.slice(0, 8)}`,
            "Source span integration space",
            repositoryPath,
          ],
        );
        await db.pool.query(
          `insert into vaults(
             id,space_id,canonical_path,name,read_only,current_revision,
             vault_key,local_path
           ) values($1,$2,$3,$4,true,$5,$6,$3)`,
          [
            vaultId,
            spaceId,
            repositoryPath,
            "Source span integration vault",
            "r0",
            `idx-span-${vaultId.slice(0, 8)}`,
          ],
        );

        const rawBody = [
          "\r\n  Visible before <!-- hidden detail --> visible after\r\n",
          "\r\n📚 Source\r\n\r\n",
          "| Name | Value | Empty |\r\n",
          "| --- | --- | --- |\r\n",
          "| repeated | A\\|B | |\r\n",
          "| repeated | A\\|B | actual |\r\n",
          "\r\n  ",
        ].join("");
        await db.pool.query(
          `insert into knowledge_documents(
             id,space_id,vault_id,path,external_id,title,type,lifecycle,
             trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
             content_hash,token_estimate,raw_links
           ) values($1,$2,$3,$4,$5,$6,$7,'ACTIVE','HUMAN_REVIEWED',$8,$9,$10::jsonb,
                    $11,$12,$13,$14,$15::jsonb)`,
          [
            randomUUID(),
            spaceId,
            vaultId,
            "managed/source-spans.md",
            "IDX-SOURCE-SPANS",
            "Source spans",
            "evidence",
            "r0",
            rawBody,
            JSON.stringify({}),
            [],
            "source",
            sha256(rawBody),
            Math.ceil(rawBody.length / 4),
            JSON.stringify([]),
          ],
        );

        // No managed path changes are needed: the full structural projection
        // reads the raw body_cache row seeded above and persists its locators.
        const result = await incrementalIndex(db, store, {
          spaceId,
          vaultId,
          revision: "r0",
          changes: [],
        });
        const persisted = await db.pool.query<{
          body_cache: string;
          unit_type: string;
          unit_key: string;
          body: string;
          content_hash: string;
          locator: {
            lineFrame: string;
            startChar: number;
            endChar: number;
            sourceFrame: string;
            sourceEncoding: string;
            sourceBodyHash: string;
            sourceTextProjection: string;
            sourceTextMasked: boolean;
            sourceStartLine: number;
            sourceEndLine: number;
            row?: number;
            column?: number;
          };
        }>(
          `select d.body_cache,u.unit_type,u.unit_key,u.body,u.content_hash,u.locator
             from knowledge_units u
             join knowledge_documents d on d.id=u.document_id
            where u.space_id=$1 and u.vault_id=$2
              and u.corpus_revision=$3
              and d.external_id='IDX-SOURCE-SPANS'
            order by u.structural_order,u.id`,
          [spaceId, vaultId, result.corpusRevision],
        );
        const bodyCache = persisted.rows[0]?.body_cache;
        expect(bodyCache).toBeDefined();
        expect(bodyCache).toContain("\r\n");
        const table = persisted.rows.find((row) => row.unit_type === "TABLE");
        const tableRows = persisted.rows.filter(
          (row) => row.unit_type === "TABLE_ROW",
        );
        const tableCells = persisted.rows.filter(
          (row) => row.unit_type === "TABLE_CELL",
        );
        const masked = persisted.rows.find(
          (row) => row.locator.sourceTextMasked,
        );
        expect(table).toBeDefined();
        expect(tableRows).toHaveLength(2);
        expect(tableCells).toHaveLength(5);
        expect(masked).toBeDefined();

        const sourceBodyHash = sha256(bodyCache!);
        for (const row of persisted.rows) {
          expect(row.locator.lineFrame).toBe("normalized-lf-trim-v1");
          expect(row.locator.sourceFrame).toBe("markdown-body-cache-raw-v1");
          expect(row.locator.sourceEncoding).toBe("utf-16-code-units");
          expect(row.locator.sourceBodyHash).toBe(sourceBodyHash);
          expect(row.locator.sourceTextProjection).toBe(
            "visible-markdown-lf-trim-v1",
          );
          expect(row.locator.endChar).toBeGreaterThanOrEqual(
            row.locator.startChar,
          );
          expect(row.locator.sourceStartLine).toBeGreaterThanOrEqual(1);
          expect(row.locator.sourceEndLine).toBeGreaterThanOrEqual(
            row.locator.sourceStartLine,
          );
        }

        const tableRaw = bodyCache!.slice(
          table!.locator.startChar,
          table!.locator.endChar,
        );
        expect(tableRaw).toContain("\r\n");
        expect(normalizeProjection(tableRaw)).toBe(table!.body);
        expect(tableRaw).not.toBe(table!.body);

        const expectedRows = [
          "| repeated | A\\|B | |",
          "| repeated | A\\|B | actual |",
        ];
        for (const [index, row] of tableRows.entries()) {
          expect(
            bodyCache!.slice(row.locator.startChar, row.locator.endChar),
          ).toBe(expectedRows[index]);
        }
        const expectedCells = new Map([
          ["1:1", "repeated"],
          ["1:2", "A\\|B"],
          ["2:1", "repeated"],
          ["2:2", "A\\|B"],
          ["2:3", "actual"],
        ]);
        for (const cell of tableCells) {
          const expected = expectedCells.get(
            `${cell.locator.row}:${cell.locator.column}`,
          );
          expect(expected).toBeDefined();
          expect(
            bodyCache!.slice(cell.locator.startChar, cell.locator.endChar),
          ).toBe(expected);
        }

        const maskedRaw = bodyCache!.slice(
          masked!.locator.startChar,
          masked!.locator.endChar,
        );
        expect(maskedRaw).toContain("<!-- hidden detail -->");
        expect(maskedRaw).not.toBe(masked!.body);
        expect(masked!.locator.sourceTextMasked).toBe(true);
      } finally {
        if (previousVectorEnabled === undefined) {
          delete process.env.AKP_VECTOR_ENABLED;
        } else {
          process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
        }
        await db.pool.end();
        await rm(repositoryPath, { recursive: true, force: true });
      }
    },
  );
});
