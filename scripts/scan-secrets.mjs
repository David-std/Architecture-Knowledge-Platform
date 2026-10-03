import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  "dist",
  "backups",
  ".git",
]);

async function fallbackRepositoryFiles(root = ".", relativeRoot = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (FALLBACK_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await fallbackRepositoryFiles(path.join(root, entry.name), relativePath)));
      continue;
    }
    if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

const files = existsSync(".git")
  ? [
      ...new Set(
        execFileSync(
          "git",
          ["ls-files", "--cached", "--others", "--exclude-standard"],
          {
            encoding: "utf8",
          },
        )
          .split(/\r?\n/)
          .map((file) => file.replaceAll("\\", "/"))
          .filter((file) => file && existsSync(file)),
      ),
    ]
  : await fallbackRepositoryFiles();
const forbiddenPaths = files.filter(
  (file) =>
    (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith(".env.example")) ||
    /^backups\//.test(file) ||
    /\.(?:dump|tar|pfx|p12|key)$/i.test(file),
);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:aws_secret_access_key|client_secret)\s*[:=]\s*["']?[A-Za-z0-9/+]{24,}/i,
];
const findings = [];
for (const file of files) {
  if (/\.(?:png|jpg|jpeg|gif|webp|pdf|zip|dump|tar)$/i.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(text)) findings.push(`${file}: ${pattern}`);
  }
}
if (forbiddenPaths.length || findings.length) {
  console.error(JSON.stringify({ forbiddenPaths, findings }, null, 2));
  process.exit(1);
}
console.log(
  JSON.stringify({ status: "PASSED", repositoryFilesScanned: files.length }),
);
