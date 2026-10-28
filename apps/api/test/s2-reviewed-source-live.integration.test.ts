/**
 * S2 live HTTP + PostgreSQL + immutable MinIO SOURCE custody (disposable DB).
 * Reviewer identities are simulated test credentials, NOT independent humans.
 * No model is invoked and no runtime promotion occurs.
 *
 * Run only against a DISPOSABLE migrated database and isolated raw store:
 * AKP_S2_LIVE_ROUTE_TEST=1 DATABASE_URL=... AKP_RAW_*=...
 */
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Postgres, grantVaultMembership } from "@akp/postgres";
import { MinioObjectStore } from "@akp/object-store";
import { buildServer } from "../src/server.js";
import { LayeredEvidenceAdmissionPipeline } from "@akp/retrieval";
import { S2PinnedLocalOllamaWriter } from "../src/s2-local-atomic-provider.js";

const enabled =
  process.env.AKP_S2_LIVE_ROUTE_TEST === "1" &&
  !!process.env.DATABASE_URL &&
  !!process.env.AKP_RAW_ENDPOINT &&
  process.env.AKP_S2_REVIEWED_SOURCE_ENABLED === "true";
const run = enabled ? describe : describe.skip;
const sha = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const orgId = randomUUID(),
  spaceId = randomUUID(),
  vaultId = randomUUID();
const originalQuestion = "Who approved shipment SR-41 on 14 August 2024?";
const writerStatement = "Elian Sora approved shipment SR-41 on 14 August 2024.";
const rawText = "# Belza station\n" + writerStatement + "\n";
const raw = Buffer.from(rawText, "utf8");
const documentPath = "test/s2/belza-current.md";
const docId = randomUUID(),
  sourceId = randomUUID(),
  evidenceId = randomUUID();
const packetId = randomUUID(),
  packetHash = sha("s2-frozen-packet:" + packetId);
const reviewers = [
  { id: randomUUID(), token: "akp-s2-operator-" + randomUUID() },
  { id: randomUUID(), token: "akp-s2-independent-simulation-" + randomUUID() },
];
const prefix = "s2-live-" + orgId.slice(0, 8);

