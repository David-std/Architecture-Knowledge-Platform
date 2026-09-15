from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one anchor in {path}, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


Path("apps/api/src/routes/profile-governance.ts").write_text(r'''import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
  canonicalKnowledgeProfileJson,
  type KnowledgeProfileV1 as KnowledgeProfile,
} from "@akp/contracts/knowledge-profile";
import { classifyKnowledgeProfileCompatibility } from "@akp/contracts/knowledge-profile-compatibility";
import {
  getKnowledgeProfileRevision,
  resolveAuthorizedVaultScope,
  resolveKnowledgeProfileBinding,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  hasUnrestrictedPathAccess,
  requirePermission,
} from "../auth.js";

interface ProfileScope {
  spaceId: string;
  vaultId: string;
}

interface ProfileDiffBody extends ProfileScope {
  candidateProfile?: unknown;
  candidateRevisionId?: string;
  baseRevisionId?: string;
}

function canonicalProfile(profile: unknown): {
  profile: KnowledgeProfile;
  canonicalProfile: string;
  profileHash: string;
} {
  const parsed = KnowledgeProfileV1.parse(profile);
  const canonicalProfile = canonicalKnowledgeProfileJson(parsed);
  return {
    profile: parsed,
    canonicalProfile,
    profileHash: createHash("sha256").update(canonicalProfile).digest("hex"),
  };
}

async function authorizeProfileAdmin(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  scope: ProfileScope,
  reply: FastifyReply,
): Promise<boolean> {
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return false;
  }
  if (!scope.spaceId || !scope.vaultId) {
    await reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
    return false;
  }
  if (!hasUnrestrictedPathAccess(actor, scope.spaceId, "admin")) {
    await reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
    return false;
  }
  try {
    const resolved = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId: scope.spaceId,
      vaultId: scope.vaultId,
      vaultIds: [scope.vaultId],
      permission: "admin",
      federated: false,
    });
    const access = resolved.accessByVault[scope.vaultId];
    if (!access || access.pathPrefix !== null) {
      await reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      return false;
    }
    return true;
  } catch (error) {
    await reply.code(403).send({
      code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
    });
    return false;
  }
}

async function effectiveProfile(
  db: Postgres,
  spaceId: string,
  vaultId: string,
) {
  const binding = await resolveKnowledgeProfileBinding(db, spaceId, vaultId);
  if (binding.revision) {
    return {
      source: "DURABLE_REVISION" as const,
      revisionId: binding.revision.id,
      profileId: binding.revision.profileId,
      version: binding.revision.version,
      profileHash: binding.revision.profileHash,
      status: binding.revision.status,
    };
  }
  const fallback = canonicalProfile(DEFAULT_KNOWLEDGE_PROFILE_V1);
  return {
    source: "V03_DEFAULT" as const,
    revisionId: null,
    profileId: fallback.profile.profileId,
    version: fallback.profile.version,
    profileHash: fallback.profileHash,
    status: "ACTIVE" as const,
  };
}

async function profileForRevisionOrEffective(
  db: Postgres,
  scope: ProfileScope,
  revisionId?: string,
): Promise<ReturnType<typeof canonicalProfile>> {
  if (revisionId) {
    const revision = await getKnowledgeProfileRevision(
      db,
      scope.spaceId,
      scope.vaultId,
      revisionId,
    );
    if (!revision) throw new Error("KNOWLEDGE_PROFILE_REVISION_NOT_FOUND");
    return canonicalProfile(revision.profile);
  }
  const binding = await resolveKnowledgeProfileBinding(
    db,
    scope.spaceId,
    scope.vaultId,
  );
  return canonicalProfile(
    binding.revision?.profile ?? DEFAULT_KNOWLEDGE_PROFILE_V1,
  );
}

export function registerProfileGovernanceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get<{ Querystring: ProfileScope }>(
    "/v1/schema/profiles",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = request.query;
      if (!(await authorizeProfileAdmin(db, actorOf(request), scope, reply))) {
        return;
      }
      const revisions = await db.pool.query(
        `
        select p.id,p.profile_id,p.version,p.profile_hash,p.status,
               p.compatibility_class,p.supersedes_revision_id,p.created_by,
               p.validated_at,p.activated_at,p.superseded_at,p.retired_at,
               p.created_at,p.updated_at,
               d.id latest_dry_run_id,d.compatibility_class latest_compatibility_class,
               d.affected_document_count,d.corpus_revision,d.created_at latest_dry_run_at
          from knowledge_profile_revisions p
          left join lateral (
            select id,compatibility_class,affected_document_count,corpus_revision,created_at
              from schema_dry_runs
             where profile_revision_id=p.id and space_id=p.space_id and vault_id=p.vault_id
             order by created_at desc limit 1
          ) d on true
         where p.space_id=$1 and p.vault_id=$2
         order by p.created_at desc,p.id
        `,
        [scope.spaceId, scope.vaultId],
      );
      return {
        spaceId: scope.spaceId,
        vaultId: scope.vaultId,
        active: await effectiveProfile(db, scope.spaceId, scope.vaultId),
        revisions: revisions.rows,
      };
    },
  );

  app.get<{
    Params: { revisionId: string };
    Querystring: ProfileScope;
  }>(
    "/v1/schema/profiles/:revisionId",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = request.query;
      if (!(await authorizeProfileAdmin(db, actorOf(request), scope, reply))) {
        return;
      }
      const revision = await getKnowledgeProfileRevision(
        db,
        scope.spaceId,
        scope.vaultId,
        request.params.revisionId,
      );
      if (!revision) {
        return reply
          .code(404)
          .send({ code: "KNOWLEDGE_PROFILE_REVISION_NOT_FOUND" });
      }
      const dryRun = await db.pool.query(
        `
        select id,compatibility_class,affected_document_count,corpus_revision,
               compatibility_status,report,created_at
          from schema_dry_runs
         where space_id=$1 and vault_id=$2 and profile_revision_id=$3
         order by created_at desc limit 1
        `,
        [scope.spaceId, scope.vaultId, revision.id],
      );
      return {
        ...revision,
        latestDryRun: dryRun.rows[0] ?? null,
        active: (await effectiveProfile(db, scope.spaceId, scope.vaultId))
          .revisionId === revision.id,
      };
    },
  );

  app.post<{ Body: ProfileScope & { profile: unknown } }>(
    "/v1/schema/profiles/validate",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = request.body;
      if (!(await authorizeProfileAdmin(db, actorOf(request), scope, reply))) {
        return;
      }
      try {
        const candidate = canonicalProfile(request.body.profile);
        return {
          valid: true,
          profileId: candidate.profile.profileId,
          version: candidate.profile.version,
          profileHash: candidate.profileHash,
          canonicalProfile: candidate.canonicalProfile,
          summary: {
            knowledgeKinds: Object.keys(candidate.profile.knowledgeKinds).sort(),
            relationTypes: Object.keys(candidate.profile.relationTypes).sort(),
            lifecycles: Object.keys(candidate.profile.lifecycles).sort(),
            evidencePolicies: Object.keys(candidate.profile.evidencePolicies).sort(),
            reviewPolicies: Object.keys(candidate.profile.reviewPolicies).sort(),
            artifactContracts: Object.keys(candidate.profile.artifactContracts).sort(),
          },
        };
      } catch (error) {
        return reply.code(400).send({
          code: "INVALID_KNOWLEDGE_PROFILE",
          detail: error instanceof Error ? error.message : "invalid profile",
        });
      }
    },
  );

  app.post<{ Body: ProfileDiffBody }>(
    "/v1/schema/profiles/diff",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const body = request.body;
      if (!(await authorizeProfileAdmin(db, actorOf(request), body, reply))) {
        return;
      }
      if (
        (body.candidateProfile === undefined) ===
        (body.candidateRevisionId === undefined)
      ) {
        return reply.code(400).send({
          code: "PROFILE_DIFF_CANDIDATE_REQUIRED",
          message: "Provide exactly one candidateProfile or candidateRevisionId.",
        });
      }
      try {
        const base = await profileForRevisionOrEffective(
          db,
          body,
          body.baseRevisionId,
        );
        const candidate = body.candidateRevisionId
          ? await profileForRevisionOrEffective(
              db,
              body,
              body.candidateRevisionId,
            )
          : canonicalProfile(body.candidateProfile);
        const compatibility = classifyKnowledgeProfileCompatibility(
          base.profile,
          candidate.profile,
        );
        return {
          base: {
            profileId: base.profile.profileId,
            version: base.profile.version,
            profileHash: base.profileHash,
            revisionId: body.baseRevisionId ?? null,
          },
          candidate: {
            profileId: candidate.profile.profileId,
            version: candidate.profile.version,
            profileHash: candidate.profileHash,
            revisionId: body.candidateRevisionId ?? null,
          },
          ...compatibility,
          usageAware: false,
          impactEndpoint: "/v1/schema/dry-run",
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (code === "KNOWLEDGE_PROFILE_REVISION_NOT_FOUND") {
          return reply.code(404).send({ code });
        }
        return reply.code(400).send({
          code: "INVALID_KNOWLEDGE_PROFILE",
          detail: code,
        });
      }
    },
  );
}
''', encoding="utf-8")

