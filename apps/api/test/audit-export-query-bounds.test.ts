import { describe, expect, it } from "vitest";
import { auditExportRowLimits } from "../src/routes/audit-export.js";

describe("audit export query bounds", () => {
  it("fetches only one row beyond each default logical limit", () => {
    expect(auditExportRowLimits({})).toEqual({
      sources: 10_001,
      documents: 20_001,
      relations: 50_001,
      evidence: 50_001,
    });
  });

  it("preserves truncation detection for caller-supplied limits", () => {
    expect(
      auditExportRowLimits({
        maxSources: 2,
        maxDocuments: 3,
        maxRelations: 4,
        maxEvidence: 5,
      }),
    ).toEqual({
      sources: 3,
      documents: 4,
      relations: 5,
      evidence: 6,
    });
  });
});
