import { describe, expect, it } from "vitest";
import { IngestRequest } from "@akp/contracts";
import { documentIntelligenceFormFields } from "../src/document-intelligence-request.js";

describe("document intelligence ingest controls", () => {
  it("preserves provider-neutral policy and bounded explicit provider controls", () => {
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
        extractor: "docling",
        ocr: true,
        ocrEngine: "tesseract",
        forceFullPageOcr: true,
        timeoutSeconds: 300,
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
      configuration_json: JSON.stringify({
        language: "es",
        extractor: "docling",
        ocr: true,
        ocr_engine: "tesseract",
        force_full_page_ocr: true,
        timeout_seconds: 300,
      }),
    });
  });

  it("uses safe defaults for legacy jobs without document policy", () => {
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

  it("rejects arbitrary provider configuration instead of forwarding it", () => {
    expect(() =>
      documentIntelligenceFormFields(
        {
          documentIntelligence: {
            complexity: "remote-magic",
            ocrRequired: "yes",
            extractor: "https://attacker.invalid",
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
          extractor: "https://attacker.invalid",
          providerUrl: "https://attacker.invalid",
        },
      }),
    ).toThrow();
  });
});
