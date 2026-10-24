import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@akp/contracts";
import type { Postgres } from "@akp/postgres";
import { resolveSectionCandidatesShadow } from "../src/section-candidate-shadow.js";

const doc = "10000000-0000-4000-8000-000000000001";
const vault = "20000000-0000-4000-8000-000000000002";
const space = "30000000-0000-4000-8000-000000000003";
const child = "40000000-0000-4000-8000-000000000004";
const parent = "50000000-0000-4000-8000-000000000005";
const source = "## Operations\r\nRequires review.\r\nApproval stays human.";
const normalized = "## Operations\nRequires review.\nApproval stays human.";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function childHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    documentId: doc,
    vaultId: vault,
    unitId: child,
    unitType: "RULE",
    parentUnitId: parent,
    parentUnitType: "SECTION",
    document: {
      externalId: null,
      path: "docs/operations.md",
      title: "Operations",
    },
    revision: "r1",
    title: "Operations",
    type: "source-summary",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 0.9,
    reasons: [],
    excerpt: "Requires review.",
    citations: [],
    ...overrides,
  };
}

function sectionRow(overrides: Record<string, unknown> = {}) {
  return {
    child_id: child,
    child_document_id: doc,
    child_vault_id: vault,
    child_revision: "r1",
    child_trust: "HUMAN_REVIEWED",
    child_permissions: {},
    section_id: parent,
    section_body: normalized,
    section_content_hash: digest(normalized),
    section_revision: "r1",
    section_trust: "HUMAN_REVIEWED",
    section_permissions: {},
    section_locator: {
      kind: "markdown",
      sourceFrame: "markdown-body-cache-raw-v1",
      sourceEncoding: "utf-16-code-units",
      sourceTextProjection: "visible-markdown-lf-trim-v1",
      sourceTextMasked: false,
      startChar: 0,
      endChar: source.length,
      sourceBodyHash: digest(source),
    },
    document_id: doc,
    vault_id: vault,
    path: "docs/operations.md",
    layer: "concept",
    type: "source-summary",
    current_revision: "r1",
    lifecycle: "ACTIVE",
    trust_tier: "HUMAN_REVIEWED",
    refresh_status: "CURRENT",
    body_cache: source,
    ...overrides,
  };
}

async function resolve(
  rows: Array<ReturnType<typeof sectionRow>>,
  hits: SearchHit[] = [childHit()],
  permitted = true,
) {
  const query = vi.fn().mockResolvedValue({ rows });
  const db = { pool: { query } } as unknown as Pick<Postgres, "pool">;
  const result = await resolveSectionCandidatesShadow(db, {
    spaceId: space,
    vaultIds: [vault],
    authorizedChildHits: hits,
    pathAuthorizer: (path, targetVault) =>
      permitted && path === "docs/operations.md" && targetVault === vault,
    sourceReadAuthorizer: () => permitted,
  });
  return { result, query };
}

describe("independently bound SECTION shadow candidates", () => {
  it("takes its own identity, verified body, raw UTF-16 span and hashes", async () => {
    const { result, query } = await resolve([sectionRow(), sectionRow()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      documentId: doc,
      sectionUnitId: parent,
      childUnitId: child,
      revision: "r1",
      body: normalized,
      sourceStartUtf16: 0,
      sourceEndUtf16: source.length,
      sourceSpanSha256: digest(source),
      projectionBodySha256: digest(source),
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "p.permissions=u.permissions",
    );
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "p.document_revision=d.current_revision",
    );
  });

  it("does not request parents when there is no authorized child unit", async () => {
    const withoutParent = childHit();
    delete withoutParent.parentUnitId;
    const { result, query } = await resolve([sectionRow()], [withoutParent]);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects every parent whose path is not authorized", async () => {
    expect((await resolve([sectionRow()], [childHit()], false)).result).toEqual(
      [],
    );
  });

  it.each([
    ["foreign vault", { vault_id: "99999999-0000-4000-8000-000000000009" }],
    ["wrong parent", { section_id: "99999999-0000-4000-8000-000000000009" }],
    ["wrong child", { child_id: "99999999-0000-4000-8000-000000000009" }],
    ["stale revision", { section_revision: "r0" }],
    ["stale hit", { current_revision: "r2" }],
    ["source tamper", { body_cache: source + " secret" }],
    ["unit body tamper", { section_body: normalized + " not literal" }],
    ["unit hash tamper", { section_content_hash: digest("different") }],
    ["trust downgrade", { section_trust: "UNVERIFIED" }],
    [
      "unauthorized permission scope",
      { section_permissions: { path: "secret/" } },
    ],
    [
      "cross-document",
      { child_document_id: "99999999-0000-4000-8000-000000000009" },
    ],
    [
      "nonliteral parentContext",
      { section_body: normalized + "\nDerived codeSupport" },
    ],
  ])("fails closed on %s", async (_name, override) => {
    expect((await resolve([sectionRow(override)])).result).toEqual([]);
  });

  it("rejects masked/ambiguous source projection and UTF-16 surrogate splits", async () => {
    const masked = sectionRow({
      section_locator: {
        ...sectionRow().section_locator,
        sourceTextMasked: true,
      },
    });
    const badBoundarySource = "😀" + source;
    const split = sectionRow({
      body_cache: badBoundarySource,
      section_locator: {
        ...sectionRow().section_locator,
        sourceBodyHash: digest(badBoundarySource),
        startChar: 1,
        endChar: badBoundarySource.length,
      },
    });
    expect((await resolve([masked, split])).result).toEqual([]);
  });

  it("independently enforces source-read even when knowledge path is allowed", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [sectionRow()] });
    const db = { pool: { query } } as unknown as Pick<Postgres, "pool">;
    const result = await resolveSectionCandidatesShadow(db, {
      spaceId: space,
      vaultIds: [vault],
      authorizedChildHits: [childHit()],
      pathAuthorizer: () => true,
      sourceReadAuthorizer: () => false,
    });
    expect(result).toEqual([]);
  });

  it("uses the actual SECTION rather than child parentContext text", async () => {
    const hit = childHit({
      parentContext: "Invented summary: ten unrelated values",
    });
    const { result } = await resolve([sectionRow()], [hit]);
    expect(result[0]?.body).toBe(normalized);
    expect(result[0]?.body).not.toContain("Invented summary");
  });
});