replace_once(
    "apps/api/src/server.ts",
    'import { registerProfileActivationRoutes } from "./routes/profile-activation.js";\n',
    'import { registerProfileActivationRoutes } from "./routes/profile-activation.js";\nimport { registerProfileGovernanceRoutes } from "./routes/profile-governance.js";\n',
)
replace_once(
    "apps/api/src/server.ts",
    '  registerProfileActivationRoutes(app, db);\n',
    '  registerProfileActivationRoutes(app, db);\n  registerProfileGovernanceRoutes(app, db);\n',
)

cli_anchor = '''const vault = program
  .command("vault")
  .description("Read-only vault operations");
'''
cli_insert = r'''const profile = program
  .command("profile")
  .description("Versioned KnowledgeProfile governance");

profile
  .command("list")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .action(async (options: { spaceId: string; vaultId: string }) => {
    const params = new URLSearchParams({
      spaceId: options.spaceId,
      vaultId: options.vaultId,
    });
    printJson(await api(`/v1/schema/profiles?${params.toString()}`));
  });

profile
  .command("get")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--revision-id <uuid>", "KnowledgeProfile revision UUID")
  .action(
    async (options: { spaceId: string; vaultId: string; revisionId: string }) => {
      const params = new URLSearchParams({
        spaceId: options.spaceId,
        vaultId: options.vaultId,
      });
      printJson(
        await api(
          `/v1/schema/profiles/${options.revisionId}?${params.toString()}`,
        ),
      );
    },
  );

profile
  .command("validate")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--file <path>", "KnowledgeProfile JSON file")
  .action(async (options: { spaceId: string; vaultId: string; file: string }) => {
    const profileValue = JSON.parse(
      readFileSync(path.resolve(options.file), "utf8"),
    ) as unknown;
    printJson(
      await api("/v1/schema/profiles/validate", {
        method: "POST",
        body: JSON.stringify({
          spaceId: options.spaceId,
          vaultId: options.vaultId,
          profile: profileValue,
        }),
      }),
    );
  });

profile
  .command("diff")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--file <path>", "Candidate KnowledgeProfile JSON file")
  .option("--base-revision-id <uuid>", "Optional durable base revision")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      file: string;
      baseRevisionId?: string;
    }) => {
      const candidateProfile = JSON.parse(
        readFileSync(path.resolve(options.file), "utf8"),
      ) as unknown;
      printJson(
        await api("/v1/schema/profiles/diff", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            candidateProfile,
            ...(options.baseRevisionId
              ? { baseRevisionId: options.baseRevisionId }
              : {}),
          }),
        }),
      );
    },
  );

profile
  .command("dry-run")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--file <path>", "Candidate KnowledgeProfile JSON file")
  .option("--supersedes-revision-id <uuid>", "Revision explicitly superseded")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      file: string;
      supersedesRevisionId?: string;
    }) => {
      const profileValue = JSON.parse(
        readFileSync(path.resolve(options.file), "utf8"),
      ) as unknown;
      printJson(
        await api("/v1/schema/dry-run", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            profile: profileValue,
            ...(options.supersedesRevisionId
              ? { supersedesRevisionId: options.supersedesRevisionId }
              : {}),
          }),
        }),
      );
    },
  );

profile
  .command("activate")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--revision-id <uuid>", "KnowledgeProfile revision UUID")
  .requiredOption("--dry-run-id <uuid>", "Pinned dry-run UUID")
  .requiredOption("--profile-hash <sha256>", "Expected canonical profile SHA-256")
  .requiredOption("--corpus-revision <revision>", "Expected corpus revision")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      revisionId: string;
      dryRunId: string;
      profileHash: string;
      corpusRevision: string;
    }) => {
      printJson(
        await api("/v1/schema/activate", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            profileRevisionId: options.revisionId,
            dryRunId: options.dryRunId,
            expectedProfileHash: options.profileHash,
            expectedCorpusRevision: options.corpusRevision,
          }),
        }),
      );
    },
  );

''' + cli_anchor
replace_once("apps/cli/src/main.ts", cli_anchor, cli_insert)

