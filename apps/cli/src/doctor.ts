import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { workspaceContextRevisionState, type Postgres } from "@akp/postgres";

export type DoctorStatus = "OK" | "WARN" | "FAIL" | "UNKNOWN";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  overall: DoctorStatus;
  checks: DoctorCheck[];
}

interface DoctorEnvironment {
  readonly [key: string]: string | undefined;
}

function statusRank(status: DoctorStatus): number {
  switch (status) {
    case "FAIL":
      return 4;
    case "WARN":
      return 3;
    case "UNKNOWN":
      return 2;
    case "OK":
      return 1;
  }
}

export function overallDoctorStatus(
  checks: readonly DoctorCheck[],
): DoctorStatus {
  return checks.reduce<DoctorStatus>(
    (current, check) =>
      statusRank(check.status) > statusRank(current) ? check.status : current,
    "OK",
  );
}

async function probeUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function safeCheck(
  id: string,
  label: string,
  operation: () => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
  try {
    return await operation();
  } catch {
    return {
      id,
      label,
      status: "FAIL",
      summary: "Diagnostic query failed safely.",
      details: { code: "DIAGNOSTIC_QUERY_FAILED" },
    };
  }
}

function managedGitCheck(environment: DoctorEnvironment): DoctorCheck {
  const repository = environment.AKP_MANAGED_REPO?.trim();
  if (!repository) {
    return {
      id: "managed-git",
      label: "Managed Git",
      status: "UNKNOWN",
      summary: "AKP_MANAGED_REPO is not configured.",
    };
  }
  const absolute = path.resolve(repository);
  const inside = spawnSync(
    "git",
    ["-C", absolute, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8", windowsHide: true },
  );
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return {
      id: "managed-git",
      label: "Managed Git",
      status: "FAIL",
      summary: "Configured managed repository is not a readable Git work tree.",
      details: { configured: true },
    };
  }
  const head = spawnSync("git", ["-C", absolute, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    id: "managed-git",
    label: "Managed Git",
    status: head.status === 0 ? "OK" : "FAIL",
    summary:
      head.status === 0
        ? "Managed Git repository is readable."
        : "Managed Git HEAD could not be resolved.",
    details:
      head.status === 0
        ? { configured: true, head: head.stdout.trim() }
        : { configured: true },
  };
}

export function modelRoutingCheck(environment: DoctorEnvironment): DoctorCheck {
  const policyRaw = environment.AKP_MODEL_ROLE_POLICIES_JSON?.trim();
  const endpointRaw = environment.AKP_MODEL_ENDPOINTS_JSON?.trim();

  if (policyRaw) {
    try {
      const policies = JSON.parse(policyRaw) as unknown;
      const endpoints = endpointRaw
        ? (JSON.parse(endpointRaw) as unknown)
        : undefined;
      if (!Array.isArray(policies) || policies.length === 0) {
        throw new Error("MODEL_ROLE_POLICIES_INVALID");
      }
      if (
        !endpoints ||
        typeof endpoints !== "object" ||
        Array.isArray(endpoints)
      ) {
        throw new Error("MODEL_ENDPOINT_REGISTRY_INVALID");
      }
      const endpointMap = endpoints as Record<string, unknown>;
      const roles = policies.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("MODEL_ROLE_POLICY_INVALID");
        }
        const policy = value as Record<string, unknown>;
        const role = typeof policy.role === "string" ? policy.role.trim() : "";
        const provider =
          typeof policy.provider === "string" ? policy.provider.trim() : "";
        const model =
          typeof policy.model === "string" ? policy.model.trim() : "";
        const endpointRef =
          typeof policy.endpointRef === "string"
            ? policy.endpointRef.trim()
            : "";
        const dataResidency =
          typeof policy.dataResidency === "string"
            ? policy.dataResidency.trim()
            : "";
        if (!role || !provider || !model || !endpointRef || !dataResidency) {
          throw new Error("MODEL_ROLE_POLICY_INVALID");
        }
        const endpoint = endpointMap[endpointRef];
        if (
          !endpoint ||
          typeof endpoint !== "object" ||
          Array.isArray(endpoint)
        ) {
          throw new Error("MODEL_ENDPOINT_REF_UNRESOLVED");
        }
        const endpointResidency = (endpoint as Record<string, unknown>)
          .dataResidency;
        if (
          typeof endpointResidency !== "string" ||
          !endpointResidency.trim()
        ) {
          throw new Error("MODEL_ENDPOINT_RESIDENCY_INVALID");
        }
        return {
          role,
          provider,
          model,
          endpointRef,
          policyDataResidency: dataResidency,
          endpointDataResidency: endpointResidency,
          fallbackCount: Array.isArray(policy.fallbackRolesOrModels)
            ? policy.fallbackRolesOrModels.length
            : 0,
        };
      });
      return {
        id: "model-routing",
        label: "Model routing and residency",
        status: "OK",
        summary:
          "Role-specific model routing configuration is structurally resolvable.",
        details: {
          mode: "ROLE_POLICY",
          roles,
          endpointCount: Object.keys(endpointMap).length,
          secretsExposed: false,
        },
      };
    } catch (error) {
      return {
        id: "model-routing",
        label: "Model routing and residency",
        status: "FAIL",
        summary: "Model routing configuration is invalid.",
        details: {
          code:
            error instanceof Error ? error.message : "MODEL_ROUTING_INVALID",
          secretsExposed: false,
        },
      };
    }
  }

  const provider = environment.AKP_LLM_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "disabled") {
    return {
      id: "model-routing",
      label: "Model routing and residency",
      status: "OK",
      summary:
        "External model routing is disabled; the baseline has no mandatory model provider.",
      details: {
        mode: "DISABLED",
        externalProviderRequired: false,
        secretsExposed: false,
      },
    };
  }
  if (provider !== "openai-compatible") {
    return {
      id: "model-routing",
      label: "Model routing and residency",
      status: "FAIL",
      summary: "Configured legacy model provider is unsupported.",
      details: {
        mode: "LEGACY",
        provider,
        code: "MODEL_PROVIDER_UNSUPPORTED",
        secretsExposed: false,
      },
    };
  }

  const baseUrl = environment.AKP_LLM_BASE_URL?.trim();
  const model = environment.AKP_LLM_MODEL?.trim();
  if (!baseUrl || !model) {
    return {
      id: "model-routing",
      label: "Model routing and residency",
      status: "FAIL",
      summary: "Legacy model routing is missing its endpoint or model.",
      details: {
        mode: "LEGACY",
        provider,
        baseUrlConfigured: Boolean(baseUrl),
        modelConfigured: Boolean(model),
        secretsExposed: false,
      },
    };
  }

  let inferredResidency = environment.AKP_LLM_DATA_RESIDENCY?.trim() || "";
  if (!inferredResidency) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      inferredResidency = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
        hostname,
      )
        ? "LOCAL_ONLY"
        : "EXTERNAL_ALLOWED";
    } catch {
      return {
        id: "model-routing",
        label: "Model routing and residency",
        status: "FAIL",
        summary: "Legacy model routing endpoint is not a valid URL.",
        details: {
          mode: "LEGACY",
          provider,
          code: "MODEL_ENDPOINT_INVALID",
          secretsExposed: false,
        },
      };
    }
  }
  if (
    !["LOCAL_ONLY", "ORG_APPROVED", "EXTERNAL_ALLOWED"].includes(
      inferredResidency,
    )
  ) {
    return {
      id: "model-routing",
      label: "Model routing and residency",
      status: "FAIL",
      summary: "Legacy model residency is invalid.",
      details: {
        mode: "LEGACY",
        provider,
        code: "MODEL_RESIDENCY_INVALID",
        secretsExposed: false,
      },
    };
  }

  return {
    id: "model-routing",
    label: "Model routing and residency",
    status: "OK",
    summary: "Legacy model routing configuration is structurally complete.",
    details: {
      mode: "LEGACY",
      provider,
      model,
      endpointRef:
        environment.AKP_LLM_ENDPOINT_REF?.trim() || "legacy-knowledge-compile",
      dataResidency: inferredResidency,
      baseUrlConfigured: true,
      apiKeyConfigured: Boolean(environment.AKP_LLM_API_KEY?.trim()),
      secretsExposed: false,
    },
  };
}

