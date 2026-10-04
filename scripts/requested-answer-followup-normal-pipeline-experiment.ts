import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildEmbeddingIndex } from "../packages/indexing/src/index.js";
import {
  assertSyntheticFixtureDatabaseSafety,
  Postgres,
} from "../packages/postgres/src/index.js";
import {
  assessRetrievalAnswerability,
  LocalSemanticEmbeddingAdapter,
  parseKnowledgeUnits,
  projectRequestedAnswerSlot,
  QueryEmbeddingService,
  retrievalAnswerabilityCandidateKey,
  runRequestedAnswerFollowUp,
  type RequestedAnswerSupportAssessment,
} from "../packages/retrieval/src/index.js";
import { queryKnowledge } from "../apps/api/src/routes/search.js";

type RegisteredDocument = {
  id: string;
  title: string;
  aliases: string[];
  sourcePath: string;
  related: string[];
  evidence: string[];
  citations: string[];
};

type RegisteredVault = {
  id: string;
  kind: string;
  documents: RegisteredDocument[];
};

type RegisteredManifest = {
  schemaVersion: number;
  evidenceLevel: string;
  name: string;
  description: string;
  vaults: RegisteredVault[];
};

type GoldPredicate = {
  id: string;
  document: string;
  all_terms: string[];
  any_terms?: string[];
};

type GoldCase = {
  id: string;
  category: string;
  query: string;
  gold_documents: string[];
  gold_support?: GoldPredicate[];
  expect_no_answer?: boolean;
  vault: string;
  critical?: boolean;
  slice?: string;
};

type ExperimentManifest = {
  schemaVersion: string;
  frozen: boolean;
  frozenAt: string;
  baselineSha: string;
  sourceInputs: {
    corpusManifest: { path: string; gitBlobSha: string };
    cases: { path: string; gitBlobSha: string };
    selectionPolicy: string;
  };
  protocol: {
    independentVariable: string;
    developmentVault: string;
    heldoutVault: string;
    noTuningAfterHeldout: boolean;
    retrievalConfiguration: {
      channels: string[];
      embeddingProvider: string;
      deterministicRerank: boolean;
      queryTransformation: boolean;
      presentationLimit: number;
    };
    productionBehaviorChanged: boolean;
    productionAdmissionChanged: boolean;
    routeWiringChanged: boolean;
    relevanceCanGrantSupport: boolean;
  };
  casePolicy: {
    primaryLabels: string[];
    controls: string[];
    totalRegisteredCases: number;
    primaryCaseIds: string[];
    controlCaseIds: string[];
  };
  decisionRule: {
    requiredInvariantGates: {
      maxFollowUpAttemptsPerCase: number;
      unsupportedQueryFollowUpRate: number;
      reassessmentUsesOriginalQueryRate: number;
      newCrossVaultViolationCount: number;
      newWrongGoldDocumentAdmissionCount: number;
      productionBehaviorChanged: boolean;
      productionAdmissionChanged: boolean;
      routeWiringChanged: boolean;
      relevanceCanGrantSupport: boolean;
    };
    qualityFrontier: {
      developmentAnswerableAdmissionRecallNonRegression: boolean;
      heldoutAnswerableAdmissionRecallNonRegression: boolean;
      developmentGoldSupportRecallNonRegression: boolean;
      heldoutGoldSupportRecallNonRegression: boolean;
      developmentNoAnswerFalseAcceptanceNonRegression: boolean;
      heldoutNoAnswerFalseAcceptanceNonRegression: boolean;
      criticalCaseNonRegression: boolean;
      requireAtLeastOneCorrectHeldoutRecoveryForPromotion: boolean;
    };
    outcomes: {
      promote: string;
      noAdvantage: string;
      regression: string;
      invalid: string;
    };
    claimBoundary: string;
  };
};

type ResolvedDocument = RegisteredDocument & { body: string };
type ResolvedVault = Omit<RegisteredVault, "documents"> & {
  documents: ResolvedDocument[];
};
type ResolvedManifest = Omit<RegisteredManifest, "vaults"> & {
  vaults: ResolvedVault[];
};

type Fixture = {
  organizationId: string;
  spaceId: string;
  corpusRevision: string;
  vaultIds: Map<string, string>;
  documentIds: Map<string, string>;
};

type QueryHit = Awaited<ReturnType<typeof queryKnowledge>>[number];

