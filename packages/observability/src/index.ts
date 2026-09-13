import {
  context,
  createTraceState,
  metrics,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Context,
  type Span,
  type SpanOptions,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface AuditEvent {
  action: string;
  actorId?: string;
  resourceType: string;
  resourceId?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface Telemetry {
  counter(
    name: string,
    value?: number,
    attributes?: Record<string, string>,
  ): void;
  gauge(
    name: string,
    value: number,
    attributes?: Record<string, string>,
  ): void;
  histogram(
    name: string,
    value: number,
    attributes?: Record<string, string>,
  ): void;
  audit(event: AuditEvent): Promise<void>;
}

export interface TraceMetadata {
  traceparent?: string;
  tracestate?: string;
}

export interface OpenTelemetryRuntimeStatus {
  enabled: boolean;
  started: boolean;
  serviceName: string | null;
  tracesExporter: string;
  metricsExporter: string;
  endpoint: string | null;
  protocol: string;
  w3cTraceContext: true;
  logs: "STRUCTURED_APPLICATION_LOGS";
  lastError: string | null;
}

export interface OpenTelemetryBootstrapOptions {
  serviceName: string;
  autoInstrument?: boolean;
}

let sdk: NodeSDK | null = null;
let sdkStarting = false;
let runtimeStatus: OpenTelemetryRuntimeStatus = {
  enabled: false,
  started: false,
  serviceName: null,
  tracesExporter: "none",
  metricsExporter: "none",
  endpoint: null,
  protocol: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
  w3cTraceContext: true,
  logs: "STRUCTURED_APPLICATION_LOGS",
  lastError: null,
};

function exporterSelection(signal: "TRACES" | "METRICS"): string {
  const explicit = process.env[`OTEL_${signal}_EXPORTER`]?.trim();
  if (explicit) return explicit;
  const signalEndpoint = process.env[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`];
  const commonEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return signalEndpoint || commonEndpoint ? "otlp" : "none";
}

function setSafeExporterDefaults(): void {
  if (!process.env.OTEL_TRACES_EXPORTER) {
    process.env.OTEL_TRACES_EXPORTER = exporterSelection("TRACES");
  }
  if (!process.env.OTEL_METRICS_EXPORTER) {
    process.env.OTEL_METRICS_EXPORTER = exporterSelection("METRICS");
  }
  if (!process.env.OTEL_LOGS_EXPORTER) {
    process.env.OTEL_LOGS_EXPORTER = "none";
  }
}

/**
 * Register the real Node SDK only when an OpenTelemetry signal is explicitly
 * enabled. This keeps the local product runnable without a Collector while
 * still honoring standard OTEL_* configuration when export is requested.
 */
export function bootstrapOpenTelemetry(
  options: OpenTelemetryBootstrapOptions,
): OpenTelemetryRuntimeStatus {
  if (sdk || sdkStarting) return getOpenTelemetryStatus();
  const disabled = process.env.OTEL_SDK_DISABLED?.toLowerCase() === "true";
  if (!process.env.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = options.serviceName;
  }
  setSafeExporterDefaults();
  const tracesExporter = process.env.OTEL_TRACES_EXPORTER ?? "none";
  const metricsExporter = process.env.OTEL_METRICS_EXPORTER ?? "none";
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    null;
  const enabled =
    !disabled && (tracesExporter !== "none" || metricsExporter !== "none");
  runtimeStatus = {
    enabled,
    started: false,
    serviceName: process.env.OTEL_SERVICE_NAME ?? options.serviceName,
    tracesExporter,
    metricsExporter,
    endpoint,
    protocol: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
    w3cTraceContext: true,
    logs: "STRUCTURED_APPLICATION_LOGS",
    lastError: null,
  };
  if (!enabled) return getOpenTelemetryStatus();

  sdkStarting = true;
  try {
    sdk = new NodeSDK({
      serviceName: runtimeStatus.serviceName ?? options.serviceName,
      ...(options.autoInstrument === false
        ? {}
        : {
            instrumentations: [
              getNodeAutoInstrumentations({
                "@opentelemetry/instrumentation-fs": { enabled: false },
              }),
            ],
          }),
    });
    sdk.start();
    runtimeStatus = { ...runtimeStatus, started: true };
  } catch (error) {
    sdk = null;
    runtimeStatus = {
      ...runtimeStatus,
      started: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    sdkStarting = false;
  }
  return getOpenTelemetryStatus();
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const current = sdk;
  sdk = null;
  if (!current) return;
  try {
    await current.shutdown();
  } finally {
    runtimeStatus = { ...runtimeStatus, started: false };
  }
}

export function getOpenTelemetryStatus(): OpenTelemetryRuntimeStatus {
  return { ...runtimeStatus };
}

function validTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/i.test(value);
}

function validSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/i.test(value);
}

/** Produce portable W3C trace metadata from the current active context. */
export function currentTraceMetadata(): TraceMetadata {
  const spanContext = trace.getSpanContext(context.active());
  if (
    !spanContext ||
    !validTraceId(spanContext.traceId) ||
    !validSpanId(spanContext.spanId)
  ) {
    return {};
  }
  const flags = (spanContext.traceFlags & TraceFlags.SAMPLED)
    .toString(16)
    .padStart(2, "0");
  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
    ...(spanContext.traceState
      ? { tracestate: spanContext.traceState.serialize() }
      : {}),
  };
}

/** Parse persisted W3C metadata into a remote parent Context. */
export function contextFromTraceMetadata(metadata: TraceMetadata): Context {
  const match = metadata.traceparent?.match(
    /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i,
  );
  if (!match) return ROOT_CONTEXT;
  const [, traceId = "", spanId = "", flagHex = "00"] = match;
  if (!validTraceId(traceId) || !validSpanId(spanId)) return ROOT_CONTEXT;
  const parsedFlags = Number.parseInt(flagHex, 16);
  const traceFlags = Number.isFinite(parsedFlags)
    ? (parsedFlags & TraceFlags.SAMPLED)
    : TraceFlags.NONE;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags,
    isRemote: true,
    ...(metadata.tracestate
      ? { traceState: createTraceState(metadata.tracestate) }
      : {}),
  });
}

export class ConsoleTelemetry implements Telemetry {
  counter(
    name: string,
    value = 1,
    attributes: Record<string, string> = {},
  ): void {
    console.log(JSON.stringify({ kind: "counter", name, value, attributes }));
  }

  gauge(
    name: string,
    value: number,
    attributes: Record<string, string> = {},
  ): void {
    console.log(JSON.stringify({ kind: "gauge", name, value, attributes }));
  }

  histogram(
    name: string,
    value: number,
    attributes: Record<string, string> = {},
  ): void {
    console.log(JSON.stringify({ kind: "histogram", name, value, attributes }));
  }

  async audit(event: AuditEvent): Promise<void> {
    console.log(JSON.stringify({ kind: "audit", ...event }));
  }
}

export interface ActiveTrace {
  traceId: string;
  spanId: string;
  fail(error: unknown): void;
  end(attributes?: Record<string, string | number | boolean>): void;
}

const tracer = trace.getTracer("architecture-knowledge-platform", "0.3.0");
const meter = metrics.getMeter("architecture-knowledge-platform", "0.3.0");
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();

function metricAttributes(
  attributes: Record<string, string> | undefined,
): Attributes {
  return attributes ?? {};
}

export class OpenTelemetryBridge implements Telemetry {
  counter(
    name: string,
    value = 1,
    attributes: Record<string, string> = {},
  ): void {
    let counter = counters.get(name);
    if (!counter) {
      counter = meter.createCounter(name);
      counters.set(name, counter);
    }
    counter.add(value, metricAttributes(attributes));
  }

  gauge(
    name: string,
    value: number,
    attributes: Record<string, string> = {},
  ): void {
    let gauge = gauges.get(name);
    if (!gauge) {
      gauge = meter.createGauge(name);
      gauges.set(name, gauge);
    }
    gauge.record(value, metricAttributes(attributes));
  }

  histogram(
    name: string,
    value: number,
    attributes: Record<string, string> = {},
  ): void {
    let histogram = histograms.get(name);
    if (!histogram) {
      histogram = meter.createHistogram(name);
      histograms.set(name, histogram);
    }
    histogram.record(value, metricAttributes(attributes));
  }

  async audit(event: AuditEvent): Promise<void> {
    this.counter("akp.audit.events", 1, {
      action: event.action,
      resource_type: event.resourceType,
    });
  }

  startTrace(
    name: string,
    attributes: Record<string, string | number | boolean> = {},
  ): ActiveTrace {
    const span = tracer.startSpan(name, { attributes });
    return activeTrace(span);
  }

  async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withSpan(name, attributes, operation);
  }
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation();
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function withRemoteParentSpan<T>(
  name: string,
  metadata: TraceMetadata,
  attributes: Record<string, string | number | boolean>,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = contextFromTraceMetadata(metadata);
  const options: SpanOptions = { attributes };
  return tracer.startActiveSpan(name, options, parent, async (span) => {
    try {
      return await operation();
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

function failSpan(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : new Error(message));
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

function activeTrace(span: Span): ActiveTrace {
  const identifiers = span.spanContext();
  return {
    traceId: identifiers.traceId,
    spanId: identifiers.spanId,
    fail(error: unknown): void {
      failSpan(span, error);
    },
    end(attributes = {}): void {
      span.setAttributes(attributes);
      span.end();
    },
  };
}
