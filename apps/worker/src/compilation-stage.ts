import {
  CompilationPlan,
  type ConfiguredKnowledgeCompiler,
  type KnowledgeCompilerResult,
} from "@akp/compiler";
import { StructuralLocator, type DocumentArtifact } from "@akp/contracts";
import { withSpan } from "@akp/observability";
import { resolveAuthorizedVaultScope, type Postgres } from "@akp/postgres";
import { renderDocumentArtifactDraft } from "./document-artifact.js";
import { assertEvidenceFragmentIntegrity } from "./evidence-fragment.js";
import { compileGroundedKnowledgeProposal } from "./knowledge-compilation.js";

interface EvidenceRow {
  id: string;
  locator: unknown;
  content_hash: string;
  excerpt: string | null;
}

interface VaultRow {
  schema_profile: Record<string, unknown>;
  current_revision: string | null;
}

interface PriorSourceRow {
  id: string;
  path: string;
  external_id: string | null;
  current_revision: string;
}

export interface CompilationStageInput {
  spaceId: string;
  vaultId: string | null;
  sourceId: string;
  sourceArtifactId: string;
  evidenceId: string;
  sha256: string;
  title: string;
  mediaType: string;
  extractor: string;
  extractorVersion: string;
  artifact: DocumentArtifact;
  vectorEnabled: boolean;
  requesterId?: string | null;
}

export interface CompilationStageMetadata {
  mode: "GENERATIVE" | "SOURCE_SUMMARY_FALLBACK";
  provider?: ConfiguredKnowledgeCompiler["descriptor"];
  retrievalChannels?: string[];
  retrievalWarnings?: string[];
  identity?: unknown;
  warnings?: string[];
  knowledgeCandidateCount?: number;
  contradictionCount?: number;
  compilerResult?: KnowledgeCompilerResult;
  reason?: string;
}

export interface CompilationStageOutput {
  plan: CompilationPlan;
  metadata: CompilationStageMetadata;
}