Path("apps/web/app/admin/profiles/page.tsx").parent.mkdir(parents=True, exist_ok=True)
Path("apps/web/app/admin/profiles/page.tsx").write_text(r'''import Link from "next/link";
import { akp } from "../../../lib/api";

type Vault = {
  id: string;
  space_id: string;
  vault_key: string;
  name: string;
};

type ProfileRevision = {
  id: string;
  profile_id: string;
  version: string;
  profile_hash: string;
  status: string;
  compatibility_class: string | null;
  supersedes_revision_id: string | null;
  affected_document_count: number | null;
  corpus_revision: string | null;
  latest_dry_run_id: string | null;
  created_at: string;
};

type ProfilesResponse = {
  active: {
    source: "DURABLE_REVISION" | "V03_DEFAULT";
    revisionId: string | null;
    profileId: string;
    version: string;
    profileHash: string;
    status: string;
  };
  revisions: ProfileRevision[];
};

export default async function ProfilesPage({
  searchParams,
}: {
  searchParams: Promise<{ vaultId?: string }>;
}) {
  const query = await searchParams;
  const vaultResponse = await akp<{ vaults: Vault[] }>("/v1/vaults");
  const selected =
    vaultResponse.vaults.find((vault) => vault.id === query.vaultId) ??
    vaultResponse.vaults[0];

  if (!selected) {
    return (
      <main>
        <p className="muted">Gobernanza de KnowledgeProfile</p>
        <h1>Perfiles</h1>
        <div className="card">No hay vaults visibles para esta identidad.</div>
      </main>
    );
  }

  const params = new URLSearchParams({
    spaceId: selected.space_id,
    vaultId: selected.id,
  });
  const profiles = await akp<ProfilesResponse>(
    `/v1/schema/profiles?${params.toString()}`,
  );
  const pending = profiles.revisions.filter((revision) =>
    ["DRAFT", "VALIDATED", "REVIEW_REQUIRED"].includes(revision.status),
  );

  return (
    <main>
      <p className="muted">Gobernanza versionada por vault</p>
      <h1>Knowledge Profiles</h1>

      <div className="card">
        <strong>Vault</strong>
        <p>
          {selected.name} <span className="muted">({selected.vault_key})</span>
        </p>
        <p>
          {vaultResponse.vaults.map((vault, index) => (
            <span key={vault.id}>
              {index > 0 ? " · " : ""}
              <Link href={`/admin/profiles?vaultId=${vault.id}`}>
                {vault.name}
              </Link>
            </span>
          ))}
        </p>
      </div>

      <div className="grid">
        <section className="card">
          <p className="muted">Perfil activo</p>
          <h2>{profiles.active.profileId}</h2>
          <p>
            Versión <strong>{profiles.active.version}</strong>
          </p>
          <p>Fuente: {profiles.active.source}</p>
          <p className="muted">{profiles.active.profileHash.slice(0, 16)}…</p>
        </section>
        <section className="card">
          <p className="muted">Revisiones pendientes</p>
          <h2>{pending.length}</h2>
          <p>
            {pending.length
              ? pending.map((revision) => `${revision.version} · ${revision.status}`).join(", ")
              : "Sin revisiones pendientes"}
          </p>
        </section>
      </div>

      <h2>Historial y compatibilidad</h2>
      {profiles.revisions.length === 0 ? (
        <div className="card">
          El vault usa el perfil de compatibilidad v0.3 y todavía no tiene revisiones durables.
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Versión</th>
                <th>Estado</th>
                <th>Compatibilidad</th>
                <th>Impacto</th>
                <th>Acción requerida</th>
              </tr>
            </thead>
            <tbody>
              {profiles.revisions.map((revision) => (
                <tr key={revision.id}>
                  <td>{revision.version}</td>
                  <td>{revision.status}</td>
                  <td>{revision.compatibility_class ?? "Sin clasificar"}</td>
                  <td>
                    {revision.affected_document_count === null
                      ? "Sin dry-run"
                      : `${revision.affected_document_count} docs`}
                  </td>
                  <td>
                    {revision.compatibility_class === "NON_BREAKING"
                      ? revision.status === "VALIDATED"
                        ? "Activación pendiente"
                        : "Sin migración"
                      : revision.compatibility_class
                        ? "Revisión/migración requerida"
                        : "Ejecutar dry-run"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
''', encoding="utf-8")

