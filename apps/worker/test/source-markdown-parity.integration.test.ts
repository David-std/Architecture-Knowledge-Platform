import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deriveKnowledgePath,
  type ConfiguredKnowledgeCompiler,
  type KnowledgeCompilerRouteCandidate,
} from "@akp/compiler";
import { DocumentArtifact, ModelRolePolicy } from "@akp/contracts";
import { Postgres, registerVault } from "@akp/postgres";
import { buildCompilationStage } from "../src/compilation-stage.js";
import {
  buildFaithfulSourceMarkdown,
  canonicalJson,
  DOCUMENT_ARTIFACT_SCHEMA_VERSION,
  documentArtifactConfigurationHash,
  renderDocumentArtifactPreview,
} from "../src/document-artifact.js";
import { selectEvidenceFragment } from "../src/evidence-fragment.js";
import { backfillHistoricalSourceProjection } from "../src/source-projection-backfill.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SPACE_ID = "00000000-0000-0000-0000-000000000003";
const OWNER_ID = "00000000-0000-0000-0000-000000000002";
const integration = describe.skipIf(!DATABASE_URL);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * A real persisted source/artifact/evidence identity drives both compiler
 * modes. Only the semantic provider is mocked; all database reads and
 * compilation-plan validation execute against PostgreSQL.
 */
