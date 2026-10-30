import { createHash } from "node:crypto";
import type { PostgresPoolClient } from "@akp/postgres";
import { parseKnowledgeUnits } from "@akp/retrieval";

const SHA256 = /^[a-f0-9]{64}$/;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface SourceProjectionUnitInput {
  sourceId: string;
  sourceArtifactId: string;
  sourceSha256: string;
  markdown: string;
  markdownSha256: string;
  title: string;
}

/**
 * Called from an ingestion/backfill transaction. Replacing an artifact
 * projection and its noncanonical source units is atomic. This function
 * never writes knowledge_documents, knowledge_units or embedding indexes.
 */
export async function replaceSourceProjectionUnits(
  client: PostgresPoolClient,
  input: SourceProjectionUnitInput,
): Promise<number> {
  if (
    !SHA256.test(input.sourceSha256) ||
    !SHA256.test(input.markdownSha256) ||
    digest(input.markdown) !== input.markdownSha256
  ) {
    throw new Error("SOURCE_UNIT_PROJECTION_HASH_MISMATCH");
  }
  const units = parseKnowledgeUnits(input.title, input.markdown)
    .filter((unit) => !unit.containerOnly && unit.body.trim().length > 0)
    .map((unit) => {
      const { startChar, endChar } = unit.locator;
      if (
        !Number.isSafeInteger(startChar) ||
        !Number.isSafeInteger(endChar) ||
        startChar < 0 ||
        endChar <= startChar ||
        endChar > input.markdown.length
      ) {
        throw new Error("SOURCE_UNIT_SPAN_INVALID");
      }
      return {
        unitKey: unit.unitKey,
        parentUnitKey: unit.parentUnitKey,
        unitType: unit.unitType,
        headingPath: unit.headingPath,
        body: unit.body,
        bodySha256: digest(unit.body),
        sourceSpanSha256: digest(input.markdown.slice(startChar, endChar)),
        locator: unit.locator,
        structuralOrder: unit.structuralOrder,
      };
    });
  if (!units.length || units.length > 20000) {
    throw new Error("SOURCE_UNIT_COUNT_OUT_OF_RANGE");
  }
  if (new Set(units.map((unit) => unit.unitKey)).size !== units.length) {
    throw new Error("SOURCE_UNIT_KEY_DUPLICATE");
  }
  await client.query(
    "delete from source_projection_units where source_artifact_id=$1",
    [input.sourceArtifactId],
  );
  for (let offset = 0; offset < units.length; offset += 200) {
    const batch = units.slice(offset, offset + 200);
    await client.query(
      "insert into source_projection_units(" +
        "source_artifact_id,source_id,source_sha256,markdown_sha256," +
        "unit_key,parent_unit_key,unit_type,heading_path,body,body_sha256," +
        "source_span_sha256,locator,structural_order) " +
        "select $1,$2,$3,$4,unit_key,parent_unit_key,unit_type,heading_path," +
        "body,body_sha256,source_span_sha256,locator,structural_order " +
        "from jsonb_to_recordset($5::jsonb) as unit(" +
        "unit_key text,parent_unit_key text,unit_type text," +
        "heading_path text[],body text,body_sha256 text," +
        "source_span_sha256 text,locator jsonb,structural_order int)",
      [
        input.sourceArtifactId,
        input.sourceId,
        input.sourceSha256,
        input.markdownSha256,
        JSON.stringify(
          batch.map((unit) => ({
            unit_key: unit.unitKey,
            parent_unit_key: unit.parentUnitKey,
            unit_type: unit.unitType,
            heading_path: unit.headingPath,
            body: unit.body,
            body_sha256: unit.bodySha256,
            source_span_sha256: unit.sourceSpanSha256,
            locator: unit.locator,
            structural_order: unit.structuralOrder,
          })),
        ),
      ],
    );
  }
  return units.length;
}
