import { createHash } from "node:crypto";
import { DocumentArtifact } from "@akp/contracts";
import type { Postgres } from "@akp/postgres";
import { replaceSourceProjectionUnits } from "@akp/indexing";
import {
  assertFaithfulSourceMarkdown,
  buildFaithfulSourceMarkdown,
  canonicalJson,
  documentArtifactConfigurationHash,
  sanitizeDocumentArtifact,
} from "./document-artifact.js";

export interface HistoricalSourceProjectionTarget {
  spaceId: string;
  vaultId: string;
  sourceId: string;
  sourceArtifactId: string;
  sourceSha256: string;
}

export interface HistoricalSourceProjectionOutcome {
  status: "DRY_RUN" | "MATERIALIZED" | "ALREADY_MATERIALIZED";
  sourceId: string;
  sourceArtifactId: string;
  sourceSha256: string;
  markdownSha256: string;
  rendererVersion: string;
  characters: number;
}

interface LegacyProjectionRow {
  source_id: string;
  source_sha256: string;
  source_media_type: string | null;
  source_title: string;
  artifact_id: string;
  artifact_source_hash: string;
  extractor: string;
  extractor_version: string;
  configuration_hash: string | null;
  structured_content_hash: string | null;
  document_artifact: unknown;
  source_markdown: string | null;
  source_markdown_hash: string | null;
  source_markdown_renderer_version: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Reconstruct a missing projection from the existing sanitized artifact,
 * never from a UI preview or an LLM. Target is pinned to a single active
 * source/artifact/vault identity; caller must explicitly opt in to writing.
 *
 * This is NOT OCR re-extraction, does not change reviews or managed Git, and
 * cannot promote a machine extraction into approved knowledge.
 */
export async function backfillHistoricalSourceProjection(
  db: Postgres,
  target: HistoricalSourceProjectionTarget,
  apply = false,
): Promise<HistoricalSourceProjectionOutcome> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<LegacyProjectionRow>(
      `
      select s.id source_id,s.sha256 source_sha256,s.media_type source_media_type,
             s.title source_title,
             a.id artifact_id,a.source_hash artifact_source_hash,
             a.extractor,a.extractor_version,a.configuration_hash,
             a.structured_content_hash,a.document_artifact,
             a.source_markdown,a.source_markdown_hash,
             a.source_markdown_renderer_version
        from sources s
        join vaults v on v.id=s.vault_id and v.space_id=s.space_id
        join source_artifacts a on a.source_id=s.id
       where s.space_id=$1 and s.vault_id=$2
         and s.id=$3 and a.id=$4 and s.sha256=$5
         and s.status='ACTIVE' and v.enabled
         and a.kind='document-artifact'
       for update of a
      `,
      [
        target.spaceId,
        target.vaultId,
        target.sourceId,
        target.sourceArtifactId,
        target.sourceSha256,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("SOURCE_PROJECTION_BACKFILL_TARGET_NOT_FOUND");
    if (
      row.artifact_source_hash !== row.source_sha256 ||
      !row.configuration_hash ||
      !row.structured_content_hash
    ) {
      throw new Error("SOURCE_PROJECTION_BACKFILL_IDENTITY_INVALID");
    }

    const parsed = DocumentArtifact.safeParse(row.document_artifact);
    if (!parsed.success) {
      throw new Error("SOURCE_PROJECTION_BACKFILL_ARTIFACT_INVALID");
    }
    const artifact = parsed.data;
    if (
      artifact.source_id !== row.source_id ||
      artifact.source_hash !== row.source_sha256 ||
      artifact.extractor !== row.extractor ||
      artifact.extractor_version !== row.extractor_version ||
      (row.source_media_type !== null &&
        artifact.media_type.toLowerCase() !==
          row.source_media_type.toLowerCase())
    ) {
      throw new Error("SOURCE_PROJECTION_BACKFILL_IDENTITY_INVALID");
    }
    if (
      sha256(canonicalJson(artifact)) !== row.structured_content_hash ||
      documentArtifactConfigurationHash(artifact.configuration) !==
        row.configuration_hash
    ) {
      throw new Error("SOURCE_PROJECTION_BACKFILL_ARTIFACT_HASH_MISMATCH");
    }
    if (
      canonicalJson(sanitizeDocumentArtifact(artifact, row.source_id)) !==
      canonicalJson(artifact)
    ) {
      throw new Error("SOURCE_PROJECTION_BACKFILL_REDACTION_REQUIRED");
    }

    const projected = buildFaithfulSourceMarkdown(artifact);
    if (!projected.content.trim()) {
      throw new Error("SOURCE_PROJECTION_BACKFILL_EMPTY_CONTENT");
    }
    const existing = [
      row.source_markdown,
      row.source_markdown_hash,
      row.source_markdown_renderer_version,
    ];
    if (existing.some((value) => value !== null)) {
      if (existing.some((value) => value === null)) {
        throw new Error("SOURCE_PROJECTION_BACKFILL_PARTIAL_PROJECTION");
      }
      assertFaithfulSourceMarkdown(artifact, {
        content: row.source_markdown!,
        sha256: row.source_markdown_hash!,
        rendererVersion: row.source_markdown_renderer_version!,
      });
      if (apply) {
        await replaceSourceProjectionUnits(client, {
          sourceId: row.source_id,
          sourceArtifactId: row.artifact_id,
          sourceSha256: row.source_sha256,
          markdown: projected.content,
          markdownSha256: projected.sha256,
          title: row.source_title,
        });
      }
      await client.query("commit");
      return {
        status: "ALREADY_MATERIALIZED",
        sourceId: row.source_id,
        sourceArtifactId: row.artifact_id,
        sourceSha256: row.source_sha256,
        markdownSha256: projected.sha256,
        rendererVersion: projected.rendererVersion,
        characters: projected.content.length,
      };
    }

    if (apply) {
      const update = await client.query<{ id: string }>(
        `
        update source_artifacts
           set source_markdown=$2,source_markdown_hash=$3,
               source_markdown_renderer_version=$4
         where id=$1 and source_markdown is null
           and source_markdown_hash is null
           and source_markdown_renderer_version is null
        returning id
        `,
        [
          row.artifact_id,
          projected.content,
          projected.sha256,
          projected.rendererVersion,
        ],
      );
      if (update.rowCount !== 1) {
        throw new Error("SOURCE_PROJECTION_BACKFILL_CONCURRENT_CHANGE");
      }
    }
    if (apply) {
      await replaceSourceProjectionUnits(client, {
        sourceId: row.source_id,
        sourceArtifactId: row.artifact_id,
        sourceSha256: row.source_sha256,
        markdown: projected.content,
        markdownSha256: projected.sha256,
        title: row.source_title,
      });
    }
    await client.query("commit");
    return {
      status: apply ? "MATERIALIZED" : "DRY_RUN",
      sourceId: row.source_id,
      sourceArtifactId: row.artifact_id,
      sourceSha256: row.source_sha256,
      markdownSha256: projected.sha256,
      rendererVersion: projected.rendererVersion,
      characters: projected.content.length,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
