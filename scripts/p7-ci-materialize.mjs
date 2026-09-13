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

const otelEnv = `OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=ci,service.namespace=akp OTEL_METRIC_EXPORT_INTERVAL=1000`;

patchFile(".github/workflows/ci.yml", [
  [
    "collector-start",
    '      - run: docker compose up -d --wait postgres minio extractor\n',
    `      - run: docker compose up -d --wait postgres minio extractor\n      - run: docker compose --profile observability up -d otel-collector\n      - name: Wait for optional OpenTelemetry Collector\n        shell: bash\n        run: |\n          for i in $(seq 1 30); do\n            if curl -fsS http://127.0.0.1:13133/ >/dev/null; then\n              exit 0\n            fi\n            sleep 1\n          done\n          docker compose --profile observability logs --no-color otel-collector\n          exit 1\n`,
  ],
  [
    "api-otel",
    '      - run: pnpm --filter @akp/api dev > api.log 2>&1 &\n',
    `      - run: ${otelEnv} pnpm --filter @akp/api dev > api.log 2>&1 &\n`,
  ],
  [
    "mcp-otel",
    '      - run: pnpm test:mcp\n',
    `      - run: ${otelEnv} pnpm test:mcp\n`,
  ],
  [
    "backup-restore-otel",
    `      - shell: pwsh\n        run: ./scripts/backup.ps1 -OutputDirectory backups/ci\n      - shell: pwsh\n        run: ./scripts/restore-smoke.ps1 -BackupDirectory backups/ci\n`,
    `      - name: Run traced backup\n        shell: bash\n        run: >-\n          ${otelEnv}\n          pnpm exec tsx scripts/telemetry-command.ts backup\n          pwsh -NoProfile -File scripts/backup.ps1\n          -OutputDirectory backups/ci\n      - name: Run traced restore smoke\n        shell: bash\n        run: >-\n          ${otelEnv}\n          pnpm exec tsx scripts/telemetry-command.ts restore\n          pwsh -NoProfile -File scripts/restore-smoke.ps1\n          -BackupDirectory backups/ci\n      - name: Verify P7 OpenTelemetry runtime evidence\n        shell: bash\n        run: |\n          sleep 5\n          mkdir -p reports/ci\n          docker compose --profile observability logs --no-color otel-collector > reports/ci/otel-collector.log 2>&1\n          AKP_OTEL_COLLECTOR_LOG=reports/ci/otel-collector.log node scripts/verify-observability.mjs \\\n            | tee reports/ci/p7-observability-verification.json\n`,
  ],
]);

patchFile(".env.example", [
  [
    "otel-env",
    'AKP_EXTRACTOR_TOKEN=replace-with-a-random-local-secret\n',
    `AKP_EXTRACTOR_TOKEN=replace-with-a-random-local-secret\n\n# OpenTelemetry is optional. The platform remains usable when both exporters\n# are disabled. Enable the Compose \'observability\' profile and switch the\n# exporters to \'otlp\' to send traces/metrics to the local Collector.\nOTEL_TRACES_EXPORTER=none\nOTEL_METRICS_EXPORTER=none\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318\n# OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=local,service.namespace=akp\n# OTEL_METRIC_EXPORT_INTERVAL=60000\nAKP_OTEL_GRPC_PORT=4317\nAKP_OTEL_HTTP_PORT=4318\nAKP_OTEL_HEALTH_PORT=13133\n`,
  ],
]);
