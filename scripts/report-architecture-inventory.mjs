import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z", "apps", "packages"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) =>
        /\.(?:[cm]?[jt]s|tsx|jsx|py)$/.test(file) && !file.endsWith(".d.ts"),
    );
}

function isProduct(file) {
  return (
    /^((apps|packages)\/[^/]+\/(?:src|app)\/)/.test(file) &&
    !/(\/test\/|\/tests\/|\.test\.|\.spec\.|\/fixtures\/)/.test(file)
  );
}

function exportedNames(file, source) {
  if (!/\.[jt]sx?$/.test(file)) return [];
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = [];
  tree.forEachChild((node) => {
    if (
      !ts.canHaveModifiers(node) ||
      !ts
        .getModifiers(node)
        ?.some((part) => part.kind === ts.SyntaxKind.ExportKeyword)
    )
      return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          names.push(declaration.name.text);
      }
    } else if ("name" in node && node.name && ts.isIdentifier(node.name)) {
      names.push(node.name.text);
    }
  });
  return names;
}

export function gatherArchitectureInventory(files = trackedSources()) {
  const entries = files.map((file) => {
    const content = readFileSync(path.join(root, file), "utf8");
    return { file, content, lines: content.split(/\r?\n/).length };
  });
  const large = entries
    .filter((entry) => isProduct(entry.file) && entry.lines >= 650)
    .map(({ file, lines }) => ({ file, lines }))
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const corpus = entries.filter((entry) => /\.[jt]sx?$/.test(entry.file));
  const exported = entries.flatMap(({ file, content }) =>
    exportedNames(file, content).map((name) => ({ file, name })),
  );
  const possibleUnused = exported
    .filter(({ file, name }) => {
      if (/\/(?:page|layout|error|not-found|loading|route)\.tsx?$/.test(file))
        return false;
      if (/\/index\.tsx?$/.test(file)) return false;
      const escapedName = name.replaceAll("$", "\\$");
      const usage = new RegExp("\\b" + escapedName + "\\b");
      return !corpus.some(
        (entry) => entry.file !== file && usage.test(entry.content),
      );
    })
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
    );
  return {
    schema: "akp.architecture.s0-inventory.v1",
    method:
      "tracked source files, TS AST top-level exports and approximate identifier search",
    trackedSourceFiles: entries.length,
    trackedSourceLines: entries.reduce(
      (total, entry) => total + entry.lines,
      0,
    ),
    largeThresholdLines: 650,
    largeFileCount: large.length,
    largestFiles: large.slice(0, 40),
    possibleUnusedExportCount: possibleUnused.length,
    possibleUnusedExports: possibleUnused.slice(0, 80),
    disclaimer:
      "Possible unused means no exact identifier occurrence in another tracked TS/JS file; framework reflection, package consumers, dynamic access and TS declaration exports create false positives. Never delete from this report alone.",
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  process.stdout.write(
    JSON.stringify(gatherArchitectureInventory(), null, 2) + "\n",
  );
}
