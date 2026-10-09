import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Architectural dependencies of pure modules. Infrastructure belongs outside.
export const pureModuleDependencies = Object.freeze({
  "@akp/contracts": [],
  "@akp/domain": [],
  "@akp/application": ["@akp/contracts", "@akp/domain"],
  "@akp/compiler": ["@akp/contracts"],
  "@akp/graph": ["@akp/domain"],
  "@akp/policy": ["@akp/contracts"],
  "@akp/project-adapter": ["@akp/contracts"],
  "@akp/retrieval": ["@akp/contracts"],
  "@akp/validation": ["@akp/contracts"],
});

export function validateModuleGraph(manifests) {
  const errors = [];
  const byName = new Map();
  for (const item of manifests) {
    const { name, location } = item;
    if (!name || byName.has(name)) {
      errors.push(
        "MODULE_NAME_DUPLICATE_OR_MISSING:" + location + ":" + (name || ""),
      );
      continue;
    }
    byName.set(name, item);
  }
  const edges = new Map();
  for (const [name, module] of byName) {
    const internal = new Set();
    const all = {
      ...module.dependencies,
      ...module.devDependencies,
      ...module.optionalDependencies,
    };
    for (const dependency of Object.keys(all).sort()) {
      if (!dependency.startsWith("@akp/")) continue;
      if (!byName.has(dependency)) {
        errors.push("MODULE_DEPENDENCY_NOT_FOUND:" + name + ":" + dependency);
        continue;
      }
      internal.add(dependency);
      if (
        module.location.startsWith("packages/") &&
        byName.get(dependency).location.startsWith("apps/")
      ) {
        errors.push("LIBRARY_IMPORTS_APP:" + name + ":" + dependency);
      }
      const allowed = pureModuleDependencies[name];
      if (allowed && !allowed.includes(dependency)) {
        errors.push("CORE_BOUNDARY_VIOLATION:" + name + ":" + dependency);
      }
    }
    edges.set(name, [...internal].sort());
  }

  const visiting = new Set();
  const visited = new Set();
  const reportedCycles = new Set();
  function walk(name, ancestry) {
    if (visiting.has(name)) {
      const begin = ancestry.indexOf(name);
      const cycle = [...ancestry.slice(begin), name].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        reportedCycles.add(cycle);
        errors.push("MODULE_DEPENDENCY_CYCLE:" + cycle);
      }
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const next of edges.get(name) ?? []) walk(next, [...ancestry, name]);
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of [...byName.keys()].sort()) walk(name, []);
  return {
    moduleCount: byName.size,
    dependencyCount: [...edges.values()].reduce(
      (n, deps) => n + deps.length,
      0,
    ),
    errors: errors.sort(),
  };
}

export function readRepositoryManifests(root = repositoryRoot) {
  const manifests = [];
  for (const container of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(root, container), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const location = container + "/" + entry.name;
      const manifestPath = path.join(root, location, "package.json");
      let json;
      try {
        json = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      manifests.push({
        location,
        name: json.name,
        dependencies: json.dependencies ?? {},
        devDependencies: json.devDependencies ?? {},
        optionalDependencies: json.optionalDependencies ?? {},
      });
    }
  }
  return manifests;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = validateModuleGraph(readRepositoryManifests());
  for (const error of result.errors) console.error(error);
  if (result.errors.length) process.exitCode = 1;
  else
    console.log(
      "MODULE_BOUNDARIES_OK modules=" +
        result.moduleCount +
        " edges=" +
        result.dependencyCount,
    );
}
