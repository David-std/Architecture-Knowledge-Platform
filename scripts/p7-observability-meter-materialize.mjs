import fs from "node:fs";

const path = "packages/observability/src/index.ts";
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
  `const tracer = trace.getTracer("architecture-knowledge-platform", "0.3.0");
const meter = metrics.getMeter("architecture-knowledge-platform", "0.3.0");
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();`,
  `const tracer = trace.getTracer("architecture-knowledge-platform", "0.3.0");
type Meter = ReturnType<typeof metrics.getMeter>;
type CounterInstrument = ReturnType<Meter["createCounter"]>;
type GaugeInstrument = ReturnType<Meter["createGauge"]>;
type HistogramInstrument = ReturnType<Meter["createHistogram"]>;
const counters = new Map<string, CounterInstrument>();
const gauges = new Map<string, GaugeInstrument>();
const histograms = new Map<string, HistogramInstrument>();

function currentMeter(): Meter {
  // Unlike Tracer, the JS Metrics API can hand out a no-op Meter before a
  // provider is registered. Resolve it lazily so application modules imported
  // before bootstrap do not permanently bind their instruments to no-op.
  return metrics.getMeter("architecture-knowledge-platform", "0.3.0");
}`,
  "lazy-meter-declaration",
);

replaceOnce(
  `    let counter = counters.get(name);
    if (!counter) {
      counter = meter.createCounter(name);
      counters.set(name, counter);
    }
    counter.add(value, metricAttributes(attributes));`,
  `    let counter = counters.get(name);
    if (!counter) {
      counter = currentMeter().createCounter(name);
      // Do not cache a no-op instrument created before SDK startup. A later
      // call after bootstrap must be able to bind to the real MeterProvider.
      if (runtimeStatus.started) counters.set(name, counter);
    }
    counter.add(value, metricAttributes(attributes));`,
  "lazy-counter",
);

replaceOnce(
  `    let gauge = gauges.get(name);
    if (!gauge) {
      gauge = meter.createGauge(name);
      gauges.set(name, gauge);
    }
    gauge.record(value, metricAttributes(attributes));`,
  `    let gauge = gauges.get(name);
    if (!gauge) {
      gauge = currentMeter().createGauge(name);
      if (runtimeStatus.started) gauges.set(name, gauge);
    }
    gauge.record(value, metricAttributes(attributes));`,
  "lazy-gauge",
);

replaceOnce(
  `    let histogram = histograms.get(name);
    if (!histogram) {
      histogram = meter.createHistogram(name);
      histograms.set(name, histogram);
    }
    histogram.record(value, metricAttributes(attributes));`,
  `    let histogram = histograms.get(name);
    if (!histogram) {
      histogram = currentMeter().createHistogram(name);
      if (runtimeStatus.started) histograms.set(name, histogram);
    }
    histogram.record(value, metricAttributes(attributes));`,
  "lazy-histogram",
);

replaceOnce(
  `  } finally {
    runtimeStatus = { ...runtimeStatus, started: false };
  }
}`,
  `  } finally {
    counters.clear();
    gauges.clear();
    histograms.clear();
    runtimeStatus = { ...runtimeStatus, started: false };
  }
}`,
  "clear-instrument-cache-on-shutdown",
);

fs.writeFileSync(path, source);
