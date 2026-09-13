import { describe, expect, it } from "vitest";
import { documentIntelligenceFormFields } from "../src/document-intelligence-request.js";

describe("document intelligence ingest controls", () => {
  it("maps provider-neutral policy into the extractor multipart contract", () => {
    expect(
      documentIntelligenceFormFields(
        {
          documentIntelligence: {
            complexity: "scanned",
            ocrRequired: true,
            tables: true,
            formula: false,
            costPolicy: "NO_PAID",
            privacyPolicy: "LOCAL_ONLY",
            language: "es",
          },
        },
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

  it("does not forward arbitrary provider names, URLs, or malformed policy", () => {
    const fields = documentIntelligenceFormFields(
      {
        documentIntelligence: {
          complexity: "remote-magic",
          ocrRequired: "yes",
          tables: 1,
          formula: null,
          costPolicy: "FREE_FOREVER",
          privacyPolicy: "SEND_ANYWHERE",
          language: "https://attacker.invalid/provider",
          extractor: "chunkr",
          providerUrl: "https://attacker.invalid",
        },
      },
      "job-tampered",
    );

    expect(fields).toEqual({
      ocr_required: "false",
      tables: "false",
      formula: "false",
      cost_policy: "STANDARD",
      privacy_policy: "LOCAL_PREFERRED",
      ingest_job_id: "job-tampered",
      configuration_json: "{}",
    });
    expect(JSON.stringify(fields)).not.toContain("chunkr");
    expect(JSON.stringify(fields)).not.toContain("attacker.invalid");
  });
});
