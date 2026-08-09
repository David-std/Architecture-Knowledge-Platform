import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
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

function projectKnowledgeBody(
  slug: string,
  snapshot: Awaited<ReturnType<typeof buildProjectSnapshot>>,
): string {
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
    `- Repository: ${snapshot.repository}`,
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
      const result = await db.pool.query(
        "select * from projects where space_id=any($1::uuid[]) order by created_at desc",
        [spaceIdsForPermission(actor, "knowledge:read")],
      );
      return {
        projects: result.rows.filter((project) =>
          hasPathAccess(
            actor,
            String(project.space_id),
            "knowledge:read",
            `projects/${String(project.slug)}`,
          ),
        ),
      };
    },
  );

  app.post<{
    Body: {
      slug: string;
      rootPath: string;
      spaceId?: string;
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
      const rootPath = await realpath(
        path.resolve(request.body.rootPath),
      ).catch(() => null);
      if (!rootPath || !(await stat(rootPath)).isDirectory()) {
        return reply.code(400).send({ code: "PROJECT_ROOT_NOT_FOUND" });
      }
      const allowedRoots = (process.env.AKP_PROJECT_ROOTS ?? process.cwd())
        .split(path.delimiter)
        .map((root) => path.resolve(root.trim()))
        .filter(Boolean);
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
      const spaceId =
        request.body.spaceId ??
        spaceIdsForPermission(actorOf(request), "knowledge:propose")[0] ??
        "00000000-0000-0000-0000-000000000003";
      if (!hasSpaceAccess(actorOf(request), spaceId, "knowledge:propose")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      if (
        !hasPathAccess(
          actorOf(request),
          spaceId,
          "knowledge:propose",
          `projects/${slug}`,
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const body = projectKnowledgeBody(slug, snapshot);
      const result = await db.pool.query(
        `
        insert into projects(space_id,slug,root_path,metadata)
        values($1,$2,$3,$4::jsonb)
        on conflict(space_id,slug) do update set root_path=excluded.root_path,metadata=excluded.metadata
        returning *
        `,
        [
          spaceId,
          slug,
          rootPath,
          JSON.stringify({
            commit,
            snapshot,
            scannedAt: new Date().toISOString(),
            limitation:
              "Static inventories and explicit imports are evidence signals; runtime behavior and architectural intent still require stronger proof.",
          }),
        ],
      );
      await db.pool.query(
        `
        insert into knowledge_documents(
          space_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
          body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
        ) values($1,$2,$3,$4,'project-evidence','ACTIVE','MACHINE_SUPPORTED',$5,
                 $6,$7::jsonb,$8,'project',$9,$10,'[]'::jsonb)
        on conflict(space_id,path) do update set
          external_id=excluded.external_id,title=excluded.title,current_revision=excluded.current_revision,
          body_cache=excluded.body_cache,frontmatter=excluded.frontmatter,aliases=excluded.aliases,
          content_hash=excluded.content_hash,token_estimate=excluded.token_estimate,
          lifecycle='ACTIVE',trust_tier='MACHINE_SUPPORTED',refresh_status='CURRENT',updated_at=now()
        `,
        [
          spaceId,
          `projects/${slug}/snapshot.md`,
          `PROJECT-${slug.toUpperCase()}`,
          `Project evidence: ${slug}`,
          snapshot.commit,
          body,
          JSON.stringify({
            repository: snapshot.repository,
            commit: snapshot.commit,
            snapshot_mode: snapshot.snapshotMode,
            code_evidence_tier: "NO_SIGNAL",
          }),
          [slug],
          createHash("sha256").update(body).digest("hex"),
          Math.ceil(body.length / 4),
        ],
      );
      const projection = await rebuildSpaceProjections(db, spaceId);
      await audit(
        db,
        request,
        "project.scan",
        "project",
        String(result.rows[0]?.id),
        {
          rootPath,
          commit,
          evidenceCount: snapshot.evidence.length,
          fileCount: snapshot.files.length,
          symbolCount: snapshot.symbols.length,
          dependencyCount: snapshot.dependencies.length,
          projection,
        },
      );
      return reply.code(201).send({ ...result.rows[0], projection });
    },
  );
}