replace_once(
    "apps/web/app/layout.tsx",
    '            <Link href="/admin/spaces">Espacios</Link>\n',
    '            <Link href="/admin/spaces">Espacios</Link>\n            <Link href="/admin/profiles">Perfiles</Link>\n',
)
replace_once(
    "apps/web/ROUTES.md",
    "/admin/spaces            space and RBAC\n",
    "/admin/spaces            space and RBAC\n/admin/profiles          active/pending KnowledgeProfile governance\n",
)

Path("apps/api/test/profile-governance.integration.test.ts").write_text(r'''import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_PROFILE_V1 } from "@akp/contracts/knowledge-profile";
import { Postgres, registerVault } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const token = `profile-governance-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let vaultId: string;
let candidateRevisionId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'P1 profile governance integration',$3::jsonb)`,
    [
      adminId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "admin"],
          },
        ],
      }),
    ],
  );
  const vault = await registerVault(
    db,
    {
      vaultKey: `profile-govern-${randomUUID().slice(0, 8)}`,
      name: "P1 profile governance vault",
      spaceId,
      visibility: "PRIVATE",
      gitRepository: null,
      defaultBranch: "main",
      localPath: path.join(tmpdir(), `profile-govern-${randomUUID()}`),
      contentRoots: ["."],
      sourceRoots: [],
      schemaProfile: {},
      evalPack: {
        name: "generic",
        version: "1",
        enabled: true,
        criticalCases: [],
      },
      retrievalConfig: {},
      permissions: {},
      enabled: true,
    },
    { ownerUserId: adminId },
  );
  vaultId = vault.id;
  await db.pool.query(
    "update vaults set current_revision='profile-govern-r1' where id=$1",
    [vaultId],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  await db.pool.query(
    "update vaults set active_knowledge_profile_revision_id=null where id=$1",
    [vaultId],
  );
  await db.pool.query("delete from audit_events where vault_id=$1", [vaultId]);
  await db.pool.query("delete from schema_dry_runs where vault_id=$1", [vaultId]);
  await db.pool.query("delete from vaults where id=$1", [vaultId]);
  await db.pool.query("delete from api_tokens where token_hash=$1", [tokenHash]);
  await db.close();
});

describe("KnowledgeProfile governance surfaces", () => {
  it("validates a profile without persisting a revision", async () => {
    const before = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    const candidate = {
      ...DEFAULT_KNOWLEDGE_PROFILE_V1,
      version: "0.4-governance-validate",
      displayName: "P1 governance validation profile",
    };
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/profiles/validate",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      valid: true,
      profileId: "default",
      version: "0.4-governance-validate",
    });
    const after = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("rejects malformed profile references during validation", async () => {
    const invalid = structuredClone(DEFAULT_KNOWLEDGE_PROFILE_V1);
    invalid.knowledgeKinds.rule.lifecycle = "missing-lifecycle";
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/profiles/validate",
      headers,
      payload: { spaceId, vaultId, profile: invalid },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_KNOWLEDGE_PROFILE" });
  });

  it("lists and gets durable revisions with latest impact evidence", async () => {
    const candidate = {
      ...DEFAULT_KNOWLEDGE_PROFILE_V1,
      version: "0.4-governance-list",
      displayName: "P1 governance list profile",
    };
    const dryRun = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: { spaceId, vaultId, profile: candidate },
    });
    expect(dryRun.statusCode).toBe(200);
    candidateRevisionId = dryRun.json<{ profileRevisionId: string }>().profileRevisionId;

    const query = new URLSearchParams({ spaceId, vaultId }).toString();
    const listed = await app.inject({
      method: "GET",
      url: `/v1/schema/profiles?${query}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json<{
      active: { source: string; version: string };
      revisions: Array<Record<string, unknown>>;
    }>();
    expect(listedBody.active).toMatchObject({
      source: "V03_DEFAULT",
      version: "0.3-compat",
    });
    expect(listedBody.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: candidateRevisionId,
          version: "0.4-governance-list",
          status: "VALIDATED",
          latest_dry_run_id: expect.any(String),
          affected_document_count: 0,
        }),
      ]),
    );

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/schema/profiles/${candidateRevisionId}?${query}`,
      headers,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      id: candidateRevisionId,
      profileId: "default",
      version: "0.4-governance-list",
      active: false,
      latestDryRun: {
        affected_document_count: 0,
        compatibility_class: "NON_BREAKING",
      },
    });
  });

  it("diffs a durable candidate without creating another revision", async () => {
    const before = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/profiles/diff",
      headers,
      payload: {
        spaceId,
        vaultId,
        candidateRevisionId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      compatibilityClass: "NON_BREAKING",
      usageAware: false,
      candidate: { revisionId: candidateRevisionId },
    });
    const after = await db.pool.query<{ count: string }>(
      "select count(*)::text count from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
''', encoding="utf-8")
