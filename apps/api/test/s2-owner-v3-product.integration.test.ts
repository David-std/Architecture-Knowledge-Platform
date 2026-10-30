import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres, grantVaultMembership } from "@akp/postgres";
import { MinioObjectStore } from "@akp/object-store";
import { buildServer } from "../src/server.js";

const enabled =
  process.env.AKP_OWNER_V3_HTTP === "1" &&
  !!process.env.AKP_OWNER_V3_ROOT &&
  !!process.env.AKP_OWNER_V3_RECEIPTS &&
  !!process.env.DATABASE_URL &&
  !!process.env.AKP_RAW_ENDPOINT;
// Synthetic owner-approved calibration only. The HUMAN_REVIEWED/REVIEWED
// fixture flags below are NOT independently human-attested SOURCE reviews.
const run = enabled ? describe : describe.skip;
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
type OwnerCase = {
  questionKeySha256: string;
  question: string;
  language: "en" | "es";
  sourceFamily: string;
  relativePath: string;
  proposedDisposition: "EXPLICITLY_DECIDABLE" | "NOT_SUPPORTED";
  proposedQuotes: { quote: string }[];
};
type Original = {
  publisherFamily: string;
  localRelativePath: string;
  sourceSha256: string;
  upstreamGitBlobSha1: string;
  bytes: number;
  repo: string;
};
type ContextResponse = {
  code?: string;
  status?: string;
  packetId?: string;
  packetHash?: string;
  sections?: { documentId?: string; content?: string }[];
};
run(
  "owner V3 authorized native search/context over refreshed original SOURCE",
  () => {
    const orgId = randomUUID();
    const spaceId = randomUUID();
    const vaultId = randomUUID();
    const actorId = randomUUID();
    const deniedId = randomUUID();
    const token = "owner-v3-" + randomUUID();
    const deniedToken = "denied-v3-" + randomUUID();
    const revision = "owner-v3-r1";
    const folder = process.env.AKP_OWNER_V3_ROOT ?? "";
    const output = process.env.AKP_OWNER_V3_RECEIPTS ?? "";
    let db: Postgres;
    let store: MinioObjectStore;
    let app: ReturnType<typeof buildServer>;
    let base = "";
    let cases: OwnerCase[] = [];
    const documentFamily = new Map<string, string>();
    const originIds = new Map<string, string>();
    const originalsSha = new Map<string, string>();
    const post = async (endpoint: string, bearer: string, payload: object) => {
      const response = await fetch(base + endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + bearer,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25_000),
      });
      return {
        http: response.status,
        value: (await response.json()) as Record<string, unknown>,
      };
    };
    beforeAll(async () => {
      const caseManifest = JSON.parse(
        (
          await readFile(path.join(folder, "owner-case-proposals-240.json"))
        ).toString("utf8"),
      ) as { cases: OwnerCase[] };
      const provenance = JSON.parse(
        (
          await readFile(path.join(folder, "download-provenance.json"))
        ).toString("utf8"),
      ) as { sources: Original[] };
      cases = caseManifest.cases;
      expect(cases).toHaveLength(240);
      expect(provenance.sources).toHaveLength(12);
      db = new Postgres(process.env.DATABASE_URL!);
      store = new MinioObjectStore({
        endpoint: process.env.AKP_RAW_ENDPOINT!,
        accessKey: process.env.AKP_RAW_ACCESS_KEY!,
        secretKey: process.env.AKP_RAW_SECRET_KEY!,
        bucket: process.env.AKP_RAW_BUCKET!,
      });
      await db.pool.query(
        "insert into organizations(id,slug,name) values($1,$2,'Owner V3 study')",
        [orgId, "owner-v3-" + orgId.slice(0, 8)],
      );
      await db.pool.query(
        "insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path) values($1,$2,$3,'Owner V3','TEAM',$4)",
        [spaceId, orgId, "owner-v3-" + orgId.slice(0, 8), "owner/v3"],
      );
      await db.pool.query(
        "insert into users(id,email,display_name) values($1,$2,$3),($4,$5,$6)",
        [
          actorId,
          actorId + "@example.test",
          "Owner test principal",
          deniedId,
          deniedId + "@example.test",
          "Denied principal",
        ],
      );
      await db.pool.query(
        "insert into memberships(user_id,space_id,role) values($1,$2,'ADMIN')",
        [actorId, spaceId],
      );
      await db.pool.query(
        "insert into vaults(id,space_id,canonical_path,name,read_only,current_revision,vault_key,local_path,visibility,enabled) values($1,$2,$3,'Owner V3',true,$4,$5,$3,'TEAM',true)",
        [
          vaultId,
          spaceId,
          "owner/v3/" + vaultId,
          revision,
          "owner-v3-" + vaultId.slice(0, 8),
        ],
      );
      await grantVaultMembership(db, {
        userId: actorId,
        vaultId,
        role: "ADMIN",
        permissions: [
          "knowledge:read",
          "source:read",
          "source:write",
          "knowledge:propose",
          "knowledge:review",
          "eval:run",
          "admin",
        ],
      });
      await db.pool.query(
        "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'owner-v3',$3::jsonb),($4,$5,'owner-v3-denied',$6::jsonb)",
        [
          actorId,
          sha(token),
          JSON.stringify({
            spaces: [
              {
                spaceId,
                pathPrefix: null,
                permissions: [
                  "knowledge:read",
                  "source:read",
                  "source:write",
                  "knowledge:propose",
                  "knowledge:review",
                  "eval:run",
                  "admin",
                ],
              },
            ],
          }),
          deniedId,
          sha(deniedToken),
          JSON.stringify({ spaces: [] }),
        ],
      );
      await db.pool.query(
        "insert into vault_index_revisions(space_id,vault_id,corpus_revision,lexical_revision,vector_revision,graph_revision,context_pack_revision,status,warnings) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)",
        [spaceId, vaultId, revision],
      );
      for (const original of provenance.sources) {
        const bytes = await readFile(
          path.join(folder, original.localRelativePath),
        );
        expect(sha(bytes)).toBe(original.sourceSha256);
        const gitSha = createHash("sha1")
          .update(
            Buffer.concat([Buffer.from("blob " + bytes.length + "\0"), bytes]),
          )
          .digest("hex");
        expect(gitSha).toBe(original.upstreamGitBlobSha1);
        const stored = await store.putImmutable({
          stream: Readable.from([bytes]),
          mediaType: "text/markdown",
          expectedSha256: original.sourceSha256,
        });
        const id = randomUUID();
        originIds.set(original.publisherFamily, id);
        originalsSha.set(original.publisherFamily, stored.sha256);
        await db.pool.query(
          "insert into sources(id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,object_key,status,metadata) values($1,$2,$3,$4,$5,'text/markdown',$6,$7,$8,'ACTIVE','{}'::jsonb)",
          [
            id,
            spaceId,
            vaultId,
            original.publisherFamily,
            "https://github.com/" + original.repo,
            stored.sha256,
            stored.bytes,
            stored.key,
          ],
        );
      }
      const positives = cases.filter(
        (c) =>
          c.language === "en" &&
          c.proposedDisposition === "EXPLICITLY_DECIDABLE",
      );
      expect(positives).toHaveLength(60);
      for (const [index, c] of positives.entries()) {
        const quote = c.proposedQuotes[0]?.quote ?? "";
        expect(quote.length).toBeGreaterThan(10);
        const documentId = randomUUID();
        const evidenceId = randomUUID();
        const sourceId = originIds.get(c.sourceFamily)!;
        const filePath =
          "owner/v3/" +
          c.sourceFamily +
          "/" +
          String(index).padStart(3, "0") +
          ".md";
        documentFamily.set(documentId, c.sourceFamily);
        await db.pool.query(
          "insert into knowledge_documents(id,space_id,vault_id,path,external_id,aliases,title,type,lifecycle,trust_tier,current_revision,body_cache,frontmatter,layer,content_hash,token_estimate,raw_links) values($1,$2,$3,$4,$5,'{}',$6,'claim','ACTIVE','HUMAN_REVIEWED',$7,$8,'{}'::jsonb,'concept',$9,100,'[]'::jsonb)",
          [
            documentId,
            spaceId,
            vaultId,
            filePath,
            "owner-v3:" + c.questionKeySha256.slice(0, 18),
            "Owner V3 case " + index,
            revision,
            quote,
            sha(quote),
          ],
        );
        await db.pool.query(
          "insert into evidence(id,space_id,vault_id,source_id,locator,content_hash,excerpt,review_status) values($1,$2,$3,$4,$5::jsonb,$6,$7,'REVIEWED')",
          [
            evidenceId,
            spaceId,
            vaultId,
            sourceId,
            JSON.stringify({
              kind: "source",
              path: "source:" + sourceId,
              source_hash: originalsSha.get(c.sourceFamily),
            }),
            sha(quote),
            quote,
          ],
        );
        await db.pool.query(
          "insert into document_evidence(document_id,evidence_id,relation_type) values($1,$2,'supported_by')",
          [documentId, evidenceId],
        );
      }
      await mkdir(path.dirname(output), { recursive: true });
      app = buildServer();
      await app.ready();
      base = await app.listen({ host: "127.0.0.1", port: 0 });
    }, 180000);
    afterAll(async () => {
      await app?.close();
      await db?.close();
    }, 30000);
    it("runs 240 real Search and Context HTTP pairs across twelve pinned public original-source families", async () => {
      let count = 0;
      for (const c of cases) {
        const request = {
          query: c.question,
          spaceId,
          vaultId,
          mode: "SOURCE_BACKED",
          packetMode: "FULL_CONTEXT_PACKET",
          contextLevel: "L2",
          reasoningMode: "DIRECT",
          limit: 10,
          maxTokens: 1400,
          minimumTrust: "MACHINE_SUPPORTED",
        };
        const t0 = performance.now();
        const search = await post("/v1/search", token, request);
        const searchMs = performance.now() - t0;
        const t1 = performance.now();
        const context = await post("/v1/context", token, request);
        const contextMs = performance.now() - t1;
        const payload = context.value as ContextResponse;
        const sections = Array.isArray(payload.sections)
          ? payload.sections
          : [];
        const families = sections.map(
          (x) => documentFamily.get(x.documentId ?? "") ?? "UNKNOWN",
        );
        const searchHits = (search.value.hits ??
          search.value.results ??
          []) as { documentId?: string }[];
        const searchList = Array.isArray(searchHits) ? searchHits : [];
        const row = {
          schemaVersion: "akp.s2.owner-v3-http-pair.v1",
          questionSha256: c.questionKeySha256,
          language: c.language,
          expectedFamily: c.sourceFamily,
          proposedDisposition: c.proposedDisposition,
          searchHttp: search.http,
          searchCode: search.value.code ?? null,
          searchMs: Math.round(searchMs * 100) / 100,
          searchHits: searchList.length,
          searchTopFamily:
            documentFamily.get(searchList[0]?.documentId ?? "") ?? null,
          contextHttp: context.http,
          contextCode: payload.code ?? null,
          contextStatus: payload.status ?? null,
          contextMs: Math.round(contextMs * 100) / 100,
          packetId: payload.packetId ?? null,
          packetHash: payload.packetHash ?? null,
          sectionCount: sections.length,
          sectionFamilies: families,
          expectedFamilyFound: families.includes(c.sourceFamily),
          sections: sections.map((s) => ({
            family: documentFamily.get(s.documentId ?? "") ?? "UNKNOWN",
            documentId: s.documentId,
            content: s.content,
          })),
          independentHumanGold: false,
          releaseGateAccepted: false,
        };
        await appendFile(output, JSON.stringify(row) + "\n", {
          encoding: "utf8",
        });
        count++;
        if (count % 20 === 0)
          console.log(
            "OWNER_V3_REAL_HTTP",
            count,
            "OF",
            cases.length,
            context.http,
            payload.status,
            sections.length,
          );
      }
      expect(count).toBe(240);
    }, 900000);
    it("denies an uncredentialed actor with no scope", async () => {
      const response = await post("/v1/context", deniedToken, {
        query: cases[0]!.question,
        spaceId,
        vaultId,
        mode: "SOURCE_BACKED",
      });
      expect([401, 403, 404]).toContain(response.http);
    });
    it("fails closed after active vault membership is revoked", async () => {
      await db.pool.query(
        "update vault_memberships set enabled=false where vault_id=$1 and user_id=$2",
        [vaultId, actorId],
      );
      const response = await post("/v1/context", token, {
        query: cases[0]!.question,
        spaceId,
        vaultId,
        mode: "SOURCE_BACKED",
      });
      expect([403, 404]).toContain(response.http);
    });
  },
);