integration("S1 faithful source projection compiler parity", () => {
  it("preserves full source bytes, table locators and approval boundaries with compiler OFF/ON", async () => {
    const db = new Postgres(DATABASE_URL!);
    let sourceId: string | undefined;
    try {
      const vault = await registerVault(
        db,
        {
          vaultKey: "s1-parity-" + randomUUID().slice(0, 12),
          name: "S1 parity disposable vault",
          spaceId: SPACE_ID,
          gitRepository: null,
          defaultBranch: "main",
          localPath: "/tmp/akp-s1-parity",
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
          visibility: "PRIVATE",
          enabled: true,
        },
        { ownerUserId: OWNER_ID },
      );

      const original = "S1 parity raw fixture " + randomUUID();
      const rawHash = sha256(original);
      const source = await db.pool.query<{ id: string }>(
        "insert into sources(space_id,vault_id,title,source_uri,media_type,sha256,byte_size,object_key,status,model_residency) values($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE','LOCAL_ONLY') returning id",
        [
          SPACE_ID,
          vault.id,
          "Immutable policy table",
          "source://s1-parity/" + rawHash,
          "text/markdown",
          rawHash,
          Buffer.byteLength(original, "utf8"),
          "sha256/" + rawHash,
        ],
      );
      sourceId = source.rows[0]?.id;
      if (!sourceId) throw new Error("PARITY_SOURCE_INSERT_FAILED");

      const sourcePath = "source:" + sourceId;
      const paragraphLocator = {
        kind: "paragraph" as const,
        source_hash: rawHash,
        path: sourcePath,
        page: 1,
        paragraph: 1,
        heading_path: ["Operations"],
      };
      const tableLocator = {
        kind: "table" as const,
        source_hash: rawHash,
        path: sourcePath,
        page: 2,
        table: 1,
        heading_path: ["Operations"],
      };
      const lateLocator = {
        kind: "paragraph" as const,
        source_hash: rawHash,
        path: sourcePath,
        page: 2,
        paragraph: 2,
        heading_path: ["Operations"],
      };
      const paragraph = {
        id: "p-1",
        kind: "paragraph" as const,
        text: "Invalidate cached material after the source revision changes.",
        locator: paragraphLocator,
      };
      const table = {
        id: "t-1",
        kind: "table" as const,
        rows: [
          ["mode", "local"],
          ["recovery", "47 minutes"],
        ],
        locator: tableLocator,
      };
      const lateParagraph = {
        id: "p-2",
        kind: "paragraph" as const,
        text:
          "Full-length extracted material. ".repeat(480) +
          "The complete recovery time is 47 minutes.",
        locator: lateLocator,
      };
      const artifact = DocumentArtifact.parse({
        source_id: sourceId,
        source_hash: rawHash,
        media_type: "text/markdown",
        extractor: "fixture-deterministic",
        extractor_version: "1",
        configuration: {},
        blocks: [paragraph, table, lateParagraph],
        paragraphs: [paragraph, lateParagraph],
        tables: [table],
        reading_order: ["p-1", "t-1", "p-2"],
        locators: [paragraphLocator, tableLocator, lateLocator],
        quality: "DETERMINISTIC",
      });
      const markdown = buildFaithfulSourceMarkdown(artifact);
      expect(renderDocumentArtifactPreview(artifact, 1_200).truncated).toBe(
        true,
      );
      expect(markdown.content).toContain(
        "The complete recovery time is 47 minutes.",
      );
      expect(markdown.content).toContain("| recovery | 47 minutes |");
      expect(markdown.content).toContain("page=2");

      const structuredHash = sha256(canonicalJson(artifact));
      const stored = await db.pool.query<{ id: string }>(
        "insert into source_artifacts(source_id,kind,object_key,source_hash,extractor,extractor_version,quality,metadata,document_artifact,artifact_schema_version,configuration_hash,structured_content_hash) values($1,'document-artifact',$2,$3,$4,$5,$6,'{}'::jsonb,$7::jsonb,$8,$9,$10) returning id",
        [
          sourceId,
          "sha256/" + rawHash,
          rawHash,
          "fixture-deterministic",
          "1",
          "DETERMINISTIC",
          JSON.stringify(artifact),
          DOCUMENT_ARTIFACT_SCHEMA_VERSION,
          documentArtifactConfigurationHash({}),
          structuredHash,
        ],
      );
      const artifactId = stored.rows[0]?.id;
      if (!artifactId) throw new Error("PARITY_ARTIFACT_INSERT_FAILED");
      const target = {
        spaceId: SPACE_ID,
        vaultId: vault.id,
        sourceId,
        sourceArtifactId: artifactId,
        sourceSha256: rawHash,
      };
      await expect(
        backfillHistoricalSourceProjection(db, {
          ...target,
          sourceSha256: "b".repeat(64),
        }, true),
      ).rejects.toThrow("SOURCE_PROJECTION_BACKFILL_TARGET_NOT_FOUND");
      const dryRun = await backfillHistoricalSourceProjection(db, target);
      expect(dryRun).toMatchObject({
        status: "DRY_RUN",
        sourceArtifactId: artifactId,
        markdownSha256: markdown.sha256,
        rendererVersion: "1.0",
      });
      const beforeApply = await db.pool.query<{
        source_markdown: string | null;
      }>(
        "select source_markdown from source_artifacts where id=$1",
        [artifactId],
      );
      expect(beforeApply.rows[0]?.source_markdown).toBeNull();
      const applied = await backfillHistoricalSourceProjection(db, target, true);
      expect(applied.status).toBe("MATERIALIZED");
      expect(applied.markdownSha256).toBe(markdown.sha256);
      const repeated = await backfillHistoricalSourceProjection(
        db,
        target,
        true,
      );
      expect(repeated.status).toBe("ALREADY_MATERIALIZED");
      expect(repeated.markdownSha256).toBe(markdown.sha256);

      const fragment = selectEvidenceFragment(artifact, markdown.content);
      const evidence = await db.pool.query<{ id: string }>(
        "insert into evidence(space_id,vault_id,source_id,artifact_id,locator,content_hash,excerpt,review_status) values($1,$2,$3,$4,$5::jsonb,$6,$7,'MACHINE_EXTRACTED') returning id",
        [
          SPACE_ID,
          vault.id,
          sourceId,
          artifactId,
          JSON.stringify(fragment.locator),
          fragment.excerptHash,
          fragment.excerpt,
        ],
      );
      const evidenceId = evidence.rows[0]?.id;
      if (!evidenceId) throw new Error("PARITY_EVIDENCE_INSERT_FAILED");

      const persisted = await db.pool.query<{
        source_hash: string;
        document_artifact: unknown;
        source_markdown: string;
        source_markdown_hash: string;
        source_markdown_renderer_version: string;
      }>(
        "select source_hash,document_artifact,source_markdown,source_markdown_hash,source_markdown_renderer_version from source_artifacts where id=$1",
        [artifactId],
      );
      const row = persisted.rows[0];
      if (!row) throw new Error("PARITY_PROJECTION_NOT_PERSISTED");
      const persistedArtifact = DocumentArtifact.parse(row.document_artifact);
      const input = {
        spaceId: SPACE_ID,
        vaultId: vault.id,
        sourceId,
        sourceArtifactId: artifactId,
        evidenceId,
        sha256: row.source_hash,
        title: "Immutable policy table",
        mediaType: "text/markdown",
        extractor: "fixture-deterministic",
        extractorVersion: "1",
        artifact: persistedArtifact,
        sourceMarkdown: {
          content: row.source_markdown,
          sha256: row.source_markdown_hash,
          rendererVersion: row.source_markdown_renderer_version,
        },
        vectorEnabled: false,
      };
      const off = await buildCompilationStage(db, input, null);
      const statement =
        "Invalidate cached material after the source revision changes.";
      const compile = vi.fn(async (_input: unknown) => ({
        identity: {
          classification: "DISTINCT" as const,
          candidates: [],
          reason: "Separate candidate requiring a human review.",
        },
        evidenceCandidates: [
          {
            sourceArtifactId: artifactId,
            locator: fragment.locator,
            excerptHash: fragment.excerptHash,
          },
        ],
        knowledgeCandidates: [
          {
            candidateId: "candidate-parity",
            kind: "rule" as const,
            statement,
            scope: "Immutable source revision policy.",
            evidenceIds: [evidenceId],
            confidence: 0.9,
            proposedAction: "CREATE" as const,
          },
        ],
        contradictions: [],
        proposedFileChanges: [
          {
            candidateId: "candidate-parity",
            path: deriveKnowledgePath({ title: statement, kind: "rule" }),
            operation: "CREATE" as const,
            content:
              "---\nid: S1-PARITY\ntype: rule\nstatus: draft\n---\n\n" +
              statement +
              "\n",
            reasons: ["Grounded only in the source evidence."],
            evidenceIds: [evidenceId],
          },
        ],
        impactedDocumentIds: [],
        probes: [
          {
            question: "Is this candidate supported by immutable evidence?",
            criticality: "CRITICAL" as const,
            evidenceIds: [evidenceId],
          },
        ],
        warnings: [],
        summary: "Proposed rule pending human review.",
      }));
      const descriptor = {
        role: "KNOWLEDGE_COMPILE" as const,
        provider: "openai-compatible" as const,
        model: "local-parity-fixture",
        endpointRef: "local-test-fixture",
        policyDataResidency: "LOCAL_ONLY" as const,
        dataResidency: "LOCAL_ONLY" as const,
        configurationHash: "f".repeat(64),
      };
      const configured = {
        compiler: { compile },
        descriptor,
      } satisfies ConfiguredKnowledgeCompiler;
      const candidate: KnowledgeCompilerRouteCandidate = {
        policy: ModelRolePolicy.parse({
          role: "KNOWLEDGE_COMPILE",
          provider: "openai-compatible",
          model: descriptor.model,
          endpointRef: descriptor.endpointRef,
          timeoutMs: 30_000,
          maxRetries: 0,
          concurrency: 1,
          structuredOutputRequired: true,
          dataResidency: "LOCAL_ONLY",
        }),
        descriptor,
        supportsStructuredOutput: true,
        createConfigured: () => configured,
      };
      const on = await buildCompilationStage(db, input, [candidate]);

      expect(off.metadata.mode).toBe("SOURCE_SUMMARY_FALLBACK");
      expect(on.metadata.mode).toBe("GENERATIVE");
      expect(compile).toHaveBeenCalledOnce();
      for (const result of [off, on]) {
        expect(result.plan.sourceId).toBe(sourceId);
        expect(result.metadata.sourceMarkdownHash).toBe(markdown.sha256);
        expect(result.metadata.sourceMarkdownRendererVersion).toBe("1.0");
      }
      expect(off.plan.proposedChanges[0]?.content).toContain(markdown.content);
      expect(off.plan.proposedChanges[0]?.content).toContain(
        "human review required",
      );
      expect(on.plan.proposedChanges[0]?.evidenceIds).toEqual([evidenceId]);
      expect(on.plan.reviewContext?.evidence[0]).toMatchObject({
        sourceArtifactId: artifactId,
        excerptHash: fragment.excerptHash,
      });
      expect(on.plan.summary).not.toBe(off.plan.summary);

      const after = await db.pool.query<{
        source_markdown_hash: string;
        document_artifact: unknown;
        source_markdown: string;
      }>(
        "select source_markdown_hash,document_artifact,source_markdown from source_artifacts where id=$1",
        [artifactId],
      );
      expect(after.rows[0]?.source_markdown_hash).toBe(markdown.sha256);
      expect(after.rows[0]?.source_markdown).toBe(markdown.content);
      expect(
        DocumentArtifact.parse(after.rows[0]?.document_artifact).locators,
      ).toEqual(persistedArtifact.locators);
      expect(after.rows[0]?.source_markdown_hash).toBe(
        sha256(markdown.content),
      );
      const premature = await db.pool.query<{ count: number }>(
        "select count(*)::int count from knowledge_documents where vault_id=$1",
        [vault.id],
      );
      expect(premature.rows[0]?.count).toBe(0);
    } finally {
      if (sourceId) {
        await db.pool.query("delete from evidence where source_id=$1", [
          sourceId,
        ]);
        await db.pool.query("delete from source_artifacts where source_id=$1", [
          sourceId,
        ]);
        await db.pool.query("delete from sources where id=$1", [sourceId]);
      }
      await db.close();
    }
  }, 90_000);
});
