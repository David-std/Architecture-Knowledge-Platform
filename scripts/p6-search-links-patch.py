from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


contracts_path = Path("packages/contracts/src/index.ts")
contracts = contracts_path.read_text()
marker = 'export const SearchHit = z.object({'
schema = '''export const SearchReferenceLink = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    documentId: z.string().uuid(),
    label: z.string().min(1),
  }),
  z.object({
    kind: z.literal("source"),
    sourceId: z.string().uuid(),
    evidenceId: z.string().uuid(),
    label: z.string().min(1),
  }),
]);
export type SearchReferenceLink = z.infer<typeof SearchReferenceLink>;

'''
if 'export const SearchReferenceLink =' not in contracts:
    contracts = replace_once(
        contracts, marker, schema + marker, "SearchReferenceLink schema"
    )
contracts = replace_once(
    contracts,
    '  citations: z.array(z.string()),\n',
    '  citations: z.array(z.string()),\n  referenceLinks: z.array(SearchReferenceLink).optional(),\n',
    "SearchHit.referenceLinks",
)
contracts_path.write_text(contracts)

search_path = Path("apps/api/src/routes/search.ts")
search = search_path.read_text()
search = replace_once(
    search,
    """           coalesce(jsonb_agg(distinct e.locator) filter (where e.id is not null),'[]'::jsonb)
             evidence_locators""",
    """           coalesce(
             jsonb_agg(distinct jsonb_build_object(
               'id',e.id,'sourceId',e.source_id,'locator',e.locator
             )) filter (where e.id is not null),
             '[]'::jsonb
           ) evidence_references""",
    "structured evidence references SQL",
)
pattern = re.compile(
    r"      const citations = \[\n        \.\.\.documentCitations,\n        \.\.\.\(\(row\.evidence_locators \?\? \[\]\) as Array<Record<string, unknown>>\).*?\n      \];\n      const matchedUnit",
    re.S,
)
replacement = '''      const evidenceReferences = (
        (row.evidence_references ?? []) as Array<Record<string, unknown>>
      ).filter((reference) => {
        const locator = reference.locator;
        return (
          locator !== null &&
          typeof locator === "object" &&
          evidenceLocatorAllowed(
            locator as Record<string, unknown>,
            rowPathAuthorizer,
          )
        );
      });
      const evidenceCitations = evidenceReferences.map((reference) => {
        const locator = reference.locator as Record<string, unknown>;
        return `evidence:${JSON.stringify(sanitizeEvidenceLocator(locator))}`;
      });
      const citations = [...documentCitations, ...evidenceCitations];
      const documentReferenceLinks = ["source", "resource"].includes(
        String(row.layer),
      )
        ? [
            {
              kind: "document" as const,
              documentId: String(row.id),
              label: `${row.path}@${row.current_revision}`,
            },
          ]
        : ((row.citations ?? []) as Array<Record<string, unknown>>).flatMap(
            (citation) => {
              const label = `${String(citation.path)}@${String(
                citation.revision ?? row.current_revision,
              )}`;
              const documentId = String(citation.id ?? "");
              return documentId && documentCitations.includes(label)
                ? [{ kind: "document" as const, documentId, label }]
                : [];
            },
          );
      const evidenceReferenceLinks = evidenceReferences.flatMap((reference) => {
        const sourceId = String(reference.sourceId ?? "");
        const evidenceId = String(reference.id ?? "");
        const locator = reference.locator as Record<string, unknown>;
        if (!sourceId || !evidenceId) return [];
        return [
          {
            kind: "source" as const,
            sourceId,
            evidenceId,
            label: `evidence:${JSON.stringify(sanitizeEvidenceLocator(locator))}`,
          },
        ];
      });
      const referenceLinks = [
        ...documentReferenceLinks,
        ...evidenceReferenceLinks,
      ];
      const matchedUnit'''
search, count = pattern.subn(replacement, search, count=1)
if count != 1:
    raise SystemExit(f"citation mapping: expected one match, got {count}")
search = replace_once(
    search,
    '        citations,\n        warnings:',
    '        citations,\n        referenceLinks,\n        warnings:',
    "SearchHit referenceLinks output",
)
search_path.write_text(search)

web_path = Path("apps/web/app/search/page.tsx")
web = web_path.read_text()
hit_marker = 'interface SearchHit {\n'
reference_interface = '''interface SearchReferenceLink {
  kind: "document" | "source";
  documentId?: string;
  sourceId?: string;
  evidenceId?: string;
  label: string;
}

'''
if 'interface SearchReferenceLink {' not in web:
    web = replace_once(
        web, hit_marker, reference_interface + hit_marker, "web reference interface"
    )
web = replace_once(
    web,
    '  citations: string[];\n',
    '  citations: string[];\n  referenceLinks?: SearchReferenceLink[];\n',
    "web SearchHit.referenceLinks",
)
old = '''          <p>
            <strong>Citaciones/evidencia:</strong>{" "}
            {hit.citations.length
              ? hit.citations.join(" · ")
              : "Sin referencias"}
          </p>'''
