import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAgentInstructionBundle,
  verifyAgentInstructionBundle,
} from "../src/instruction-bundle.js";

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
  it("is versioned, stable across generation times, and integrity-addressed", () => {
    const generatedAt = "2026-09-19T21:15:00.000Z";
    const bundle = createAgentInstructionBundle(generatedAt);
    const expectedPayload = {
      schemaVersion: 1,
      platformVersion: "0.4.0",
      contextApiVersion: "v1",
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
    expect(
      createAgentInstructionBundle("2026-09-20T00:00:00.000Z").manifest.sha256,
    ).toBe(expectedHash);
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

  it("recomputes content integrity and supports WARN or STRICT expected-digest policy", () => {
    const bundle = createAgentInstructionBundle(
      "2026-09-19T21:15:00.000Z",
    );
    expect(
      verifyAgentInstructionBundle(bundle, {
        expectedSha256: bundle.manifest.sha256,
        mode: "STRICT",
      }),
    ).toMatchObject({
      valid: true,
      computedSha256: bundle.manifest.sha256,
      expectedSha256: bundle.manifest.sha256,
      warnings: [],
    });

    const tampered = {
      ...bundle,
      rules: [...bundle.rules, "Tampered runtime instruction."],
    };
    expect(() =>
      verifyAgentInstructionBundle(tampered, { mode: "STRICT" }),
    ).toThrow("AGENT_INSTRUCTION_BUNDLE_HASH_MISMATCH");
    expect(
      verifyAgentInstructionBundle(tampered, { mode: "WARN" }),
    ).toMatchObject({
      valid: false,
      warnings: ["AGENT_INSTRUCTION_BUNDLE_HASH_MISMATCH"],
    });

    const wrongExpected = "0".repeat(64);
    expect(() =>
      verifyAgentInstructionBundle(bundle, {
        expectedSha256: wrongExpected,
        mode: "STRICT",
      }),
    ).toThrow("AGENT_INSTRUCTION_EXPECTED_DIGEST_MISMATCH");
    expect(
      verifyAgentInstructionBundle(bundle, {
        expectedSha256: wrongExpected,
        mode: "WARN",
      }),
    ).toMatchObject({
      valid: false,
      expectedSha256: wrongExpected,
      warnings: ["AGENT_INSTRUCTION_EXPECTED_DIGEST_MISMATCH"],
    });
  });
});
