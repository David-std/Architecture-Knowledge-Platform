import { readFile, writeFile } from "node:fs/promises";

const path = "apps/api/test/product-lifecycle.integration.test.ts";
let source = await readFile(path, "utf8");

const before = `      \`select r.status review_status,d.lifecycle,i.status index_status,\n                (select count(*)::int from knowledge_units u\n                  where u.document_id=d.id\n                    and u.lifecycle in ('ACTIVE','DISPUTED')) active_units,\n                (select count(*)::int from knowledge_units u\n                  where u.document_id=d.id) total_units,\n                (select count(*)::int from knowledge_units u\n                  where u.document_id=d.id\n                    and u.lifecycle not in ('ACTIVE','DISPUTED')) inactive_units\n           from reviews r\n           join knowledge_documents d on d.vault_id=r.vault_id\n             and d.frontmatter->>'source_sha256'=$2\n           join vault_index_revisions i on i.vault_id=r.vault_id\n          where r.id=$1\`,`;

const after = `      \`select r.status review_status,d.lifecycle,i.status index_status,\n                coalesce(u.active_units,0)::int active_units,\n                coalesce(u.total_units,0)::int total_units,\n                coalesce(u.inactive_units,0)::int inactive_units\n           from reviews r\n           join knowledge_documents d on d.vault_id=r.vault_id\n             and d.frontmatter->>'source_sha256'=$2\n           join vault_index_revisions i on i.vault_id=r.vault_id\n           left join lateral (\n             select count(*)::int total_units,\n                    count(*) filter (\n                      where lifecycle in ('ACTIVE','DISPUTED')\n                    )::int active_units,\n                    count(*) filter (\n                      where lifecycle not in ('ACTIVE','DISPUTED')\n                    )::int inactive_units\n               from knowledge_units\n              where document_id=d.id\n           ) u on true\n          where r.id=$1\`,`;

const index = source.indexOf(before);
if (index < 0) {
  throw new Error("P8 rollback post-drain verification query anchor missing");
}
if (source.indexOf(before, index + before.length) >= 0) {
  throw new Error("P8 rollback post-drain verification query anchor ambiguous");
}
source = source.slice(0, index) + after + source.slice(index + before.length);
await writeFile(path, source, "utf8");
console.log("P8 rollback verification query patched");