function backupCheck(environment: DoctorEnvironment, cwd: string): DoctorCheck {
  const configured = environment.AKP_BACKUP_DIR?.trim() || "backups/latest";
  const backupDirectory = path.resolve(cwd, configured);
  const manifestPath = path.join(backupDirectory, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      id: "backup-recency",
      label: "Backup recency",
      status: "WARN",
      summary: "No backup manifest was found.",
      details: { configuredDirectory: configured },
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {
      id: "backup-recency",
      label: "Backup recency",
      status: "FAIL",
      summary: "Backup manifest is unreadable or invalid JSON.",
      details: { configuredDirectory: configured },
    };
  }
  const createdAt =
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    typeof (manifest as { createdAt?: unknown }).createdAt === "string"
      ? (manifest as { createdAt: string }).createdAt
      : null;
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(createdMs)) {
    return {
      id: "backup-recency",
      label: "Backup recency",
      status: "FAIL",
      summary: "Backup manifest does not contain a valid createdAt timestamp.",
      details: { configuredDirectory: configured },
    };
  }
  const configuredMax = Number(environment.AKP_BACKUP_MAX_AGE_HOURS ?? 24);
  const maxAgeHours =
    Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 24;
  const ageHours = Math.max(0, (Date.now() - createdMs) / 3_600_000);
  return {
    id: "backup-recency",
    label: "Backup recency",
    status: ageHours <= maxAgeHours ? "OK" : "WARN",
    summary:
      ageHours <= maxAgeHours
        ? "Latest backup is within the configured recency window."
        : "Latest backup is older than the configured recency window.",
    details: {
      createdAt,
      ageHours: Number(ageHours.toFixed(2)),
      maxAgeHours,
    },
  };
}

