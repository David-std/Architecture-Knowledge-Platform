import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

export function moduleSpecifierReferences(file, source) {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const references = [];
  function collect(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      references.push({
        file,
        specifier: specifier.text,
        line:
          tree.getLineAndCharacterOfPosition(specifier.getStart(tree)).line + 1,
      });
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  return references;
}

export function validateImportSurfaces(references, modules) {
  const moduleByName = new Map(
    modules.map(({ name, ...rest }) => [name, rest]),
  );
  const errors = [];
  for (const { file, specifier, line } of references) {
    const parts = file.replaceAll("\\", "/").split("/");
    if (parts.length < 3 || !["apps", "packages"].includes(parts[0])) continue;
    const owner = parts.slice(0, 2).join("/");
    const place = file + ":" + line;

    if (specifier.startsWith("@akp/")) {
      const segments = specifier.split("/");
      const packageName = segments.slice(0, 2).join("/");
      const module = moduleByName.get(packageName);
      if (!module) {
        errors.push("UNKNOWN_INTERNAL_PACKAGE:" + place + ":" + specifier);
        continue;
      }
      if (segments.length > 2) {
        const key = "./" + segments.slice(2).join("/");
        const exports = module.exports;
        if (!exports || !Object.hasOwn(exports, key)) {
          errors.push("UNDECLARED_PACKAGE_SUBPATH:" + place + ":" + specifier);
        }
      }
    }

    const isProduction = ["src", "app"].includes(parts[2]);
    if (
      isProduction &&
      (specifier.startsWith("../") || specifier.startsWith("./"))
    ) {
      const resolved = path.posix.normalize(
        path.posix.join(parts.slice(0, -1).join("/"), specifier),
      );
      const target = resolved.split("/").slice(0, 2).join("/");
      if (target !== owner) {
        errors.push("CROSS_PACKAGE_RELATIVE_IMPORT:" + place + ":" + specifier);
      }
    }
  }
  return errors.sort();
}

export function readImportSurfaces(rootDirectory = root) {
  const names = execFileSync("git", ["ls-files", "-z", "apps", "packages"], {
    cwd: rootDirectory,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (name) =>
        /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(name) && !name.endsWith(".d.ts"),
    );
  const modules = [];
  for (const folder of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(rootDirectory, folder), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const file = folder + "/" + entry.name + "/package.json";
      try {
        const json = JSON.parse(
          readFileSync(path.join(rootDirectory, file), "utf8"),
        );
        modules.push({
          name: json.name,
          location: file,
          exports: json.exports,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  const references = names.flatMap((file) =>
    moduleSpecifierReferences(
      file,
      readFileSync(path.join(rootDirectory, file), "utf8"),
    ),
  );
  return {
    fileCount: names.length,
    references,
    errors: validateImportSurfaces(references, modules),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = readImportSurfaces();
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exitCode = 1;
  else
    console.log(
      "IMPORT_SURFACES_OK files=" +
        result.fileCount +
        " references=" +
        result.references.length,
    );
}
