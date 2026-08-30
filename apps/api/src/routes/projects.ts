import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import { buildProjectSnapshot } from "@akp/project-adapter";
import {
  actorOf,
  audit,
  hasPathAccess,
  hasSpaceAccess,
  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";
import { rebuildSpaceProjections } from "../projections.js";

function revision(repositoryPath: string): string | null {
  const result = spawnSync(
    "git",
    ["-C", repositoryPath, "rev-parse", "--verify", "HEAD^{commit}"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return result.status === 0 && /^[a-f0-9]{40}$/i.test(result.stdout.trim())
    ? result.stdout.trim()
    : null;
}

function safeProjectSlug(slug: string): string | null {
  return /^[a-z0-9][a-z0-9-]{0,79}$/i.test(slug) ? slug : null;
}

function configuredProjectRoots(): string[] | null {
  const configured = process.env.AKP_PROJECT_ROOTS;
  if (!configured?.trim()) return null;
  const values = configured.split(path.delimiter).map((root) => root.trim());
  if (values.length === 0 || values.some((root) => root.length === 0)) {
    return null;
  }
  return values.map((root) => path.resolve(root));
}

function sanitizeProjectPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProjectPayload);
  if (typeof value === "string") {
    return value.replace(
      /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g,
      "[REDACTED_PATH]",
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/^(?:root(?:path|_path)|repository(?:path|_path)|local(?:path|_path)|absolute(?:path|_path)|canonical(?:path|_path))$/i.test(
            key,
          ),
      )
      .map(([key, entry]) => [key, sanitizeProjectPayload(entry)]),
  );
}

function projectKnowledgeBody(
  slug: string,
  snapshot: Awaited<ReturnType<typeof buildProjectSnapshot>>,
): string {
  const repositoryFingerprint = createHash("sha256")
    .update(snapshot.repository)
    .digest("hex")
    .slice(0, 16);
  const evidence = snapshot.evidence.slice(0, 200).map((item) => {
    const locator = item.locator;
    return `- [${item.tier}] ${item.behavior} — ${locator.path}:${locator.startLine}-${locator.endLine}`;
  });
  const changed = snapshot.changedFiles
    .slice(0, 200)
    .map((file) => `- ${file}`);
  return [
    `# Project evidence: ${slug}`,
    "",
    "## Immutable snapshot",
    "",
    `- Repository fingerprint: ${repositoryFingerprint}`,
    `- Commit: ${snapshot.commit}`,
    `- Snapshot mode: ${snapshot.snapshotMode}`,
    `- Files: ${snapshot.files.length}`,
    `- Symbols: ${snapshot.symbols.length}`,
    `- Dependencies: ${snapshot.dependencies.length}`,
    "",
    "## Deterministic code evidence",
    "",
    ...(evidence.length
      ? evidence
      : ["- No deterministic code signal was found."]),
    "",
    "## Changed files",
    "",
    ...(changed.length ? changed : ["- No change range was supplied."]),
    "",
    "## Limits",
    "",
    "Static signals are not runtime proof. Each code locator remains tied to the immutable commit above.",
  ].join("\n");
}

export function registerProjectRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/projects",
    { preHandler: requirePermission("knowledge:read") },
    async (request) => {
      const actor = actorOf(request);
      if (!actor) return { projects: [] };
      const spaces = spaceIdsForPermission(actor, "knowledge:read");
      const vaultIds: string[] = [];
      const accessByVault: Record<
        string,
        { pathPrefix: string | null; permissions: string[] }
      > = {};
      for (const spaceId of spaces) {
        try {
          const scope = await resolveAuthorizedVaultScope(db, {
            userId: actor.id,
            spaceId,
            permission: "knowledge:read",
            federated: true,
          });
          vaultIds.push(...scope.vaultIds);
          Object.assign(accessByVault, scope.accessByVault);
        } catch {
          // Keep private vaults hidden rather than signaling their existence.
        }
      }
      if (!vaultIds.length) return { projects: [] };
      const result = await db.pool.query(
        "select * from projects where space_id=any($1::uuid[]) and vault_id=any($2::uuid[]) order by created_at desc",
        [spaces, [...new Set(vaultIds)]],
      );
      return {
        projects: result.rows.filter(
          (project) =>
            hasPathAccess(
              actor,
              String(project.space_id),
              "knowledge:read",
              `projects/${String(project.slug)}`,
            ) &&
            pathMatchesVaultPrefix(
              `projects/${String(project.slug)}`,
              accessByVault[String(project.vault_id)]?.pathPrefix,
            ),
        ),
      };
    },
  );

  app.post<{
    Body: {
      slug: string;
      rootPath: string;
      spaceId: string;
      vaultId: string;
      commit?: string;
      changedSince?: string;
    };
  }>(
    "/v1/projects/scan",
    { preHandler: requirePermission("knowledge:propose") },
    async (request, reply) => {
      if (!request.body?.slug || !request.body?.rootPath) {
        return reply.code(400).send({ code: "PROJECT_INPUT_REQUIRED" });
      }
      const slug = safeProjectSlug(request.body.slug);
      if (!slug) return reply.code(400).send({ code: "INVALID_PROJECT_SLUG" });
      const spaceId = request.body.spaceId;
      const vaultId = request.body.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!hasSpaceAccess(actor, spaceId, "knowledge:propose")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const projectPath = `projects/${slug}`;
      if (!hasPathAccess(actor, spaceId, "knowledge:propose", projectPath)) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      let vaultScope: Awaited<ReturnType<typeof resolveAuthorizedVaultScope>>;
      try {
        vaultScope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId,
          permission: "knowledge:propose",
          vaultId,
          vaultIds: [vaultId],
          federated: false,
        });
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      const vaultAccess = vaultScope.accessByVault[vaultId];
      if (
        !vaultAccess ||
        !pathMatchesVaultPrefix(projectPath, vaultAccess.pathPrefix)
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const configuredRoots = configuredProjectRoots();
      if (!configuredRoots) {
        return reply.code(503).send({ code: "PROJECT_ROOTS_NOT_CONFIGURED" });
      }
      const rootPath = await realpath(
        path.resolve(request.body.rootPath),
      ).catch(() => null);
      const rootStat = rootPath ? await stat(rootPath).catch(() => null) : null;
      if (!rootPath || !rootStat?.isDirectory()) {
        return reply.code(400).send({ code: "PROJECT_ROOT_NOT_FOUND" });
      }
      const allowedRoots = (
        await Promise.all(
          configuredRoots.map(async (root) => {
            const canonicalRoot = await realpath(root).catch(() => null);
            const rootInfo = canonicalRoot
              ? await stat(canonicalRoot).catch(() => null)
              : null;
            return canonicalRoot && rootInfo?.isDirectory()
              ? canonicalRoot
              : null;
          }),
        )
      ).filter((root): root is string => Boolean(root));
      if (
        !allowedRoots.some((root) => {
          const relative = path.relative(root, rootPath);
          return (
            relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative))
          );
        })
      ) {
        return reply.code(403).send({ code: "PROJECT_ROOT_NOT_ALLOWED" });
      }
      if (request.body.commit && !/^[a-f0-9]{40}$/i.test(request.body.commit)) {
        return reply.code(400).send({ code: "INVALID_IMMUTABLE_COMMIT" });
      }
      if (
        request.body.changedSince &&
        !/^[a-f0-9]{40}$/i.test(request.body.changedSince)
      ) {
        return reply.code(400).send({ code: "INVALID_CHANGED_SINCE_COMMIT" });
      }
      const commit = request.body.commit ?? revision(rootPath);
      if (!commit) {
        return reply.code(422).send({ code: "IMMUTABLE_GIT_COMMIT_REQUIRED" });
      }
      const snapshot = await buildProjectSnapshot({
        repositoryPath: rootPath,
        commit,
        ...(request.body.changedSince
          ? { changedSince: request.body.changedSince }
          : {}),
      });
      const safeSnapshot = sanitizeProjectPayload(snapshot) as typeof snapshot;
      const body = projectKnowledgeBody(slug, snapshot);
      const result = await db.pool.query(
        `
        insert into projects(space_id,vault_id,slug,root_path,metadata)
        values($1,$2,$3,$4,$5::jsonb)
        on conflict(vault_id,slug) do update set root_path=excluded.root_path,metadata=excluded.metadata
        returning *
        `,
        [
          spaceId,
          vaultId,
          slug,
          rootPath,
          JSON.stringify({
            commit,
            snapshot: safeSnapshot,
            scannedAt: new Date().toISOString(),
            limitation:
              "Static inventories and explicit imports are evidence signals; runtime behavior and architectural intent still require stronger proof.",
          }),
        ],
      );
      await db.pool.query(
        `
        insert into knowledge_documents(
          space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
          body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
        ) values($1,$2,$3,$4,$5,'project-evidence','ACTIVE','MACHINE_SUPPORTED',$6,
                 $7,$8::jsonb,$9,'project',$10,$11,'[]'::jsonb)
        on conflict(vault_id,path) where vault_id is not null do update set
          external_id=excluded.external_id,title=excluded.title,current_revision=excluded.current_revision,
          body_cache=excluded.body_cache,frontmatter=excluded.frontmatter,aliases=excluded.aliases,
          content_hash=excluded.content_hash,token_estimate=excluded.token_estimate,
          lifecycle='ACTIVE',trust_tier='MACHINE_SUPPORTED',refresh_status='CURRENT',updated_at=now()
        `,
        [
          spaceId,
          vaultId,
          `projects/${slug}/snapshot.md`,
          `PROJECT-${slug.toUpperCase()}`,
          `Project evidence: ${slug}`,
          snapshot.commit,
          body,
          JSON.stringify({
            repository_fingerprint: createHash("sha256")
              .update(snapshot.repository)
              .digest("hex")
              .slice(0, 16),
            commit: snapshot.commit,
            snapshot_mode: snapshot.snapshotMode,
            code_evidence_tier: "NO_SIGNAL",
          }),
          [slug],
          createHash("sha256").update(body).digest("hex"),
          Math.ceil(body.length / 4),
        ],
      );
      const projection = await rebuildSpaceProjections(db, spaceId, vaultId);
      await audit(
        db,
        request,
        "project.scan",
        "project",
        String(result.rows[0]?.id),
        {
          vaultId,
          repositoryFingerprint: createHash("sha256")
            .update(rootPath)
            .digest("hex")
            .slice(0, 16),
          commit,
          evidenceCount: snapshot.evidence.length,
          fileCount: snapshot.files.length,
          symbolCount: snapshot.symbols.length,
          dependencyCount: snapshot.dependencies.length,
          projection,
        },
        spaceId,
      );
      const project = sanitizeProjectPayload(result.rows[0]) as Record<
        string,
        unknown
      >;
      return reply.code(201).send({ ...project, projection });
    },
  );
}
