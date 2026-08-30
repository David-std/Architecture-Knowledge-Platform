import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a local source only when it is inside an explicitly configured,
 * canonical ingestion root. This check is repeated by the worker immediately
 * before opening a queued job because the API check and the later file read
 * are separate trust boundaries.
 */
export async function resolveAuthorizedLocalSource(
  sourceUri: string,
  rootsValue = process.env.AKP_INGEST_ROOTS,
): Promise<string> {
  let candidate: string;
  try {
    candidate = sourceUri.startsWith("file:")
      ? fileURLToPath(sourceUri)
      : sourceUri;
  } catch {
    throw new Error("SOURCE_PATH_NOT_ALLOWED");
  }
  if (/^https?:/i.test(sourceUri)) {
    throw new Error(
      "Remote URLs require a captured local snapshot before ingestion.",
    );
  }
  const configuredRoots = rootsValue?.trim();
  if (!configuredRoots) throw new Error("SOURCE_PATH_NOT_ALLOWED");
  const rootValues = configuredRoots.split(path.delimiter);
  if (rootValues.some((root) => !root.trim())) {
    throw new Error("SOURCE_PATH_NOT_ALLOWED");
  }
  const canonical = await realpath(path.resolve(candidate)).catch(() => null);
  const fileStat = canonical ? await stat(canonical).catch(() => null) : null;
  if (!canonical || !fileStat?.isFile()) {
    throw new Error("SOURCE_PATH_NOT_ALLOWED");
  }
  const roots = await Promise.all(
    rootValues.map(async (root) =>
      realpath(path.resolve(root.trim())).catch(() => null),
    ),
  );
  const inside = roots.some((root) => {
    if (!root) return false;
    const relative = path.relative(root, canonical);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
  if (!inside) throw new Error("SOURCE_PATH_NOT_ALLOWED");
  return canonical;
}