type ArmObservation = {
  supported: boolean;
  reason: string;
  admittedDocumentIds: string[];
  admittedCandidateKeys: string[];
  goldDocumentRecovered: boolean;
  goldSupportRecovered: string[];
  falseAcceptance: boolean;
  wrongGoldDocumentAdmission: boolean;
  crossVaultViolation: boolean;
};

type CaseObservation = {
  id: string;
  vault: string;
  category: string;
  slice: string;
  critical: boolean;
  primary: boolean;
  query: string;
  projection: ReturnType<typeof projectRequestedAnswerSlot>;
  expectedNoAnswer: boolean;
  goldDocuments: string[];
  goldSupportIds: string[];
  baseline: ArmObservation;
  candidate: ArmObservation;
  followUp: {
    outcome: string;
    coverageStatus: string;
    followUpAttemptCount: number;
    followUpQuery: string | null;
    assessmentQueries: string[];
  };
  correctRecovery: boolean;
  regressed: boolean;
};

const root = path.resolve(".");
const experimentManifestPath = path.resolve(
  "evals/registered/requested-answer-followup-normal-pipeline.json",
);
const outputPath = path.resolve(
  process.env.AKP_REQUESTED_ANSWER_FOLLOWUP_NORMAL_REPORT ??
    "reports/ci/requested-answer-followup-normal-pipeline.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US");
}

function passageMatchesPredicate(
  passage: string,
  predicate: GoldPredicate,
): boolean {
  const normalized = normalize(passage);
  const all = predicate.all_terms.every((term) =>
    normalized.includes(normalize(term)),
  );
  const any =
    !predicate.any_terms?.length ||
    predicate.any_terms.some((term) => normalized.includes(normalize(term)));
  return all && any;
}

function gitBlobSha(filePath: string): string {
  return execFileSync("git", ["hash-object", filePath], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function assertAncestor(sha: string): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
}

async function loadInputs() {
  const experimentRaw = await readFile(experimentManifestPath, "utf8");
  const experiment = JSON.parse(experimentRaw) as ExperimentManifest;
  if (
    experiment.schemaVersion !==
      "akp.requested-answer-followup-normal-pipeline.v1" ||
    experiment.frozen !== true ||
    experiment.protocol.noTuningAfterHeldout !== true ||
    experiment.protocol.productionBehaviorChanged !== false ||
    experiment.protocol.productionAdmissionChanged !== false ||
    experiment.protocol.routeWiringChanged !== false ||
    experiment.protocol.relevanceCanGrantSupport !== false
  ) {
    throw new Error("Normal-pipeline follow-up protocol drifted.");
  }
  assertAncestor(experiment.baselineSha);

  const corpusPath = path.resolve(experiment.sourceInputs.corpusManifest.path);
  const casesPath = path.resolve(experiment.sourceInputs.cases.path);
  if (
    gitBlobSha(corpusPath) !== experiment.sourceInputs.corpusManifest.gitBlobSha ||
    gitBlobSha(casesPath) !== experiment.sourceInputs.cases.gitBlobSha
  ) {
    throw new Error("Registered public corpus inputs changed after freeze.");
  }

  const corpusRaw = await readFile(corpusPath, "utf8");
  const casesRaw = await readFile(casesPath, "utf8");
  const parsed = JSON.parse(corpusRaw) as RegisteredManifest;
  const cases = casesRaw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoldCase);
  if (cases.length !== experiment.casePolicy.totalRegisteredCases) {
    throw new Error("Registered case count changed after freeze.");
  }

  const expectedIds = new Set([
    ...experiment.casePolicy.primaryCaseIds,
    ...experiment.casePolicy.controlCaseIds,
  ]);
  const actualIds = new Set(cases.map((entry) => entry.id));
  if (
    expectedIds.size !== cases.length ||
    [...expectedIds].some((id) => !actualIds.has(id))
  ) {
    throw new Error("Frozen case selection no longer matches registered cases.");
  }

  const vaults: ResolvedVault[] = [];
  const hashes: Record<string, string> = {
    [experiment.sourceInputs.corpusManifest.path]: sha256(corpusRaw),
    [experiment.sourceInputs.cases.path]: sha256(casesRaw),
    [path.relative(root, experimentManifestPath).replaceAll("\\", "/")]:
      sha256(experimentRaw),
  };
  for (const vault of parsed.vaults) {
    const documents: ResolvedDocument[] = [];
    for (const document of vault.documents) {
      const absolute = path.resolve(root, document.sourcePath);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          `Registered corpus path escapes repository: ${document.sourcePath}`,
        );
      }
      const body = await readFile(absolute, "utf8");
      hashes[document.sourcePath] = sha256(body);
      documents.push({ ...document, body });
    }
    vaults.push({ ...vault, documents });
  }

  return {
    experiment,
    experimentHash: sha256(experimentRaw),
    corpus: { ...parsed, vaults } as ResolvedManifest,
    cases,
    hashes,
  };
}

