import path from "node:path";
import type { NextConfig } from "next";

// Next executes this workspace script with `apps/web` as its working
// directory. Avoid `import.meta` here because the package intentionally uses
// Next's CommonJS-compatible config loading during `tsc --noEmit`.
const repositoryRoot = path.resolve(process.cwd(), "../..");

const config: NextConfig = {
  // A Team Context Node ships the web surface as a container. Standalone
  // output traces exactly the workspace files the server needs instead of
  // requiring the whole monorepo install at runtime.
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  turbopack: {
    root: repositoryRoot,
  },
};

export default config;
