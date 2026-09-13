import { context, trace, TraceFlags } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";
import {
  ConsoleTelemetry,
  bootstrapOpenTelemetry,
  contextFromTraceMetadata,
  currentTraceMetadata,
  getOpenTelemetryStatus,
} from "../src/index.js";

describe("ConsoleTelemetry", () => {
  it("emits deterministic structured records", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telemetry = new ConsoleTelemetry();
    telemetry.counter("jobs", 2, { state: "PENDING" });
    telemetry.gauge("queue_depth", 4, { queue: "ingest" });
    telemetry.histogram("latency", 12.5, { channel: "lexical" });
    await telemetry.audit({ action: "read", resourceType: "document" });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls[0]?.[0]).toContain('"kind":"counter"');
    expect(spy.mock.calls[2]?.[0]).toContain('"kind":"histogram"');
    spy.mockRestore();
  });
});

describe("OpenTelemetry runtime", () => {
  it("remains usable without a collector", () => {
    const previousTraces = process.env.OTEL_TRACES_EXPORTER;
    const previousMetrics = process.env.OTEL_METRICS_EXPORTER;
    const previousDisabled = process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_TRACES_EXPORTER = "none";
    process.env.OTEL_METRICS_EXPORTER = "none";
    delete process.env.OTEL_SDK_DISABLED;
    const status = bootstrapOpenTelemetry({
      serviceName: "akp-observability-test",
      autoInstrument: false,
    });
    expect(status.enabled).toBe(false);
    expect(status.started).toBe(false);
    expect(getOpenTelemetryStatus().w3cTraceContext).toBe(true);
    if (previousTraces === undefined) delete process.env.OTEL_TRACES_EXPORTER;
    else process.env.OTEL_TRACES_EXPORTER = previousTraces;
    if (previousMetrics === undefined) delete process.env.OTEL_METRICS_EXPORTER;
    else process.env.OTEL_METRICS_EXPORTER = previousMetrics;
    if (previousDisabled === undefined) delete process.env.OTEL_SDK_DISABLED;
    else process.env.OTEL_SDK_DISABLED = previousDisabled;
  });

  it("round-trips persisted W3C trace metadata", () => {
    const metadata = {
      traceparent:
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    };
    const parent = contextFromTraceMetadata(metadata);
    const remote = trace.getSpanContext(parent);
    expect(remote).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    expect(remote?.traceState?.serialize()).toBe("vendor=value");

    const local = trace.setSpanContext(context.active(), {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
      traceState: remote?.traceState,
    });
    expect(context.with(local, () => currentTraceMetadata())).toEqual(metadata);
  });

  it("rejects malformed persisted trace metadata", () => {
    const parent = contextFromTraceMetadata({ traceparent: "not-a-trace" });
    expect(trace.getSpanContext(parent)).toBeUndefined();
  });
});