function createFixture(manifest: ResolvedManifest): Fixture {
  return {
    organizationId: randomUUID(),
    spaceId: randomUUID(),
    corpusRevision: `requested-answer-followup-${randomUUID()}`,
    vaultIds: new Map(manifest.vaults.map((vault) => [vault.id, randomUUID()])),
    documentIds: new Map(
      manifest.vaults.flatMap((vault) =>
        vault.documents.map((document) => [document.id, randomUUID()] as const),
      ),
    ),
  };
}

async function seedCorpus(
  db: Postgres,
  manifest: ResolvedManifest,
  fixture: Fixture,
): Promise<void> {
  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,$3)",
    [
      fixture.organizationId,
      `requested-answer-${fixture.organizationId.slice(0, 8)}`,
      "Requested answer follow-up normal-pipeline benchmark",
    ],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,$4,'PRIVATE',$5)`,
    [
      fixture.spaceId,
      fixture.organizationId,
      `requested-answer-${fixture.spaceId.slice(0, 8)}`,
      "Requested answer follow-up normal-pipeline benchmark",
      `benchmark/requested-answer/${fixture.spaceId}`,
    ],
  );

  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId) throw new Error(`Missing vault mapping for ${vault.id}`);
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        fixture.spaceId,
        `benchmark/requested-answer/${vault.id}`,
        `Requested answer ${vault.kind}`,
        fixture.corpusRevision,
        `requested-answer-${vault.id}-${vaultId.slice(0, 8)}`,
      ],
    );
    await db.pool.query(
      `insert into vault_index_revisions(
         space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
         graph_revision,context_pack_revision,status,warnings
       ) values($1,$2,$3,$3,$3,$3,$3,'CONSISTENT','[]'::jsonb)`,
      [fixture.spaceId, vaultId, fixture.corpusRevision],
    );

    for (const document of vault.documents) {
      const documentId = fixture.documentIds.get(document.id);
      if (!documentId) {
        throw new Error(`Missing document mapping for ${document.id}`);
      }
      const contentHash = sha256(document.body);
      await db.pool.query(
        `insert into knowledge_documents(
           id,space_id,vault_id,path,external_id,title,type,lifecycle,
           trust_tier,current_revision,body_cache,frontmatter,aliases,layer,
           content_hash,token_estimate,raw_links
         ) values($1,$2,$3,$4,$5,$6,'concept','ACTIVE','HUMAN_REVIEWED',
                  $7,$8,$9::jsonb,$10,'concept',$11,$12,'[]'::jsonb)`,
        [
          documentId,
          fixture.spaceId,
          vaultId,
          document.sourcePath,
          document.id,
          document.title,
          fixture.corpusRevision,
          document.body,
          JSON.stringify({
            id: document.id,
            title: document.title,
            knowledge_layer: "concept",
            benchmark_corpus: manifest.name,
            source_path: document.sourcePath,
            experiment: "requested-answer-followup-normal-pipeline",
          }),
          document.aliases,
          contentHash,
          Math.max(1, document.body.split(/\s+/u).length),
        ],
      );

      const parsedUnits = parseKnowledgeUnits(document.title, document.body);
      const unitIds = new Map(
        parsedUnits.map((unit) => [unit.unitKey, randomUUID()] as const),
      );
      for (const unit of parsedUnits) {
        const unitId = unitIds.get(unit.unitKey);
        if (!unitId) throw new Error(`Missing unit id for ${unit.unitKey}`);
        const parentUnitId = unit.parentUnitKey
          ? (unitIds.get(unit.parentUnitKey) ?? null)
          : null;
        await db.pool.query(
          `insert into knowledge_units(
             id,document_id,space_id,vault_id,unit_key,unit_type,heading_path,
             body,content_hash,corpus_revision,document_revision,lifecycle,
             trust_tier,source_ids,token_estimate,parent_unit_id,permissions,
             locator,structural_order,container_only,embedding_eligible
           ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'ACTIVE',
                    'HUMAN_REVIEWED',$11,$12,$13,'{}'::jsonb,$14::jsonb,
                    $15,$16,$17)`,
          [
            unitId,
            documentId,
            fixture.spaceId,
            vaultId,
            unit.unitKey,
            unit.unitType,
            unit.headingPath,
            unit.body,
            unit.contentHash,
            fixture.corpusRevision,
            document.evidence,
            unit.tokenEstimate,
            parentUnitId,
            JSON.stringify(unit.locator),
            unit.structuralOrder,
            unit.containerOnly,
            unit.embeddingEligible,
          ],
        );
      }
    }
  }
}

async function buildEmbeddings(
  db: Postgres,
  manifest: ResolvedManifest,
  fixture: Fixture,
  adapter: LocalSemanticEmbeddingAdapter,
) {
  const generations = [];
  for (const vault of manifest.vaults) {
    const vaultId = fixture.vaultIds.get(vault.id);
    if (!vaultId) throw new Error(`Missing vault mapping for ${vault.id}`);
    const built = await buildEmbeddingIndex(db, {
      spaceId: fixture.spaceId,
      vaultId,
      corpusRevision: fixture.corpusRevision,
      provider: adapter,
      activate: true,
      batchSize: 8,
    });
    if (!built.activated || built.generation.status !== "ACTIVE") {
      throw new Error(
        `Embedding generation did not activate for ${vault.id}`,
      );
    }
    generations.push({
      vault: vault.id,
      generationId: built.generation.generationId,
      status: built.generation.status,
      provider: built.generation.provider,
      model: built.generation.model,
      modelRevision: built.generation.modelRevision,
      dimensions: built.generation.dimensions,
      inputStrategy: built.generation.inputStrategy,
      configurationHash: built.generation.configurationHash,
    });
  }
  return generations;
}

async function cleanup(db: Postgres, fixture: Fixture): Promise<void> {
  const vaultIds = [...fixture.vaultIds.values()];
  await db.pool.query(
    `delete from unit_embeddings
      where generation_id in (
        select id from embedding_generations where vault_id=any($1::uuid[])
      )`,
    [vaultIds],
  );
  await db.pool.query(
    "delete from embedding_generations where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from knowledge_units where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query("delete from knowledge_documents where space_id=$1", [
    fixture.spaceId,
  ]);
  await db.pool.query(
    "delete from vault_index_revisions where vault_id=any($1::uuid[])",
    [vaultIds],
  );
  await db.pool.query("delete from vaults where id=any($1::uuid[])", [
    vaultIds,
  ]);
  await db.pool.query("delete from spaces where id=$1", [fixture.spaceId]);
  await db.pool.query("delete from organizations where id=$1", [
    fixture.organizationId,
  ]);
}

function supportAssessment(
  assessment: ReturnType<typeof assessRetrievalAnswerability>,
): RequestedAnswerSupportAssessment {
  return {
    supported: assessment.supported,
    reason: assessment.reason,
    supportedCandidateKeys: assessment.supportedCandidateKeys,
  };
}

function admitted(
  candidates: readonly QueryHit[],
  assessment: RequestedAnswerSupportAssessment,
  limit: number,
): QueryHit[] {
  const supported = new Set(assessment.supportedCandidateKeys);
  return candidates
    .filter((hit) => supported.has(retrievalAnswerabilityCandidateKey(hit)))
    .slice(0, limit);
}

function recoveredSupport(
  testCase: GoldCase,
  hits: readonly QueryHit[],
): string[] {
  return (testCase.gold_support ?? []).flatMap((predicate) =>
    hits.some(
      (hit) =>
        hit.document.externalId === predicate.document &&
        passageMatchesPredicate(
          hit.parentContext?.trim() || hit.excerpt,
          predicate,
        ),
    )
      ? [predicate.id]
      : [],
  );
}

function observeArm(
  testCase: GoldCase,
  hits: readonly QueryHit[],
  assessment: RequestedAnswerSupportAssessment,
  expectedVaultId: string,
): ArmObservation {
  const selected = admitted(hits, assessment, 10);
  const admittedDocumentIds = selected.flatMap((hit) =>
    hit.document.externalId ? [hit.document.externalId] : [],
  );
  const goldDocumentRecovered = testCase.gold_documents.some((documentId) =>
    admittedDocumentIds.includes(documentId),
  );
  const expectedNoAnswer = testCase.expect_no_answer === true;
  return {
    supported: assessment.supported,
    reason: assessment.reason,
    admittedDocumentIds,
    admittedCandidateKeys: assessment.supportedCandidateKeys.slice(0, 10),
    goldDocumentRecovered,
    goldSupportRecovered: recoveredSupport(testCase, selected),
    falseAcceptance: expectedNoAnswer && selected.length > 0,
    wrongGoldDocumentAdmission:
      !expectedNoAnswer &&
      testCase.gold_documents.length > 0 &&
      selected.length > 0 &&
      !goldDocumentRecovered,
    crossVaultViolation: hits.some((hit) => hit.vaultId !== expectedVaultId),
  };
}

function splitMetrics(rows: readonly CaseObservation[]) {
  const primary = rows.filter((row) => row.primary);
  const answerable = primary.filter((row) => !row.expectedNoAnswer);
  const noAnswer = primary.filter((row) => row.expectedNoAnswer);
  const goldSupportCount = answerable.reduce(
    (sum, row) => sum + row.goldSupportIds.length,
    0,
  );
  const arm = (key: "baseline" | "candidate") => ({
    answerableAdmissionRecall:
      answerable.length === 0
        ? 1
        : answerable.filter((row) => row[key].goldDocumentRecovered).length /
          answerable.length,
    goldSupportRecall:
      goldSupportCount === 0
        ? 1
        : answerable.reduce(
              (sum, row) => sum + row[key].goldSupportRecovered.length,
              0,
            ) / goldSupportCount,
    noAnswerFalseAcceptance:
      noAnswer.length === 0
        ? 0
        : noAnswer.filter((row) => row[key].falseAcceptance).length /
          noAnswer.length,
  });
  return {
    cases: primary.length,
    answerableCases: answerable.length,
    noAnswerCases: noAnswer.length,
    baseline: arm("baseline"),
    candidate: arm("candidate"),
    correctRecoveries: primary.filter((row) => row.correctRecovery).length,
    regressions: primary.filter((row) => row.regressed).map((row) => row.id),
  };
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
assertSyntheticFixtureDatabaseSafety(databaseUrl);

const previousVectorEnabled = process.env.AKP_VECTOR_ENABLED;
process.env.AKP_VECTOR_ENABLED = "true";
const db = new Postgres(databaseUrl);
const inputs = await loadInputs();
const fixture = createFixture(inputs.corpus);
const adapter = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 8,
});

try {
  await seedCorpus(db, inputs.corpus, fixture);
  await adapter.load();
  const generations = await buildEmbeddings(
    db,
    inputs.corpus,
    fixture,
    adapter,
  );
  const queryEmbeddingService = new QueryEmbeddingService(async () => adapter);
  const observations: CaseObservation[] = [];

  for (const testCase of inputs.cases) {
    const vaultId = fixture.vaultIds.get(testCase.vault);
    if (!vaultId) throw new Error(`Unknown case vault ${testCase.vault}`);

    const retrieve = async (query: string): Promise<readonly QueryHit[]> => {
      let answerabilityCandidates: readonly QueryHit[] | undefined;
      const rawHits = await queryKnowledge(
        db,
        {
          query,
          spaceId: fixture.spaceId,
          vaultId,
          vaultIds: [],
          federated: false,
          types: [],
          minimumTrust: "MACHINE_SUPPORTED",
          mode: "SOURCE_BACKED",
          limit:
            inputs.experiment.protocol.retrievalConfiguration.presentationLimit,
        },
        {
          vaultIds: [vaultId],
          channels: ["exact", "lexical", "vector"],
          allowVectorForBenchmark: true,
          deterministicRerank: false,
          queryEmbeddingService,
          answerabilityCandidateSink: (candidates) => {
            answerabilityCandidates = candidates;
          },
        },
      );
      return answerabilityCandidates ?? rawHits;
    };

    const initialCandidates = await retrieve(testCase.query);
    const initialAssessment = supportAssessment(
      assessRetrievalAnswerability(initialCandidates, testCase.query, {}, {
        comparisonHits: initialCandidates,
      }),
    );
    const assessmentQueries: string[] = [];
    const followUp = await runRequestedAnswerFollowUp({
      query: testCase.query,
      initialCandidates,
      initialAssessment,
      retrieve,
      assess: (candidates, originalQuery) => {
        assessmentQueries.push(originalQuery);
        return supportAssessment(
          assessRetrievalAnswerability(candidates, originalQuery, {}, {
            comparisonHits: candidates,
          }),
        );
      },
    });

    const baseline = observeArm(
      testCase,
      initialCandidates,
      initialAssessment,
      vaultId,
    );
    const candidate = observeArm(
      testCase,
      followUp.finalCandidates,
      followUp.finalAssessment,
      vaultId,
    );
    const primary = inputs.experiment.casePolicy.primaryCaseIds.includes(
      testCase.id,
    );
    const correctRecovery =
      primary &&
      followUp.followUpAttemptCount === 1 &&
      candidate.goldSupportRecovered.length >
        baseline.goldSupportRecovered.length &&
      candidate.goldDocumentRecovered;
    const regressed =
      primary &&
      (candidate.goldSupportRecovered.length <
        baseline.goldSupportRecovered.length ||
        (baseline.goldDocumentRecovered && !candidate.goldDocumentRecovered) ||
        (!baseline.falseAcceptance && candidate.falseAcceptance) ||
        (!baseline.wrongGoldDocumentAdmission &&
          candidate.wrongGoldDocumentAdmission));

    observations.push({
      id: testCase.id,
      vault: testCase.vault,
      category: testCase.category,
      slice: testCase.slice ?? testCase.category,
      critical: testCase.critical === true,
      primary,
      query: testCase.query,
      projection: projectRequestedAnswerSlot(testCase.query),
      expectedNoAnswer: testCase.expect_no_answer === true,
      goldDocuments: [...testCase.gold_documents],
      goldSupportIds: (testCase.gold_support ?? []).map(
        (predicate) => predicate.id,
      ),
      baseline,
      candidate,
      followUp: {
        outcome: followUp.outcome,
        coverageStatus: followUp.coverage.status,
        followUpAttemptCount: followUp.followUpAttemptCount,
        followUpQuery: followUp.followUpQuery,
        assessmentQueries,
      },
      correctRecovery,
      regressed,
    });
  }

  const development = splitMetrics(
    observations.filter(
      (row) => row.vault === inputs.experiment.protocol.developmentVault,
    ),
  );
  const heldout = splitMetrics(
    observations.filter(
      (row) => row.vault === inputs.experiment.protocol.heldoutVault,
    ),
  );
  const unsupportedRows = observations.filter(
    (row) => row.followUp.coverageStatus === "UNSUPPORTED_QUERY",
  );
  const unsupportedQueryFollowUpRate =
    unsupportedRows.length === 0
      ? 0
      : unsupportedRows.filter(
            (row) => row.followUp.followUpAttemptCount > 0,
          ).length / unsupportedRows.length;
  const reassessmentQueries = observations.flatMap(
    (row) => row.followUp.assessmentQueries,
  );
  const correctReassessmentQueries = observations.reduce(
    (sum, row) =>
      sum +
      row.followUp.assessmentQueries.filter((query) => query === row.query)
        .length,
    0,
  );
  const reassessmentUsesOriginalQueryRate =
    reassessmentQueries.length === 0
      ? 1
      : correctReassessmentQueries / reassessmentQueries.length;
  const maxFollowUpAttempts = Math.max(
    0,
    ...observations.map((row) => row.followUp.followUpAttemptCount),
  );
  const newCrossVaultViolationCount = observations.filter(
    (row) =>
      !row.baseline.crossVaultViolation && row.candidate.crossVaultViolation,
  ).length;
  const newWrongGoldDocumentAdmissionCount = observations.filter(
    (row) =>
      !row.baseline.wrongGoldDocumentAdmission &&
      row.candidate.wrongGoldDocumentAdmission,
  ).length;
  const criticalRegressions = observations
    .filter((row) => row.critical && row.regressed)
    .map((row) => row.id);

  const nonRegression = {
    developmentAnswerableAdmissionRecall:
      development.candidate.answerableAdmissionRecall >=
      development.baseline.answerableAdmissionRecall,
    heldoutAnswerableAdmissionRecall:
      heldout.candidate.answerableAdmissionRecall >=
      heldout.baseline.answerableAdmissionRecall,
    developmentGoldSupportRecall:
      development.candidate.goldSupportRecall >=
      development.baseline.goldSupportRecall,
    heldoutGoldSupportRecall:
      heldout.candidate.goldSupportRecall >= heldout.baseline.goldSupportRecall,
    developmentNoAnswerFalseAcceptance:
      development.candidate.noAnswerFalseAcceptance <=
      development.baseline.noAnswerFalseAcceptance,
    heldoutNoAnswerFalseAcceptance:
      heldout.candidate.noAnswerFalseAcceptance <=
      heldout.baseline.noAnswerFalseAcceptance,
    criticalCase: criticalRegressions.length === 0,
  };
  const gates = {
    maxFollowUpAttempts:
      maxFollowUpAttempts <=
      inputs.experiment.decisionRule.requiredInvariantGates
        .maxFollowUpAttemptsPerCase,
    unsupportedQueryFollowUpRate:
      unsupportedQueryFollowUpRate ===
      inputs.experiment.decisionRule.requiredInvariantGates
        .unsupportedQueryFollowUpRate,
    reassessmentUsesOriginalQueryRate:
      reassessmentUsesOriginalQueryRate ===
      inputs.experiment.decisionRule.requiredInvariantGates
        .reassessmentUsesOriginalQueryRate,
    newCrossVaultViolationCount:
      newCrossVaultViolationCount ===
      inputs.experiment.decisionRule.requiredInvariantGates
        .newCrossVaultViolationCount,
    newWrongGoldDocumentAdmissionCount:
      newWrongGoldDocumentAdmissionCount ===
      inputs.experiment.decisionRule.requiredInvariantGates
        .newWrongGoldDocumentAdmissionCount,
    productionBehaviorChanged:
      inputs.experiment.protocol.productionBehaviorChanged === false,
    productionAdmissionChanged:
      inputs.experiment.protocol.productionAdmissionChanged === false,
    routeWiringChanged: inputs.experiment.protocol.routeWiringChanged === false,
    relevanceCanGrantSupport:
      inputs.experiment.protocol.relevanceCanGrantSupport === false,
  };

  const invariantPass = Object.values(gates).every(Boolean);
  const qualityPass = Object.values(nonRegression).every(Boolean);
  const heldoutAdvantage = heldout.correctRecoveries > 0;
  const outcome = !invariantPass
    ? inputs.experiment.decisionRule.outcomes.invalid
    : !qualityPass
      ? inputs.experiment.decisionRule.outcomes.regression
      : heldoutAdvantage
        ? inputs.experiment.decisionRule.outcomes.promote
        : inputs.experiment.decisionRule.outcomes.noAdvantage;

  const report = {
    schemaVersion: inputs.experiment.schemaVersion,
    generatedAt: new Date().toISOString(),
    commit: currentCommit(),
    baselineSha: inputs.experiment.baselineSha,
    experimentManifestHash: inputs.experimentHash,
    sourceHashes: inputs.hashes,
    outcome,
    claimBoundary: inputs.experiment.decisionRule.claimBoundary,
    productionBehaviorChanged: false,
    productionAdmissionChanged: false,
    routeWiringChanged: false,
    retrievalConfiguration:
      inputs.experiment.protocol.retrievalConfiguration,
    fixture: {
      corpus: inputs.corpus.name,
      documents: inputs.corpus.vaults.reduce(
        (sum, vault) => sum + vault.documents.length,
        0,
      ),
      registeredCases: inputs.cases.length,
      primaryCases: inputs.experiment.casePolicy.primaryCaseIds.length,
      controlCases: inputs.experiment.casePolicy.controlCaseIds.length,
      generations,
    },
    metrics: {
      development,
      heldout,
      maxFollowUpAttempts,
      unsupportedQueryFollowUpRate,
      reassessmentUsesOriginalQueryRate,
      newCrossVaultViolationCount,
      newWrongGoldDocumentAdmissionCount,
      criticalRegressions,
    },
    gates,
    nonRegression,
    observations,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (!invariantPass) process.exitCode = 1;
} finally {
  try {
    await cleanup(db, fixture);
  } finally {
    await db.close();
    await adapter.dispose();
    if (previousVectorEnabled === undefined) {
      delete process.env.AKP_VECTOR_ENABLED;
    } else {
      process.env.AKP_VECTOR_ENABLED = previousVectorEnabled;
    }
  }
}
