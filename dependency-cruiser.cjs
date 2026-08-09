module.exports = {
  forbidden: [
    {
      name: "domain-must-not-depend-on-infrastructure",
      from: { path: "^packages/domain" },
      to: {
        path: "^(apps|packages/(postgres|git-store|object-store|retrieval))",
      },
    },
    {
      name: "contracts-must-stay-independent",
      from: { path: "^packages/contracts" },
      to: {
        path: "^(apps|packages/(application|postgres|git-store|object-store))",
      },
    },
    {
      name: "web-must-use-api",
      from: { path: "^apps/web" },
      to: { path: "^packages/(postgres|git-store|object-store)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"] },
  },
};