async function contextParityCheck(db: Postgres): Promise<DoctorCheck> {
  const sessions = await db.pool.query<{
    id: string;
    space_id: string;
    vault_id: string;
    total_count: number;
  }>(
    `select id,space_id,vault_id,count(*) over()::int total_count
       from agent_sessions
      where vault_id is not null
      order by updated_at desc
      limit 500`,
  );
  let current = 0;
  let changed = 0;
  let legacy = 0;
  for (const session of sessions.rows) {
    const state = await workspaceContextRevisionState(
      db.pool,
      session.id,
      session.space_id,
      session.vault_id,
    );
    if (state.status === "CURRENT") current += 1;
    else if (state.status === "CHANGED") changed += 1;
    else legacy += 1;
  }
  const total = sessions.rows[0]?.total_count ?? 0;
  const truncated = total > sessions.rows.length;
  return {
    id: "context-revision-parity",
    label: "Context revision parity",
    status: changed > 0 || legacy > 0 || truncated ? "WARN" : "OK",
    summary:
      total === 0
        ? "No vault-scoped workspace sessions require parity checks."
        : changed === 0 && legacy === 0 && !truncated
          ? "All inspected workspace pins match current authority revisions."
          : "Some workspace pins require attention.",
    details: {
      inspected: sessions.rows.length,
      total,
      current,
      changed,
      legacyUnpinned: legacy,
      truncated,
    },
  };
}

