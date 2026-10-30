import { createHash } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import type { Postgres } from "@akp/postgres";

/**
 * Experimental, library-only parent lookup. Its output is NEVER admitted by
 * retrieval or sent to HTTP clients. A source reviewer must still rebind
 * these projection spans to the frozen original before using them as citations.
 */
export interface SectionShadowCandidate {
  documentId: string;
  vaultId: string;
  childUnitId: string;
  sectionUnitId: string;
  revision: string;
  path: string;
  body: string;
  contentSha256: string;
  projectionBodySha256: string;
  sourceStartUtf16: number;
  sourceEndUtf16: number;
  sourceSpanSha256: string;
}

interface SectionRow {
  child_id: string;
  child_document_id: string;
  child_vault_id: string;
  child_revision: string;
  child_trust: string;
  child_permissions: unknown;
  section_id: string;
  section_body: string;
  section_content_hash: string;
  section_revision: string;
  section_trust: string;
  section_permissions: unknown;
  section_locator: unknown;
  document_id: string;
  vault_id: string;
  path: string;
  layer: string;
  type: string;
  current_revision: string;
  lifecycle: string;
  trust_tier: string;
  refresh_status: string;
  body_cache: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CHILDREN = 64;
const MAX_SECTION_CHARS = 12_000;
const MAX_PROJECTION_CHARS = 500_000;
const TRUST_RANK: Record<string, number> = {
  UNVERIFIED: 0,
  MACHINE_SUPPORTED: 1,
  HUMAN_REVIEWED: 2,
  ATTESTED: 3,
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function utf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}

function sourceLocator(value: unknown): {
  startChar: number;
  endChar: number;
  sourceBodyHash: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const locator = value as Record<string, unknown>;
  if (
    locator.kind !== "markdown" ||
    locator.sourceFrame !== "markdown-body-cache-raw-v1" ||
    locator.sourceEncoding !== "utf-16-code-units" ||
    locator.sourceTextProjection !== "visible-markdown-lf-trim-v1" ||
    locator.sourceTextMasked !== false ||
    !Number.isSafeInteger(locator.startChar) ||
    !Number.isSafeInteger(locator.endChar) ||
    typeof locator.sourceBodyHash !== "string" ||
    !SHA256.test(locator.sourceBodyHash)
  )
    return null;
  return {
    startChar: locator.startChar as number,
    endChar: locator.endChar as number,
    sourceBodyHash: locator.sourceBodyHash,
  };
}

/**
 * The caller must have ALREADY resolved vault + path authorization and the
 * ordinary truth-filtered child pool. Recheck the parent's independent
 * provenance, trust, scope and exact source-projection bytes.
 */
export async function resolveSectionCandidatesShadow(
  db: Pick<Postgres, "pool">,
  input: {
    spaceId: string;
    vaultIds: readonly string[];
    authorizedChildHits: readonly SearchHit[];
    pathAuthorizer: (path: string, vaultId: string) => boolean;
    sourceReadAuthorizer: (
      path: string,
      vaultId: string,
      layer: string,
      type: string,
    ) => boolean;
  },
): Promise<SectionShadowCandidate[]> {
  const vaultIds = [...new Set(input.vaultIds)];
  const inScope = new Set(vaultIds);
  const eligible = new Map<string, SearchHit>();
  for (const hit of input.authorizedChildHits) {
    if (
      hit.unitId &&
      hit.parentUnitId &&
      hit.parentUnitType === "SECTION" &&
      inScope.has(hit.vaultId) &&
      !eligible.has(hit.unitId)
    )
      eligible.set(hit.unitId, hit);
    if (eligible.size >= MAX_CHILDREN) break;
  }
  if (eligible.size === 0 || vaultIds.length === 0) return [];

  const rows = await db.pool.query<SectionRow>(
    `select
        u.id child_id, u.document_id child_document_id,
        u.vault_id child_vault_id, u.document_revision child_revision,
        u.trust_tier child_trust, u.permissions child_permissions,
        p.id section_id, p.body section_body,
        p.content_hash section_content_hash,
        p.document_revision section_revision, p.trust_tier section_trust,
        p.permissions section_permissions, p.locator section_locator,
        d.id document_id, d.vault_id, d.path, d.layer, d.type, d.current_revision,
        d.lifecycle, d.trust_tier, d.refresh_status, d.body_cache
      from knowledge_units u
      join knowledge_units p
        on p.id=u.parent_unit_id
       and p.document_id=u.document_id
       and p.space_id=u.space_id
       and p.vault_id=u.vault_id
       and p.corpus_revision=u.corpus_revision
       and p.unit_type='SECTION'
       and p.container_only=true
       and p.permissions=u.permissions
      join knowledge_documents d
        on d.id=u.document_id and d.space_id=u.space_id
       and d.vault_id=u.vault_id
      where u.id=any($1::uuid[])
        and u.space_id=$2 and u.vault_id=any($3::uuid[])
        and u.document_revision=d.current_revision
        and p.document_revision=d.current_revision
        and d.refresh_status='CURRENT'
        and d.lifecycle not in ('ARCHIVED','DELETED_TOMBSTONE',
                                'SUPERSEDED','INVALID')
        and u.lifecycle=d.lifecycle and p.lifecycle=d.lifecycle
        and length(p.body) between 1 and $4
        and length(d.body_cache) <= $5`,
    [
      [...eligible.keys()],
      input.spaceId,
      vaultIds,
      MAX_SECTION_CHARS,
      MAX_PROJECTION_CHARS,
    ],
  );

  const unique = new Set<string>();
  const candidates: SectionShadowCandidate[] = [];
  for (const row of rows.rows) {
    const hit = eligible.get(String(row.child_id));
    if (
      !hit ||
      hit.documentId !== row.document_id ||
      hit.vaultId !== row.vault_id ||
      hit.unitId !== row.child_id ||
      hit.parentUnitId !== row.section_id ||
      hit.revision !== row.current_revision ||
      hit.trust !== row.trust_tier ||
      !inScope.has(row.vault_id) ||
      !input.pathAuthorizer(row.path, row.vault_id) ||
      !input.sourceReadAuthorizer(
        row.path,
        row.vault_id,
        row.layer,
        row.type,
      ) ||
      hit.document.path !== row.path ||
      hit.lifecycle !== row.lifecycle ||
      hit.refreshStatus !== row.refresh_status ||
      row.child_document_id !== row.document_id ||
      row.child_vault_id !== row.vault_id ||
      row.child_revision !== row.current_revision ||
      row.section_revision !== row.current_revision ||
      (TRUST_RANK[row.section_trust] ?? -1) <
        (TRUST_RANK[row.child_trust] ?? 999) ||
      row.child_trust !== row.trust_tier ||
      JSON.stringify(row.child_permissions) !==
        JSON.stringify(row.section_permissions)
    )
      continue;

    const locator = sourceLocator(row.section_locator);
    if (
      !locator ||
      typeof row.body_cache !== "string" ||
      typeof row.section_body !== "string" ||
      row.section_body.length > MAX_SECTION_CHARS ||
      row.body_cache.length > MAX_PROJECTION_CHARS ||
      locator.startChar < 0 ||
      locator.endChar <= locator.startChar ||
      locator.endChar > row.body_cache.length ||
      !utf16Boundary(row.body_cache, locator.startChar) ||
      !utf16Boundary(row.body_cache, locator.endChar) ||
      digest(row.body_cache) !== locator.sourceBodyHash ||
      digest(row.section_body) !== row.section_content_hash
    )
      continue;

    const originalSpan = row.body_cache.slice(
      locator.startChar,
      locator.endChar,
    );
    // This intentionally rejects projected context with erased comments,
    // rewritten text, or non-literal SECTION bodies. No fuzzy match.
    if (originalSpan.replace(/\r\n?|\n/g, "\n").trim() !== row.section_body)
      continue;
    const identity = `${row.vault_id}:${row.document_id}:${row.section_id}:${row.current_revision}`;
    if (unique.has(identity)) continue;
    unique.add(identity);
    candidates.push({
      documentId: row.document_id,
      vaultId: row.vault_id,
      childUnitId: row.child_id,
      sectionUnitId: row.section_id,
      revision: row.current_revision,
      path: row.path,
      body: row.section_body,
      contentSha256: row.section_content_hash,
      projectionBodySha256: locator.sourceBodyHash,
      sourceStartUtf16: locator.startChar,
      sourceEndUtf16: locator.endChar,
      sourceSpanSha256: digest(originalSpan),
    });
  }
  return candidates;
}
