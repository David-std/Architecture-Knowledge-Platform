import { describe, expect, it } from "vitest";
import { operationalErrorRecord } from "../src/operational-error.js";

describe("operational error redaction", () => {
  it("preserves only explicit machine-safe provider codes", () => {
    expect(operationalErrorRecord(new Error("COMPILER_PROVIDER_TIMEOUT"))).toEqual({
      code: "COMPILER_PROVIDER_TIMEOUT",
      message: "COMPILER_PROVIDER_TIMEOUT",
    });

    const coded = Object.assign(
      new Error(
        "Authorization: Bearer top-secret https://private.example.test/path?sig=secret",
      ),
      { code: "KNOWLEDGE_COMPILER_UNAVAILABLE" },
    );
    expect(operationalErrorRecord(coded)).toEqual({
      code: "KNOWLEDGE_COMPILER_UNAVAILABLE",
      message: "KNOWLEDGE_COMPILER_UNAVAILABLE",
    });
  });

  it("redacts arbitrary messages rather than attempting to persist source details", () => {
    const record = operationalErrorRecord(
      new Error(
        'api_key=secret source="customer-confidential-text" signed=https://example.test/x?token=secret',
      ),
    );

    expect(record).toEqual({
      code: "OPERATIONAL_FAILURE_REDACTED",
      message: "Operational failure details redacted.",
    });
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(JSON.stringify(record)).not.toContain("customer-confidential-text");
    expect(JSON.stringify(record)).not.toContain("example.test");
  });
});