run(
  "S2 real authenticated loopback HTTP, PostgreSQL and immutable SOURCE",
  () => {
    // Vitest evaluates describe.skip callbacks even for excluded integration files.
    // Never instantiate a DB, object store or HTTP server until beforeAll has
    // confirmed that this deliberately opt-in suite is actually running.
    let db: Postgres;
    let store: MinioObjectStore;
    let app: ReturnType<typeof buildServer>;
    let layeredApp: ReturnType<typeof buildServer>;
    let nativeCallCount = 0;
    let esPacketId = "";
    let esPacketHash = "";
    let nativeMode:
      "GOOD" | "FORGED_CITATION" | "TRUNCATED" | "UNREVIEWED_CLAIM" = "GOOD";
    const pinnedAtomicProvider = {
      id: "s2:mock-provider-transport-only",
      model: "s2-synthetic-model:latest",
      modelDigestSha256: sha("s2-mock-model-digest"),
      codeCommitSha: "a".repeat(40),
      async generate(requestBytes: Uint8Array) {
        nativeCallCount++;
        const request = JSON.parse(
          Buffer.from(requestBytes).toString("utf8"),
        ) as {
          model: string;
          think?: boolean;
          format: {
            properties: {
              statements: {
                items: { properties: { citationId: { enum: string[] } } };
              };
            };
          };
        };
        expect(request.model).toBe("s2-synthetic-model:latest");
        expect(request.think).toBe(false);
        expect(
          request.format.properties.statements.items.properties.citationId.enum,
        ).toEqual(["SECTION1"]);
        const claim = {
          answerText:
            nativeMode === "UNREVIEWED_CLAIM"
              ? "An unreviewed actor approved shipment SR-41 on 14 August 2024."
              : writerStatement,
          statements: [
            {
              text:
                nativeMode === "UNREVIEWED_CLAIM"
                  ? "An unreviewed actor approved shipment SR-41 on 14 August 2024."
                  : writerStatement,
              citationId:
                nativeMode === "FORGED_CITATION" ? "SECTION9" : "SECTION1",
            },
          ],
          abstained: false,
        };
        return Buffer.from(
          JSON.stringify({
            model: request.model,
            done: true,
            done_reason: nativeMode === "TRUNCATED" ? "length" : "stop",
            prompt_eval_count: 420,
            eval_count: 62,
            message: { role: "assistant", content: JSON.stringify(claim) },
          }),
        );
      },
    };
    let base = "";
    let layeredBase = "";
    const headers = (i: number) => ({
      Authorization: "Bearer " + reviewers[i]!.token,
      "Content-Type": "application/json",
    });
    const bodyQuery = {
      subject: "",
      predicate: "approved",
      object: "shipment SR-41",
      requestedAnswerRole: "SUBJECT" as const,
      temporalScope: "on 14 August 2024",
    };
    const sourceProposition = {
      subject: "Elian Sora",
      predicate: "approved",
      object: "shipment SR-41",
      temporalScope: "on 14 August 2024",
      quote: { startOffset: 0, endOffset: writerStatement.length },
    };
    const proposal = (question: string, queryProposition: unknown) => ({
      spaceId,
      vaultId,
      documentId: docId,
      unitId: null,
      sourceId,
      question,
      excerpt: writerStatement,
      queryProposition,
      sourceProposition,
    });
    const post = async (route: string, user: number, payload?: unknown) =>
      fetch(base + route, {
        method: "POST",
        headers: {
          ...headers(user),
          "Idempotency-Key": randomUUID() + "-" + randomUUID(),
        },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(20_000),
      });
    const approvedRecord = async (question: string, queryProp: unknown) => {
      const proposed = await post(
        "/v1/s2/proposition-reviews",
        0,
        proposal(question, queryProp),
      );
      const p = (await proposed.json()) as { id?: string; code?: string };
      expect(proposed.status, JSON.stringify(p)).toBe(201);
      expect(p.id).toBeTruthy();
      const same = await post(
        "/v1/s2/proposition-reviews/" + p.id + "/approve",
        0,
      );
      expect(same.status).toBe(409);
      const approved = await post(
        "/v1/s2/proposition-reviews/" + p.id + "/approve",
        1,
      );
      const a = await approved.json();
      expect(approved.status, JSON.stringify(a)).toBe(200);
      return p.id!;
    };
    beforeAll(async () => {
      db = new Postgres(process.env.DATABASE_URL!);
      store = new MinioObjectStore({
        endpoint: process.env.AKP_RAW_ENDPOINT!,
        accessKey: process.env.AKP_RAW_ACCESS_KEY!,
        secretKey: process.env.AKP_RAW_SECRET_KEY!,
        bucket: process.env.AKP_RAW_BUCKET!,
      });
      app = buildServer({ s2AtomicWriterProvider: pinnedAtomicProvider });
      layeredApp = buildServer({
        s2AtomicWriterProvider: pinnedAtomicProvider,
        evidenceVerifierMode: "LAYERED",
        evidenceVerifier: {
          id: "s2-lab-deny-untrusted-reader",
          verify: async () => ({
            decision: "INSUFFICIENT",
            reason: "S2_LAB_READER_WITHHELD",
          }),
        },
        evidenceAdmissionPipeline: new LayeredEvidenceAdmissionPipeline({
          semanticReader: {
            id: "s2-lab-no-unverified-semantic-fallback",
            read: async () => {
              throw new Error("S2_LAB_UNREVIEWED_READER_DENIED");
            },
          },
          structuredMismatchPolicy: "ABSTAIN",
        }),
      });
      await db.pool.query(
        "insert into organizations(id,slug,name) values($1,$2,'S2 live source evaluation')",
        [orgId, prefix],
      );
      await db.pool.query(
        "insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path) values($1,$2,$3,'S2 live','TEAM',$4)",
        [spaceId, orgId, prefix, "test/s2/" + spaceId],
      );
      for (let i = 0; i < reviewers.length; i++) {
        const reviewer = reviewers[i]!;
        await db.pool.query(
          "insert into users(id,email,display_name) values($1,$2,$3)",
          [
            reviewer.id,
            `s2-${i}-${orgId}@example.test`,
            "S2 simulated reviewer " + i,
          ],
        );
        await db.pool.query(
          "insert into memberships(user_id,space_id,role) values($1,$2,'ADMIN')",
          [reviewer.id, spaceId],
        );
      }
      await db.pool.query(
        `insert into vaults(id,space_id,canonical_path,name,read_only,current_revision,
        vault_key,local_path,visibility,enabled)
        values($1,$2,$3,'S2 disposable',true,'s2:r1',$4,$3,'TEAM',true)`,
        [vaultId, spaceId, "test/s2/" + vaultId, prefix + "-vault"],
      );
      for (const reviewer of reviewers) {
        await grantVaultMembership(db, {
          userId: reviewer.id,
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
          "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,$3,$4::jsonb)",
          [
            reviewer.id,
            sha(reviewer.token),
            "s2 disposable integration",
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
          ],
        );
      }
      await db.pool.query(
        `insert into vault_index_revisions(space_id,vault_id,corpus_revision,
          lexical_revision,vector_revision,graph_revision,context_pack_revision,
          status,warnings)
          values($1,$2,'s2:r1','s2:r1','s2:r1','s2:r1','s2:r1','CONSISTENT','[]'::jsonb)`,
        [spaceId, vaultId],
      );
      const ref = await store.putImmutable({
        stream: Readable.from([raw]),
        mediaType: "text/markdown",
        expectedSha256: sha(raw),
      });
      await db.pool.query(
        `insert into sources(id,space_id,vault_id,title,source_uri,
        media_type,sha256,byte_size,object_key,status,metadata)
        values($1,$2,$3,'S2 SOURCE',$4,'text/markdown',$5,$6,$7,'ACTIVE','{}'::jsonb)`,
        [
          sourceId,
          spaceId,
          vaultId,
          "https://example.test/s2-" + orgId,
          ref.sha256,
          ref.bytes,
          ref.key,
        ],
      );
      await db.pool.query(
        `insert into knowledge_documents(id,space_id,vault_id,path,external_id,
        aliases,title,type,lifecycle,trust_tier,current_revision,body_cache,
        frontmatter,layer,content_hash,token_estimate,raw_links)
        values($1,$2,$3,$4,$5,'{}','S2 SOURCE','claim','ACTIVE',
         'HUMAN_REVIEWED','s2:r1',$6,'{}'::jsonb,'concept',$7,50,'[]'::jsonb)`,
        [
          docId,
          spaceId,
          vaultId,
          documentPath,
          "s2:" + docId,
          writerStatement,
          sha(writerStatement),
        ],
      );
      await db.pool.query(
        `insert into evidence(id,space_id,vault_id,source_id,locator,content_hash,
        excerpt,review_status)
        values($1,$2,$3,$4,$5::jsonb,$6,$7,'REVIEWED')`,
        [
          evidenceId,
          spaceId,
          vaultId,
          sourceId,
          JSON.stringify({
            kind: "source",
            path: "source:" + sourceId,
            source_hash: sha(raw),
          }),
          sha(writerStatement),
          writerStatement,
        ],
      );
      await db.pool.query(
        "insert into document_evidence(document_id,evidence_id,relation_type) values($1,$2,'supported_by')",
        [docId, evidenceId],
      );
      const packet = {
        packetMode: "FULL_CONTEXT_PACKET",
        packetId,
        query: originalQuestion,
        intent: "FACT_LOOKUP",
        corpusRevision: "s2:r1",
        status: "SUPPORTED",
        indexRevisions: {},
        retrievalConfiguration: {},
        scope: { spaceId, vaultIds: [vaultId], federated: false },
        generatedAt: new Date().toISOString(),
        budget: {
          maxTokens: 512,
          usedTokens: 40,
          contentTokens: 25,
          metadataTokens: 15,
          serializedTokens: 40,
          tokenizer: {
            id: "s2-test",
            label: "s2-test",
            quality: "EXACT",
            approximate: false,
            source: "injected",
          },
        },
        mode: "SOURCE_BACKED",
        requestedContextLevel: "L2",
        searchedChannels: ["lexical"],
        sections: [
          {
            kind: "source",
            contextLevel: "L2",
            title: "S2 SOURCE",
            content: writerStatement,
            documentId: docId,
            vaultId,
            document: {
              externalId: "s2:" + docId,
              path: documentPath,
              title: "S2 SOURCE",
            },
            documentRevision: "s2:r1",
            selectionReason: "authorized-fixture",
            sourceOrEvidenceIds: [evidenceId],
          },
        ],
        citations: ["SEC1"],
        gaps: [],
        conflicts: [],
        requiredActions: [],
        recommendedActions: [],
        continuations: [],
        packetHash,
      };
      await db.pool.query(
        `insert into context_packets(id,space_id,vault_id,actor_id,
        corpus_revision,query_hash,packet_hash,request,packet,scope)
        values($1,$2,$3,$4,'s2:r1',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
        [
          packetId,
          spaceId,
          vaultId,
          reviewers[0]!.id,
          sha(originalQuestion),
          packetHash,
          JSON.stringify({ query: originalQuestion, spaceId, vaultId }),
          JSON.stringify(packet),
          JSON.stringify({ spaceId, vaultIds: [vaultId], federated: false }),
        ],
      );
      await app.ready();
      base = await app.listen({ host: "127.0.0.1", port: 0 });
      layeredBase = await layeredApp.listen({ host: "127.0.0.1", port: 0 });
    }, 90_000);
    afterAll(async () => {
      await layeredApp.close();
      await app.close();
      await db.close();
      // The entire disposable Compose project is removed after the test. Never
      // point this test at a persistent production or developer database.
    }, 30_000);
    it("denies premature review, approves two distinct test identities, and verifies Writer over HTTP", async () => {
      const denied = await post("/v1/s2/proposition-reviews", 0, {
        ...proposal(originalQuestion, bodyQuery),
        excerpt: "This excerpt did not come from SOURCE.",
      });
      expect(denied.status).toBe(409);
      await approvedRecord(originalQuestion, bodyQuery);
      await approvedRecord(writerStatement, {
        subject: "Elian Sora",
        predicate: "approved",
        object: "shipment SR-41",
        temporalScope: "on 14 August 2024",
      });
      const response = await post("/v1/s2/writer-claims/audit", 0, {
        packetId,
        packetHash,
        answerText: writerStatement,
        statements: [
          {
            text: writerStatement,
            startUtf16: 0,
            endUtf16: writerStatement.length,
            citationId: "SEC1",
          },
        ],
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({
        status: "SOURCE_BOUND_CLAIMS_CANDIDATE",
        productionAdmission: false,
        releaseGateAccepted: false,
        fullAuthenticatedWriterRoundTripIndependentlyVerified: false,
      });
      const forged = await post("/v1/s2/writer-claims/audit", 0, {
        packetId,
        packetHash,
        answerText: writerStatement,
        statements: [
          {
            text: writerStatement,
            startUtf16: 0,
            endUtf16: writerStatement.length,
            citationId: "SEC2",
          },
        ],
      });
      expect(forged.status).toBe(400);
    }, 45_000);
    it("enforces explicitly reviewed Spanish question and Writer claims over EN SOURCE", async () => {
      const esQuestion =
        "¿Quién aprobó el envío SR-41 el 14 de agosto de 2024?";
      const esStatement =
        "Elian Sora aprobó el envío SR-41 el 14 de agosto de 2024.";
      await approvedRecord(esQuestion, bodyQuery);
      await approvedRecord(esStatement, {
        subject: "Elian Sora",
        predicate: "approved",
        object: "shipment SR-41",
        temporalScope: "on 14 August 2024",
      });
      const snapshot = await db.pool.query<{ packet: Record<string, unknown> }>(
        "select packet from context_packets where id=$1",
        [packetId],
      );
      const id = randomUUID();
      const digest = sha("s2:es:" + id);
      esPacketId = id;
      esPacketHash = digest;
      const packet = {
        ...snapshot.rows[0]!.packet,
        packetId: id,
        packetHash: digest,
        query: esQuestion,
      };
      await db.pool.query(
        `insert into context_packets(id,space_id,vault_id,actor_id,corpus_revision,
          query_hash,packet_hash,request,packet,scope)
         values($1,$2,$3,$4,'s2:r1',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
        [
          id,
          spaceId,
          vaultId,
          reviewers[0]!.id,
          sha(esQuestion),
          digest,
          JSON.stringify({ query: esQuestion, spaceId, vaultId }),
          JSON.stringify(packet),
          JSON.stringify({ spaceId, vaultIds: [vaultId], federated: false }),
        ],
      );
      const response = await post("/v1/s2/writer-claims/audit", 0, {
        packetId: id,
        packetHash: digest,
        answerText: esStatement,
        statements: [
          {
            text: esStatement,
            startUtf16: 0,
            endUtf16: esStatement.length,
            citationId: "SEC1",
          },
        ],
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({
        status: "SOURCE_BOUND_CLAIMS_CANDIDATE",
        productionAdmission: false,
      });
    }, 45_000);
    it("retrieves the newly indexed SOURCE via actual authenticated /v1/context HTTP", async () => {
      const response = await post("/v1/context", 0, {
        query: originalQuestion,
        spaceId,
        vaultId,
        mode: "SOURCE_BACKED",
        packetMode: "FULL_CONTEXT_PACKET",
        contextLevel: "L2",
        limit: 6,
        maxTokens: 1200,
      });
      const content = (await response.json()) as {
        packetMode?: string;
        status?: string;
        packetId?: string;
        sections?: {
          documentId?: string;
          content?: string;
          selectionReason?: string;
        }[];
        code?: string;
        gaps?: string[];
      };
      expect(
        response.status,
        JSON.stringify({
          code: content.code,
          status: content.status,
          gaps: content.gaps,
        }),
      ).toBe(200);
      expect(content.packetMode).toBe("FULL_CONTEXT_PACKET");
      expect(content.packetId).toBeTruthy();
      // With a correctly typed factual 'claim' and matched index revision,
      // even the deterministic path can return supported material; this does
      // not prove the Writer's requested role or its generated answer.
      expect(content.status).toBe("SUPPORTED");
      const start = performance.now();
      const layeredResponse = await fetch(layeredBase + "/v1/context", {
        method: "POST",
        headers: {
          ...headers(0),
          "Idempotency-Key": randomUUID() + "-" + randomUUID(),
        },
        body: JSON.stringify({
          query: originalQuestion,
          spaceId,
          vaultId,
          mode: "SOURCE_BACKED",
          packetMode: "FULL_CONTEXT_PACKET",
          contextLevel: "L2",
          limit: 6,
          maxTokens: 1200,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const elapsedMs = performance.now() - start;
      const candidate = (await layeredResponse.json()) as {
        status?: string;
        sections?: { documentId?: string; content?: string }[];
        gaps?: string[];
        code?: string;
      };
      expect(
        layeredResponse.status,
        JSON.stringify({
          code: candidate.code,
          status: candidate.status,
          gaps: candidate.gaps,
        }),
      ).toBe(200);
      console.log(
        "S2_LIVE_RETRIEVAL_DIAGNOSTIC",
        JSON.stringify({
          baseline: content.status,
          baselineSections: content.sections?.length,
          baselineGaps: content.gaps,
          layered: candidate.status,
          layeredSections: candidate.sections?.length,
          layeredGaps: candidate.gaps,
        }),
      );
      expect(candidate.status).toBe("SUPPORTED");
      expect(
        candidate.sections?.some(
          (s) => s.documentId === docId && s.content?.includes("Elian Sora"),
        ),
      ).toBe(true);
      expect(elapsedMs).toBeGreaterThan(0);
    }, 45_000);
    it("runs native atomic Writer against immutable original source then the SAME HTTP claim audit owner", async () => {
      const before = nativeCallCount;
      const resp = await post("/v1/s2/writer-claims/generate-audit", 0, {
        packetId,
        packetHash,
        language: "en",
      });
      const result = await resp.json();
      expect(resp.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({
        status: "SOURCE_BOUND_CLAIMS_CANDIDATE",
        modelInvoked: true,
        model: "s2-synthetic-model:latest",
        claimCount: 1,
        testedClaims: 1,
        productionAdmission: false,
        releaseGateAccepted: false,
        fullAuthenticatedWriterRoundTripIndependentlyVerified: false,
      });
      expect(result).not.toHaveProperty("answerText");
      expect(result).not.toHaveProperty("originalSourceText");
      expect(nativeCallCount).toBe(before + 1);
      nativeMode = "FORGED_CITATION";
      const forged = await post("/v1/s2/writer-claims/generate-audit", 0, {
        packetId,
        packetHash,
        language: "en",
      });
      expect(forged.status).toBe(200);
      expect(await forged.json()).toMatchObject({
        status: "WITHHELD_PROVIDER_OUTPUT",
        reason: "CLAIM_GAP_OR_UNAUTHORIZED_CITATION",
        productionAdmission: false,
        releaseGateAccepted: false,
      });
      nativeMode = "TRUNCATED";
      const truncated = await post("/v1/s2/writer-claims/generate-audit", 0, {
        packetId,
        packetHash,
        language: "en",
      });
      expect(truncated.status).toBe(200);
      expect(await truncated.json()).toMatchObject({
        status: "WITHHELD_PROVIDER_OUTPUT",
        reason: "PROVIDER_NOT_FULLY_COMPLETED",
      });
      nativeMode = "UNREVIEWED_CLAIM";
      const unreviewed = await post("/v1/s2/writer-claims/generate-audit", 0, {
        packetId,
        packetHash,
        language: "en",
      });
      expect(unreviewed.status).toBe(200);
      expect(await unreviewed.json()).toMatchObject({
        status: "WITHHELD_WRITER_STATEMENT_REVIEW",
        productionAdmission: false,
        releaseGateAccepted: false,
      });
      nativeMode = "GOOD";
      const unrelated = await post("/v1/s2/writer-claims/generate-audit", 1, {
        packetId,
        packetHash,
        language: "en",
      });
      expect(unrelated.status).toBe(404);
      expect(nativeCallCount).toBe(before + 4);
    }, 60000);
    it("withholds an unreviewed new natural-language question BEFORE calling the model", async () => {
      const question = "Who approved shipment SR-42 on 14 August 2024?";
      const snapshot = await db.pool.query<{ packet: Record<string, unknown> }>(
        "select packet from context_packets where id=$1",
        [packetId],
      );
      const id = randomUUID(),
        digest = sha("negative:" + id);
      const packet = {
        ...snapshot.rows[0]!.packet,
        packetId: id,
        packetHash: digest,
        query: question,
      };
      await db.pool.query(
        `insert into context_packets(id,space_id,vault_id,actor_id,
          corpus_revision,query_hash,packet_hash,request,packet,scope)
          values($1,$2,$3,$4,'s2:r1',$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
        [
          id,
          spaceId,
          vaultId,
          reviewers[0]!.id,
          sha(question),
          digest,
          JSON.stringify({ query: question, spaceId, vaultId }),
          JSON.stringify(packet),
          JSON.stringify({ spaceId, vaultIds: [vaultId], federated: false }),
        ],
      );
      const before = nativeCallCount;
      const resp = await post("/v1/s2/writer-claims/generate-audit", 0, {
        packetId: id,
        packetHash: digest,
        language: "en",
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({
        status: "WITHHELD_UNREVIEWED_QUESTION_OR_SOURCE",
        modelInvoked: false,
        productionAdmission: false,
        releaseGateAccepted: false,
      });
      expect(nativeCallCount).toBe(before);
    }, 45000);
    const itRealNative =
      process.env.AKP_S2_ATOMIC_WRITER_REAL_PROVIDER_TEST === "true"
        ? it
        : it.skip;
    itRealNative(
      "uses real pinned local Ollama through authenticated HTTP, retaining every release gate",
      async () => {
        const realProvider = new S2PinnedLocalOllamaWriter({
          model: process.env.AKP_S2_REAL_NATIVE_MODEL ?? "",
          modelDigestSha256: process.env.AKP_S2_REAL_NATIVE_DIGEST ?? "",
          codeCommitSha: process.env.AKP_BUILD_COMMIT_SHA ?? "",
        });
        const liveApp = buildServer({ s2AtomicWriterProvider: realProvider });
        let endpoint = "";
        try {
          await liveApp.ready();
          endpoint = await liveApp.listen({ host: "127.0.0.1", port: 0 });
          for (const [language, id, digest] of [
            ["en", packetId, packetHash],
            ["es", esPacketId, esPacketHash],
          ] as const) {
            const before = performance.now();
            const response = await fetch(
              endpoint + "/v1/s2/writer-claims/generate-audit",
              {
                method: "POST",
                headers: {
                  ...headers(0),
                  "Idempotency-Key": randomUUID() + "-" + randomUUID(),
                },
                body: JSON.stringify({
                  packetId: id,
                  packetHash: digest,
                  language,
                }),
                signal: AbortSignal.timeout(28000),
              },
            );
            const receipt = (await response.json()) as Record<string, unknown>;
            expect([200, 503]).toContain(response.status);
            expect(receipt.productionAdmission).toBe(false);
            expect(receipt.releaseGateAccepted).toBe(false);
            expect(receipt).not.toHaveProperty("answerText");
            expect(receipt).not.toHaveProperty("sourceOriginalText");
            console.log(
              "S2_REAL_ATOMIC_WRITER_REDACTED_DIAGNOSTIC",
              JSON.stringify({
                language,
                httpStatus: response.status,
                status: receipt.status ?? receipt.code,
                modelInvoked: receipt.modelInvoked ?? false,
                claimCount: receipt.claimCount ?? 0,
                testedClaims: receipt.testedClaims ?? 0,
                providerMs: receipt.providerMs ?? null,
                fullHttpMs: Math.round(performance.now() - before),
                releaseGateAccepted: false,
              }),
            );
          }
        } finally {
          await liveApp.close();
        }
      },
      60000,
    );
    it("rechecks revocation and current vault authorization on subsequent HTTP audits", async () => {
      const approved = await db.pool.query<{ id: string }>(
        "select id from s2_reviewed_source_propositions where space_id=$1 and document_id=$2 and question_text=$3 and status='APPROVED' order by created_at desc limit 1",
        [spaceId, docId, writerStatement],
      );
      expect(approved.rows).toHaveLength(1);
      const revoked = await post(
        "/v1/s2/proposition-reviews/" + approved.rows[0]!.id + "/revoke",
        1,
      );
      expect(revoked.status).toBe(200);
      const replay = await post("/v1/s2/writer-claims/audit", 0, {
        packetId,
        packetHash,
        answerText: writerStatement,
        statements: [
          {
            text: writerStatement,
            startUtf16: 0,
            endUtf16: writerStatement.length,
            citationId: "SEC1",
          },
        ],
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        status: "WITHHELD_WRITER_STATEMENT_REVIEW",
        productionAdmission: false,
      });
      await db.pool.query(
        "update vault_memberships set enabled=false where user_id=$1 and vault_id=$2",
        [reviewers[0]!.id, vaultId],
      );
      const denied = await post("/v1/s2/writer-claims/audit", 0, {
        packetId,
        packetHash,
        answerText: writerStatement,
        statements: [
          {
            text: writerStatement,
            startUtf16: 0,
            endUtf16: writerStatement.length,
            citationId: "SEC1",
          },
        ],
      });
      expect([401, 403]).toContain(denied.status);
    }, 45_000);
  },
);