export async function graphChecks(db: Postgres): Promise<{
  graphs: DoctorCheck;
  code: DoctorCheck;
}> {
  const result = await db.pool.query<{
    graph_domain: string;
    active: number;
    stale: number;
    failed: number;
    building: number;
    retired: number;
    latest_update: Date | null;
  }>(
    `with ranked as (
       select r.*,
              row_number() over(
                partition by space_id,graph_domain,scope_id
                order by requested_at desc,id desc
              ) as rn
         from federated_graph_projection_revisions r
     )
     select graph_domain,
            count(*) filter(where lifecycle='ACTIVE')::int active,
            count(*) filter(
              where lifecycle='ACTIVE' and freshness='STALE'
            )::int stale,
            count(*) filter(
              where rn=1 and lifecycle='FAILED'
            )::int failed,
            count(*) filter(
              where rn=1 and lifecycle in (
                'REQUESTED','BUILDING','READY','BUILT'
              )
            )::int building,
            count(*) filter(
              where lifecycle in ('RETIRED','STALE')
            )::int retired,
            max(updated_at) latest_update
       from ranked
      group by graph_domain
      order by graph_domain`,
  );
  const expected = [
    "EPISTEMIC",
    "SOFTWARE_CATALOG",
    "CODE",
    "RUNTIME",
    "TEMPORAL",
    "WORK",
    "COMMUNITY",
  ];
  const byDomain = new Map(result.rows.map((row) => [row.graph_domain, row]));
  const details = Object.fromEntries(
    expected.map((domain) => {
      const row = byDomain.get(domain);
      return [
        domain,
        row
          ? {
              active: row.active,
              stale: row.stale,
              failed: row.failed,
              building: row.building,
              retired: row.retired,
              latestUpdate: row.latest_update?.toISOString() ?? null,
            }
          : {
              active: 0,
              stale: 0,
              failed: 0,
              building: 0,
              retired: 0,
              latestUpdate: null,
            },
      ];
    }),
  );
  const anyFailure = result.rows.some((row) => row.failed > 0);
  const anyStale = result.rows.some((row) => row.stale > 0);
  const anyBuilding = result.rows.some((row) => row.building > 0);
  const missingDomains = expected.filter((domain) => !byDomain.has(domain));
  const graphs: DoctorCheck = {
    id: "graph-domain-revisions",
    label: "Graph domain revisions",
    status: anyFailure
      ? "FAIL"
      : anyStale || anyBuilding || missingDomains.length
        ? "WARN"
        : "OK",
    summary:
      result.rows.length === 0
        ? "No graph projection revisions are present."
        : anyFailure
          ? "At least one graph domain has an unrecovered latest failure."
          : anyStale || anyBuilding || missingDomains.length
            ? "Graph revision coverage is incomplete, building, or stale."
            : "All graph domains have healthy current revision state.",
    details: { domains: details, missingDomains },
  };

  const projects = await db.pool.query<{
    repository: string | null;
    slug: string;
    requested_sha: string | null;
    active_graph_sha: string | null;
    active_freshness: string | null;
    provider: string | null;
    provider_version: string | null;
    last_build: Date | string | null;
    node_count: number;
    edge_count: number;
    warning_count: string | null;
    warnings: unknown;
    last_failure_code: string | null;
    last_failure_at: Date | string | null;
  }>(
    `select
        p.metadata#>>'{codeGraph,repository}' repository,
        p.slug,
        p.metadata->>'commit' requested_sha,
        active.source_revision active_graph_sha,
        active.freshness active_freshness,
        active.provider,
        active.provider_version,
        active.last_successful_update last_build,
        coalesce(
          (select count(*)::int
             from federated_graph_projection_nodes pn
            where pn.projection_revision_id=active.id),
          0
        ) node_count,
        coalesce(
          (select count(*)::int
             from federated_graph_projection_edges pe
            where pe.projection_revision_id=active.id),
          0
        ) edge_count,
        p.metadata#>>'{codeGraph,warningCount}' warning_count,
        case
          when jsonb_typeof(p.metadata#>'{codeGraph,warnings}')='array'
            then p.metadata#>'{codeGraph,warnings}'
          else '[]'::jsonb
        end warnings,
        failure.error->>'code' last_failure_code,
        failure.updated_at last_failure_at
      from projects p
      left join lateral (
        select r.*
          from federated_graph_projection_revisions r
         where r.space_id=p.space_id
           and r.graph_domain='CODE'
           and r.scope_id=p.metadata#>>'{codeGraph,scopeId}'
           and r.lifecycle='ACTIVE'
         order by r.activated_at desc nulls last,r.id desc
         limit 1
      ) active on true
      left join lateral (
        select r.error,r.updated_at
          from federated_graph_projection_revisions r
         where r.space_id=p.space_id
           and r.graph_domain='CODE'
           and r.scope_id=p.metadata#>>'{codeGraph,scopeId}'
           and r.lifecycle='FAILED'
         order by r.updated_at desc,r.id desc
         limit 1
      ) failure on true
     where p.metadata#>>'{codeGraph,scopeId}' is not null
     order by p.space_id,p.vault_id,p.slug
     limit 201`,
  );
  const truncated = projects.rows.length > 200;
  const codeProjects = projects.rows.slice(0, 200).map((row) => {
    const lastBuild =
      row.last_build === null
        ? null
        : (row.last_build instanceof Date
            ? row.last_build
            : new Date(row.last_build)
          ).toISOString();
    const lastFailureAt =
      row.last_failure_at === null
        ? null
        : (row.last_failure_at instanceof Date
            ? row.last_failure_at
            : new Date(row.last_failure_at)
          ).toISOString();
    const warnings = Array.isArray(row.warnings)
      ? row.warnings.slice(0, 32).flatMap((warning) => {
          if (
            !warning ||
            typeof warning !== "object" ||
            Array.isArray(warning)
          ) {
            return [];
          }
          const value = warning as Record<string, unknown>;
          if (typeof value.code !== "string") return [];
          return [
            {
              code: value.code.slice(0, 160),
              ...(typeof value.path === "string"
                ? { path: value.path.slice(0, 4096) }
                : {}),
            },
          ];
        })
      : [];
    const warningCount =
      row.warning_count && /^\d{1,9}$/u.test(row.warning_count)
        ? Number(row.warning_count)
        : warnings.length;
    const stale =
      !row.active_graph_sha ||
      !row.requested_sha ||
      row.active_graph_sha.toLowerCase() !== row.requested_sha.toLowerCase() ||
      row.active_freshness !== "FRESH";
    const unrecoveredFailure =
      lastFailureAt !== null &&
      (lastBuild === null || Date.parse(lastFailureAt) > Date.parse(lastBuild));
    const status: DoctorStatus =
      !row.active_graph_sha && unrecoveredFailure
        ? "FAIL"
        : stale || unrecoveredFailure
          ? "WARN"
          : "OK";
    return {
      repository: row.repository,
      slug: row.slug,
      requestedSha: row.requested_sha,
      activeGraphSha: row.active_graph_sha,
      stale,
      provider: row.provider,
      providerVersion: row.provider_version,
      lastBuild,
      nodeCount: row.node_count,
      edgeCount: row.edge_count,
      warningCount,
      warnings,
      lastFailure: row.last_failure_code
        ? {
            code: row.last_failure_code.slice(0, 160),
            at: lastFailureAt,
            unrecovered: unrecoveredFailure,
          }
        : null,
      status,
    };
  });
  const codeStatus: DoctorStatus = codeProjects.some(
    (project) => project.status === "FAIL",
  )
    ? "FAIL"
    : codeProjects.some((project) => project.status === "WARN") || truncated
      ? "WARN"
      : codeProjects.length === 0
        ? "UNKNOWN"
        : "OK";
  const code: DoctorCheck = {
    id: "code-graph-staleness",
    label: "Code graph projects",
    status: codeStatus,
    summary:
      codeProjects.length === 0
        ? "No managed project CODE graph has been recorded."
        : codeStatus === "FAIL"
          ? "At least one project CODE graph has no active replacement after a failure."
          : codeStatus === "WARN"
            ? "At least one project CODE graph is stale, degraded, or omitted by the diagnostic bound."
            : "Managed project CODE graphs match their requested immutable revisions.",
    details: {
      projects: codeProjects,
      truncated,
      inspected: codeProjects.length,
    },
  };
  return { graphs, code };
}

