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
  histogram(
    name: string,
    value: number,
    attributes?: Record<string, string>,
  ): void;
  audit(event: AuditEvent): Promise<void>;
}

export class ConsoleTelemetry implements Telemetry {
  counter(
    name: string,
    value = 1,
    attributes: Record<string, string> = {},
  ): void {
    console.log(JSON.stringify({ kind: "counter", name, value, attributes }));
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

export class OpenTelemetryBridge implements Telemetry {
  private readonly tracer = trace.getTracer(
    "architecture-knowledge-platform",
    "0.2.0",
  );
  private readonly meter = metrics.getMeter(
    "architecture-knowledge-platform",
    "0.2.0",
  );
  private readonly counters = new Map<
    string,
    ReturnType<typeof this.meter.createCounter>
  >();
  private readonly histograms = new Map<
    string,
    ReturnType<typeof this.meter.createHistogram>
  >();

  counter(
    name: string,
    value = 1,
    attributes: Record<string, string> = {},
  ): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, attributes);
  }

  histogram(
    name: string,
    value: number,
    attributes: Record<string, string> = {},
  ): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = this.meter.createHistogram(name);
      this.histograms.set(name, histogram);
    }
    histogram.record(value, attributes);
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
    const span = this.tracer.startSpan(name, { attributes });
    return activeTrace(span);
  }
}

function activeTrace(span: Span): ActiveTrace {
  const identifiers = span.spanContext();
  return {
    traceId: identifiers.traceId,
    spanId: identifiers.spanId,
    fail(error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      span.recordException(error instanceof Error ? error : new Error(message));
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    },
    end(attributes = {}): void {
      span.setAttributes(attributes);
      span.end();
    },
  };
}
import { metrics, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
