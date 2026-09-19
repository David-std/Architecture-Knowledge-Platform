import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentInstructionBundle } from "../src/instruction-bundle.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

describe("agent instruction bundle", () => {
  it("is versioned, deterministic for one generation timestamp, and integrity-addressed", () => {
    const generatedAt = "2026-09-19T21:15:00.000Z";
    const bundle = createAgentInstructionBundle(generatedAt);
    const expectedPayload = {
      schemaVersion: 1,
      platformVersion: "0.4.0",
      contextApiVersion: "v1",
      generatedAt,
      capabilities: bundle.manifest.capabilities,
      rules: bundle.rules,
      lifecycle: bundle.lifecycle,
    };
    const expectedHash = createHash("sha256")
      .update(canonicalJson(expectedPayload))
      .digest("hex");

    expect(bundle.manifest).toMatchObject({
      schemaVersion: 1,
      platformVersion: "0.4.0",
      contextApiVersion: "v1",
      generatedAt,
      sha256: expectedHash,
    });
    expect(bundle.rules).toEqual(
      expect.arrayContaining([
        expect.stringContaining("architectural decision"),
        expect.stringContaining("broad refactor"),
        expect.stringContaining("captured finding is not published truth"),
        expect.stringContaining("Cite evidence"),
        expect.stringContaining("context revision warnings"),
      ]),
    );
    expect(bundle.lifecycle).toEqual([
      "BOOTSTRAP",
      "WORK",
      "TARGETED_RETRIEVAL",
      "IMPACT_CHECK",
      "CAPTURE_OR_HANDOFF",
      "OPTIONAL_PROMOTION",
      "FINISH_WORK_CONTEXT",
    ]);
  });
});