new = '''          <p>
            <strong>Citaciones/evidencia:</strong>{" "}
            {hit.referenceLinks?.length
              ? hit.referenceLinks.map((reference, referenceIndex) => {
                  const href =
                    reference.kind === "document" && reference.documentId
                      ? `/documents/${reference.documentId}`
                      : reference.kind === "source" && reference.sourceId
                        ? `/sources/${reference.sourceId}`
                        : null;
                  return (
                    <span
                      key={`${reference.kind}-${reference.documentId ?? reference.sourceId ?? referenceIndex}`}
                    >
                      {referenceIndex > 0 ? " · " : ""}
                      {href ? <Link href={href}>{reference.label}</Link> : reference.label}
                    </span>
                  );
                })
              : hit.citations.length
                ? hit.citations.join(" · ")
                : "Sin referencias"}
          </p>'''
web = replace_once(web, old, new, "web citation links")
web_path.write_text(web)

test_path = Path("apps/api/test/lexical-ranking.integration.test.ts")
test = test_path.read_text()
seed_marker = '''        await db.pool.query(
          `update knowledge_documents
              set refresh_status='STALE_PENDING_REVIEW'
            where id=$1`,
          [fixture.documents.externalId],
        );'''
seed_extra = seed_marker + '''
        const evidenceSourceId = randomUUID();
        const evidenceId = randomUUID();
        const evidenceHash = createHash("sha256")
          .update(`evidence-${evidenceId}`)
          .digest("hex");
        await db.pool.query(
          `update knowledge_documents set layer='source' where id=$1`,
          [fixture.documents.alias],
        );
        await db.pool.query(
          `insert into knowledge_relations(
             space_id,from_document_id,to_document_id,relation_type,provenance
           ) values($1,$2,$3,'supports','lexical-link-fixture')`,
          [
            fixture.spaceId,
            fixture.documents.externalId,
            fixture.documents.alias,
          ],
        );
        await db.pool.query(
          `insert into sources(
             id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
             object_key,status,metadata
           ) values($1,$2,$3,'Lexical evidence','fixture://lexical-evidence',
                    'text/plain',$4,16,$5,'ACTIVE','{}'::jsonb)`,
          [
            evidenceSourceId,
            fixture.spaceId,
            fixture.vaultId,
            evidenceHash,
            `lexical/${evidenceSourceId}`,
          ],
        );
        await db.pool.query(
          `insert into evidence(
             id,space_id,vault_id,source_id,locator,content_hash,excerpt,
             review_status
           ) values($1,$2,$3,$4,$5::jsonb,$6,'ranking evidence','REVIEWED')`,
          [
            evidenceId,
            fixture.spaceId,
            fixture.vaultId,
            evidenceSourceId,
            JSON.stringify({
              kind: "paragraph",
              path: "docs/identity.md",
              paragraph: 1,
            }),
            evidenceHash,
          ],
        );
        await db.pool.query(
          `insert into document_evidence(document_id,evidence_id) values($1,$2)`,
          [fixture.documents.externalId, evidenceId],
        );'''
test = replace_once(test, seed_marker, seed_extra, "lexical provenance seed")
assertion_marker = '''        expect(best?.warnings).toContain("STALE_PENDING_REVIEW");

        expect(best?.parentUnitType).toBe("SECTION");'''
assertion = '''        expect(best?.warnings).toContain("STALE_PENDING_REVIEW");
        expect(best?.referenceLinks).toEqual(
          expect.arrayContaining([
            {
              kind: "document",
              documentId: fixture.documents.alias,
              label: `docs/alias.md@${fixture.corpusRevision}`,
            },
            expect.objectContaining({
              kind: "source",
              sourceId: evidenceSourceId,
              evidenceId,
            }),
          ]),
        );

        expect(best?.parentUnitType).toBe("SECTION");'''
test = replace_once(test, assertion_marker, assertion, "lexical link assertions")
cleanup_marker = '''  await db.pool.query("delete from knowledge_units where vault_id=$1", [
    fixture.vaultId,
  ]);'''
cleanup = '''  await db.pool.query(
    `delete from document_evidence
      where evidence_id in (select id from evidence where vault_id=$1)`,
    [fixture.vaultId],
  );
  await db.pool.query("delete from evidence where vault_id=$1", [fixture.vaultId]);
  await db.pool.query("delete from sources where vault_id=$1", [fixture.vaultId]);
  await db.pool.query(
    `delete from knowledge_relations
      where from_document_id in (select id from knowledge_documents where vault_id=$1)
         or to_document_id in (select id from knowledge_documents where vault_id=$1)`,
    [fixture.vaultId],
  );
''' + cleanup_marker
test = replace_once(test, cleanup_marker, cleanup, "lexical provenance cleanup")
test_path.write_text(test)
