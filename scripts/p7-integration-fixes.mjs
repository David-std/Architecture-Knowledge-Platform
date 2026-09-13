import fs from "node:fs";

function patchFile(path, patches) {
  let source = fs.readFileSync(path, "utf8");
  for (const [label, before, after] of patches) {
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`P7_PATCH_MISSING:${path}:${label}`);
    if (source.indexOf(before, first + before.length) >= 0) {
      throw new Error(`P7_PATCH_AMBIGUOUS:${path}:${label}`);
    }
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

patchFile("packages/postgres/src/outbox.ts", [
  [
    "direct-otel-api",
    `import { randomUUID } from "node:crypto";\nimport {\n  currentTraceMetadata,\n  withSpan,\n  type TraceMetadata,\n} from "@akp/observability";\n`,
    `import { randomUUID } from "node:crypto";\nimport {\n  context,\n  SpanStatusCode,\n  trace,\n  TraceFlags,\n} from "@opentelemetry/api";\n\nexport interface TraceMetadata {\n  traceparent?: string;\n  tracestate?: string;\n}\n\nconst outboxTracer = trace.getTracer("akp-postgres-outbox", "0.3.0");\n\nfunction validTraceId(value: string): boolean {\n  return /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/i.test(value);\n}\n\nfunction validSpanId(value: string): boolean {\n  return /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/i.test(value);\n}\n\nfunction currentTraceMetadata(): TraceMetadata {\n  const active = trace.getSpanContext(context.active());\n  if (!active || !validTraceId(active.traceId) || !validSpanId(active.spanId)) {\n    return {};\n  }\n  const flags = (active.traceFlags & TraceFlags.SAMPLED)\n    .toString(16)\n    .padStart(2, "0");\n  return {\n    traceparent: \`00-\${active.traceId}-\${active.spanId}-\${flags}\`,\n    ...(active.traceState ? { tracestate: active.traceState.serialize() } : {}),\n  };\n}\n\nasync function withSpan<T>(\n  name: string,\n  attributes: Record<string, string | number | boolean>,\n  operation: () => Promise<T>,\n): Promise<T> {\n  return outboxTracer.startActiveSpan(name, { attributes }, async (span) => {\n    try {\n      return await operation();\n    } catch (error) {\n      const normalized = error instanceof Error ? error : new Error(String(error));\n      span.recordException(normalized);\n      span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message });\n      throw error;\n    } finally {\n      span.end();\n    }\n  });\n}\n`,
  ],
]);

patchFile("packages/postgres/package.json", [
  [
    "direct-otel-dependency",
    '    "@akp/observability": "*"\n',
    '    "@opentelemetry/api": "^1.9.0"\n',
  ],
]);

patchFile("apps/mcp/tsconfig.json", [
  [
    "workspace-rootdir",
    '  "compilerOptions": { "outDir": "dist", "rootDir": "src" },',
    '  "compilerOptions": { "outDir": "dist" },',
  ],
]);

patchFile("apps/worker/src/compilation-stage.ts", [
  [
    "vault-narrowing",
    `  if (!input.vaultId) throw new Error("KNOWLEDGE_COMPILER_VAULT_REQUIRED");\n\n  const evidence = await loadEvidence(db, {\n    ...input,\n    vaultId: input.vaultId,\n  });`,
    `  const vaultId = input.vaultId;\n  if (!vaultId) throw new Error("KNOWLEDGE_COMPILER_VAULT_REQUIRED");\n\n  const evidence = await loadEvidence(db, {\n    ...input,\n    vaultId,\n  });`,
  ],
  [
    "vault-narrowing-callback",
    `        spaceId: input.spaceId,\n        vaultId: input.vaultId,\n        vectorEnabled: input.vectorEnabled,`,
    `        spaceId: input.spaceId,\n        vaultId,\n        vectorEnabled: input.vectorEnabled,`,
  ],
]);

patchFile("apps/web/app/admin/health/page.tsx", [
  ["honest-sdk-state", '                  ? "EXPORTING"', '                  ? "SDK_ACTIVE"'],
]);
