import { access, readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

const root = process.cwd();
const failures = [];
const required = [
  "README.md",
  "PROJECT_STATE.md",
  "VALIDATION_REPORT.md",
  "docs/architecture/c4.md",
  "docs/architecture/database-erd.md",
  "docs/security/threat-model.md",
  "docs/runbooks/local-operations.md",
];
for (const file of required) {
  await access(path.join(root, file)).catch(() =>
    failures.push(`missing required document: ${file}`),
  );
}

const markdownFiles = await fg(["*.md", "docs/**/*.md", "reports/**/*.md"], {
  cwd: root,
  onlyFiles: true,
  ignore: ["docs/archive/iterations/**"],
});
for (const relativePath of markdownFiles) {
  const raw = await readFile(path.join(root, relativePath), "utf8");
  if (/\b(TODO|TBD)\b/.test(raw))
    failures.push(`${relativePath}: unresolved TODO/TBD marker`);
  for (const match of raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = String(match[1]).split("#", 1)[0]?.trim() ?? "";
    if (
      !target ||
      /^(?:https?:|mailto:|#)/i.test(target) ||
      path.isAbsolute(target)
    )
      continue;
    const resolved = path.resolve(
      path.dirname(path.join(root, relativePath)),
      target,
    );
    await access(resolved).catch(() =>
      failures.push(`${relativePath}: broken link ${target}`),
    );
  }
}

console.log(
  JSON.stringify({
    status: failures.length ? "FAILED" : "PASSED",
    markdownFiles: markdownFiles.length,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