async function loadVaultContext(
  db: Postgres,
  spaceId: string,
  vaultId: string | null,
): Promise<{ schemaProfile: Record<string, unknown>; corpusRevision: string }> {
  if (!vaultId) {
    return { schemaProfile: {}, corpusRevision: "managed:initial" };
  }
  const result = await db.pool.query<VaultRow>(
    `
    select schema_profile,current_revision
      from vaults
     where id=$1 and space_id=$2 and enabled
     limit 1
    `,
    [vaultId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("COMPILER_VAULT_NOT_FOUND");
  return {
    schemaProfile: row.schema_profile ?? {},
    corpusRevision: row.current_revision ?? "managed:initial",
  };
}

async function loadEvidence(
  db: Postgres,
  input: CompilationStageInput & { vaultId: string },
): Promise<{
  id: string;
  sourceArtifactId: string;
  locator: ReturnType<typeof StructuralLocator.parse>;
  excerpt: string;
  excerptHash: string;
}> {
  const result = await db.pool.query<EvidenceRow>(
    `
    select id,locator,content_hash,excerpt
      from evidence
     where id=$1 and space_id=$2 and vault_id=$3
       and source_id=$4 and artifact_id=$5
     limit 1
    `,
    [
      input.evidenceId,
      input.spaceId,
      input.vaultId,
      input.sourceId,
      input.sourceArtifactId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("COMPILER_EVIDENCE_NOT_FOUND");
  if (!row.excerpt?.trim())
    throw new Error("COMPILER_EVIDENCE_EXCERPT_REQUIRED");
  if (!/^[a-f0-9]{64}$/.test(row.content_hash)) {
    throw new Error("COMPILER_EVIDENCE_HASH_INVALID");
  }
  const locator = StructuralLocator.parse(row.locator);
  assertEvidenceFragmentIntegrity(input.artifact, {
    locator,
    excerpt: row.excerpt,
    excerptHash: row.content_hash,
  });
  return {
    id: row.id,
    sourceArtifactId: input.sourceArtifactId,
    locator,
    excerpt: row.excerpt,
    excerptHash: row.content_hash,
  };
}

async function loadRetrievalPathPrefix(
  db: Postgres,
  input: CompilationStageInput,
): Promise<string | null> {
  if (!input.vaultId || !input.requesterId) return null;
  const scope = await resolveAuthorizedVaultScope(db, {
    userId: input.requesterId,
    spaceId: input.spaceId,
    vaultId: input.vaultId,
    permission: "knowledge:read",
    federated: false,
  });
  const access = scope.accessByVault[input.vaultId];
  if (!access) throw new Error("COMPILER_REQUESTER_SCOPE_DENIED");
  return access.pathPrefix;
}

async function validateCompilationPlan(
  plan: CompilationPlan,
  mode: CompilationStageMetadata["mode"],
): Promise<CompilationPlan> {
  return withSpan("compile.validate", { "akp.compiler.mode": mode }, async () =>
    CompilationPlan.parse(plan),
  );
}

async function sourceSummaryFallback(
  db: Postgres,
  input: CompilationStageInput,
  corpusRevision: string,
  pathPrefix: string | null,
): Promise<CompilationPlan> {
  const priorSource = await db.pool.query<PriorSourceRow>(
    `
    select id,path,external_id,current_revision
      from knowledge_documents
     where space_id=$1
       and (($2::uuid is null and vault_id is null) or vault_id=$2::uuid)
       and (frontmatter->>'source_id'=$3 or frontmatter->>'source_sha256'=$4)
       and ($5::text is null or path=$5 or path like $5 || '/%')
       and lifecycle in ('ACTIVE','DISPUTED')
     order by updated_at desc
     limit 1
    `,
    [input.spaceId, input.vaultId, input.sourceId, input.sha256, pathPrefix],
  );
  const prior = priorSource.rows[0];
  const externalId = `SRC-INGEST-${input.sha256.slice(0, 12).toUpperCase()}`;
  const relativePath = prior?.path
    ? String(prior.path).replace(/^managed\//, "")
    : `10-sources/ingested/source-${input.sha256.slice(0, 16)}.md`;
  const content = renderDocumentArtifactDraft({
    externalId,
    title: input.title,
    sourceId: input.sourceId,
    sourceArtifactId: input.sourceArtifactId,
    sha256: input.sha256,
    mediaType: input.mediaType,
    extractor: input.extractor,
    extractorVersion: input.extractorVersion,
    artifact: input.artifact,
  });
  return CompilationPlan.parse({
    sourceId: input.sourceId,
    corpusRevision,
    disposition: prior ? "UPDATE" : "NEW",
    summary:
      "Create a provenance-preserving machine draft; no semantic compilation occurred and no claim is activated.",
    proposedChanges: [
      {
        path: relativePath,
        operation: prior ? "UPDATE" : "CREATE",
        content,
        reasons: [
          "Generative compilation is disabled or unconfigured; preserve the immutable source as an inspectable review draft.",
        ],
        evidenceIds: [input.evidenceId],
      },
    ],
    impactedDocumentIds: prior ? [String(prior.id)] : [],
    conflicts: [],
    probes: [
      {
        question:
          "Does the fallback draft retain immutable provenance and explicit review uncertainty?",
        criticality: "CRITICAL",
        evidenceIds: [input.evidenceId],
      },
    ],
  });
}

export async function buildCompilationStage(
  db: Postgres,
  input: CompilationStageInput,
  configured: ConfiguredKnowledgeCompiler | null,
): Promise<CompilationStageOutput> {
  const vault = await loadVaultContext(db, input.spaceId, input.vaultId);
  const pathPrefix = await loadRetrievalPathPrefix(db, input);
  if (!configured) {
    return withSpan(
      "compile.plan",
      {
        "akp.compiler.mode": "SOURCE_SUMMARY_FALLBACK",
        "akp.vector.enabled": input.vectorEnabled,
      },
      async () => {
        const plan = await sourceSummaryFallback(
          db,
          input,
          vault.corpusRevision,
          pathPrefix,
        );
        return {
          plan: await validateCompilationPlan(plan, "SOURCE_SUMMARY_FALLBACK"),
          metadata: {
            mode: "SOURCE_SUMMARY_FALLBACK",
            reason: "GENERIC_COMPILER_DISABLED_OR_UNCONFIGURED",
          },
        };
      },
    );
  }
  const vaultId = input.vaultId;
  if (!vaultId) throw new Error("KNOWLEDGE_COMPILER_VAULT_REQUIRED");

  const evidence = await loadEvidence(db, {
    ...input,
    vaultId,
  });
  const compiled = await withSpan(
    "compile.plan",
    {
      "akp.compiler.mode": "GENERATIVE",
      "akp.vector.enabled": input.vectorEnabled,
    },
    () =>
      compileGroundedKnowledgeProposal(db, configured, {
        source: {
          sourceId: input.sourceId,
          sourceArtifactId: input.sourceArtifactId,
          sha256: input.sha256,
          title: input.title,
          mediaType: input.mediaType,
        },
        documentArtifact: input.artifact,
        evidence: [evidence],
        schemaProfile: vault.schemaProfile,
        corpusRevision: vault.corpusRevision,
        spaceId: input.spaceId,
        vaultId,
        pathPrefix,
        vectorEnabled: input.vectorEnabled,
      }),
  );
  return {
    plan: await validateCompilationPlan(compiled.plan, "GENERATIVE"),
    metadata: {
      mode: "GENERATIVE",
      provider: compiled.provider,
      retrievalChannels: compiled.retrievalChannels,
      retrievalWarnings: compiled.retrievalWarnings,
      identity: compiled.result.identity,
      warnings: compiled.result.warnings,
      knowledgeCandidateCount: compiled.result.knowledgeCandidates.length,
      contradictionCount: compiled.result.contradictions.length,
      compilerResult: compiled.result,
    },
  };
}
