import fs from "node:fs";

const path = "packages/postgres/src/outbox.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`P7_PATCH_MISSING:${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`P7_PATCH_AMBIGUOUS:${label}`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  'import { randomUUID } from "node:crypto";\n',
  'import { randomUUID } from "node:crypto";\nimport {\n  currentTraceMetadata,\n  withSpan,\n  type TraceMetadata,\n} from "@akp/observability";\n',
  "observability-import",
);

replaceOnce(
  '  payload: Record<string, unknown>;\n}\n\nexport interface AppendOutboxEventInput {',
  '  payload: Record<string, unknown>;\n  telemetry?: TraceMetadata;\n}\n\nexport interface AppendOutboxEventInput {',
  "event-envelope-telemetry",
);

replaceOnce(
  '  payload?: Record<string, unknown>;\n}\n\nexport interface OutboxEventRecord',
  '  payload?: Record<string, unknown>;\n  telemetry?: TraceMetadata;\n}\n\nexport interface OutboxEventRecord',
  "append-input-telemetry",
);

replaceOnce(
  'function parseEnvelope(input: Record<string, unknown>): EventEnvelope {',
  `function normalizeTelemetry(value: unknown): TraceMetadata {\n  if (!value || typeof value !== "object" || Array.isArray(value)) return {};\n  const candidate = value as Record<string, unknown>;\n  const traceparent =\n    typeof candidate.traceparent === "string" &&\n    /^[\\da-f]{2}-[\\da-f]{32}-[\\da-f]{16}-[\\da-f]{2}$/i.test(\n      candidate.traceparent,\n    )\n      ? candidate.traceparent.toLowerCase()\n      : undefined;\n  const tracestate =\n    typeof candidate.tracestate === "string" && candidate.tracestate.length <= 512\n      ? candidate.tracestate\n      : undefined;\n  return {\n    ...(traceparent ? { traceparent } : {}),\n    ...(tracestate ? { tracestate } : {}),\n  };\n}\n\nfunction parseEnvelope(input: Record<string, unknown>): EventEnvelope {`,
  "telemetry-normalizer",
);

replaceOnce(
  '    occurredAt,\n    payload,\n  };',
  '    occurredAt,\n    payload,\n    telemetry: normalizeTelemetry(input.telemetry),\n  };',
  "parse-envelope-telemetry",
);

replaceOnce(
  '    payload:\n      row.payload && typeof row.payload === "object"\n        ? (row.payload as Record<string, unknown>)\n        : {},\n  });',
  '    payload:\n      row.payload && typeof row.payload === "object"\n        ? (row.payload as Record<string, unknown>)\n        : {},\n    telemetry: row.telemetry_metadata,\n  });',
  "map-event-telemetry",
);

replaceOnce(
  '    occurredAt: iso(input.occurredAt),\n    payload: input.payload ?? {},\n  });',
  '    occurredAt: iso(input.occurredAt),\n    payload: input.payload ?? {},\n    telemetry: input.telemetry ?? currentTraceMetadata(),\n  });',
  "normalize-event-telemetry",
);

replaceOnce(
  '  const event = normalizeEvent(input);\n  return inTransaction(target, async (client) => {',
  '  const event = normalizeEvent(input);\n  return withSpan(\n    "outbox.append",\n    { "akp.event.type": event.eventType },\n    () => inTransaction(target, async (client) => {',
  "append-span-open",
);

replaceOnce(
  '        vault_id,correlation_id,causation_id,occurred_at,payload\n      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)\n      on conflict(event_id) do nothing\n      returning event_id,event_type,event_version,resource_id,organization_id,\n                space_id,vault_id,correlation_id,causation_id,occurred_at,payload,\n                created_at',
  '        vault_id,correlation_id,causation_id,occurred_at,payload,telemetry_metadata\n      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)\n      on conflict(event_id) do nothing\n      returning event_id,event_type,event_version,resource_id,organization_id,\n                space_id,vault_id,correlation_id,causation_id,occurred_at,payload,\n                telemetry_metadata,created_at',
  "insert-telemetry",
);

replaceOnce(
  '        event.occurredAt,\n        JSON.stringify(event.payload),\n      ],',
  '        event.occurredAt,\n        JSON.stringify(event.payload),\n        JSON.stringify(event.telemetry ?? {}),\n      ],',
  "insert-telemetry-param",
);

replaceOnce(
  '             space_id,vault_id,correlation_id,causation_id,occurred_at,payload,\n             created_at\n        from event_outbox where event_id=$1',
  '             space_id,vault_id,correlation_id,causation_id,occurred_at,payload,\n             telemetry_metadata,created_at\n        from event_outbox where event_id=$1',
  "existing-select-telemetry",
);

replaceOnce(
  '      persisted.causationId !== event.causationId ||\n      JSON.stringify(persisted.payload) !== JSON.stringify(event.payload)',
  '      persisted.causationId !== event.causationId ||\n      JSON.stringify(persisted.payload) !== JSON.stringify(event.payload) ||\n      JSON.stringify(persisted.telemetry ?? {}) !==\n        JSON.stringify(event.telemetry ?? {})',
  "conflict-telemetry",
);

replaceOnce(
  '    return persisted;\n  });\n}\n\nexport interface RegisterConsumerOptions',
  '    return persisted;\n  })),\n  );\n}\n\nexport interface RegisterConsumerOptions',
  "append-span-close",
);

replaceOnce(
  '           e.vault_id,e.correlation_id,e.causation_id,e.occurred_at,e.payload,\n           e.created_at event_created_at',
  '           e.vault_id,e.correlation_id,e.causation_id,e.occurred_at,e.payload,\n           e.telemetry_metadata,e.created_at event_created_at',
  "claim-select-telemetry",
);

fs.writeFileSync(path, source);
