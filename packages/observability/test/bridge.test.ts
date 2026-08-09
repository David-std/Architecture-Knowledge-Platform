import { describe, expect, it } from "vitest";
import { OpenTelemetryBridge } from "../src/index.js";

describe("OpenTelemetry bridge", () => {
  it("works with the API no-op provider and exposes trace hooks", () => {
    const telemetry = new OpenTelemetryBridge();
    const active = telemetry.startTrace("test", { component: "unit" });
    telemetry.counter("akp.test.counter");
    telemetry.histogram("akp.test.duration", 1);
    active.end({ passed: true });
    expect(active.traceId).toHaveLength(32);
    expect(active.spanId).toHaveLength(16);
  });
});
