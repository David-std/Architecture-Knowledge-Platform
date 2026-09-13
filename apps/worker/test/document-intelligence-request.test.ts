import { describe, expect, it } from "vitest";
import { IngestRequest } from "@akp/contracts";
import { documentIntelligenceFormFields } from "../src/document-intelligence-request.js";

describe("document intelligence ingest controls", () => {
  it("uses the shared ingest contract for provider-neutral policy", () => {
    const parsed = IngestRequest.parse({
      spaceId: "00000000-0000-0000-0000-000000000003",
      vaultId: "00000000-0000-0000-0000-000000000004",
      sourceUri: "/allowed/source.pdf",
      documentIntelligence: {
        complexity: "scanned",
        ocrRequired: true,
        tables: true,
        formula: false,
        costPolicy: "NO_PAID",
        privacyPolicy: "LOCAL_ONLY",
        language: "es",
      },
    });

    expect(
      documentIntelligenceFormFields(
        parsed as unknown as Record<string, unknown>,
        "11111111-1111-1111-1111-111111111111",
      ),
    ).toEqual({
      complexity: "scanned",
      ocr_required: "true",
      tables: "true",
      formula: "false",
      cost_policy: "NO_PAID",
      privacy_policy: "LOCAL_ONLY",
      ingest_job_id: "11111111-1111-1111-1111-111111111111",
      configuration_json: JSON.stringify({ language: "es" }),
    });
  });

  it("uses safe defaults for legacy jobs without P5 policy", () => {
    expect(documentIntelligenceFormFields({}, "job-legacy")).toEqual({
      ocr_required: "false",
      tables: "false",
      formula: "false",
      cost_policy: "STANDARD",
      privacy_policy: "LOCAL_PREFERRED",
      ingest_job_id: "job-legacy",
      configuration_json: "{}",
    });
  });

  it("rejects provider-specific or malformed durable policy instead of forwarding it", () => {
    expect(() =>
      documentIntelligenceFormFields(
        {
          documentIntelligence: {
            complexity: "remote-magic",
            ocrRequired: "yes",
            extractor: "chunkr",
            providerUrl: "https://attacker.invalid",
          },
        },
        "job-tampered",
      ),
    ).toThrowError("INVALID_DOCUMENT_INTELLIGENCE_PAYLOAD");

    expect(() =>
      IngestRequest.parse({
        spaceId: "00000000-0000-0000-0000-000000000003",
        vaultId: "00000000-0000-0000-0000-000000000004",
        sourceUri: "/allowed/source.pdf",
        documentIntelligence: {
          extractor: "chunkr",
          providerUrl: "https://attacker.invalid",
        },
      }),
    ).toThrow();
  });
});
