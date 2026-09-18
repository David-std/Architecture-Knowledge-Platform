import { describe, expect, it } from "vitest";
import {
  validateGovernedTrustBoundary,
  validateMarkdownDocument,
} from "../src/index.js";

const header = `---\ntype: note\nstatus: draft\nknowledge_layer: generated\n---\n\n# Generated\n\n`;

describe("generated Markdown safety", () => {
  it.each([
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(1)">',
    "[click](javascript:alert(1))",
    '<iframe src="https://example.test"></iframe>',
  ])("rejects active markup: %s", (payload) => {
    const issues = validateMarkdownDocument(
      header + payload + " safe filler ".repeat(12),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "UNSAFE_ACTIVE_MARKUP",
        severity: "ERROR",
      }),
    );
  });

  it("allows inert Markdown", () => {
    const issues = validateMarkdownDocument(
      header +
        "Use **bounded review** with [portable evidence](https://example.test/docs). " +
        "Safe explanatory text. ".repeat(8),
    );
    expect(issues).not.toContainEqual(
      expect.objectContaining({ code: "UNSAFE_ACTIVE_MARKUP" }),
    );
  });

  it.each([
    ["trust_tier", "attested"],
    ["verification_status", "ATTESTED"],
    ["status", "attested"],
  ])("rejects governed self-attestation through %s", (field, value) => {
    const candidate =
      "---\n" +
      "type: note\n" +
      "status: proposed\n" +
      "knowledge_layer: generated\n" +
      `${field}: ${value}\n` +
      "---\n\n# Generated\n\n" +
      "Substantive governed proposal content. ".repeat(8);
    const issues = validateGovernedTrustBoundary(candidate);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: "TRUST_ESCALATION_FORBIDDEN",
        severity: "ERROR",
      }),
    );
  });

  it.each([
    ["trust_tier", "machine-supported"],
    ["trust_tier", "human-reviewed"],
    ["verification_status", "reviewed"],
    ["status", "proposed"],
  ])(
    "does not reject non-attested governed trust metadata %s=%s",
    (field, value) => {
      const candidate =
        "---\n" +
        "type: note\n" +
        "status: proposed\n" +
        "knowledge_layer: generated\n" +
        `${field}: ${value}\n` +
        "---\n\n# Generated\n\n" +
        "Substantive governed proposal content. ".repeat(8);
      expect(validateGovernedTrustBoundary(candidate)).toEqual([]);
    },
  );
});