export async function runDoctor(
  db: Postgres,
  environment: DoctorEnvironment = process.env,
  cwd = process.cwd(),
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(
    await safeCheck("database", "Database", async () => {
      const healthy = await db.health();
      return {
        id: "database",
        label: "Database",
        status: healthy ? "OK" : "FAIL",
        summary: healthy
          ? "PostgreSQL is reachable."
          : "PostgreSQL health probe failed.",
      };
    }),
  );

  checks.push(
    await safeCheck("raw-object-store", "Raw object store", async () => {
      const base =
        environment.AKP_RAW_ENDPOINT?.trim() || "http://127.0.0.1:19000";
      const healthy = await probeUrl(
        `${base.replace(/\/$/u, "")}/minio/health/live`,
      );
      return {
        id: "raw-object-store",
        label: "Raw object store",
        status: healthy ? "OK" : "FAIL",
        summary: healthy
          ? "Raw object-store health endpoint is reachable."
          : "Raw object-store health endpoint is unavailable.",
      };
    }),
  );

  checks.push(managedGitCheck(environment));

  checks.push(
    await safeCheck("outbox-jobs", "Outbox and jobs", async () => {
      const result = await db.pool.query<{
        quarantined: number;
        retrying: number;
        ingest_failed: number;
        ingest_active: number;
      }>(
        `select
          (select count(*)::int from event_deliveries where status='QUARANTINED') quarantined,
          (select count(*)::int from event_deliveries where status='RETRY') retrying,
          (select count(*)::int from ingest_jobs where state='FAILED') ingest_failed,
          (select count(*)::int from ingest_jobs
            where state not in ('FAILED','REVIEW_REQUIRED')
              and cancelled_at is null) ingest_active`,
      );
      const row = result.rows[0]!;
      return {
        id: "outbox-jobs",
        label: "Outbox and jobs",
        status:
          row.quarantined > 0
            ? "FAIL"
            : row.retrying > 0 || row.ingest_failed > 0
              ? "WARN"
              : "OK",
        summary:
          row.quarantined > 0
            ? "Quarantined outbox deliveries require operator attention."
            : row.retrying > 0 || row.ingest_failed > 0
              ? "Retrying deliveries or failed ingest jobs are present."
              : "No quarantined deliveries or failed ingest jobs were found.",
        details: row,
      };
    }),
  );

  checks.push(
    await safeCheck("active-profile", "Active profile", async () => {
      const result = await db.pool.query<{
        enabled_vaults: number;
        durable_active: number;
        default_profile: number;
        invalid_binding: number;
      }>(
        `select
          count(*) filter(where v.enabled)::int enabled_vaults,
          count(*) filter(
            where v.enabled and v.active_knowledge_profile_revision_id is not null
              and p.status='ACTIVE'
          )::int durable_active,
          count(*) filter(
            where v.enabled and v.active_knowledge_profile_revision_id is null
          )::int default_profile,
          count(*) filter(
            where v.enabled and v.active_knowledge_profile_revision_id is not null
              and (p.id is null or p.status<>'ACTIVE')
          )::int invalid_binding
        from vaults v
        left join knowledge_profile_revisions p
          on p.id=v.active_knowledge_profile_revision_id`,
      );
      const row = result.rows[0]!;
      return {
        id: "active-profile",
        label: "Active profile",
        status: row.invalid_binding > 0 ? "FAIL" : "OK",
        summary:
          row.invalid_binding > 0
            ? "One or more vaults have an invalid active profile binding."
            : "Active/default profile bindings are internally consistent.",
        details: row,
      };
    }),
  );

  checks.push(
    await safeCheck("context-revision-parity", "Context revision parity", () =>
      contextParityCheck(db),
    ),
  );

  checks.push(modelRoutingCheck(environment));

  checks.push(
    await safeCheck("vector-generation", "Vector generation", async () => {
      const result = await db.pool.query<{
        total: number;
        active: number;
        stale: number;
        failed: number;
        building: number;
      }>(
        `select count(*)::int total,
                count(*) filter(where status='ACTIVE')::int active,
                count(*) filter(where status='STALE')::int stale,
                count(*) filter(where status='FAILED')::int failed,
                count(*) filter(where status in ('REQUESTED','BUILDING'))::int building
           from embedding_generations`,
      );
      const row = result.rows[0]!;
      const vectorEnabled = environment.AKP_VECTOR_ENABLED === "true";
      return {
        id: "vector-generation",
        label: "Vector generation",
        status:
          row.failed > 0
            ? "FAIL"
            : vectorEnabled && row.active === 0
              ? "WARN"
              : row.stale > 0
                ? "WARN"
                : row.total === 0
                  ? "UNKNOWN"
                  : "OK",
        summary:
          row.failed > 0
            ? "Failed embedding generations are present."
            : vectorEnabled && row.active === 0
              ? "Vector retrieval is enabled but no active generation exists."
              : row.stale > 0
                ? "Stale embedding generations are present."
                : row.total === 0
                  ? "No embedding generation has been recorded."
                  : "Vector generation state is healthy.",
        details: { ...row, vectorEnabled },
      };
    }),
  );

  const graphResult = await safeCheck(
    "graph-domain-revisions",
    "Graph domain revisions",
    async () => (await graphChecks(db)).graphs,
  );
  checks.push(graphResult);
  checks.push(
    await safeCheck(
      "code-graph-staleness",
      "Code graph staleness",
      async () => {
        return (await graphChecks(db)).code;
      },
    ),
  );

  checks.push(
    await safeCheck("truth-index", "Truth support/index health", async () => {
      const result = await db.pool.query<{
        truth_heads: number;
        disputed_support_sets: number;
        unhealthy_projection_items: number;
      }>(
        `select
          (select count(*)::int from truth_revision_heads
            where revision_hash is not null) truth_heads,
          (select count(*)::int from truth_support_sets
            where state='DISPUTED') disputed_support_sets,
          (select count(*)::int from derived_truth_projection_items
            where valid=false or state in ('UNSUPPORTED','UNANNOTATED'))
            unhealthy_projection_items`,
      );
      const row = result.rows[0]!;
      return {
        id: "truth-index",
        label: "Truth support/index health",
        status:
          row.unhealthy_projection_items > 0
            ? "FAIL"
            : row.disputed_support_sets > 0
              ? "WARN"
              : row.truth_heads === 0
                ? "UNKNOWN"
                : "OK",
        summary:
          row.unhealthy_projection_items > 0
            ? "Invalid or unsupported derived truth items are present."
            : row.disputed_support_sets > 0
              ? "Disputed truth support sets are present."
              : row.truth_heads === 0
                ? "No published truth revision heads are present."
                : "Truth support and derived projection health is consistent.",
        details: row,
      };
    }),
  );

  checks.push(
    await safeCheck("community-ppr", "Community/PPR status", async () => {
      const result = await db.pool.query<{
        total: number;
        active: number;
        stale: number;
        failed: number;
      }>(
        `select count(*)::int total,
                count(*) filter(where status='ACTIVE' and stale=false)::int active,
                count(*) filter(where status='STALE' or stale=true)::int stale,
                count(*) filter(where status='FAILED')::int failed
           from community_index_revisions`,
      );
      const row = result.rows[0]!;
      return {
        id: "community-ppr",
        label: "Community/PPR status",
        status:
          row.failed > 0
            ? "FAIL"
            : row.stale > 0
              ? "WARN"
              : row.total === 0
                ? "UNKNOWN"
                : "OK",
        summary:
          row.failed > 0
            ? "Failed community revisions are present."
            : row.stale > 0
              ? "Stale community revisions are present."
              : row.total === 0
                ? "No community index revision is present; PPR has no durable job state."
                : "Community revisions are healthy; PPR is evaluated on demand.",
        details: { ...row, pprMode: "ON_DEMAND_NO_DURABLE_JOB_STATE" },
      };
    }),
  );

  checks.push(
    await safeCheck("connectors", "Connectors", async () => {
      const result = await db.pool.query<{
        active: number;
        disabled: number;
        pending_events: number;
        exhausted_events: number;
      }>(
        `select
          (select count(*)::int from source_connector_registrations
            where state='ACTIVE') active,
          (select count(*)::int from source_connector_registrations
            where state='DISABLED') disabled,
          (select count(*)::int from source_connector_events
            where status='PENDING') pending_events,
          (select count(*)::int from source_connector_events
            where status='PENDING'
              and apply_attempts>=max_apply_attempts) exhausted_events`,
      );
      const row = result.rows[0]!;
      return {
        id: "connectors",
        label: "Connectors",
        status:
          row.exhausted_events > 0
            ? "FAIL"
            : row.pending_events > 0
              ? "WARN"
              : "OK",
        summary:
          row.exhausted_events > 0
            ? "Connector events exhausted their apply budget."
            : row.pending_events > 0
              ? "Connector events are pending application."
              : "Connector inbox/checkpoint state has no pending failures.",
        details: row,
      };
    }),
  );

  checks.push(
    await safeCheck("federation-peers", "Federation peers", async () => {
      const result = await db.pool.query<{
        approved: number;
        discovered: number;
        disabled: number;
        circuit_open: number;
        degraded: number;
      }>(
        `select
          count(*) filter(where trust_state='APPROVED')::int approved,
          count(*) filter(where trust_state='DISCOVERED')::int discovered,
          count(*) filter(where trust_state='DISABLED')::int disabled,
          count(*) filter(
            where circuit_open_until is not null and circuit_open_until>now()
          )::int circuit_open,
          count(*) filter(where failure_count>0)::int degraded
         from context_fabric_peers`,
      );
      const row = result.rows[0]!;
      return {
        id: "federation-peers",
        label: "Federation peers",
        status:
          row.circuit_open > 0 ? "FAIL" : row.degraded > 0 ? "WARN" : "OK",
        summary:
          row.circuit_open > 0
            ? "One or more federation peer circuits are open."
            : row.degraded > 0
              ? "One or more federation peers have recent failures."
              : "Federation peer health has no active failures.",
        details: row,
      };
    }),
  );

  checks.push(
    await safeCheck("otel-exporter", "OTel exporter", async () => {
      const healthUrl = environment.AKP_OTEL_HEALTH_URL?.trim();
      const configured =
        Boolean(environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) ||
        Boolean(environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim());
      if (healthUrl) {
        const healthy = await probeUrl(healthUrl);
        return {
          id: "otel-exporter",
          label: "OTel exporter",
          status: healthy ? "OK" : "FAIL",
          summary: healthy
            ? "Configured OTel health endpoint is reachable."
            : "Configured OTel health endpoint is unavailable.",
          details: { configured: true, healthProbeConfigured: true },
        };
      }
      return configured
        ? {
            id: "otel-exporter",
            label: "OTel exporter",
            status: "UNKNOWN",
            summary:
              "OTel exporter is configured, but no AKP_OTEL_HEALTH_URL is available for a reliable health probe.",
            details: { configured: true, healthProbeConfigured: false },
          }
        : {
            id: "otel-exporter",
            label: "OTel exporter",
            status: "UNKNOWN",
            summary: "No OTel exporter is configured.",
            details: { configured: false, healthProbeConfigured: false },
          };
    }),
  );

  checks.push(backupCheck(environment, cwd));

  checks.push(
    await safeCheck(
      "open-critical-findings",
      "Open critical findings",
      async () => {
        const result = await db.pool.query<{ count: number }>(
          `select count(*)::int count
             from assurance_findings
            where status='OPEN' and severity='CRITICAL'`,
        );
        const count = result.rows[0]?.count ?? 0;
        return {
          id: "open-critical-findings",
          label: "Open critical findings",
          status: count > 0 ? "FAIL" : "OK",
          summary:
            count > 0
              ? "Open CRITICAL assurance findings require attention."
              : "No open CRITICAL assurance findings were found.",
          details: { count },
        };
      },
    ),
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overall: overallDoctorStatus(checks),
    checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [
    `AKP doctor: ${report.overall}`,
    `Generated: ${report.generatedAt}`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.label}: ${check.summary}`);
    if (check.details && Object.keys(check.details).length > 0) {
      lines.push(`  ${JSON.stringify(check.details)}`);
    }
  }
  return lines.join("\n");
}
